"use strict";

// Un turno de chat: pedido -> modelo -> edicion -> verificacion -> commit.
// runTurn es la entrada (con el candado de "busy" y el reintento del modo
// Auto); runTurnInner corre las fases y tambien lo usa /task para cada paso.
const vscode = require("vscode");
const path = require("path");
const { buildContents, systemPromptFor, ARCHITECT_PROMPT, EDITOR_NOTE } = require("./gemini");
const verify = require("./verify");
const bugLogs = require("./logs");
const { prepareArchitect } = require("./archBase");
const { parseToolRequest, runTools, newToolSession, roundsFor, toolsPrompt, nativeToolDefs, nativeToolsPrompt, toolCallToReq, MAX_REQUESTS_PER_ROUND } = require("./tools");
const { planChangeSet } = require("./editEngine");
const { parseEdits, hasEdits, stripEdits, resolveEditFormat, repairInstruction, verifyFixInstruction, describeFailure } = require("./editFormats");
const { computeCost, addUsage, addCost } = require("./pricing");
const router = require("./router");
const i18n = require("./i18n");
const { L } = i18n;
const gitUtil = require("./git");
const { state, rt, cfg, workspaceRoot, log, post } = require("./state");
const { AUTO, missingApiKeyFor, autoTiers, callLLM, warnIfExpensive, nativeToolsFor } = require("./models");
const { getRepoMap, repoMapParts, applyFocus, historyWindow } = require("./context");
const { activeRelPath, validatePath, uriOf, readRel, exists, contextPaths, loadContextFiles, currentSelection, sendFilesUpdate, writeChangeSet, restoreFiles } = require("./workspaceFiles");
const { diagContext, appendUsageLog, logTurn } = require("./sessionLog");
const { lspDiagnosticsFor } = require("./logAttach");
const { runExecCommand } = require("./execRunner");
const { revertSnapshot } = require("./undo");

// v0.20.1: una ronda de herramientas obliga a una segunda llamada que reenvia
// TODO el contexto de la primera (asi son las APIs sin estado) -- eso no se
// puede evitar sin romper el cache de prefijo identico. Lo que si se puede
// evitar es pagar el MISMO presupuesto de razonamiento otra vez: en la
// llamada de continuacion el modelo ya "penso" que necesitaba la herramienta,
// ahora solo tiene que leer el resultado y responder, asi que baja un escalon
// de Effort (nunca menos de "low") SOLO para esa llamada -- menos tokens de
// pensamiento/salida en la parte mas cara de la ronda extra, sin tocar el
// Effort que el usuario eligio para el resto del turno.
const EFFORT_STEP_DOWN = { extra: "high", high: "medium", medium: "low", low: "low" };
function lowerEffort(e) { return EFFORT_STEP_DOWN[e] || "low"; }

const MAX_FILE_REQUEST_ROUNDS = 2; // NECESITO_ARCHIVOS -> se agregan y se vuelve a preguntar
const MAX_REPAIR_ROUNDS = 1; // igual que MAX_EDIT_REPAIR_ROUNDS en app_en.py
const MAX_VERIFY_ROUNDS = 2; // reintentos de auto-correccion cuando la verificacion falla

function parseFileRequest(text, format) {
  if (hasEdits(text, format)) return null;
  const m = /^\s*NECESITO_ARCHIVOS\s*:\s*(.+)$/m.exec(text || "");
  if (!m) return null;
  // Separado solo por comas: una ruta puede tener espacios ("base de dooom.py").
  return m[1].split(",").map((s) => s.replace(/[`"'*]/g, "").trim()).filter(Boolean);
}

// El flag busy se marca de forma SINCRONA antes de cualquier await: antes se
// marcaba despues de leer la API key, y un doble Enter rapido lanzaba dos
// turnos a la vez (el segundo pisaba los archivos del primero y Detener
// solo cortaba uno).
// Modo Auto, "probar en vez de adivinar" (v0.29): si el turno lo hizo un
// modelo que NO es el fuerte y fallo de forma VERIFICABLE (los cambios no se
// pudieron aplicar, o la verificacion -- sintaxis / verifyCommand -- se
// rindio), se deshace ese intento y se repite UNA vez con el fuerte, pasandole
// el error. Un error de red/API no escala (no dice nada del modelo). Si el
// pedido ya tenia senales de dificultad, Auto habia ido directo al fuerte y
// aca no hay nada que hacer.
async function maybeEscalate(question, r) {
  if (!r || !r.auto || r.isError || cfg().get("autoEscalate") === false) return;
  if (!state.abort || state.abort.signal.aborted) return;
  const { tiers, level, usedModel } = r.auto;
  if (level === "fuerte" || !tiers || tiers.fuerte === usedModel) return;
  const fail = r.failures && r.failures.length
    ? L("los cambios no se pudieron aplicar", "the changes could not be applied") + ": " + r.failures.map((f) => f.path).join(", ")
    : r.verifyFailed ? L("la verificacion fallo", "verification failed") + ": " + r.verifyFailed.split("\n")[0].slice(0, 200) : "";
  if (!fail) return;
  // deshacer lo que escribio el intento barato (solo si es de ESTE turno)
  const top = state.undoStack[state.undoStack.length - 1];
  if (top && top.turnId === r.turnId) {
    state.undoStack.pop();
    await revertSnapshot(top);
    sendFilesUpdate();
  }
  // sacar el intento fallido del historial: el reintento no debe verlo dos veces
  const h = state.history;
  if (h.length >= 2 && h[h.length - 2].role === "user" && h[h.length - 2].content === question) h.splice(h.length - 2, 2);
  post({ type: "system", text: L(`Auto: \`${usedModel}\` no lo resolvio (${fail}). Se deshizo ese intento y se reintenta con \`${tiers.fuerte}\`.`, `Auto: \`${usedModel}\` didn't solve it (${fail}). That attempt was reverted; retrying with \`${tiers.fuerte}\`.`) });
  await runTurnInner(question, {
    model: tiers.fuerte,
    note: `NOTA: un intento anterior de este mismo pedido, hecho por un modelo mas chico, fallo asi (ya se deshizo): ${r.verifyFailed || fail}\nEvita ese error.`,
  });
}

async function runTurn(question) {
  if (state.busy) return post({ type: "system", text: L("Espera a que termine el turno actual (o pulsa Detener).", "Wait for the current turn to finish (or press Stop).") });
  state.busy = true;
  state.abort = new AbortController();
  try {
    const r = await runTurnInner(question);
    await maybeEscalate(question, r);
  } finally {
    state.busy = false;
    state.abort = null;
    post({ type: "idle" });
  }
}

// ---------------------------------------------------------------- turno por fases
// Un turno pasa por estas fases, en orden:
//   startTurn      -> resuelve modelos (Auto / arquitecto), API keys, turnId
//   prepareContext -> mapa del repo, archivos, historial, herramientas
//   askModel       -> llamada(s) al modelo: arquitecto+editor o una sola,
//                     con rondas de herramientas y de NECESITO_ARCHIVOS
//   applyEdits     -> aplicar bloques (con reparacion), escribir, verificar
//                     (con correcciones), commit de git, abrir el archivo
//   finishTurn     -> historial, costos de la sesion, logs y aviso al webview
// Todas comparten `t`, el estado de ESTE turno (lo que antes eran variables
// locales de una sola funcion de 600 lineas).
async function runTurnInner(question, opts = {}) {
  if (!workspaceRoot()) {
    post({ type: "error", text: L("Abre una carpeta (File > Open Folder) para que SovNode sepa donde leer y crear archivos.", "Open a folder (File > Open Folder) so SovNode knows where to read and create files.") });
    return;
  }
  const t = await startTurn(question, opts);
  if (!t) return;
  try {
    await prepareContext(t);
    const r = await askModel(t);
    t.finalText = r.text;
    if (!String(t.finalText || "").trim()) t.notes.push(L("El modelo no devolvio texto ni cambios en este turno. Reintenta o reformula el pedido; si pasa seguido, revisa el log de sesion.", "The model returned no text or changes this turn. Retry or rephrase the request; if it keeps happening, check the session log."));
    if (t.toolSaved >= 200) t.notes.push(L(`Herramientas: no se reenviaron ~${t.toolSaved.toLocaleString("es")} caracteres que el modelo ya tenia.`, `Tools: skipped resending ~${t.toolSaved.toLocaleString("en")} characters the model already had.`));
    if (r.finishReason === "MAX_TOKENS") t.notes.push(L("La respuesta se corto por el limite de tokens de salida. Sube el effort o pide el cambio en partes.", "The response was cut off by the output token limit. Raise the effort or ask for the change in parts."));
    if (hasEdits(t.finalText, t.editFormat)) await applyEdits(t);
    rememberTurn(t);
  } catch (err) {
    reportTurnError(t, err);
  }
  return finishTurn(t);
}

// ---------------------------------------------------------------- fase: arranque
// Devuelve el estado del turno, o null si no se puede arrancar (ya avisado).
async function startTurn(question, opts) {
  // opts.model (v0.26): el modo agente fuerza el modelo de un paso (barato
  // primero, el principal al escalar). Con modelo forzado no hay arquitecto:
  // ese paso lo hace un solo modelo, que es justamente el punto.
  // Idioma de la respuesta: el del pedido ORIGINAL del usuario (en /task la
  // pregunta del paso viene envuelta en espanol, por eso llega en opts).
  const replyLang = opts.replyLang || i18n.detectLang(question);
  let model = opts.model || cfg().get("model");
  const effort = cfg().get("effort");
  const pricingOverrides = cfg().get("pricing");
  // Modo Auto: se decide aca, con senales que ya tenemos (sin llamada extra).
  let autoPlan = null;
  if (model === AUTO) {
    const tiers = await autoTiers();
    if (!tiers) {
      post({ type: "error", text: L("Modo Auto: no hay ninguna API key guardada. Pulsa 🔑 para agregar una.", "Auto mode: no API key saved. Press 🔑 to add one.") });
      return null;
    }
    const pre = await loadContextFiles();
    const route = router.routeLevel({ question, fileCount: pre.length, fileChars: pre.reduce((n, f) => n + f.content.length, 0), hasLogs: state.logs.length > 0, prevFailed: state.lastTurnFailed });
    autoPlan = { ...router.planTurn(tiers, route), route, tiers };
    model = autoPlan.model;
  }
  // Modo arquitecto: el modelo principal planea, el "editor" (editorModel,
  // o el mismo si esta vacio) escribe los bloques. Reparacion y verificacion
  // tambien las hace el editor, que es quien escribe codigo. Cada uno puede
  // ser de un proveedor distinto (ej: Gemini planea, GPT-6 Luna barato
  // edita) -- por eso el chequeo de API key es por proveedor, no uno solo.
  const architect = autoPlan ? autoPlan.architect : !opts.model && Boolean(cfg().get("architect"));
  const editModel = autoPlan ? autoPlan.editModel : architect ? ((cfg().get("editorModel") || "").trim() || model) : model;
  const missingKey = await missingApiKeyFor([model, editModel]);
  if (missingKey) {
    post({ type: "error", text: L(`Falta la API key de ${missingKey}. Pulsa el boton de llave arriba del chat o corre "SovNode: Set API Key".`, `Missing the ${missingKey} API key. Press the key button above the chat or run "SovNode: Set API Key".`) });
    return null;
  }
  warnIfExpensive([model, editModel], cfg().get("pricing"));

  const turnId = ++state.turnCounter;
  if (autoPlan) post({ type: "info", turnId: null, text: L(`Auto → nivel **${autoPlan.route.level}**: ${architect ? `${model} planea, ${editModel} escribe` : model} (${autoPlan.route.reasons.join("; ")})`, `Auto → level **${autoPlan.route.level}**: ${architect ? `${model} plans, ${editModel} writes` : model} (${autoPlan.route.reasons.join("; ")})`) });
  // Formato de edicion del turno (SEARCH/REPLACE, diff unificado o archivo
  // completo): lo decide el modelo que ESCRIBE el codigo (el editor en modo
  // arquitecto). Se recalcula con el tamanio real de los archivos en cuanto
  // se cargan, y despues queda fijo todo el turno -- reparacion y
  // correccion por verificacion usan el mismo formato.
  const fmt = resolveEditFormat(cfg().get("editFormat"), editModel, 0);
  const t = {
    question, opts, replyLang, model, editModel, architect, autoPlan, effort, pricingOverrides, turnId,
    fmt, editFormat: fmt.format,
    calls: [], turnUsage: {}, turnCost: {}, notes: [],
    phase: "preparando contexto",
    resultLabel: "respuesta sin cambios",
    filesChanged: [],
    failures: [],
    verifyFailed: "", // v0.24: si la verificacion se rindio, el error (para el modo agente)
    finalText: "",
    contextInfo: null,
    archPlan: "",
    toolStats: { rounds: 0, requests: 0 },
    toolSaved: 0,
    // los completa prepareContext
    map: null, mapParts: null, history: [], files: [], fullPaths: new Set(), selection: null,
    toolRoundsLeft: 0, toolsOn: false, execEnabled: false, toolCtx: null,
  };
  post({ type: "turnStart", turnId, model: architect ? `${model} → ${editModel}` : model, effort, architect });
  return t;
}

// ---------------------------------------------------------------- llamadas al modelo
const PHASE_TEXT = () => ({
  principal: L("Pensando...", "Thinking..."),
  arquitecto: L("El arquitecto esta planeando el cambio...", "The architect is planning the change..."),
  editor: L("El editor esta escribiendo el codigo segun el plan...", "The editor is writing the code from the plan..."),
  reparacion: L("Corrigiendo un bloque que no calzo...", "Fixing a block that didn't match..."),
  herramientas: L("Leyendo lo que pidio y siguiendo...", "Reading what it asked for and continuing..."),
  verificacion: L("Corrigiendo lo que fallo en la verificacion...", "Fixing what failed verification..."),
});

async function callModel(t, kind, contents, opts = {}) {
  const useModel = opts.model || t.model;
  post({ type: "phase", turnId: t.turnId, text: PHASE_TEXT()[kind] || L("Leyendo los archivos que pidio...", "Reading the files it asked for...") });
  const hasNativeTurns = contents.some((m) => m.native || m.toolResults);
  let r;
  try {
    r = await callOnce();
  } catch (e) {
    // Anthropic empezo a exigir thinking.type "adaptive" + output_config.effort
    // en vez de "enabled"+budget_tokens para modelos nuevos (v0.29.3): se
    // reintenta la misma llamada con el formato nuevo y se recuerda por
    // modelo para el resto de la sesion (mismo patron que nativeToolsOff).
    if (!state.thinkingAdaptive.has(useModel) && /HTTP 400/.test(e.message) && /thinking\.type|output_config\.effort/i.test(e.message)) {
      state.thinkingAdaptive.add(useModel);
      r = await callOnce();
    } else if (opts.native && !hasNativeTurns && /HTTP 400/.test(e.message) && /tool|function/i.test(e.message)) {
      // Herramientas nativas rechazadas (modelo sin soporte, API que cambio):
      // si todavia no hubo rondas nativas en esta llamada, se repite con el
      // protocolo de texto y se recuerda para el resto de la sesion.
      state.nativeToolsOff.add(useModel);
      opts.native = false; // toolLoop lee el mismo objeto
      t.notes.push(L(`${useModel} rechazo las herramientas nativas (${e.message.slice(0, 160)}); se uso el protocolo de texto y se sigue asi en esta sesion.`, `${useModel} rejected native tools (${e.message.slice(0, 160)}); switched to the text protocol for the rest of this session.`));
      r = await callOnce();
    } else {
      throw e;
    }
  }
  return finishCall(t, r, kind, useModel);

  function callOnce() {
    const turnId = t.turnId;
    return callLLM({
      // Siempre se manda un prompt de sistema explicito: antes el turno
      // normal dependia del default de gemini.js, y con OpenAI/Anthropic
      // (que no tienen ese default) el modelo no recibia NINGUNA instruccion
      // de como editar.
      // opts.effort permite bajarlo puntualmente para una llamada (ver
      // lowerEffort/toolLoop); si no viene, se usa el effort del turno.
      model: useModel, contents, effort: opts.effort || t.effort,
      systemPrompt: (opts.systemPrompt || systemPromptFor(t.editFormat)) + (opts.tools ? (opts.native ? nativeToolsPrompt(opts.execEnabled) : toolsPrompt(opts.execEnabled)) : ""),
      toolDefs: opts.tools && opts.native ? nativeToolDefs(opts.execEnabled) : undefined,
      toolChoiceNone: Boolean(opts.toolChoiceNone),
      signal: state.abort.signal, streaming: Boolean(cfg().get("streaming")),
      onText: (x) => post({ type: "delta", turnId, text: x }),
      onThought: (x) => post({ type: "thought", turnId, text: x }),
      onReset: () => post({ type: "resetStream", turnId }),
    });
  }
}

function finishCall(t, r, kind, useModel) {
  if (r.usedFallback) {
    t.notes.push(L(`El streaming se corto por un problema de red/proxy/antivirus (${r.fallbackReason}); se reintento sin streaming y funciono. Si se repite seguido, revisa si algo intercepta el trafico HTTPS (antivirus, VPN, proxy corporativo).`, `Streaming was cut off by a network/proxy/antivirus issue (${r.fallbackReason}); retried without streaming and it worked. If this keeps happening, check whether something intercepts HTTPS traffic (antivirus, VPN, corporate proxy).`));
    post({ type: "info", turnId: t.turnId, text: L("El streaming fallo por un problema de conexion; reintentando sin streaming...", "Streaming failed due to a connection problem; retrying without streaming...") });
  }
  const cost = computeCost(useModel, r.usage, { overrides: t.pricingOverrides });
  t.calls.push({ kind, model: useModel, usage: r.usage, cost, latencyMs: r.latencyMs, firstTokenMs: r.firstTokenMs, finishReason: r.finishReason, usedFallback: Boolean(r.usedFallback) });
  t.turnUsage = addUsage(t.turnUsage, r.usage);
  t.turnCost = addCost(t.turnCost, cost);
  post({ type: "callDone", turnId: t.turnId, call: t.calls[t.calls.length - 1] });
  return r;
}

// ---------------------------------------------------------------- fase: contexto
function focusFor(t, fs, text) {
  return applyFocus(fs, text, t.map, t.fullPaths, t.selection, t.editFormat);
}

function describeFiles(sent) {
  return sent.map((f) => ({ path: f.path, chars: (f.rendered || f.content).length, focus: f.focus || null, archBase: f.archBase || null }));
}

async function prepareContext(t) {
  t.phase = "construyendo el mapa del repositorio";
  const map = await getRepoMap();
  t.map = map;
  t.mapParts = repoMapParts(map, t.question);
  t.history = historyWindow();
  t.files = await loadContextFiles();
  t.fmt = resolveEditFormat(cfg().get("editFormat"), t.editModel, t.files.reduce((n, f) => n + f.content.length, 0));
  t.editFormat = t.fmt.format;
  // Contexto enfocado: en archivos grandes solo van las partes que el pedido
  // toca (ver focus.js). fullPaths = archivos que el modelo pidio ver enteros.
  t.selection = currentSelection();
  const mapParts = t.mapParts;
  t.contextInfo = { files: describeFiles(focusFor(t, t.files, t.question)), repoMapChars: (mapParts.cached || mapParts.text).length + mapParts.focus.length, repoMapCached: Boolean(mapParts.cached), projectMemoryChars: mapParts.memory.length, historyMsgs: t.history.length, editFormat: t.editFormat, editFormatReason: t.fmt.reason, logs: state.logs.map((l) => ({ label: l.label, chars: l.chars })) };
  post({ type: "context", turnId: t.turnId, context: t.contextInfo });
  // v0.29.1: carpeta vacia (tipico: se abrio la carpeta equivocada) -> avisar
  // en vez de dejar que el modelo busque en la nada y conteste vacio.
  if (!t.files.length && !(map && map.entries && map.entries.length)) {
    const any = await vscode.workspace.findFiles("**/*", "**/{node_modules,.git}/**", 1);
    if (!any.length) post({ type: "info", turnId: t.turnId, text: L(`La carpeta abierta (${workspaceRoot().fsPath}) no tiene archivos. Si el pedido habla de archivos existentes, probablemente abriste la carpeta equivocada (File > Open Folder).`, `The open folder (${workspaceRoot().fsPath}) has no files. If the request refers to existing files, you probably opened the wrong folder (File > Open Folder).`) });
  }

  // Micro-herramientas (tools.js): el modelo puede pedir leer un rango de
  // lineas o buscar un texto a mitad del turno. Tope de rondas COMPARTIDO
  // por todo el turno (arquitecto + editor), resultados fuera del historial.
  t.toolRoundsLeft = roundsFor(cfg().get("toolsMaxRounds"), t.effort);
  t.toolsOn = t.toolRoundsLeft > 0;
  t.execEnabled = t.toolsOn && cfg().get("execEnabled") !== false;
  t.toolCtx = makeToolCtx(t);
}

function makeToolCtx(t) {
  const map = t.map;
  let listFilesMemo = null;
  return {
    readRel,
    validatePath,
    // v0.23: TODO el proyecto (codigo, config, docs), no solo lo que tiene
    // el mapa (que son solo lenguajes con tree-sitter). Orden: archivos del
    // chat, despues los del mapa (mas relevantes), despues el resto --
    // "buscar" corta en MAX_SEARCH_FILES, asi los importantes van primero.
    // Una sola vez por turno (se cachea la promesa).
    listFiles: () => (listFilesMemo ||= (async () => {
      const set = new Set(contextPaths().map((f) => f.path));
      if (map && map.entries) for (const e of map.entries) set.add(e.relPath);
      const found = await vscode.workspace.findFiles("**/*", "**/{node_modules,.git,dist,build,out,.venv,venv,__pycache__,.next,target,coverage}/**", 3000);
      for (const u of found) set.add(vscode.workspace.asRelativePath(u).split("\\").join("/"));
      return [...set];
    })()),
    // Donde se define (mapa del repo): "draw_map", "def draw_map", "class Enemy".
    definitions: (q) => {
      if (!map || !map.entries) return [];
      const name = (/^(?:def|class|function|fn|func|const|let|var)\s+([\w$]+)$/.exec(q.trim()) || [])[1] || q.trim();
      const out = [];
      for (const e of map.entries) for (const sy of e.symbols || []) if (sy.name === name) out.push({ path: e.relPath, line: sy.line });
      return out;
    },
    runExec: t.execEnabled ? ((cmd) => runExecCommand(cmd, t.turnId)) : null,
  };
}

// ---------------------------------------------------------------- fase: modelo (herramientas)
// Lineas del archivo ACTUAL que el modelo ya tiene en esta llamada
// (entero o extracto). La base del arquitecto no cuenta: es una version
// vieja + diff, los numeros de linea no son los del archivo actual.
function shownOf(sent) {
  const m = new Map();
  for (const f of sent) {
    if (f.archBase) continue;
    if (f.focus && f.focus.ranges) m.set(f.path, f.focus.ranges.map((x) => [...x]));
    else if (typeof f.content === "string") m.set(f.path, [[1, f.content.split("\n").length]]);
  }
  return m;
}

// Cada ronda AGREGA [pedido del modelo][resultados] al final: el pedido
// anterior queda como prefijo identico (cacheable) de la llamada nueva.
// v0.25: cada llamada nativa se traduce al pedido interno y corre por
// runTools (misma dedup, topes y recortes que el protocolo de texto).
// Hay que responder TODAS las llamadas (Anthropic/OpenAI lo exigen), asi
// que las que no corren igual reciben un resultado explicando por que.
async function runNativeCalls(t, calls, sess) {
  const results = [];
  const summary = [];
  let used = 0;
  for (const c of calls) {
    const out = { id: c.id, apiId: c.apiId, name: c.name };
    const conv = toolCallToReq(c);
    if (conv.error) { results.push({ ...out, result: `error: ${conv.error}` }); continue; }
    if (conv.req.kind === "ejecutar" && calls.length > 1) { results.push({ ...out, result: "no se corrio: \"ejecutar\" tiene que ir SOLO en su ronda (pedilo de nuevo sin otras herramientas)." }); continue; }
    if (used >= MAX_REQUESTS_PER_ROUND) { results.push({ ...out, result: `no se corrio: tope de ${MAX_REQUESTS_PER_ROUND} consultas por ronda.` }); continue; }
    used++;
    const res = await runTools([conv.req], t.toolCtx, sess);
    t.toolSaved += res.saved;
    summary.push(...res.summary);
    results.push({ ...out, result: res.text.replace(/^RESULTADOS DE HERRAMIENTAS:\n\n/, "") });
  }
  return { results, summary, used };
}

async function toolLoop(t, r, contents, opts, sent) {
  const turnId = t.turnId;
  const convo = [];
  const sess = newToolSession(shownOf(sent || []));
  for (;;) {
    if (opts.native) {
      const calls = r.toolCalls || [];
      if (!calls.length || hasEdits(r.text, t.editFormat)) return r;
      if (t.toolRoundsLeft <= 0) {
        t.notes.push(L("El modelo siguio pidiendo herramientas despues del tope de rondas; se uso lo que respondio (subi sovnodeAider.toolsMaxRounds si pasa seguido).", "The model kept requesting tools after the round limit; its answer was used as is (raise sovnodeAider.toolsMaxRounds if this happens often)."));
        return r;
      }
      t.toolRoundsLeft--;
      t.toolStats.rounds++;
      const { results, summary, used } = await runNativeCalls(t, calls, sess);
      t.toolStats.requests += used;
      post({ type: "info", turnId, text: L(`SovNode consulto: ${summary.length ? summary.join(", ") : "(nada valido)"}`, `SovNode looked up: ${summary.length ? summary.join(", ") : "(nothing valid)"}`) });
      const lastRes = results[results.length - 1];
      lastRes.result += t.toolRoundsLeft <= 0
        ? "\n\nYa no quedan consultas: responde AHORA el pedido original con lo que tenes."
        : "\n\nSegui con el pedido original. Solo usa mas herramientas si de verdad te falta algo.";
      convo.push(
        { role: "model", parts: [{ text: (r.text || "").trim() }], native: r.native },
        { role: "user", parts: [{ text: results.map((x) => x.result).join("\n\n") }], toolResults: results }
      );
      post({ type: "resetStream", turnId });
      t.phase = "llamada al modelo (herramientas)";
      // sin rondas restantes: se le prohibe llamar mas (tool_choice none)
      // en vez de quitar las definiciones, que algunas APIs exigen
      // mientras haya llamadas previas en la conversacion.
      r = await callModel(t, "herramientas", [...contents, ...convo], { ...opts, effort: lowerEffort(opts.effort || t.effort), toolChoiceNone: t.toolRoundsLeft <= 0 });
      continue;
    }
    const reqs = hasEdits(r.text, t.editFormat) ? null : parseToolRequest(r.text);
    if (!reqs) return r;
    if (t.toolRoundsLeft <= 0) {
      t.notes.push(L("El modelo siguio pidiendo herramientas despues del tope de rondas; se uso lo que respondio (subi sovnodeAider.toolsMaxRounds si pasa seguido).", "The model kept requesting tools after the round limit; its answer was used as is (raise sovnodeAider.toolsMaxRounds if this happens often)."));
      return r;
    }
    t.toolRoundsLeft--;
    t.toolStats.rounds++;
    t.toolStats.requests += reqs.length;
    const res = await runTools(reqs, t.toolCtx, sess);
    t.toolSaved += res.saved;
    post({ type: "info", turnId, text: L(`SovNode consulto: ${res.summary.join(", ")}`, `SovNode looked up: ${res.summary.join(", ")}`) });
    const tail = t.toolRoundsLeft <= 0
      ? "\n\nYa no quedan consultas: responde AHORA el pedido original con lo que tenes (no vuelvas a pedir HERRAMIENTAS)."
      : "\n\nSegui con el pedido original. Solo pedi mas HERRAMIENTAS si de verdad te falta algo.";
    convo.push({ role: "model", parts: [{ text: r.text.trim() }] }, { role: "user", parts: [{ text: res.text + tail }] });
    post({ type: "resetStream", turnId });
    t.phase = "llamada al modelo (herramientas)";
    // effort mas bajo SOLO en esta llamada de continuacion (ver comentario
    // en lowerEffort): el resto del turno sigue con el effort configurado.
    r = await callModel(t, "herramientas", [...contents, ...convo], { ...opts, effort: lowerEffort(opts.effort || t.effort) });
  }
}

// ---------------------------------------------------------------- fase: modelo (pedido)
// Una llamada con el contexto del turno + sus rondas de herramientas + hasta
// MAX_FILE_REQUEST_ROUNDS pedidos de archivos (NECESITO_ARCHIVOS) antes de
// editar.
async function askWithFiles(t, kind, extra, opts) {
  const turnId = t.turnId;
  const question = t.question;
  const mapParts = t.mapParts;
  t.phase = `llamada al modelo (${kind})`;
  // v0.29.1: el tope de rondas es por TURNO. Si el arquitecto ya lo gasto,
  // al editor no se le ofrecen herramientas: antes las pedia igual, se
  // cortaba por tope y el turno terminaba con una respuesta vacia.
  const toolsNow = t.toolsOn && t.toolRoundsLeft > 0;
  opts = { ...opts, tools: toolsNow, execEnabled: t.execEnabled, native: toolsNow && nativeToolsFor(opts.model || t.model) };
  const focusText = `${extra.question || question}\n${extra.note || ""}`;
  // Arquitecto: archivo base (cacheado) + diff de lo que cambio. El resto
  // (editor / modo normal) recibe el codigo actual, enfocado si es grande.
  const useBase = kind === "arquitecto" && cfg().get("architectBaseCache") !== false;
  let baseFiles = null;
  const prepare = () => {
    if (!useBase) return focusFor(t, t.files, focusText);
    const pa = prepareArchitect(t.files, state.archBases);
    baseFiles = pa.base;
    return pa.files;
  };
  const contentsFor = (sent) => buildContents({ replyLang: t.replyLang, question: extra.question || question, files: sent, history: t.history, repoMapText: mapParts.text, repoMapCached: mapParts.cached, repoMapFocus: mapParts.focus, projectMemory: mapParts.memory, extraNote: extra.note, logs: state.logs, baseFiles });
  let sent = prepare();
  t.contextInfo[useBase ? "archFiles" : "files"] = describeFiles(sent);
  post({ type: "context", turnId, context: t.contextInfo });
  let contents = contentsFor(sent);
  let r = await toolLoop(t, await callModel(t, kind, contents, opts), contents, opts, sent);
  for (let round = 0; round < MAX_FILE_REQUEST_ROUNDS; round++) {
    const wanted = parseFileRequest(r.text, t.editFormat);
    if (!wanted) break;
    const added = [];
    for (const w of wanted) {
      if (!validatePath(w) && (await exists(w))) {
        state.chatFiles.add(path.posix.normalize(w));
        t.fullPaths.add(path.posix.normalize(w)); // si ya estaba como extracto, ahora va entero
        added.push(w);
      }
    }
    if (!added.length) {
      t.notes.push(L(`El modelo pidio ${wanted.join(", ")} pero esos archivos no existen.`, `The model asked for ${wanted.join(", ")} but those files don't exist.`));
      break;
    }
    post({ type: "info", turnId, text: L(`SovNode pidio ver: ${added.join(", ")} (agregados al chat)`, `SovNode asked to see: ${added.join(", ")} (added to the chat)`) });
    sendFilesUpdate();
    t.files = await loadContextFiles();
    sent = prepare();
    t.contextInfo[useBase ? "archFiles" : "files"] = describeFiles(sent);
    post({ type: "context", turnId, context: t.contextInfo });
    post({ type: "resetStream", turnId });
    t.phase = `llamada al modelo (pedido de archivos, ${kind})`;
    contents = contentsFor(sent);
    r = await toolLoop(t, await callModel(t, "pedido-archivos", contents, opts), contents, opts, sent);
  }
  return r;
}

// Arquitecto (planea) + editor (escribe), o una sola llamada.
async function askModel(t) {
  if (!t.architect) return askWithFiles(t, "principal", { note: t.opts.note }, {});
  const a = await askWithFiles(t, "arquitecto", { note: t.opts.note }, { systemPrompt: ARCHITECT_PROMPT });
  const planText = a.text.trim();
  if (/^SIN_CAMBIOS\b/.test(planText)) return { ...a, text: planText.replace(/^SIN_CAMBIOS\s*/, "") };
  // El arquitecto se salto las reglas y ya trajo bloques: se usan tal cual.
  if (hasEdits(planText, "search-replace")) return a;
  t.archPlan = planText;
  post({ type: "archPlan", turnId: t.turnId, text: t.archPlan });
  post({ type: "resetStream", turnId: t.turnId });
  return askWithFiles(t, "editor", {
    question: `Implementa el siguiente plan para este pedido del usuario: ${t.question}`,
    note: `${EDITOR_NOTE}\n\n${t.archPlan}`,
  }, { model: t.editModel });
}

// ---------------------------------------------------------------- fase: aplicar
// Aplicar bloques (multi-archivo, todo-o-nada), con 1 ronda de reparacion.
async function applyEdits(t) {
  const { turnId, editFormat } = t;
  const defaultPath = activeRelPath();
  let edits = parseEdits(t.finalText, editFormat, defaultPath);
  t.phase = "aplicando los bloques de edicion (plan)";
  let plan = await planChangeSet(edits, readRel, validatePath);
  for (let round = 0; !plan.ok && round < MAX_REPAIR_ROUNDS; round++) {
    const failedPaths = [...new Set(plan.failures.map((f) => f.path))];
    const current = [];
    for (const p of failedPaths) {
      const c = validatePath(p) ? null : await readRel(p);
      if (c !== null) current.push({ path: p, content: c, active: false });
    }
    const failureText = plan.failures.map((f) => describeFailure(f, editFormat)).join("\n");
    const repairHistory = [...t.history, { role: "user", content: t.question }, { role: "assistant", content: t.finalText }];
    post({ type: "resetStream", turnId });
    t.phase = "llamada al modelo (reparacion)";
    const rr = await callModel(t, "reparacion", buildContents({
      question: repairInstruction(editFormat),
      files: current.length ? current : t.files,
      history: repairHistory,
      repoMapText: "",
      extraNote: `Fallos:\n${failureText}`,
    }), { model: t.editModel });
    if (!hasEdits(rr.text, editFormat)) break;
    t.finalText = rr.text;
    edits = parseEdits(t.finalText, editFormat, defaultPath);
    plan = await planChangeSet(edits, readRel, validatePath);
  }

  // Formato "archivo completo": si un archivo quedo MUCHO mas corto, se
  // avisa (no se bloquea: borrar codigo puede ser justo lo pedido, y
  // /undo lo revierte entero) -- es la forma tipica en que un modelo
  // chico "pierde" medio archivo sin marcarlo como abreviado.
  if (plan.ok) {
    for (const f of plan.files) {
      if (f.created || f.before == null || !(f.changes || []).some((c) => c.kind === "rewrite")) continue;
      const b = f.before.split("\n").length;
      const a = f.after.split("\n").length;
      if (b >= 20 && a < b * 0.6) t.notes.push(L(`${f.path} quedo con ${a} lineas (antes ${b}). Si no pediste borrar tanto, revisalo o usa /undo.`, `${f.path} now has ${a} lines (was ${b}). If you didn't ask to delete that much, review it or use /undo.`));
    }
  }

  if (!plan.ok) {
    t.failures = plan.failures;
    t.resultLabel = "edits NO aplicados (ningun archivo fue modificado)";
    return;
  }
  if (!plan.files.length) {
    t.resultLabel = "sin cambios reales (lo propuesto es igual a lo que ya habia)";
    t.notes.push(L("La respuesta traia cambios, pero el resultado es identico al contenido actual: no se escribio nada.", "The response had changes, but the result is identical to the current content: nothing was written."));
    return;
  }

  // El snapshot de undo se guarda ANTES de escribir: si la escritura
  // falla a la mitad, se revierte lo que alcanzo a escribirse.
  const snapshot = { turnId, taskId: t.opts.taskId || null, files: plan.files.map((f) => ({ path: f.path, before: f.before, after: f.after, created: f.created })), commit: null };
  try {
    t.phase = "escribiendo archivos";
    await writeChangeSet(plan.files);
  } catch (e) {
    try { await restoreFiles(snapshot); } catch (_) { /* best effort */ }
    throw new Error(`Fallo al escribir los cambios (se revirtio lo escrito): ${e.message}`);
  }
  // Se apila YA, apenas los archivos estan escritos: si despues algo
  // falla o el usuario pulsa Detener (en la correccion por verificacion
  // o en el commit), los cambios quedan en disco y /undo tiene que
  // poder revertirlos. Antes se apilaba al final, y un error en el medio
  // dejaba cambios sin entrada de undo -- /undo revertia el turno ANTERIOR.
  // El objeto se sigue actualizando en el lugar (correcciones, commit).
  state.undoStack.push(snapshot);
  for (const f of plan.files) state.beforeStore.set(`${turnId}|${f.path}`, f.before || "");
  for (const f of plan.files) if (f.created) state.chatFiles.add(f.path);

  if (cfg().get("verify")) await verifyAndFix(t, plan, snapshot);
  await commitChanges(t, plan, snapshot);
  t.filesChanged = plan.files.map((f) => ({ path: f.path, created: f.created, tolerantCount: f.tolerantCount, changes: f.changes }));
  t.resultLabel = `${plan.files.length} archivo(s) cambiados`;

  t.phase = "abriendo el archivo cambiado";
  if (cfg().get("openChangedFiles")) {
    const first = plan.files[0];
    const line = Math.max(0, (first.changes[0] ? first.changes[0].line : 1) - 1);
    const doc = await vscode.workspace.openTextDocument(uriOf(first.path));
    await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true, selection: new vscode.Range(line, 0, line, 0) });
  }
}

// ---------------------------------------------------------------- fase: verificar
// Verificacion automatica (sintaxis por archivo + comando propio del
// proyecto si esta configurado), con reintentos de correccion ANTES del
// commit -- asi el commit de git siempre queda con la version que ya paso
// la verificacion, nunca con la rota a medias. Actualiza plan y snapshot en
// el lugar con lo que escriba cada correccion.
async function verifyAndFix(t, plan, snapshot) {
  const { turnId, editFormat } = t;
  let verifyRound = 0;
  let currentFiles = plan.files;
  while (verifyRound <= MAX_VERIFY_ROUNDS) {
    t.phase = "verificando cambios (sintaxis)";
    post({ type: "phase", turnId, text: L("Verificando que los archivos compilen...", "Checking that the files compile...") });
    const vres = await verify.verifyFiles(currentFiles.map((f) => ({ path: f.path, absPath: uriOf(f.path).fsPath })));
    for (const r of vres.results) if (r.skipped) log(`[verify] ${r.path}: sin verificador (${r.reason || "extension no soportada"})`);
    post({ type: "verifyResult", turnId, results: vres.results });

    let cmdFail = null;
    const verifyCmd = (cfg().get("verifyCommand") || "").trim();
    if (vres.ok && verifyCmd) {
      t.phase = "verificando cambios (comando del proyecto)";
      post({ type: "phase", turnId, text: L(`Corriendo "${verifyCmd}"...`, `Running "${verifyCmd}"...`) });
      const cmdRes = await verify.runProjectCommand(verifyCmd, workspaceRoot().fsPath, Number(cfg().get("verifyTimeoutMs")) || 60000);
      post({ type: "verifyCommand", turnId, command: verifyCmd, ok: cmdRes.ok, output: cmdRes.output });
      if (!cmdRes.ok) cmdFail = cmdRes;
    }

    if (vres.ok && !cmdFail) {
      if (verifyRound > 0) t.notes.push(L(`Verificacion OK despues de ${verifyRound} correccion(es) automatica(s).`, `Verification OK after ${verifyRound} automatic fix(es).`));
      return;
    }
    if (verifyRound >= MAX_VERIFY_ROUNDS) {
      t.verifyFailed = (vres.failures.length
        ? vres.failures.map((f) => `${f.path}: ${f.reason}`).join("\n")
        : `comando de verificacion "${verifyCmd}" fallo:\n${bugLogs.compressVerifyOutput(cmdFail.output)}`).slice(0, 1500);
      t.notes.push(L(`La verificacion sigue fallando tras ${MAX_VERIFY_ROUNDS} intento(s) de correccion automatica; los cambios quedan aplicados igual, revisalos a mano.`, `Verification still fails after ${MAX_VERIFY_ROUNDS} automatic fix attempt(s); the changes stay applied, review them by hand.`));
      return;
    }

    // Se le pasa el error real al modelo (igual que la ronda de
    // reparacion de SEARCH/REPLACE) para que corrija con nuevos
    // bloques -- todo o nada tambien aca.
    // Modo hibrido (v0.21.4): py_compile/node --check siguen siendo la
    // fuente de verdad (failures.length > 0 es lo que dispara esto);
    // el LSP solo agrega detalle extra del MISMO archivo cuando lo
    // tiene, nunca decide si hubo error o no.
    const lspExtra = vres.failures.map((f) => lspDiagnosticsFor(f.path)).filter(Boolean).join("\n");
    const failText = vres.failures.length
      ? vres.failures.map((f) => `- ${f.path}:\n${f.reason}`).join("\n\n") + (lspExtra ? `\n\nDiagnosticos del editor (Language Server) para el mismo archivo:\n${lspExtra}` : "")
      : `Comando de verificacion "${verifyCmd}" fallo (codigo de salida distinto de 0):\n${bugLogs.compressVerifyOutput(cmdFail.output)}`;
    const filesForFix = vres.failures.length
      ? currentFiles.filter((f) => vres.failures.some((x) => x.path === f.path)).map((f) => ({ path: f.path, content: f.after, active: false }))
      : currentFiles.map((f) => ({ path: f.path, content: f.after, active: false }));
    const fixHistory = [...t.history, { role: "user", content: t.question }, { role: "assistant", content: t.finalText }];
    post({ type: "resetStream", turnId });
    t.phase = "llamada al modelo (correccion por verificacion)";
    const fr = await callModel(t, "verificacion", buildContents({
      question: verifyFixInstruction(editFormat),
      files: filesForFix,
      history: fixHistory,
      repoMapText: "",
      extraNote: `Error de verificacion:
${failText}`,
    }), { model: t.editModel });
    if (!hasEdits(fr.text, editFormat)) { t.notes.push(L("La correccion automatica no trajo cambios de codigo; se deja como esta.", "The automatic fix brought no code changes; leaving it as is.")); return; }
    const fixEdits = parseEdits(fr.text, editFormat, activeRelPath());
    const fixPlan = await planChangeSet(fixEdits, readRel, validatePath);
    if (!fixPlan.ok || !fixPlan.files.length) { t.notes.push(L("La correccion automatica no se pudo aplicar; se deja como esta.", "The automatic fix could not be applied; leaving it as is.")); return; }
    t.phase = "escribiendo la correccion";
    await writeChangeSet(fixPlan.files);
    for (const f of fixPlan.files) {
      const idx = plan.files.findIndex((x) => x.path === f.path);
      if (idx !== -1) plan.files[idx].after = f.after;
      else plan.files.push(f); // la correccion toco un archivo NUEVO: tambien va al commit
      const sidx = snapshot.files.findIndex((x) => x.path === f.path);
      if (sidx !== -1) snapshot.files[sidx].after = f.after;
      else {
        // ...y al undo, con su contenido de ANTES de la correccion
        // (o "creado", para que /undo lo borre).
        snapshot.files.push({ path: f.path, before: f.before, after: f.after, created: f.created });
        state.beforeStore.set(`${turnId}|${f.path}`, f.before || "");
        if (f.created) state.chatFiles.add(f.path);
      }
    }
    t.finalText += `

(Correccion automatica aplicada tras verificar)

${fr.text}`;
    currentFiles = plan.files;
    verifyRound++;
  }
}

// ---------------------------------------------------------------- fase: commit
async function commitChanges(t, plan, snapshot) {
  t.phase = "commit de git";
  if (!cfg().get("autoCommit")) return;
  const cwd = workspaceRoot().fsPath;
  if (!(await gitUtil.isRepo(cwd))) return;
  try {
    const msg = `sovnode: ${t.question.replace(/\s+/g, " ").slice(0, 72)}`;
    snapshot.commit = await gitUtil.commitFiles(cwd, plan.files.map((f) => f.path), msg);
    t.notes.push(L(`Commit ${snapshot.commit.slice(0, 7)} creado (${msg}).`, `Commit ${snapshot.commit.slice(0, 7)} created (${msg}).`));
  } catch (e) {
    t.notes.push(L(`No se pudo hacer commit: ${e.message}`, `Could not commit: ${e.message}`));
  }
}

// ---------------------------------------------------------------- fase: cierre
// En el historial se guarda la respuesta SIN los bloques de edicion (ni el
// archivo entero, en formato "whole"): el contenido resultante ya se
// vuelve a mandar fresco en "files" la proxima vez que se toque ese
// archivo, asi que repetir el bloque/diff/archivo completo turno tras
// turno (mientras siga dentro de la ventana de maxHistoryTurns) es puro
// gasto de tokens de entrada, sin que el modelo pierda nada util -- lo
// que necesita para dar continuidad es la explicacion en prosa, no su
// propio parche viejo.
function rememberTurn(t) {
  const historyEdits = t.finalText ? parseEdits(t.finalText, t.editFormat, null) : [];
  const historyText = t.finalText ? stripEdits(t.finalText, historyEdits) : t.finalText;
  state.history.push({ role: "user", content: t.question }, { role: "assistant", content: historyText });
}

function reportTurnError(t, err) {
  const { turnId, phase } = t;
  const msg = String((err && err.message) || err);
  // v0.28.1: Detener NO es un error -- antes se mostraba como error rojo con
  // stack trace y abria el panel de Output, como si algo se hubiera roto.
  if (state.abort && state.abort.signal.aborted) {
    log(`[cancelado] turno #${turnId} (fase: ${phase})`);
    post({ type: "system", text: L("⏹ Detenido. Si este turno ya habia escrito algun archivo, podes deshacerlo con /undo.", "⏹ Stopped. If this turn had already written any file, you can revert it with /undo.") });
    t.resultLabel = "cancelado por el usuario";
    return;
  }
  const stack = `${(err && err.stack) || "(sin stack)"}\n\n--- contexto ---\nfase del turno: ${phase}\n${diagContext()}`;
  log(`[error] turno #${turnId} (fase: ${phase}): ${msg}\n${stack}`);
  rt.output.show(true);
  post({ type: "error", turnId, text: L(`${msg}  [fase: ${phase}]`, `${msg}  [phase: ${phase}]`), stack });
  t.resultLabel = `error en ${phase}: ${msg}`;
}

function finishTurn(t) {
  const { turnId, model, editModel, archPlan, finalText, filesChanged, failures, autoPlan } = t;
  state.session.turns += 1;
  state.session.usage = addUsage(state.session.usage, t.turnUsage);
  state.session.cost = addCost(state.session.cost, t.turnCost);

  const edits = parseEdits(finalText, t.editFormat, null);
  const turnRecord = {
    turnId, at: Date.now(), question: t.question, model, effort: t.effort,
    context: t.contextInfo || { files: [], repoMapChars: 0, historyMsgs: 0 },
    calls: t.calls, usage: t.turnUsage, cost: t.turnCost, result: t.resultLabel,
    filesChanged: filesChanged.map((f) => ({ path: f.path, created: f.created, changes: f.changes.map((c) => ({ kind: c.kind, line: c.line, removed: c.removed, added: c.added })) })),
    tools: t.toolStats.rounds ? { rounds: t.toolStats.rounds, requests: t.toolStats.requests, saved: t.toolSaved } : null,
  };
  logTurn(turnRecord);
  appendUsageLog(turnRecord);

  post({
    type: "turnEnd",
    turnId,
    prose: (archPlan ? L(`**Plan del arquitecto** (${model})\n\n${archPlan}\n\n---\n\n**Editor** (${editModel})\n\n`, `**Architect plan** (${model})\n\n${archPlan}\n\n---\n\n**Editor** (${editModel})\n\n`) : "") + (finalText ? stripEdits(finalText, edits) : ""),
    filesChanged,
    failures,
    notes: t.notes,
    usage: t.turnUsage,
    cost: t.turnCost,
    calls: t.calls,
    session: state.session,
  });
  sendFilesUpdate();
  const isError = /^error en /.test(t.resultLabel);
  state.lastTurnFailed = isError || failures.length > 0 || Boolean(t.verifyFailed);
  return {
    resultLabel: t.resultLabel, failures, filesChanged, verifyFailed: t.verifyFailed, turnId, isError,
    auto: autoPlan ? { tiers: autoPlan.tiers, level: autoPlan.route.level, usedModel: autoPlan.architect ? autoPlan.editModel : autoPlan.model } : null,
  };
}

module.exports = { runTurn, runTurnInner, parseFileRequest, MAX_FILE_REQUEST_ROUNDS };
