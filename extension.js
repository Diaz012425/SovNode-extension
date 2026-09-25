"use strict";

const vscode = require("vscode");
const path = require("path");
const { streamGemini, buildContents, pingGemini, systemPromptFor, ARCHITECT_PROMPT, EDITOR_NOTE, taskPlanPrompt } = require("./gemini");
const { providerForModel, callProvider, pingProvider, PROVIDER_LABEL } = require("./providers");
const verify = require("./verify");
const bugLogs = require("./logs");
const { planFocus, renderFocused } = require("./focus");
const { prepareArchitect } = require("./archBase");
const { parseToolRequest, runTools, newToolSession, roundsFor, toolsPrompt, nativeToolDefs, nativeToolsPrompt, toolCallToReq, MAX_REQUESTS_PER_ROUND } = require("./tools");
const execTool = require("./execTool");
const { planChangeSet } = require("./editEngine");
const editFormats = require("./editFormats");
const { parseEdits, hasEdits, stripEdits, resolveEditFormat, repairInstruction, verifyFixInstruction, describeFailure, FORMAT_LABEL } = editFormats;
const { buildRepoMap, renderRepoMap, renderFocusMap, extractFocusNames } = require("./repoMap");
const treesitter = require("./treesitter");
const { computeCost, addUsage, addCost, fmtUsd, priceFor } = require("./pricing");
const router = require("./router");
const i18n = require("./i18n");
const { L } = i18n;
const gitUtil = require("./git");

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

// Multi-proveedor (v0.11, como Aider): el nombre del modelo decide el
// proveedor (providerForModel en providers.js), asi que cada uno necesita su
// propia API key -- se guardan por separado en el almacen de secretos de VS
// Code, una entrada por proveedor. LEGACY_GEMINI_KEY es la clave vieja de
// antes de esta version (una sola key, siempre Gemini); se sigue leyendo
// como fallback para no romper a nadie que ya tenia la suya guardada, pero
// las keys nuevas (de cualquier proveedor, Gemini incluido) se guardan bajo
// SECRET_KEY_FOR(provider).
const LEGACY_GEMINI_KEY = "sovnodeAider.geminiApiKey";
const SECRET_KEY_FOR = (provider) => `sovnodeAider.apiKey.${provider}`;
async function apiKeyFor(provider) {
  const k = await extContext.secrets.get(SECRET_KEY_FOR(provider));
  if (k) return k;
  if (provider === "gemini") return extContext.secrets.get(LEGACY_GEMINI_KEY);
  return undefined;
}

// Revisa que TODOS los modelos de la lista (tipicamente [model, editModel])
// tengan API key para su proveedor. Devuelve el nombre del proveedor que
// falta (para el mensaje de error) o null si esta todo bien -- se llama una
// sola vez al arrancar un turno/tarea en vez de fallar a mitad de camino.
async function missingApiKeyFor(models) {
  // "auto" (v0.27): solo falta algo si no hay NINGUNA key (Auto elige entre
  // los modelos con key).
  if (models.includes(AUTO)) {
    if (!(await autoTiers())) return "algun proveedor (Gemini, OpenAI o Anthropic)";
    models = models.filter((m) => m !== AUTO);
  }
  const providers = [...new Set(models.map(providerForModel))];
  for (const p of providers) if (!(await apiKeyFor(p))) return PROVIDER_LABEL[p];
  return null;
}

// ---------------------------------------------------------------- modo Auto (v0.27)
const AUTO = "auto";
const isAuto = () => cfg().get("model") === AUTO;
// Niveles barato/medio/fuerte entre los modelos con API key (ver router.js).
async function autoTiers() {
  const overrides = cfg().get("pricing");
  const has = {};
  for (const p of ["gemini", "openai", "anthropic"]) has[p] = Boolean(await apiKeyFor(p));
  const available = (m) => { try { return has[providerForModel(m)]; } catch (_) { return false; } };
  return router.pickTiers(MODEL_CHOICES.map((model) => ({ model, price: priceFor(model, overrides) })), available, cfg().get("autoModels") || {});
}

// Punto de entrada unico a cualquier modelo, de cualquier proveedor: resuelve
// el proveedor por el nombre del modelo (providerForModel) y su API key, y
// devuelve siempre la misma forma de resultado (text/thoughts/usage/...) sin
// importar si vino de Gemini, OpenAI o Anthropic. Gemini sigue yendo directo
// a gemini.js (streamGemini) -- es el camino original, ya probado a fondo
// por el harness, y no hacia falta pasarlo por el dispatcher generico.
async function callLLM(opts) {
  const provider = providerForModel(opts.model);
  const apiKey = await apiKeyFor(provider);
  if (!apiKey) throw new Error(`Falta la API key de ${PROVIDER_LABEL[provider]}.`);
  // "Extended thinking" de Anthropic (v0.17, ver providers.js): antes nunca
  // se activaba, asi que Claude respondia sin la fase de razonamiento previo
  // que si tienen Gemini/OpenAI segun el effort. Solo en high/extra (cuesta
  // tokens de mas) y solo Anthropic (los otros dos ya piensan por su cuenta).
  const thinkingEnabled = provider === "anthropic" && (opts.effort === "high" || opts.effort === "extra") && cfg().get("extendedThinking") !== false;
  const adaptiveThinking = provider === "anthropic" && state.thinkingAdaptive.has(opts.model);
  const args = { ...opts, apiKey, thinkingEnabled, adaptiveThinking };
  return provider === "gemini" ? streamGemini(args) : callProvider(provider, args);
}
const BEFORE_SCHEME = "sovnode-before";
const MAX_FILE_REQUEST_ROUNDS = 2; // NECESITO_ARCHIVOS -> se agregan y se vuelve a preguntar
const MAX_REPAIR_ROUNDS = 1; // igual que MAX_EDIT_REPAIR_ROUNDS en app_en.py
const MAX_VERIFY_ROUNDS = 2; // reintentos de auto-correccion cuando la verificacion falla
// Aviso de modelo caro (v0.20.2): un turno normal con un modelo de output
// arriba de este precio (Sonnet $10, Opus $20 por M) sale varias veces mas
// caro que con un flash barato (Gemini 3.6 $3.75, GPT-6 Luna $0.50) haciendo
// el mismo trabajo -- el ahorro de contexto/cache ayuda pero no cambia esa
// proporcion. Es solo un aviso (una vez por modelo por sesion de VS Code),
// no bloquea nada: el usuario puede elegir el modelo caro a proposito.
const EXPENSIVE_OUTPUT_PRICE = 8; // USD por millon de tokens de salida
function warnIfExpensive(models, pricingOverrides) {
  for (const m of new Set((models || []).filter(Boolean))) {
    if (state.warnedExpensiveModels.has(m)) continue;
    const price = priceFor(m, pricingOverrides);
    if (!price || price.output < EXPENSIVE_OUTPUT_PRICE) continue;
    state.warnedExpensiveModels.add(m);
    post({
      type: "system",
      text: L(`⚠️ Modelo caro activo: ${m} ($${price.output.toFixed(2)}/M tok de salida). Los turnos con este modelo pueden salir varias veces mas caros que con un modelo flash barato haciendo el mismo trabajo. Este aviso no se repite en lo que queda de esta sesion de VS Code.`, `⚠️ Expensive model active: ${m} ($${price.output.toFixed(2)}/M output tok). Turns with this model can cost several times more than a cheap flash model doing the same work. This warning won't repeat for the rest of this VS Code session.`),
    });
  }
}
// Un grupo de modelos por proveedor -- el selector del webview los muestra
// todos juntos (con <optgroup>, ver renderModelChoices en chat.js), pero
// mezclarlos entre modelo principal y editor del modo arquitecto funciona
// perfecto: cada llamada resuelve su propio proveedor y su propia API key.
// gemini-2.5-flash sacado del selector (v0.20.2): Google la dio de baja para
// cuentas nuevas (HTTP 404 "no longer available to new users", visto en un
// turno real de un usuario). gemini-2.5-pro sigue -- no dio ese error.
const MODEL_CHOICES_GEMINI = ["gemini-3.6-flash", "gemini-3.8-flash", "gemini-3.5-flash", "gemini-3.1-flash-lite", "gemini-3.1-pro-preview", "gemini-2.5-pro"];
const MODEL_CHOICES_OPENAI = ["gpt-6-sol", "gpt-6-astra", "gpt-6-luna"];
const MODEL_CHOICES_ANTHROPIC = ["claude-sonnet-5", "claude-opus-5-5", "claude-haiku-4-5-20251001"];
const MODEL_CHOICES = [...MODEL_CHOICES_GEMINI, ...MODEL_CHOICES_OPENAI, ...MODEL_CHOICES_ANTHROPIC];

// ---------------------------------------------------------------- estado
const state = {
  history: [], // [{role, content}]
  chatFiles: new Set(), // rutas relativas agregadas con /add o por NECESITO_ARCHIVOS
  archBases: new Map(), // ruta -> contenido "base" que ya vio el arquitecto (archBase.js)
  trustedExecCmds: new Set(), // comandos exactos que el usuario aprobo "para toda la sesion" (ver runExecCommand)
  lastTurnFailed: false, // senal para el modo Auto (v0.27)
  nativeToolsOff: new Set(), // modelos que rechazaron las herramientas nativas (v0.25): texto el resto de la sesion
  thinkingAdaptive: new Set(), // modelos que exigen thinking.type "adaptive" + output_config.effort en vez de "enabled"+budget_tokens (v0.29.3)
  warnedExpensiveModels: new Set(), // modelos caros ya avisados esta sesion de VS Code (ver warnIfExpensive)
  logs: [], // logs de bugs adjuntos (🐞 / /bug): [{label, text, chars, ...}], ver logs.js
  undoStack: [], // [{turnId, files:[{path, before, created}], commit}]
  beforeStore: new Map(), // "turnId|path" -> contenido previo (para "Ver diff")
  session: { turns: 0, usage: {}, cost: {} },
  busy: false,
  abort: null,
  turnCounter: 0,
  taskCounter: 0,
  lastEditor: null,
};

let view = null;
let output = null;
let extContext = null;
let repoMapCache = null;
let repoMapBuilding = null;

function cfg() {
  return vscode.workspace.getConfiguration("sovnodeAider");
}

function workspaceRoot() {
  const f = vscode.workspace.workspaceFolders;
  return f && f.length ? f[0].uri : null;
}

function log(line) {
  if (output) output.appendLine(line);
}

// Datos del entorno que suelen explicar un error: version de VS Code/Node,
// si el depurador (F5) esta activo, proxy, carpetas abiertas, config.
function diagContext() {
  let inspectorOn = false;
  try { inspectorOn = Boolean(require("inspector").url()); } catch (_) { /* sin inspector */ }
  const folders = vscode.workspace.workspaceFolders || [];
  const proxy = vscode.workspace.getConfiguration("http").get("proxy") || process.env.HTTPS_PROXY || process.env.https_proxy || "(ninguno)";
  return [
    `extension: sovnode-aider ${(extContext && extContext.extension && extContext.extension.packageJSON.version) || "?"}`,
    `VS Code ${vscode.version} · Node ${process.versions.node} · Electron ${process.versions.electron || "-"} · ${process.platform}/${process.arch}`,
    `depurador (F5) activo: ${inspectorOn ? "si" : "no"}`,
    `proxy: ${proxy}`,
    `carpetas abiertas: ${folders.length}${folders.length > 1 ? " (multi-root: SovNode usa solo la primera)" : ""}`,
    `log de esta sesion: ${sessionLogUri ? sessionLogUri.fsPath : "(sin crear todavia)"}`,
    `modelo: ${cfg().get("model")} · effort: ${cfg().get("effort")} · streaming: ${cfg().get("streaming")} · autoCommit: ${cfg().get("autoCommit")}`,
  ].join("\n");
}

// Mapa del repo cacheable (v0.21). Antes el mapa iba DENTRO del mensaje final
// (archivos + pedido, distinto cada turno), y encima ordenado segun lo que
// nombraba la pregunta y con "linea N" que cambia con cada edicion: nunca era
// texto identico, nunca se cacheaba, se pagaba entero en cada llamada.
// Ahora: mapa estable (sin lineas, sin orden por pedido) en su propio bloque
// al principio -> cache; y lo que depende del pedido (simbolos nombrados, con
// su linea actual) va chiquito en el mensaje final.
// sovnodeAider.repoMapCache=false vuelve al modo viejo.
// Memoria del proyecto (v0.22.0): archivo que escribe EL USUARIO
// (.sovnode/memoria.md) con convenciones, decisiones y "no toques X". Se lee
// cada turno y va como PRIMER par [user][model] del pedido: es lo que menos
// cambia, asi que queda al principio del prefijo cacheable (antes de la base
// del arquitecto y del mapa). Sin archivo = costo cero. No lleva ancla
// propia de Anthropic (ya hay 4: system/base/mapa/historial); queda cubierta
// por la siguiente ancla que haya. El modelo NO la edita solo: una edicion por
// turno romperia el cache de todo lo que viene despues (misma leccion que
// v0.21.1/v0.21.2). Tope de tamano para que no se coma el presupuesto.
const PROJECT_MEMORY_REL = ".sovnode/memoria.md";
const PROJECT_MEMORY_MAX_CHARS = 6000;
const PROJECT_MEMORY_TEMPLATE = `# Memoria del proyecto
<!-- SovNode manda este archivo en CADA pedido (es barato: va cacheado, pero no es gratis).
     Mantenelo corto: solo lo que el modelo no puede deducir leyendo el codigo.
     Borra estos comentarios y los ejemplos que no apliquen. Archivo vacio = no se manda nada. -->

## Convenciones
- 

## Decisiones tomadas (y por que)
- 

## No tocar / cuidado con
- 
`;
function projectMemoryText() {
  if (cfg().get("projectMemory") === false) return "";
  const root = workspaceRoot();
  if (!root || root.scheme !== "file") return "";
  let raw;
  try {
    raw = require("fs").readFileSync(require("path").join(root.fsPath, PROJECT_MEMORY_REL), "utf8");
  } catch (_) {
    return "";
  }
  // sin comentarios HTML ni lineas-plantilla vacias ("- "): la plantilla recien
  // creada sin completar no cuesta nada
  const body = raw.replace(/<!--[\s\S]*?-->/g, "").split("\n").filter((l) => !/^\s*-\s*$/.test(l)).join("\n").trim();
  if (!body.replace(/^#.*$/gm, "").trim()) return "";
  const clipped = body.length > PROJECT_MEMORY_MAX_CHARS ? body.slice(0, PROJECT_MEMORY_MAX_CHARS) + "\n[...memoria recortada: el archivo supera el tope; acortalo]" : body;
  return `MEMORIA DEL PROYECTO (notas del usuario sobre este repo: convenciones, decisiones y restricciones. Respetalas; si un pedido las contradice, avisalo):\n\n${clipped}`;
}

async function openProjectMemory() {
  const root = workspaceRoot();
  if (!root) {
    vscode.window.showWarningMessage(L("SovNode: abri una carpeta primero.", "SovNode: open a folder first."));
    return;
  }
  const uri = vscode.Uri.joinPath(root, ...PROJECT_MEMORY_REL.split("/"));
  try {
    await vscode.workspace.fs.stat(uri);
  } catch (_) {
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(root, ".sovnode"));
    await vscode.workspace.fs.writeFile(uri, Buffer.from(PROJECT_MEMORY_TEMPLATE, "utf8"));
  }
  await vscode.window.showTextDocument(uri);
}

function repoMapParts(map, question) {
  const focusNames = extractFocusNames(question, map);
  if (cfg().get("repoMapCache") === false) {
    const personalize = contextPaths().map((f) => f.path);
    return { text: renderRepoMap(map, focusNames, undefined, undefined, personalize), cached: "", focus: "", memory: projectMemoryText() };
  }
  // OJO: el bloque "cached" NUNCA debe recibir personalizeFiles (contextPaths,
  // los archivos que estan en el chat ahora mismo). Un bug de la v0.21.0 lo
  // personalizaba igual que el modo viejo -- eso reordena el mapa (PageRank
  // distinto) cada vez que agregas/sacas un archivo del chat, que es
  // MUCHISIMO mas seguido que un cambio real de codigo. Rompia el "prefijo
  // identico" a cada rato, y como el mapa va ANTES del historial, romperlo
  // tambien forzaba reescribir el ancla de historial -- Anthropic cobra la
  // reescritura de cache a 1.25x en vez de leerla a 0.1x, asi que cada
  // agregado de archivo terminaba costando MAS que si esto no existiera.
  // Sin personalizar, el orden depende solo del mapa (estable mientras no
  // cambies codigo de verdad), que es justo la garantia que se buscaba.
  return {
    text: "",
    cached: renderRepoMap(map, [], undefined, undefined, undefined, { noLines: true }),
    memory: projectMemoryText(),
    focus: renderFocusMap(map, focusNames),
  };
}

function post(msg) {
  if (view) view.webview.postMessage(msg);
}

// ---------------------------------------------------------------- repo map
// repoMapGen sube con cada cambio de archivos: si un archivo cambia MIENTRAS
// se construye el mapa, ese resultado ya nace viejo y no se guarda en cache.
let repoMapGen = 0;
async function getRepoMap() {
  if (repoMapCache) return repoMapCache.map;
  const gen = repoMapGen;
  if (!repoMapBuilding) repoMapBuilding = buildRepoMap().finally(() => (repoMapBuilding = null));
  const map = await repoMapBuilding;
  if (gen === repoMapGen) repoMapCache = { map }; // envuelto: un mapa null (sin codigo) tambien se cachea
  return map;
}

// ---------------------------------------------------------------- archivos
function activeEditor() {
  const ed = vscode.window.activeTextEditor || state.lastEditor;
  if (!ed || ed.document.isClosed) return null;
  if (!["file", "untitled"].includes(ed.document.uri.scheme)) return null;
  return ed;
}

function relPathOf(uri) {
  return vscode.workspace.asRelativePath(uri, false).replace(/\\/g, "/");
}

function activeRelPath() {
  const ed = activeEditor();
  if (!ed || ed.document.uri.scheme !== "file") return null;
  const root = workspaceRoot();
  if (!root) return null;
  const rel = relPathOf(ed.document.uri);
  return path.isAbsolute(rel) ? null : rel; // fuera del workspace
}

// Rutas que el modelo puede tocar: relativas, dentro del proyecto, y nunca
// dentro de .git/ ni node_modules/.
function validatePath(rel) {
  if (!rel) return "Ruta vacia.";
  // Backslashes a "/" ANTES de validar: si no, "src\..\..\Users\x" pasaba el
  // chequeo de ".." (que solo miraba "/") y en Windows salia del proyecto.
  rel = String(rel).replace(/\\/g, "/");
  if (/^[a-zA-Z]:/.test(rel) || rel.startsWith("/") || rel.includes(":")) return `Ruta absoluta no permitida: ${rel} (usa rutas relativas al proyecto).`;
  const norm = path.posix.normalize(rel);
  if (norm.startsWith("..")) return `La ruta ${rel} sale de la carpeta del proyecto.`;
  // Comparacion por segmento, en minusculas y sin puntos/espacios finales:
  // en Windows y macOS el disco no distingue mayusculas (".GIT" ES ".git"), y
  // Win32 ademas ignora puntos y espacios al final (".git." y ".git " abren
  // ".git"). Sin esto, el modelo podia escribir en .GIT/hooks/pre-commit y
  // ejecutar codigo en el proximo commit.
  const segs = norm.toLowerCase().split("/").map((s) => s.replace(/[. ]+$/, ""));
  if (segs.some((s) => s === ".git" || s === "node_modules")) return `No se permite escribir en ${rel}.`;
  return null;
}

function uriOf(rel) {
  return vscode.Uri.joinPath(workspaceRoot(), path.posix.normalize(String(rel).replace(/\\/g, "/")));
}

// Lee el contenido ACTUAL siempre a traves de VS Code (openTextDocument), no
// leyendo bytes y asumiendo UTF-8: asi un archivo en Windows-1252/Latin-1
// (comun en Windows en español) o con BOM se lee con la MISMA decodificacion
// con la que despues se escribe. Leerlo como UTF-8 a mano convertia cada "ñ"
// en "�" y al guardar se destruian todos los acentos del archivo.
// Tambien respeta cambios sin guardar. null = no existe.
async function readRel(rel) {
  const uri = uriOf(rel);
  try {
    await vscode.workspace.fs.stat(uri);
  } catch (_) {
    return null;
  }
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    return doc.getText();
  } catch (e) {
    throw new Error(`No se pudo abrir ${rel} como texto (¿es binario o muy grande?): ${e.message}`);
  }
}

async function exists(rel) {
  try {
    await vscode.workspace.fs.stat(uriOf(rel));
    return true;
  } catch (_) {
    return false;
  }
}

function contextPaths() {
  const list = [];
  const active = cfg().get("includeActiveFile") ? activeRelPath() : null;
  if (active) list.push({ path: active, active: true });
  for (const p of state.chatFiles) if (p !== active) list.push({ path: p, active: false });
  return list;
}

async function loadContextFiles() {
  const out = [];
  for (const f of contextPaths()) {
    const content = await readRel(f.path);
    if (content === null) {
      state.chatFiles.delete(f.path);
      continue;
    }
    out.push({ ...f, content });
  }
  return out;
}

// Seleccion del editor activo (1-based), o null si no hay.
function currentSelection() {
  const ed = vscode.window.activeTextEditor;
  if (!ed || !ed.selection || ed.selection.isEmpty) return null;
  return { start: ed.selection.start.line + 1, end: ed.selection.end.line + 1 };
}

// Reemplaza los archivos grandes por un extracto de las partes relevantes
// (focus.js). No se enfoca nunca con formato "archivo completo" (el modelo
// reescribiria el archivo solo con lo que vio) ni los que el modelo pidio
// ver enteros. El extracto va en f.rendered; f.content queda intacto.
function applyFocus(files, text, map, fullPaths, selection, editFormat) {
  const minLines = Math.max(0, Math.floor(Number(cfg().get("focusLargeFiles")) || 0));
  if (!minLines || editFormat === "whole") return files;
  const logText = state.logs.map((l) => l.text).join("\n");
  return files.map((f) => {
    if (fullPaths.has(f.path)) return f;
    const entry = map && map.entries ? map.entries.find((e) => e.relPath === f.path) : null;
    const plan = planFocus(f.content, {
      relPath: f.path, symbols: entry ? entry.symbols : [], text, logText,
      selection: f.active ? selection : null, minLines,
    });
    if (!plan.focused) return f;
    return { ...f, rendered: renderFocused(f.path, f.content, plan, f.active), focus: { shown: plan.shownLines, total: plan.totalLines, reasons: plan.reasons, ranges: plan.ranges } };
  });
}

function sendFilesUpdate() {
  post({ type: "files", files: contextPaths() });
}

// ---------------------------------------------------------------- escritura
async function writeChangeSet(files) {
  const we = new vscode.WorkspaceEdit();
  const toSave = [];
  for (const f of files) {
    const uri = uriOf(f.path);
    if (f.created) {
      const parent = vscode.Uri.joinPath(uri, "..");
      await vscode.workspace.fs.createDirectory(parent);
      await vscode.workspace.fs.writeFile(uri, Buffer.from(f.after, "utf8"));
    } else {
      const doc = await vscode.workspace.openTextDocument(uri);
      we.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), f.after);
      toSave.push(doc);
    }
  }
  if (toSave.length) {
    const ok = await vscode.workspace.applyEdit(we);
    if (!ok) throw new Error("VS Code rechazo el WorkspaceEdit (¿archivo de solo lectura?).");
    for (const doc of toSave) {
      if (!(await doc.save())) throw new Error(`No se pudo guardar ${relPathOf(doc.uri)} (¿solo lectura o bloqueado por otro programa?).`);
    }
  }
}

// Texto actual de un archivo tal como lo ve VS Code (null si no existe).
async function currentText(rel) {
  return readRel(rel);
}

// Restaura a traves de un documento abierto (misma codificacion/BOM que el
// original, ver readRel) en vez de escribir bytes UTF-8 a mano.
async function restoreFiles(snapshot) {
  for (const f of snapshot.files) {
    const uri = uriOf(f.path);
    if (f.created) {
      try { await vscode.workspace.fs.delete(uri, { useTrash: true }); } catch (_) { /* ya no existe */ }
      continue;
    }
    const doc = await vscode.workspace.openTextDocument(uri);
    const we = new vscode.WorkspaceEdit();
    we.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), f.before);
    if (!(await vscode.workspace.applyEdit(we))) throw new Error(`No se pudo restaurar ${f.path}.`);
    await doc.save();
  }
}

// ---------------------------------------------------------------- costos / logs
function usageLogUri() {
  return vscode.Uri.joinPath(extContext.globalStorageUri, "usage.jsonl");
}

// Escrituras en cola (una a la vez): dos read-modify-write simultaneos
// perdian registros.
let usageLogQueue = Promise.resolve();
function appendUsageLog(record) {
  usageLogQueue = usageLogQueue.then(async () => {
    try {
      await vscode.workspace.fs.createDirectory(extContext.globalStorageUri);
      const uri = usageLogUri();
      let prev = "";
      try { prev = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8"); } catch (_) { /* primer registro */ }
      await vscode.workspace.fs.writeFile(uri, Buffer.from(prev + JSON.stringify(record) + "\n", "utf8"));
    } catch (e) {
      log(`[warn] no se pudo escribir usage.jsonl: ${e.message}`);
    }
  });
  return usageLogQueue;
}

// Log de sesion (v0.19): usage.jsonl acumula PARA SIEMPRE (todas las
// sesiones de VS Code, resumido a lo justo para el costo). Esto es lo
// opuesto: un archivo por sesion (desde que se abre esta ventana de VS Code
// hasta que se cierra), con el detalle COMPLETO que antes solo se veia en el
// panel "SovNode" del Output y se perdia al cerrar VS Code (rondas de
// herramientas, ahorro por foco/base del arquitecto, etc). Sirve para mirar
// despues que paso en una sesion sin haber dejado el panel abierto.
let sessionLogUri = null;
function sessionLogDir() {
  return vscode.Uri.joinPath(extContext.globalStorageUri, "sessions");
}
// Nombre ordenable y sin caracteres invalidos en ningun SO (":" en Windows).
function initSessionLog() {
  const iso = new Date().toISOString().replace(/[:.]/g, "-");
  sessionLogUri = vscode.Uri.joinPath(sessionLogDir(), `session-${iso}.log`);
  const header = [
    `SovNode -- log de esta sesion de VS Code (desde que se abrio esta ventana hasta que se cierre)`,
    diagContext(),
    `inicio: ${new Date().toLocaleString()}`,
    "",
  ].join("\n");
  sessionLogQueue = (async () => {
    try {
      await vscode.workspace.fs.createDirectory(sessionLogDir());
      await vscode.workspace.fs.writeFile(sessionLogUri, Buffer.from(header, "utf8"));
      await pruneOldSessionLogs();
    } catch (e) { log(`[warn] no se pudo crear el log de sesion: ${e.message}`); }
  })();
  return sessionLogQueue;
}
// No se acumulan para siempre (a diferencia de usage.jsonl, que es 1 linea
// por turno y pesa poco): se quedan los ultimos N archivos de sesion.
async function pruneOldSessionLogs() {
  const keep = Math.max(0, Math.floor(Number(cfg().get("sessionLogKeep")) || 0));
  if (!keep) return;
  try {
    const entries = (await vscode.workspace.fs.readDirectory(sessionLogDir())).filter(([n]) => /^session-.*\.log$/.test(n)).sort((a, b) => (a[0] < b[0] ? 1 : -1));
    for (const [name] of entries.slice(keep)) {
      try { await vscode.workspace.fs.delete(vscode.Uri.joinPath(sessionLogDir(), name)); } catch (_) { /* no crítico */ }
    }
  } catch (_) { /* carpeta recien creada, sin entradas */ }
}
let sessionLogQueue = Promise.resolve();
function appendSessionLog(text) {
  sessionLogQueue = sessionLogQueue.then(async () => {
    if (!sessionLogUri) return;
    try {
      let prev = "";
      try { prev = Buffer.from(await vscode.workspace.fs.readFile(sessionLogUri)).toString("utf8"); } catch (_) { /* se perdio el archivo (el usuario lo borro a mano): se sigue igual */ }
      await vscode.workspace.fs.writeFile(sessionLogUri, Buffer.from(prev + text, "utf8"));
    } catch (e) { log(`[warn] no se pudo escribir el log de sesion: ${e.message}`); }
  });
  return sessionLogQueue;
}

function logTurn(turn) {
  const L = [];
  L.push("");
  L.push(`===== Turno #${turn.turnId}  ${new Date(turn.at).toLocaleString()} =====`);
  L.push(`Pedido: ${turn.question.slice(0, 200)}`);
  L.push(`Modelo: ${turn.model}   Effort: ${turn.effort}`);
  L.push(`Contexto enviado: ${turn.context.files.length} archivo(s) [${turn.context.files.map((f) => `${f.path} ${f.chars}c`).join(", ") || "-"}], mapa ${turn.context.repoMapChars}c, historial ${turn.context.historyMsgs} msgs`);
  for (const c of turn.calls) {
    L.push(`  - llamada ${c.kind}: in ${c.usage.promptTokens} (cache ${c.usage.cachedTokens}) | out ${c.usage.outputTokens} | razonamiento ${c.usage.thoughtTokens} | ${c.latencyMs} ms (1er token ${c.firstTokenMs ?? "-"} ms) | fin ${c.finishReason} | ${fmtUsd(c.cost.totalUsd)}`);
  }
  const k = turn.cost;
  L.push(`  Costo turno: input ${fmtUsd(k.inputUsd)} + cache ${fmtUsd(k.cachedUsd)} + output ${fmtUsd(k.outputUsd)} + razonamiento ${fmtUsd(k.thoughtUsd)} = ${fmtUsd(k.totalUsd)}  (ahorro por cache ${fmtUsd(k.savedByCacheUsd)})`);
  if (turn.tools) L.push(`  Herramientas: ${turn.tools.rounds} ronda(s), ${turn.tools.requests} pedido(s), ~${turn.tools.saved} car. no reenviados`);
  L.push(`  Resultado: ${turn.result}`);
  for (const f of turn.filesChanged) L.push(`    * ${f.created ? "CREADO" : "EDITADO"} ${f.path}: ${f.changes.map((c) => `L${c.line} -${c.removed}/+${c.added}`).join(", ")}`);
  L.push(`  Sesion: ${state.session.turns} turnos, ${fmtUsd(state.session.cost.totalUsd)}`);
  for (const l of L) log(l);
  appendSessionLog(L.join("\n") + "\n");
}

// ---------------------------------------------------------------- turno
function parseFileRequest(text, format) {
  if (hasEdits(text, format)) return null;
  const m = /^\s*NECESITO_ARCHIVOS\s*:\s*(.+)$/m.exec(text || "");
  if (!m) return null;
  // Separado solo por comas: una ruta puede tener espacios ("base de dooom.py").
  return m[1].split(",").map((s) => s.replace(/[`"'*]/g, "").trim()).filter(Boolean);
}

// Ejecutar un comando pedido por el modelo a mitad de un turno (v0.20): la
// validacion "dura" (sintaxis, denylist) vive en execTool.js; aca solo la
// parte que SI necesita vscode -- pedir confirmacion, correr el proceso,
// devolver texto listo para el modelo. Nunca con shell:true (se corre el
// argv ya tokenizado) y nunca fuera de la carpeta del proyecto.
async function runExecCommand(cmd, turnId) {
  const v = execTool.validateCommand(cmd);
  if (!v.ok) {
    post({ type: "info", turnId, text: L(`SovNode rechazo un comando (${v.reason}): ${cmd}`, `SovNode rejected a command (${v.reason}): ${cmd}`) });
    return execTool.formatResult(cmd, { blocked: true, error: v.reason });
  }
  const root = workspaceRoot();
  if (!root) return execTool.formatResult(cmd, { denied: true, error: "no hay carpeta de proyecto abierta" });
  const allowlist = cfg().get("execAllowlist") || [];
  let approved = state.trustedExecCmds.has(v.cmd) || execTool.matchesAllowlist(v.cmd, allowlist);
  if (!approved) {
    const CONFIAR = L("Ejecutar (confiar el resto de la sesion)", "Run (trust for the rest of the session)");
    const EJECUTAR = L("Ejecutar", "Run");
    const pick = await vscode.window.showWarningMessage(
      L(`SovNode quiere ejecutar en tu proyecto:
${v.cmd}

¿Lo autorizas?`, `SovNode wants to run in your project:
${v.cmd}

Allow it?`),
      { modal: true },
      EJECUTAR, CONFIAR, "No",
    );
    if (pick === CONFIAR) { state.trustedExecCmds.add(v.cmd); approved = true; }
    else if (pick === EJECUTAR) approved = true;
  }
  if (!approved) {
    post({ type: "info", turnId, text: L(`Rechazaste ejecutar: ${v.cmd}`, `You declined to run: ${v.cmd}`) });
    return execTool.formatResult(v.cmd, { denied: true });
  }
  post({ type: "info", turnId, text: L(`Ejecutando: ${v.cmd}`, `Running: ${v.cmd}`) });
  const timeoutMs = execTool.timeoutMsFor(cfg().get("execTimeoutMs"));
  const [command, ...args] = v.argv;
  // Senial del turno actual (Detener) capturada ANTES del await: si por lo
  // que sea state.abort cambiara mientras el comando corre, seguimos
  // escuchando la que correspondia cuando arranco este comando puntual.
  const abortSignal = state.abort && state.abort.signal;
  const r = await new Promise((resolve) => {
    let child;
    try {
      // shell:false SIEMPRE: v.argv ya viene tokenizado a mano y sin
      // metacaracteres (execTool.validateCommand los rechazo antes) -- correr
      // esto con una shell de por medio reabriria la puerta que se cerro ahi.
      // detached:true (v0.21.3, POSIX): el proceso queda como lider de su
      // propio grupo -- necesario para que execTool.killProcessTree() pueda
      // matar TODO el arbol (el proceso y lo que este haya lanzado) en vez de
      // solo al que arrancamos nosotros. No afecta stdout/stderr, que se
      // siguen capturando igual.
      child = require("child_process").spawn(command, args, { cwd: root.fsPath, windowsHide: true, shell: false, detached: process.platform !== "win32" });
    } catch (e) { return resolve({ error: e.message }); }
    let out = "";
    let done = false;
    const add = (d) => { if (out.length < execTool.MAX_OUTPUT_CHARS * 4) out += d; };
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (abortSignal) abortSignal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const timer = setTimeout(() => { execTool.killProcessTree(child); finish({ timedOut: true, timeoutMs, output: out }); }, timeoutMs);
    // Boton "Detener" (v0.21.3): antes esto no estaba conectado a nada -- el
    // comando seguia corriendo igual hasta su propio timeout aunque
    // apretaras Detener (que si corta la llamada HTTP al modelo, pero no
    // esto). Ahora escucha la MISMA senial que corta el resto del turno.
    const onAbort = () => { execTool.killProcessTree(child); finish({ cancelled: true, output: out }); };
    if (abortSignal) {
      if (abortSignal.aborted) onAbort();
      else abortSignal.addEventListener("abort", onAbort, { once: true });
    }
    child.stdout && child.stdout.on("data", add);
    child.stderr && child.stderr.on("data", add);
    child.on("error", (e) => finish({ error: e.message, output: out }));
    child.on("close", (code) => finish({ code, output: out }));
  });
  // Error de "archivo no existe" + un nombre parecido en el proyecto (v0.20.1):
  // el caso tipico es "python dooom.py" cuando el archivo real es "base de
  // dooom.py" -- se le señala el nombre real en vez de dejarlo adivinar nomas.
  if ((r.code && r.code !== 0) || r.error) {
    try {
      const known = contextPaths().map((f) => f.path);
      const suggestPath = execTool.suggestFilenameFix(v.argv, r.output || r.error || "", known);
      if (suggestPath) r.suggestPath = suggestPath;
    } catch (_) { /* la sugerencia es best-effort, nunca debe romper el flujo */ }
  }
  const text = execTool.formatResult(v.cmd, r);
  appendSessionLog(`
  Ejecutado: ${v.cmd} -> ${r.error ? `error: ${r.error}` : r.timedOut ? "tiempo agotado" : `codigo ${r.code}`}
`);
  post({ type: "info", turnId, text: L(`Termino "${v.cmd}": ${r.error ? "no se pudo ejecutar" : r.timedOut ? "se corto por tiempo" : `codigo ${r.code}`}`, `Finished "${v.cmd}": ${r.error ? "could not run" : r.timedOut ? "timed out" : `exit code ${r.code}`}`) });
  return text;
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

// Ultimos N turnos (N*2 mensajes). Ojo: slice(-0) es slice(0) y devolvia TODO
// el historial -- con maxHistoryTurns = 0 se mandaba justo lo contrario de
// lo pedido.
//
// v0.21.2: antes esto era slice(-n) a secas -- una ventana deslizante que
// tira el turno mas viejo y agrega el nuevo en CADA turno. Pasado el turno N,
// el "historial" nunca era el mismo bloque dos veces seguidas: ni el cacheo
// automatico de Gemini/OpenAI (que necesita el mismo prefijo exacto) ni el
// cache_control de Anthropic (que ahi reescribe a 1.25x en vez de leer a
// 0.1x) podian agarrar nunca. Cualquier sesion mas larga que maxHistoryTurns
// pagaba el historial a precio de reescritura de cache en casi todos los
// turnos -- el mismo mecanismo que el bug del mapa del repo, pero en la
// parte que mas pesa de una sesion larga.
//
// Fix: podar de a LOTES, no de a 1 turno por turno. Mientras no se pase del
// margen (HISTORY_PRUNE_SLACK_TURNS turnos de mas), no se poda nada -- el
// historial solo CRECE, y un prefijo que crece agregando al final se cachea
// perfecto en los tres proveedores. Recien cuando se pasa del margen se poda
// de una vez hasta volver a maxHistoryTurns, y ahi queda quieto otra vez
// varios turnos hasta la proxima poda. El contexto retenido en promedio es
// el mismo (fluctua entre N y N+margen en vez de ser siempre N); lo que
// cambia es que el prefijo deja de cortarse en cada turno.
const HISTORY_PRUNE_SLACK_TURNS = 4;
function historyWindow() {
  const nTurns = Math.max(0, Math.floor(Number(cfg().get("maxHistoryTurns")) || 0));
  if (!nTurns) return [];
  const n = 2 * nTurns;
  if (state.history.length > n + 2 * HISTORY_PRUNE_SLACK_TURNS) state.history.splice(0, state.history.length - n);
  return state.history.slice(); // copia: nadie debe mutar el buffer real
}

async function runTurnInner(question, opts = {}) {
  if (!workspaceRoot()) {
    post({ type: "error", text: L("Abre una carpeta (File > Open Folder) para que SovNode sepa donde leer y crear archivos.", "Open a folder (File > Open Folder) so SovNode knows where to read and create files.") });
    return;
  }

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
      return;
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
    return;
  }
  warnIfExpensive([model, editModel], cfg().get("pricing"));

  const turnId = ++state.turnCounter;
  if (autoPlan) post({ type: "info", turnId: null, text: L(`Auto → nivel **${autoPlan.route.level}**: ${architect ? `${model} planea, ${editModel} escribe` : model} (${autoPlan.route.reasons.join("; ")})`, `Auto → level **${autoPlan.route.level}**: ${architect ? `${model} plans, ${editModel} writes` : model} (${autoPlan.route.reasons.join("; ")})`) });
  // Formato de edicion del turno (SEARCH/REPLACE, diff unificado o archivo
  // completo): lo decide el modelo que ESCRIBE el codigo (el editor en modo
  // arquitecto). Se recalcula con el tamanio real de los archivos en cuanto
  // se cargan, y despues queda fijo todo el turno -- reparacion y
  // correccion por verificacion usan el mismo formato.
  let fmt = resolveEditFormat(cfg().get("editFormat"), editModel, 0);
  let editFormat = fmt.format;
  const calls = [];
  let turnUsage = {};
  let turnCost = {};
  const notes = [];
  let phase = "preparando contexto";
  post({ type: "turnStart", turnId, model: architect ? `${model} → ${editModel}` : model, effort, architect });

  const PHASE_TEXT = {
    principal: L("Pensando...", "Thinking..."),
    arquitecto: L("El arquitecto esta planeando el cambio...", "The architect is planning the change..."),
    editor: L("El editor esta escribiendo el codigo segun el plan...", "The editor is writing the code from the plan..."),
    reparacion: L("Corrigiendo un bloque que no calzo...", "Fixing a block that didn't match..."),
    herramientas: L("Leyendo lo que pidio y siguiendo...", "Reading what it asked for and continuing..."),
    verificacion: L("Corrigiendo lo que fallo en la verificacion...", "Fixing what failed verification..."),
  };
  const callModel = async (kind, contents, opts = {}) => {
    const useModel = opts.model || model;
    post({ type: "phase", turnId, text: PHASE_TEXT[kind] || L("Leyendo los archivos que pidio...", "Reading the files it asked for...") });
    const hasNativeTurns = contents.some((t) => t.native || t.toolResults);
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
        notes.push(L(`${useModel} rechazo las herramientas nativas (${e.message.slice(0, 160)}); se uso el protocolo de texto y se sigue asi en esta sesion.`, `${useModel} rejected native tools (${e.message.slice(0, 160)}); switched to the text protocol for the rest of this session.`));
        r = await callOnce();
      } else {
        throw e;
      }
    }
    r._model = useModel;
    r._kind = kind;
    return finishCall(r);

    async function callOnce() {
    return callLLM({
      // Siempre se manda un prompt de sistema explicito: antes el turno
      // normal dependia del default de gemini.js, y con OpenAI/Anthropic
      // (que no tienen ese default) el modelo no recibia NINGUNA instruccion
      // de como editar.
      // opts.effort permite bajarlo puntualmente para una llamada (ver
      // lowerEffort/toolLoop); si no viene, se usa el effort del turno.
      model: useModel, contents, effort: opts.effort || effort,
      systemPrompt: (opts.systemPrompt || systemPromptFor(editFormat)) + (opts.tools ? (opts.native ? nativeToolsPrompt(opts.execEnabled) : toolsPrompt(opts.execEnabled)) : ""),
      toolDefs: opts.tools && opts.native ? nativeToolDefs(opts.execEnabled) : undefined,
      toolChoiceNone: Boolean(opts.toolChoiceNone),
      signal: state.abort.signal, streaming: Boolean(cfg().get("streaming")),
      onText: (t) => post({ type: "delta", turnId, text: t }),
      onThought: (t) => post({ type: "thought", turnId, text: t }),
      onReset: () => post({ type: "resetStream", turnId }),
    });
    }
  };
  const finishCall = (r) => {
    const useModel = r._model;
    if (r.usedFallback) {
      notes.push(L(`El streaming se corto por un problema de red/proxy/antivirus (${r.fallbackReason}); se reintento sin streaming y funciono. Si se repite seguido, revisa si algo intercepta el trafico HTTPS (antivirus, VPN, proxy corporativo).`, `Streaming was cut off by a network/proxy/antivirus issue (${r.fallbackReason}); retried without streaming and it worked. If this keeps happening, check whether something intercepts HTTPS traffic (antivirus, VPN, corporate proxy).`));
      post({ type: "info", turnId, text: L("El streaming fallo por un problema de conexion; reintentando sin streaming...", "Streaming failed due to a connection problem; retrying without streaming...") });
    }
    const cost = computeCost(useModel, r.usage, { overrides: pricingOverrides });
    calls.push({ kind: r._kind, model: useModel, usage: r.usage, cost, latencyMs: r.latencyMs, firstTokenMs: r.firstTokenMs, finishReason: r.finishReason, usedFallback: Boolean(r.usedFallback) });
    turnUsage = addUsage(turnUsage, r.usage);
    turnCost = addCost(turnCost, cost);
    post({ type: "callDone", turnId, call: calls[calls.length - 1] });
    return r;
  };

  let resultLabel = "respuesta sin cambios";
  let filesChanged = [];
  let failures = [];
  let verifyFailed = ""; // v0.24: si la verificacion se rindio, el error (para el modo agente)
  let finalText = "";
  let contextInfo = null;
  let archPlan = "";
  const toolStats = { rounds: 0, requests: 0 };
  let toolSaved = 0;

  try {
    phase = "construyendo el mapa del repositorio";
    const map = await getRepoMap();
    const mapParts = repoMapParts(map, question);
    const repoMapText = mapParts.text;
    const history = historyWindow();
    let files = await loadContextFiles();
    fmt = resolveEditFormat(cfg().get("editFormat"), editModel, files.reduce((n, f) => n + f.content.length, 0));
    editFormat = fmt.format;
    // Contexto enfocado: en archivos grandes solo van las partes que el pedido
    // toca (ver focus.js). fullPaths = archivos que el modelo pidio ver enteros.
    const fullPaths = new Set();
    const selection = currentSelection();
    const focusFor = (fs, text) => applyFocus(fs, text, map, fullPaths, selection, editFormat);
    const describeFiles = (sent) => sent.map((f) => ({ path: f.path, chars: (f.rendered || f.content).length, focus: f.focus || null, archBase: f.archBase || null }));
    contextInfo = { files: describeFiles(focusFor(files, question)), repoMapChars: (mapParts.cached || mapParts.text).length + mapParts.focus.length, repoMapCached: Boolean(mapParts.cached), projectMemoryChars: mapParts.memory.length, historyMsgs: history.length, editFormat, editFormatReason: fmt.reason, logs: state.logs.map((l) => ({ label: l.label, chars: l.chars })) };
    post({ type: "context", turnId, context: contextInfo });
    // v0.29.1: carpeta vacia (tipico: se abrio la carpeta equivocada) -> avisar
    // en vez de dejar que el modelo busque en la nada y conteste vacio.
    if (!files.length && !(map && map.entries && map.entries.length)) {
      const any = await vscode.workspace.findFiles("**/*", "**/{node_modules,.git}/**", 1);
      if (!any.length) post({ type: "info", turnId, text: L(`La carpeta abierta (${workspaceRoot().fsPath}) no tiene archivos. Si el pedido habla de archivos existentes, probablemente abriste la carpeta equivocada (File > Open Folder).`, `The open folder (${workspaceRoot().fsPath}) has no files. If the request refers to existing files, you probably opened the wrong folder (File > Open Folder).`) });
    }

    // 1) Llamada + pedidos de archivos (NECESITO_ARCHIVOS) antes de editar.
    // Micro-herramientas (tools.js): el modelo puede pedir leer un rango de
    // lineas o buscar un texto a mitad del turno. Tope de rondas COMPARTIDO
    // por todo el turno (arquitecto + editor), resultados fuera del historial.
    let toolRoundsLeft = roundsFor(cfg().get("toolsMaxRounds"), effort);
    const toolsOn = toolRoundsLeft > 0;
    const execEnabled = toolsOn && cfg().get("execEnabled") !== false;
    let listFilesMemo = null;
    const toolCtx = {
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
      runExec: execEnabled ? ((cmd) => runExecCommand(cmd, turnId)) : null,
    };
    // Lineas del archivo ACTUAL que el modelo ya tiene en esta llamada
    // (entero o extracto). La base del arquitecto no cuenta: es una version
    // vieja + diff, los numeros de linea no son los del archivo actual.
    const shownOf = (sent) => {
      const m = new Map();
      for (const f of sent) {
        if (f.archBase) continue;
        if (f.focus && f.focus.ranges) m.set(f.path, f.focus.ranges.map((x) => [...x]));
        else if (typeof f.content === "string") m.set(f.path, [[1, f.content.split("\n").length]]);
      }
      return m;
    };
    // Cada ronda AGREGA [pedido del modelo][resultados] al final: el pedido
    // anterior queda como prefijo identico (cacheable) de la llamada nueva.
    // v0.25: cada llamada nativa se traduce al pedido interno y corre por
    // runTools (misma dedup, topes y recortes que el protocolo de texto).
    // Hay que responder TODAS las llamadas (Anthropic/OpenAI lo exigen), asi
    // que las que no corren igual reciben un resultado explicando por que.
    const runNativeCalls = async (calls, sess) => {
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
        const res = await runTools([conv.req], toolCtx, sess);
        toolSaved += res.saved;
        summary.push(...res.summary);
        results.push({ ...out, result: res.text.replace(/^RESULTADOS DE HERRAMIENTAS:\n\n/, "") });
      }
      return { results, summary, used };
    };

    const toolLoop = async (r, contents, opts, sent) => {
      const convo = [];
      const sess = newToolSession(shownOf(sent || []));
      for (;;) {
        if (opts.native) {
          const calls = r.toolCalls || [];
          if (!calls.length || hasEdits(r.text, editFormat)) return r;
          if (toolRoundsLeft <= 0) {
            notes.push(L("El modelo siguio pidiendo herramientas despues del tope de rondas; se uso lo que respondio (subi sovnodeAider.toolsMaxRounds si pasa seguido).", "The model kept requesting tools after the round limit; its answer was used as is (raise sovnodeAider.toolsMaxRounds if this happens often)."));
            return r;
          }
          toolRoundsLeft--;
          toolStats.rounds++;
          const { results, summary, used } = await runNativeCalls(calls, sess);
          toolStats.requests += used;
          post({ type: "info", turnId, text: L(`SovNode consulto: ${summary.length ? summary.join(", ") : "(nada valido)"}`, `SovNode looked up: ${summary.length ? summary.join(", ") : "(nothing valid)"}`) });
          const lastRes = results[results.length - 1];
          lastRes.result += toolRoundsLeft <= 0
            ? "\n\nYa no quedan consultas: responde AHORA el pedido original con lo que tenes."
            : "\n\nSegui con el pedido original. Solo usa mas herramientas si de verdad te falta algo.";
          convo.push(
            { role: "model", parts: [{ text: (r.text || "").trim() }], native: r.native },
            { role: "user", parts: [{ text: results.map((x) => x.result).join("\n\n") }], toolResults: results }
          );
          post({ type: "resetStream", turnId });
          phase = "llamada al modelo (herramientas)";
          // sin rondas restantes: se le prohibe llamar mas (tool_choice none)
          // en vez de quitar las definiciones, que algunas APIs exigen
          // mientras haya llamadas previas en la conversacion.
          r = await callModel("herramientas", [...contents, ...convo], { ...opts, effort: lowerEffort(opts.effort || effort), toolChoiceNone: toolRoundsLeft <= 0 });
          continue;
        }
        const reqs = hasEdits(r.text, editFormat) ? null : parseToolRequest(r.text);
        if (!reqs) return r;
        if (toolRoundsLeft <= 0) {
          notes.push(L("El modelo siguio pidiendo herramientas despues del tope de rondas; se uso lo que respondio (subi sovnodeAider.toolsMaxRounds si pasa seguido).", "The model kept requesting tools after the round limit; its answer was used as is (raise sovnodeAider.toolsMaxRounds if this happens often)."));
          return r;
        }
        toolRoundsLeft--;
        toolStats.rounds++;
        toolStats.requests += reqs.length;
        const res = await runTools(reqs, toolCtx, sess);
        toolSaved += res.saved;
        post({ type: "info", turnId, text: L(`SovNode consulto: ${res.summary.join(", ")}`, `SovNode looked up: ${res.summary.join(", ")}`) });
        const tail = toolRoundsLeft <= 0
          ? "\n\nYa no quedan consultas: responde AHORA el pedido original con lo que tenes (no vuelvas a pedir HERRAMIENTAS)."
          : "\n\nSegui con el pedido original. Solo pedi mas HERRAMIENTAS si de verdad te falta algo.";
        convo.push({ role: "model", parts: [{ text: r.text.trim() }] }, { role: "user", parts: [{ text: res.text + tail }] });
        post({ type: "resetStream", turnId });
        phase = "llamada al modelo (herramientas)";
        // effort mas bajo SOLO en esta llamada de continuacion (ver comentario
        // en lowerEffort): el resto del turno sigue con el effort configurado.
        r = await callModel("herramientas", [...contents, ...convo], { ...opts, effort: lowerEffort(opts.effort || effort) });
      }
    };

    const askWithFiles = async (kind, extra, opts) => {
      phase = `llamada al modelo (${kind})`;
      // v0.29.1: el tope de rondas es por TURNO. Si el arquitecto ya lo gasto,
      // al editor no se le ofrecen herramientas: antes las pedia igual, se
      // cortaba por tope y el turno terminaba con una respuesta vacia.
      const toolsNow = toolsOn && toolRoundsLeft > 0;
      opts = { ...opts, tools: toolsNow, execEnabled, native: toolsNow && nativeToolsFor(opts.model || model) };
      const focusText = `${extra.question || question}\n${extra.note || ""}`;
      // Arquitecto: archivo base (cacheado) + diff de lo que cambio. El resto
      // (editor / modo normal) recibe el codigo actual, enfocado si es grande.
      const useBase = kind === "arquitecto" && cfg().get("architectBaseCache") !== false;
      let baseFiles = null;
      const prepare = () => {
        if (!useBase) return focusFor(files, focusText);
        const pa = prepareArchitect(files, state.archBases);
        baseFiles = pa.base;
        return pa.files;
      };
      let sent = prepare();
      contextInfo[useBase ? "archFiles" : "files"] = describeFiles(sent);
      post({ type: "context", turnId, context: contextInfo });
      let contents = buildContents({ replyLang, question: extra.question || question, files: sent, history, repoMapText, repoMapCached: mapParts.cached, repoMapFocus: mapParts.focus, projectMemory: mapParts.memory, extraNote: extra.note, logs: state.logs, baseFiles });
      let r = await toolLoop(await callModel(kind, contents, opts), contents, opts, sent);
    for (let round = 0; round < MAX_FILE_REQUEST_ROUNDS; round++) {
      const wanted = parseFileRequest(r.text, editFormat);
      if (!wanted) break;
      const added = [];
      for (const w of wanted) {
        if (!validatePath(w) && (await exists(w))) {
          state.chatFiles.add(path.posix.normalize(w));
          fullPaths.add(path.posix.normalize(w)); // si ya estaba como extracto, ahora va entero
          added.push(w);
        }
      }
      if (!added.length) {
        notes.push(L(`El modelo pidio ${wanted.join(", ")} pero esos archivos no existen.`, `The model asked for ${wanted.join(", ")} but those files don't exist.`));
        break;
      }
      post({ type: "info", turnId, text: L(`SovNode pidio ver: ${added.join(", ")} (agregados al chat)`, `SovNode asked to see: ${added.join(", ")} (added to the chat)`) });
      sendFilesUpdate();
      files = await loadContextFiles();
      sent = prepare();
      contextInfo[useBase ? "archFiles" : "files"] = describeFiles(sent);
      post({ type: "context", turnId, context: contextInfo });
      post({ type: "resetStream", turnId });
      phase = `llamada al modelo (pedido de archivos, ${kind})`;
      contents = buildContents({ replyLang, question: extra.question || question, files: sent, history, repoMapText, repoMapCached: mapParts.cached, repoMapFocus: mapParts.focus, projectMemory: mapParts.memory, extraNote: extra.note, logs: state.logs, baseFiles });
      r = await toolLoop(await callModel("pedido-archivos", contents, opts), contents, opts, sent);
    }
      return r;
    };

    let r;
    if (architect) {
      const a = await askWithFiles("arquitecto", { note: opts.note }, { systemPrompt: ARCHITECT_PROMPT });
      const planText = a.text.trim();
      if (/^SIN_CAMBIOS\b/.test(planText)) {
        r = { ...a, text: planText.replace(/^SIN_CAMBIOS\s*/, "") };
      } else if (hasEdits(planText, "search-replace")) {
        // El arquitecto se salto las reglas y ya trajo bloques: se usan tal cual.
        r = a;
      } else {
        archPlan = planText;
        post({ type: "archPlan", turnId, text: archPlan });
        post({ type: "resetStream", turnId });
        r = await askWithFiles("editor", {
          question: `Implementa el siguiente plan para este pedido del usuario: ${question}`,
          note: `${EDITOR_NOTE}\n\n${archPlan}`,
        }, { model: editModel });
      }
    } else {
      r = await askWithFiles("principal", { note: opts.note }, {});
    }

    finalText = r.text;
    if (!String(finalText || "").trim()) notes.push(L("El modelo no devolvio texto ni cambios en este turno. Reintenta o reformula el pedido; si pasa seguido, revisa el log de sesion.", "The model returned no text or changes this turn. Retry or rephrase the request; if it keeps happening, check the session log."));
    if (toolSaved >= 200) notes.push(L(`Herramientas: no se reenviaron ~${toolSaved.toLocaleString("es")} caracteres que el modelo ya tenia.`, `Tools: skipped resending ~${toolSaved.toLocaleString("en")} characters the model already had.`));
    if (r.finishReason === "MAX_TOKENS") notes.push(L("La respuesta se corto por el limite de tokens de salida. Sube el effort o pide el cambio en partes.", "The response was cut off by the output token limit. Raise the effort or ask for the change in parts."));

    // 2) Aplicar bloques (multi-archivo, todo-o-nada), con 1 ronda de reparacion.
    if (hasEdits(finalText, editFormat)) {
      const defaultPath = activeRelPath();
      let edits = parseEdits(finalText, editFormat, defaultPath);
      phase = "aplicando los bloques de edicion (plan)";
      let plan = await planChangeSet(edits, readRel, validatePath);
      for (let round = 0; !plan.ok && round < MAX_REPAIR_ROUNDS; round++) {
        const failedPaths = [...new Set(plan.failures.map((f) => f.path))];
        const current = [];
        for (const p of failedPaths) {
          const c = validatePath(p) ? null : await readRel(p);
          if (c !== null) current.push({ path: p, content: c, active: false });
        }
        const failureText = plan.failures.map((f) => describeFailure(f, editFormat)).join("\n");
        const repairHistory = [...history, { role: "user", content: question }, { role: "assistant", content: finalText }];
        post({ type: "resetStream", turnId });
        phase = "llamada al modelo (reparacion)";
        const rr = await callModel("reparacion", buildContents({
          question: repairInstruction(editFormat),
          files: current.length ? current : files,
          history: repairHistory,
          repoMapText: "",
          extraNote: `Fallos:\n${failureText}`,
        }), { model: editModel });
        if (!hasEdits(rr.text, editFormat)) break;
        finalText = rr.text;
        edits = parseEdits(finalText, editFormat, defaultPath);
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
          if (b >= 20 && a < b * 0.6) notes.push(L(`${f.path} quedo con ${a} lineas (antes ${b}). Si no pediste borrar tanto, revisalo o usa /undo.`, `${f.path} now has ${a} lines (was ${b}). If you didn't ask to delete that much, review it or use /undo.`));
        }
      }

      if (plan.ok && !plan.files.length) {
        resultLabel = "sin cambios reales (lo propuesto es igual a lo que ya habia)";
        notes.push(L("La respuesta traia cambios, pero el resultado es identico al contenido actual: no se escribio nada.", "The response had changes, but the result is identical to the current content: nothing was written."));
      } else if (plan.ok && plan.files.length) {
        // El snapshot de undo se guarda ANTES de escribir: si la escritura
        // falla a la mitad, se revierte lo que alcanzo a escribirse.
        const snapshot = { turnId, taskId: opts.taskId || null, files: plan.files.map((f) => ({ path: f.path, before: f.before, after: f.after, created: f.created })), commit: null };
        try {
          phase = "escribiendo archivos";
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

        // 3) Verificacion automatica (sintaxis por archivo + comando propio
        // del proyecto si esta configurado), con reintentos de correccion
        // ANTES del commit -- asi el commit de git siempre queda con la
        // version que ya paso la verificacion, nunca con la rota a medias.
        if (cfg().get("verify")) {
          let verifyRound = 0;
          let currentFiles = plan.files;
          while (verifyRound <= MAX_VERIFY_ROUNDS) {
            phase = "verificando cambios (sintaxis)";
            post({ type: "phase", turnId, text: L("Verificando que los archivos compilen...", "Checking that the files compile...") });
            const vres = await verify.verifyFiles(currentFiles.map((f) => ({ path: f.path, absPath: uriOf(f.path).fsPath })));
            for (const r of vres.results) if (r.skipped) log(`[verify] ${r.path}: sin verificador (${r.reason || "extension no soportada"})`);
            post({ type: "verifyResult", turnId, results: vres.results });

            let cmdFail = null;
            const verifyCmd = (cfg().get("verifyCommand") || "").trim();
            if (vres.ok && verifyCmd) {
              phase = "verificando cambios (comando del proyecto)";
              post({ type: "phase", turnId, text: L(`Corriendo "${verifyCmd}"...`, `Running "${verifyCmd}"...`) });
              const cmdRes = await verify.runProjectCommand(verifyCmd, workspaceRoot().fsPath, Number(cfg().get("verifyTimeoutMs")) || 60000);
              post({ type: "verifyCommand", turnId, command: verifyCmd, ok: cmdRes.ok, output: cmdRes.output });
              if (!cmdRes.ok) cmdFail = cmdRes;
            }

            if (vres.ok && !cmdFail) {
              if (verifyRound > 0) notes.push(L(`Verificacion OK despues de ${verifyRound} correccion(es) automatica(s).`, `Verification OK after ${verifyRound} automatic fix(es).`));
              break;
            }
            if (verifyRound >= MAX_VERIFY_ROUNDS) {
              verifyFailed = (vres.failures.length
                ? vres.failures.map((f) => `${f.path}: ${f.reason}`).join("\n")
                : `comando de verificacion "${verifyCmd}" fallo:\n${bugLogs.compressVerifyOutput(cmdFail.output)}`).slice(0, 1500);
              notes.push(L(`La verificacion sigue fallando tras ${MAX_VERIFY_ROUNDS} intento(s) de correccion automatica; los cambios quedan aplicados igual, revisalos a mano.`, `Verification still fails after ${MAX_VERIFY_ROUNDS} automatic fix attempt(s); the changes stay applied, review them by hand.`));
              break;
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
            const fixHistory = [...history, { role: "user", content: question }, { role: "assistant", content: finalText }];
            post({ type: "resetStream", turnId });
            phase = "llamada al modelo (correccion por verificacion)";
            const fr = await callModel("verificacion", buildContents({
              question: verifyFixInstruction(editFormat),
              files: filesForFix,
              history: fixHistory,
              repoMapText: "",
              extraNote: `Error de verificacion:
${failText}`,
            }), { model: editModel });
            if (!hasEdits(fr.text, editFormat)) { notes.push(L("La correccion automatica no trajo cambios de codigo; se deja como esta.", "The automatic fix brought no code changes; leaving it as is.")); break; }
            const fixEdits = parseEdits(fr.text, editFormat, activeRelPath());
            const fixPlan = await planChangeSet(fixEdits, readRel, validatePath);
            if (!fixPlan.ok || !fixPlan.files.length) { notes.push(L("La correccion automatica no se pudo aplicar; se deja como esta.", "The automatic fix could not be applied; leaving it as is.")); break; }
            phase = "escribiendo la correccion";
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
            finalText += `

(Correccion automatica aplicada tras verificar)

${fr.text}`;
            currentFiles = plan.files;
            verifyRound++;
          }
        }

        phase = "commit de git";
        if (cfg().get("autoCommit")) {
          const cwd = workspaceRoot().fsPath;
          if (await gitUtil.isRepo(cwd)) {
            try {
              const msg = `sovnode: ${question.replace(/\s+/g, " ").slice(0, 72)}`;
              snapshot.commit = await gitUtil.commitFiles(cwd, plan.files.map((f) => f.path), msg);
              notes.push(L(`Commit ${snapshot.commit.slice(0, 7)} creado (${msg}).`, `Commit ${snapshot.commit.slice(0, 7)} created (${msg}).`));
            } catch (e) {
              notes.push(L(`No se pudo hacer commit: ${e.message}`, `Could not commit: ${e.message}`));
            }
          }
        }
        filesChanged = plan.files.map((f) => ({ path: f.path, created: f.created, tolerantCount: f.tolerantCount, changes: f.changes }));
        resultLabel = `${plan.files.length} archivo(s) cambiados`;

        phase = "abriendo el archivo cambiado";
        if (cfg().get("openChangedFiles")) {
          const first = plan.files[0];
          const line = Math.max(0, (first.changes[0] ? first.changes[0].line : 1) - 1);
          const doc = await vscode.workspace.openTextDocument(uriOf(first.path));
          await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true, selection: new vscode.Range(line, 0, line, 0) });
        }
      } else {
        failures = plan.failures;
        resultLabel = "edits NO aplicados (ningun archivo fue modificado)";
      }
    }

    // En el historial se guarda la respuesta SIN los bloques de edicion (ni el
    // archivo entero, en formato "whole"): el contenido resultante ya se
    // vuelve a mandar fresco en "files" la proxima vez que se toque ese
    // archivo, asi que repetir el bloque/diff/archivo completo turno tras
    // turno (mientras siga dentro de la ventana de maxHistoryTurns) es puro
    // gasto de tokens de entrada, sin que el modelo pierda nada util -- lo
    // que necesita para dar continuidad es la explicacion en prosa, no su
    // propio parche viejo.
    const historyEdits = finalText ? parseEdits(finalText, editFormat, null) : [];
    const historyText = finalText ? stripEdits(finalText, historyEdits) : finalText;
    state.history.push({ role: "user", content: question }, { role: "assistant", content: historyText });
  } catch (err) {
    const msg = String((err && err.message) || err);
    // v0.28.1: Detener NO es un error -- antes se mostraba como error rojo con
    // stack trace y abria el panel de Output, como si algo se hubiera roto.
    if (state.abort && state.abort.signal.aborted) {
      log(`[cancelado] turno #${turnId} (fase: ${phase})`);
      post({ type: "system", text: L("⏹ Detenido. Si este turno ya habia escrito algun archivo, podes deshacerlo con /undo.", "⏹ Stopped. If this turn had already written any file, you can revert it with /undo.") });
      resultLabel = "cancelado por el usuario";
    } else {
    const stack = `${(err && err.stack) || "(sin stack)"}\n\n--- contexto ---\nfase del turno: ${phase}\n${diagContext()}`;
    log(`[error] turno #${turnId} (fase: ${phase}): ${msg}\n${stack}`);
    output.show(true);
    post({ type: "error", turnId, text: L(`${msg}  [fase: ${phase}]`, `${msg}  [phase: ${phase}]`), stack });
    resultLabel = `error en ${phase}: ${msg}`;
    }
  }

  state.session.turns += 1;
  state.session.usage = addUsage(state.session.usage, turnUsage);
  state.session.cost = addCost(state.session.cost, turnCost);

  const edits = parseEdits(finalText, editFormat, null);
  const turnRecord = {
    turnId, at: Date.now(), question, model, effort,
    context: contextInfo || { files: [], repoMapChars: 0, historyMsgs: 0 },
    calls, usage: turnUsage, cost: turnCost, result: resultLabel,
    filesChanged: filesChanged.map((f) => ({ path: f.path, created: f.created, changes: f.changes.map((c) => ({ kind: c.kind, line: c.line, removed: c.removed, added: c.added })) })),
    tools: toolStats.rounds ? { rounds: toolStats.rounds, requests: toolStats.requests, saved: toolSaved } : null,
  };
  logTurn(turnRecord);
  appendUsageLog(turnRecord);

  post({
    type: "turnEnd",
    turnId,
    prose: (archPlan ? L(`**Plan del arquitecto** (${model})\n\n${archPlan}\n\n---\n\n**Editor** (${editModel})\n\n`, `**Architect plan** (${model})\n\n${archPlan}\n\n---\n\n**Editor** (${editModel})\n\n`) : "") + (finalText ? stripEdits(finalText, edits) : ""),
    filesChanged,
    failures,
    notes,
    usage: turnUsage,
    cost: turnCost,
    calls,
    session: state.session,
  });
  sendFilesUpdate();
  state.lastTurnFailed = /^error en /.test(resultLabel) || failures.length > 0 || Boolean(verifyFailed);
  return {
    resultLabel, failures, filesChanged, verifyFailed, turnId, isError: /^error en /.test(resultLabel),
    auto: autoPlan ? { tiers: autoPlan.tiers, level: autoPlan.route.level, usedModel: autoPlan.architect ? autoPlan.editModel : autoPlan.model } : null,
  };
}

// ---------------------------------------------------------------- tarea autonoma (varios pasos)
// /task <objetivo>: un modelo divide el pedido en pasos chicos y despues cada
// paso se ejecuta como un turno normal (con toda su maquinaria de edicion,
// reparacion, verificacion y commit) uno tras otro, sin pedirle "sigue" al
// usuario entre paso y paso. Se puede parar en cualquier momento con
// Detener (state.abort), igual que un turno comun.
function parseSteps(text) {
  const lines = String(text || "")
    .split("\n")
    .map((l) => /^\s*\d+[.)]\s+(.+)$/.exec(l))
    .filter(Boolean)
    .map((m) => m[1].trim());
  return lines;
}

// ---------------------------------------------------------------- modo agente (v0.24)
// Opcional (agentMode, /agent, boton 🤖). Apagado, /task se comporta EXACTO
// como antes (se detiene en el primer paso que falla). Prendido:
// - Un paso que falla (error, edits que no aplican, o verificacion que se
//   rinde) se REINTENTA con el error real + la lista de intentos previos.
// - Mismo error dos veces = el enfoque no sirve -> se replanifican los pasos
//   que faltan (una vez por tarea). Si vuelve a trabarse, se detiene.
// - "Funciono" lo decide verify.js / verifyCommand, nunca otra llamada al
//   modelo (gratis y mas confiable).
// - Presupuesto por tarea (taskBudgetUSD): al llegarlo, pausa y pregunta.
const AGENT_MAX_ATTEMPTS = 3; // por paso (1 + 2 reintentos)
const AGENT_MAX_REPLANS = 1; // por tarea
function stepFailureText(r) {
  if (!r) return "no se pudo ejecutar el paso";
  if (r.isError) return r.resultLabel;
  if (r.failures && r.failures.length) return "los cambios no se pudieron aplicar:\n" + r.failures.map((f) => `- ${f.path}: ${f.reason || f.error || "no coincide"}`).join("\n");
  if (r.verifyFailed) return "la verificacion sigue fallando:\n" + r.verifyFailed;
  return "";
}
// Firma del error: sin numeros (lineas/columnas cambian entre intentos) ni
// espacios. Dos firmas iguales = el modelo esta dando vueltas en lo mismo.
const errorSignature = (t) => String(t || "").replace(/\d+/g, "#").replace(/\s+/g, " ").trim().slice(0, 300);

async function replanRemaining(objective, progress, stuckStep, fail, maxSteps, model, effort, pricingOverrides) {
  const replyLang = i18n.detectLang(objective);
  try {
    const map = await getRepoMap();
    const mapParts = repoMapParts(map, objective);
    const files = await loadContextFiles();
    const question = `Tarea general del usuario: ${objective}\n\nPasos ya completados:\n${progress.length ? progress.join("\n") : "(ninguno)"}\n\nEl paso "${stuckStep}" fallo DOS veces con el mismo error:\n${fail.slice(0, 1500)}\n\nReplanifica SOLO lo que falta (desde ese paso), con un enfoque distinto que evite ese error. Pasos chicos y verificables.`;
    const contents = buildContents({ replyLang, question, files, history: [], repoMapText: mapParts.text, repoMapCached: mapParts.cached, repoMapFocus: mapParts.focus, projectMemory: mapParts.memory, logs: state.logs });
    const r = await callLLM({ model, contents, effort, systemPrompt: taskPlanPrompt(maxSteps), signal: state.abort.signal, streaming: false, onText: () => {}, onThought: () => {}, onReset: () => {} });
    state.session.usage = addUsage(state.session.usage, r.usage);
    state.session.cost = addCost(state.session.cost, computeCost(model, r.usage, { overrides: pricingOverrides }));
    return parseSteps(r.text).slice(0, maxSteps);
  } catch (_) {
    return null;
  }
}

async function askBudget(spent, limit, step) {
  const SEGUIR = L("Seguir (otro tanto)", "Continue (same again)");
  const pick = await vscode.window.showWarningMessage(
    L(`SovNode (modo agente): la tarea ya gasto ${fmtUsd(spent)}, llego al presupuesto de ${fmtUsd(limit)} (taskBudgetUSD). Va por el paso ${step}. ¿Seguir?`, `SovNode (agent mode): the task has spent ${fmtUsd(spent)}, reaching the ${fmtUsd(limit)} budget (taskBudgetUSD). It's on step ${step}. Continue?`),
    { modal: true },
    SEGUIR,
    L("Detener", "Stop")
  );
  return pick === SEGUIR;
}

// Herramientas nativas (v0.25): por defecto si (nativeTools), salvo que ese
// modelo ya las haya rechazado en esta sesion.
function nativeToolsFor(m) {
  return cfg().get("nativeTools") !== false && !state.nativeToolsOff.has(m);
}

async function runTask(objective) {
  if (state.busy) return post({ type: "system", text: L("Espera a que termine el turno actual (o pulsa Detener).", "Wait for the current turn to finish (or press Stop).") });
  state.busy = true;
  state.abort = new AbortController();
  try {
    await runTaskInner(objective);
  } finally {
    state.busy = false;
    state.abort = null;
    post({ type: "idle" });
  }
}

async function runTaskInner(objective) {
  if (!workspaceRoot()) return post({ type: "error", text: L("Abre una carpeta (File > Open Folder) para que SovNode sepa donde leer y crear archivos.", "Open a folder (File > Open Folder) so SovNode knows where to read and create files.") });
  const missingKey = await missingApiKeyFor([cfg().get("model")]);
  if (missingKey) return post({ type: "error", text: L(`Falta la API key de ${missingKey}. Pulsa el boton de llave arriba del chat o corre "SovNode: Set API Key".`, `Missing the ${missingKey} API key. Press the key button above the chat or run "SovNode: Set API Key".`) });

  // Auto: el fuerte planifica; los pasos se enrutan solos (runTurnInner) o,
  // en modo agente, barato + escalado al fuerte.
  const taskTiers = isAuto() ? await autoTiers() : null;
  const model = taskTiers ? taskTiers.fuerte : cfg().get("model");
  const effort = cfg().get("effort");
  const pricingOverrides = cfg().get("pricing");
  const maxSteps = Math.max(1, Number(cfg().get("maxAutoSteps")) || 6);
  const taskId = ++state.taskCounter;
  warnIfExpensive([model], pricingOverrides);
  post({ type: "taskStart", taskId, objective, model });

  // 1) Planificar: una llamada aparte (no toca archivos), con su propio
  // pedido de NECESITO_ARCHIVOS si el planificador lo necesita.
  let steps = [objective];
  const replyLang = i18n.detectLang(objective);
  const costStart = state.session.cost.totalUsd || 0;
  try {
    const map = await getRepoMap();
    const mapParts = repoMapParts(map, objective);
    const repoMapText = mapParts.text;
    let files = await loadContextFiles();
    let planContents = buildContents({ replyLang, question: objective, files, history: [], repoMapText, repoMapCached: mapParts.cached, repoMapFocus: mapParts.focus, projectMemory: mapParts.memory, logs: state.logs });
    let planRes;
    for (let round = 0; round <= MAX_FILE_REQUEST_ROUNDS; round++) {
      post({ type: "taskPhase", taskId, text: L("Planificando los pasos...", "Planning the steps...") });
      planRes = await callLLM({
        model, contents: planContents, effort, systemPrompt: taskPlanPrompt(maxSteps), signal: state.abort.signal, streaming: Boolean(cfg().get("streaming")),
        onText: () => {}, onThought: () => {}, onReset: () => {},
      });
      const cost = computeCost(model, planRes.usage, { overrides: pricingOverrides });
      state.session.usage = addUsage(state.session.usage, planRes.usage);
      state.session.cost = addCost(state.session.cost, cost);
      const wanted = parseFileRequest(planRes.text);
      if (!wanted || round === MAX_FILE_REQUEST_ROUNDS) break;
      const added = [];
      for (const w of wanted) if (!validatePath(w) && (await exists(w))) { state.chatFiles.add(path.posix.normalize(w)); added.push(w); }
      if (!added.length) break;
      post({ type: "info", turnId: null, taskId, text: L(`El planificador pidio ver: ${added.join(", ")} (agregados al chat)`, `The planner asked to see: ${added.join(", ")} (added to the chat)`) });
      sendFilesUpdate();
      files = await loadContextFiles();
      planContents = buildContents({ replyLang, question: objective, files, history: [], repoMapText, repoMapCached: mapParts.cached, repoMapFocus: mapParts.focus, projectMemory: mapParts.memory, logs: state.logs });
    }
    const parsed = parseSteps(planRes.text);
    if (parsed.length) steps = parsed.slice(0, maxSteps);
  } catch (e) {
    if (state.abort && state.abort.signal.aborted) {
      post({ type: "taskEnd", taskId, ok: false, reason: L("Detenido por el usuario.", "Stopped by the user.") });
      return;
    }
    post({ type: "error", taskId, text: L(`No se pudo planificar la tarea: ${e.message}  [fase: planificando tarea]`, `Could not plan the task: ${e.message}  [phase: planificando tarea]`), stack: `${e.stack || ""}\n\n--- contexto ---\n${diagContext()}` });
    post({ type: "taskEnd", taskId, ok: false });
    return;
  }

  post({ type: "taskPlan", taskId, steps });
  const agent = Boolean(cfg().get("agentMode"));
  // Modelo barato para los pasos (v0.26): el principal (normalmente el caro)
  // planifica y replanifica -- pocas llamadas, donde mas importa pensar bien --
  // y los pasos, que son la mayoria de las llamadas, los hace agentStepModel.
  // Si un paso falla, el reintento escala al modelo principal SOLO para ese
  // paso: se paga caro justo donde el barato no alcanzo.
  const stepModel = agent ? ((cfg().get("agentStepModel") || "").trim() || (taskTiers ? taskTiers.barato : "")) : "";
  const cheapSteps = Boolean(stepModel) && stepModel !== model;
  if (cheapSteps) {
    const miss = await missingApiKeyFor([stepModel]);
    if (miss) post({ type: "system", text: L(`Modo agente: falta la API key de ${miss} para el modelo de pasos (${stepModel}); los pasos usan ${model}.`, `Agent mode: missing the ${miss} API key for the step model (${stepModel}); steps use ${model}.`) });
  }
  const useCheap = cheapSteps && !(await missingApiKeyFor([stepModel]));
  const budget = Math.max(0, Number(cfg().get("taskBudgetUSD")) || 0);
  let budgetLimit = budget;
  const spent = () => (state.session.cost.totalUsd || 0) - costStart;
  const progress = [];
  const stepStats = { cheap: 0, main: 0 };
  let stopped = false;
  let stopReason = "";
  let replans = 0;
  let i = 0;
  for (; i < steps.length; i++) {
    if (state.abort.signal.aborted) { stopped = true; stopReason = L("Detenido por el usuario.", "Stopped by the user."); break; }
    post({ type: "taskStep", taskId, index: i, total: steps.length, text: steps[i] });
    const attempts = []; // {sig, text} intentos fallidos de ESTE paso
    let replanned = false;
    for (;;) {
      if (agent && budgetLimit > 0 && spent() >= budgetLimit) {
        if (!(await askBudget(spent(), budgetLimit, i + 1))) { stopped = true; stopReason = L(`Presupuesto de la tarea alcanzado (${fmtUsd(spent())}); detenida a pedido tuyo.`, `Task budget reached (${fmtUsd(spent())}); stopped at your request.`); break; }
        budgetLimit += budget;
      }
      const tried = attempts.length
        ? `\n\nINTENTOS ANTERIORES DE ESTE PASO QUE FALLARON (no repitas lo mismo: cambia de enfoque y corrige la causa):\n${attempts.map((a, k) => `Intento ${k + 1}: ${a.text}`).join("\n\n")}`
        : "";
      const stepQuestion = `Tarea general del usuario: ${objective}\n\nEsta tarea se dividio en ${steps.length} paso(s). Progreso de los pasos anteriores:\n${progress.length ? progress.join("\n") : "(ninguno todavia)"}\n\nPaso actual (${i + 1}/${steps.length}) -- implementa SOLO esto: ${steps[i]}${tried}`;
      // intento 1 con el barato; desde el 2 (ya fallo una vez), el principal
      const stepModelNow = agent && useCheap && attempts.length === 0 ? stepModel : undefined;
      if (agent && useCheap && attempts.length === 1) post({ type: "taskPhase", taskId, text: L(`Paso ${i + 1}: ${stepModel} no pudo; escalando a ${model} solo para este paso...`, `Step ${i + 1}: ${stepModel} couldn't do it; escalating to ${model} for this step only...`) });
      let stepResult;
      try {
        // en Auto el escalado tiene que ser explicito (sin modelo, runTurnInner enrutaria solo)
        stepResult = await runTurnInner(stepQuestion, { taskId, replyLang, model: stepModelNow || (taskTiers && agent && attempts.length ? model : undefined) });
      } catch (e) {
        stopped = true; stopReason = L(`Error inesperado en el paso ${i + 1}: ${e.message}`, `Unexpected error in step ${i + 1}: ${e.message}`); break;
      }
      if (!stepResult) { stopped = true; stopReason = L(`El paso ${i + 1} no se pudo ejecutar (falta API key o carpeta).`, `Step ${i + 1} could not run (missing API key or folder).`); break; }
      const fail = stepFailureText(stepResult);
      const failedHard = stepResult.isError || (stepResult.failures && stepResult.failures.length);
      if (!agent) {
        // comportamiento clasico, sin cambios
        progress.push(`Paso ${i + 1} (${steps[i]}): ${stepResult.resultLabel}`);
        if (failedHard) {
          stopped = true;
          stopReason = stepResult.isError
            ? L(`El paso ${i + 1} termino en error; se detiene la tarea para que la revises.`, `Step ${i + 1} ended in an error; the task stops so you can review it.`)
            : L(`El paso ${i + 1} no se pudo aplicar (${stepResult.failures.map((f) => f.path).join(", ")}); se detiene la tarea para que la revises en vez de seguir sobre una base rota.`, `Step ${i + 1} could not be applied (${stepResult.failures.map((f) => f.path).join(", ")}); the task stops so you can review it instead of building on a broken base.`);
        }
        break;
      }
      if (!fail) {
        progress.push(`Paso ${i + 1} (${steps[i]}): ${stepResult.resultLabel}${attempts.length ? ` (tras ${attempts.length} reintento(s))` : ""}`);
        stepStats[stepModelNow ? "cheap" : "main"]++;
        break;
      }
      if (state.abort.signal.aborted) { stopped = true; stopReason = L("Detenido por el usuario.", "Stopped by the user."); break; }
      const sig = errorSignature(fail);
      const repeated = attempts.some((a) => a.sig === sig);
      attempts.push({ sig, text: fail.slice(0, 1200) });
      if (repeated && replans < AGENT_MAX_REPLANS) {
        // mismo error dos veces: replanificar lo que falta desde aca
        replans++;
        post({ type: "taskPhase", taskId, text: L(`Paso ${i + 1} trabado en el mismo error: replanificando lo que falta... (gastado ${fmtUsd(spent())})`, `Step ${i + 1} stuck on the same error: replanning the rest... (spent ${fmtUsd(spent())})`) });
        const newSteps = await replanRemaining(objective, progress, steps[i], fail, Math.max(1, maxSteps - i), model, effort, pricingOverrides);
        if (newSteps && newSteps.length) {
          steps = [...steps.slice(0, i), ...newSteps];
          post({ type: "taskPlan", taskId, steps });
          replanned = true;
          break;
        }
      }
      if (repeated || attempts.length >= AGENT_MAX_ATTEMPTS) {
        stopped = true;
        stopReason = L(`El paso ${i + 1} sigue fallando tras ${attempts.length} intento(s)${replans ? " y un replanteo" : ""}: ${fail.split("\n")[0].slice(0, 200)}. Se detiene para que lo revises (gastado ${fmtUsd(spent())}).`, `Step ${i + 1} still fails after ${attempts.length} attempt(s)${replans ? " and a replan" : ""}: ${fail.split("\n")[0].slice(0, 200)}. Stopping so you can review it (spent ${fmtUsd(spent())}).`);
        break;
      }
      post({ type: "taskPhase", taskId, text: L(`Paso ${i + 1} fallo; reintento ${attempts.length}/${AGENT_MAX_ATTEMPTS - 1} con el error real... (gastado ${fmtUsd(spent())}${budget ? ` de ${fmtUsd(budgetLimit)}` : ""})`, `Step ${i + 1} failed; retry ${attempts.length}/${AGENT_MAX_ATTEMPTS - 1} with the real error... (spent ${fmtUsd(spent())}${budget ? ` of ${fmtUsd(budgetLimit)}` : ""})`) });
    }
    if (stopped) break;
    if (replanned) { i--; continue; } // re-hace el indice i con el paso nuevo
    if (state.abort.signal.aborted) { stopped = true; stopReason = L("Detenido por el usuario.", "Stopped by the user."); i++; break; }
  }
  const finished = !stopped;
  if (agent && useCheap && (stepStats.cheap || stepStats.main)) post({ type: "system", text: L(`Modo agente: ${stepStats.cheap} paso(s) resueltos con ${stepModel} (barato), ${stepStats.main} necesitaron escalar a ${model}. Gasto de la tarea: ${fmtUsd((state.session.cost.totalUsd || 0) - costStart)}.`, `Agent mode: ${stepStats.cheap} step(s) solved with ${stepModel} (cheap), ${stepStats.main} needed escalating to ${model}. Task cost: ${fmtUsd((state.session.cost.totalUsd || 0) - costStart)}.`) });
  post({ type: "taskEnd", taskId, ok: finished, done: Math.min(i, steps.length), total: steps.length, reason: stopReason });
}

// ---------------------------------------------------------------- diagnostico
// /diag: revisa TODO lo que puede fallar, de afuera hacia adentro, y dice en
// palabras simples que esta bien y que no. Se puede copiar entero.
async function runDiagnostics() {
  const lines = [L("**Diagnostico de SovNode**", "**SovNode diagnostics**"), ""];
  const ok = (b) => (b ? "✅" : "❌");
  // Multi-proveedor: se chequean todos los modelos configurados que
  // realmente estan en uso (principal + editor del modo arquitecto, si esta
  // activo), cada uno con la API key y la conexion de SU proveedor -- no
  // tiene sentido reportar solo Gemini si el usuario esta usando GPT-6 o
  // Claude para alguno de los dos.
  const architect = Boolean(cfg().get("architect"));
  const model = cfg().get("model");
  const editModel = architect ? ((cfg().get("editorModel") || "").trim() || model) : model;
  const modelsInUse = [...new Set([model, editModel])];
  const providersInUse = [...new Set(modelsInUse.map(providerForModel))];
  const root = workspaceRoot();
  for (const p of providersInUse) {
    const key = await apiKeyFor(p);
    lines.push(L(`${ok(Boolean(key))} API key de ${PROVIDER_LABEL[p]} guardada${key ? ` (termina en …${key.slice(-4)})` : " — pulsa 🔑"}`, `${ok(Boolean(key))} ${PROVIDER_LABEL[p]} API key saved${key ? ` (ends in …${key.slice(-4)})` : " — press 🔑"}`));
  }
  lines.push(L(`${ok(Boolean(root))} Carpeta abierta${root ? `: ${root.fsPath}` : " — File > Open Folder"}`, `${ok(Boolean(root))} Folder open${root ? `: ${root.fsPath}` : " — File > Open Folder"}`));
  const tsAvailable = await treesitter.isAvailable();
  lines.push(L(`${tsAvailable ? "✅" : "ℹ️"} Repo map: ${tsAvailable ? "tree-sitter real disponible" : 'modo regex de respaldo -- corre "npm install" en la carpeta de la extension para el parseo real'}`, `${tsAvailable ? "✅" : "ℹ️"} Repo map: ${tsAvailable ? "real tree-sitter available" : 'fallback regex mode -- run "npm install" in the extension folder for real parsing'}`));
  if (root) {
    const isGit = await gitUtil.isRepo(root.fsPath);
    lines.push(L(`${isGit ? "✅" : "ℹ️"} Git: ${isGit ? "repo detectado (auto-commit activo)" : "no es un repo git (sin auto-commit; /undo funciona igual)"}`, `${isGit ? "✅" : "ℹ️"} Git: ${isGit ? "repo detected (auto-commit on)" : "not a git repo (no auto-commit; /undo still works)"}`));
    try {
      const map = await getRepoMap();
      if (map) {
        const t = map.treeSitter || { used: 0, total: 0 };
        const parserNote = t.total === 0
          ? ""
          : t.used === t.total
            ? L(" (parseo real con tree-sitter)", " (real tree-sitter parsing)")
            : t.used === 0
              ? L(" (modo regex: falta \"npm install\" en la carpeta de la extension, o el .wasm no cargo)", " (regex mode: \"npm install\" missing in the extension folder, or the .wasm didn't load)")
              : L(` (${t.used}/${t.total} archivos con tree-sitter, el resto con regex)`, ` (${t.used}/${t.total} files with tree-sitter, the rest with regex)`);
        lines.push(L(`ℹ️ Mapa del repo: ${map.entries.length} archivos de codigo${parserNote}`, `ℹ️ Repo map: ${map.entries.length} code files${parserNote}`));
      } else {
        lines.push(L("ℹ️ Mapa del repo: sin archivos de codigo soportados", "ℹ️ Repo map: no supported code files"));
      }
    } catch (e) {
      lines.push(L(`❌ Mapa del repo fallo: ${e.message}`, `❌ Repo map failed: ${e.message}`));
    }
  }
  const act = activeRelPath();
  lines.push(L(`ℹ️ Archivo activo: ${act || "ninguno (se pueden crear archivos igual)"}`, `ℹ️ Active file: ${act || "none (you can still create files)"}`));
  for (const m of modelsInUse) {
    const provider = providerForModel(m);
    const key = await apiKeyFor(provider);
    if (!key) continue; // ya se avisa arriba que falta la key de este proveedor
    const label = PROVIDER_LABEL[provider];
    const p = provider === "gemini" ? await pingGemini({ apiKey: key, model: m }) : await pingProvider(provider, { apiKey: key, model: m });
    if (p.ok) {
      lines.push(L(`✅ Conexion con ${label} (\`${m}\`): HTTP 200${p.ms ? ` en ${p.ms} ms` : ""}`, `✅ Connection to ${label} (\`${m}\`): HTTP 200${p.ms ? ` in ${p.ms} ms` : ""}`));
      if (p.modelExists != null) lines.push(L(`${ok(p.modelExists)} Modelo \`${m}\` ${p.modelExists ? "disponible" : `NO existe para tu key. Algunos disponibles: ${(p.sampleModels || []).join(", ")}`}`, `${ok(p.modelExists)} Model \`${m}\` ${p.modelExists ? "available" : `does NOT exist for your key. Some available: ${(p.sampleModels || []).join(", ")}`}`));
    } else if (p.status) {
      const e = String(p.apiError || "?");
      const hint = /api key|API_KEY|permission|unauthori/i.test(e) ? L(" — la API key es invalida o no tiene permiso", " — the API key is invalid or lacks permission")
        : /allowlist|proxy|blocked|forbidden/i.test(e) ? L(` — algo en tu red (proxy, firewall, VPN) bloquea a ${label}`, ` — something on your network (proxy, firewall, VPN) is blocking ${label}`)
        : p.status === 429 ? L(" — limite de uso/cuota alcanzado", " — usage/quota limit reached") : "";
      lines.push(L(`❌ ${label} respondio HTTP ${p.status}: ${e}${hint}`, `❌ ${label} responded HTTP ${p.status}: ${e}${hint}`));
    } else {
      lines.push(L(`❌ No hay conexion con ${label}: ${p.networkError} — revisa internet, proxy, VPN o antivirus`, `❌ No connection to ${label}: ${p.networkError} — check internet, proxy, VPN or antivirus`));
    }
  }
  lines.push("", "```", diagContext(), "```");
  const text = lines.join("\n");
  log(text);
  post({ type: "system", text, copy: text });
}

// Lista de modelos para el selector de editor del modo arquitecto, ordenada
// del mas barato al mas caro por precio de OUTPUT (que suele dominar el
// costo real de una respuesta) -- asi el usuario ve de un vistazo cual
// conviene para abaratar el modo arquitecto sin tener que ir a mirar
// pricing.js. Usa los mismos precios (con los overrides del usuario) que
// ya se usan para calcular el costo real de cada turno.
function editorModelChoices() {
  const overrides = cfg().get("pricing");
  return MODEL_CHOICES
    .map((model) => ({ model, price: priceFor(model, overrides) }))
    .sort((a, b) => a.price.output - b.price.output);
}

// Modelos realmente en uso ahora mismo (principal, y editor si el modo
// arquitecto esta activo) y si falta alguna API key para ellos -- lo
// comparten postConfig() y el caso "ready", asi el boton 🔑 se pone en
// rojo (y el aviso dice de que proveedor) sin importar si el modelo activo
// es de Gemini, OpenAI o Anthropic.
async function keyStatus() {
  const model = cfg().get("model");
  const architect = Boolean(cfg().get("architect"));
  const editModel = architect ? ((cfg().get("editorModel") || "").trim() || model) : model;
  const missingProvider = await missingApiKeyFor([model, editModel]);
  return { hasKey: !missingProvider, missingProvider };
}

async function postConfig() {
  const { hasKey, missingProvider } = await keyStatus();
  post({
    type: "config",
    lang: i18n.lang(),
    model: cfg().get("model"),
    effort: cfg().get("effort"),
    architect: Boolean(cfg().get("architect")),
    agentMode: Boolean(cfg().get("agentMode")),
    editorModel: (cfg().get("editorModel") || "").trim(),
    editorChoices: editorModelChoices(),
    hasKey,
    missingProvider,
  });
}

// ---------------------------------------------------------------- logs de bugs
function logSummary() {
  return state.logs.map((l) => ({ label: l.label, chars: l.chars, truncated: l.truncated, redacted: l.redacted }));
}

function sendLogsUpdate() {
  post({ type: "logs", logs: logSummary() });
}

function attachLog(raw, label, from) {
  const log = bugLogs.prepareLog(raw, label);
  if (!log) return post({ type: "system", text: L(`No hay texto para adjuntar desde ${from}. Copia el error (por ejemplo de la terminal) y proba de nuevo.`, `No text to attach from ${from}. Copy the error (e.g. from the terminal) and try again.`) });
  const { logs, note } = bugLogs.addLog(state.logs, log);
  state.logs = logs;
  sendLogsUpdate();
  post({ type: "system", text: L(`🐞 Log adjunto: **${log.label}** (${log.chars.toLocaleString("es")} car.). Ahora contame en el chat que estabas haciendo cuando paso; el log se manda en cada turno hasta que lo quites.${note ? "\n\n" + note : ""}`, `🐞 Log attached: **${log.label}** (${log.chars.toLocaleString("en")} chars). Now tell me in the chat what you were doing when it happened; the log is sent every turn until you remove it.${note ? "\n\n" + note : ""}`) });
}

// Diagnosticos del Language Server (Pylance/tsserver/ESLint/etc) para UN
// archivo puntual (v0.21.4) -- enriquece el mensaje de la ronda de correccion
// por verificacion con el detalle exacto que ya calculo el editor (tipo de
// error, regla de lint violada, columna), en vez de solo el stderr crudo de
// py_compile/node --check. NUNCA reemplaza la verificacion real: si no hay
// diagnosticos (LSP no instalado para ese lenguaje, o no llego a analizar
// todavia -- es asincrono, no hay garantia de que ya termino) simplemente no
// agrega nada; jamas se interpreta "sin diagnosticos" como "sin errores".
function lspDiagnosticsFor(relPath) {
  try {
    const items = [];
    for (const [uri, diags] of vscode.languages.getDiagnostics()) {
      if (uri.scheme !== "file" || !diags.length || relPathOf(uri) !== relPath) continue;
      items.push({ path: relPath, diagnostics: diags.map((d) => ({ severity: d.severity, line: d.range.start.line + 1, col: d.range.start.character + 1, message: String(d.message), source: d.source })) });
    }
    return bugLogs.formatDiagnostics(items);
  } catch (_) {
    return ""; // best-effort: nunca debe romper la ronda de correccion
  }
}

// Errores y warnings del panel Problems (lo que ya detectaron los linters y
// compiladores de VS Code), de los archivos del proyecto.
function attachProblems() {
  const root = workspaceRoot();
  const items = [];
  for (const [uri, diags] of vscode.languages.getDiagnostics()) {
    if (uri.scheme !== "file" || !diags.length) continue;
    const rel = relPathOf(uri);
    if (!root || rel.startsWith("..") || path.isAbsolute(rel)) continue;
    items.push({ path: rel, diagnostics: diags.map((d) => ({ severity: d.severity, line: d.range.start.line + 1, col: d.range.start.character + 1, message: String(d.message), source: d.source })) });
  }
  const text = bugLogs.formatDiagnostics(items);
  if (!text) return post({ type: "system", text: L("El panel Problems no tiene errores ni warnings en este proyecto.", "The Problems panel has no errors or warnings in this project.") });
  return attachLog(text, `Problems (${text.split("\n").length} linea${text.includes("\n") ? "s" : ""})`, "Problems");
}

// ---------------------------------------------------------------- comandos del chat
const HELP = () => [
  L("**Comandos**", "**Commands**"),
  L("- `/add <ruta o glob>` agrega archivos al chat (ej: `/add src/**/*.js`)", "- `/add <path or glob>` adds files to the chat (e.g. `/add src/**/*.js`)"),
  L("- `/drop <ruta>` o `/drop all` quita archivos del chat", "- `/drop <path>` or `/drop all` removes files from the chat"),
  L("- `/files` lista los archivos en el chat", "- `/files` lists the files in the chat"),
  L("- `/undo` deshace el ultimo cambio de SovNode (y su commit si sigue siendo el ultimo)", "- `/undo` undoes SovNode's last change (and its commit if it's still the latest)"),
  L("- `/clear` borra el historial de la conversacion (no toca archivos)", "- `/clear` clears the conversation history (doesn't touch files)"),
  L("- `/map` muestra el mapa del repositorio que ve el modelo", "- `/map` shows the repository map the model sees"),
  L("- `/cost` costo acumulado de la sesion", "- `/cost` accumulated session cost"),
  L("- `/log` abre el log completo de uso (JSONL)", "- `/log` opens the full usage log (JSONL)"),
  L("- `/diag` diagnostico: API key, conexion real con el proveedor (Gemini/OpenAI/Anthropic), modelo, git, entorno", "- `/diag` diagnostics: API key, real connection to the provider (Gemini/OpenAI/Anthropic), model, git, environment"),
  L("- `/undo force` deshace aunque hayas editado el archivo despues", "- `/undo force` undoes even if you edited the file afterwards"),
  L("- `/architect` (o `/architect on|off`) modo arquitecto: un modelo planea y otro escribe el codigo", "- `/architect` (or `/architect on|off`) architect mode: one model plans and another writes the code"),
  L("- `/format` muestra el formato de edicion (SEARCH/REPLACE, diff unificado o archivo completo) y por que; `/format auto|search-replace|udiff|whole` lo fija", "- `/format` shows the edit format (SEARCH/REPLACE, unified diff or whole file) and why; `/format auto|search-replace|udiff|whole` sets it"),
  L("- `/editor <modelo>` modelo editor para el modo arquitecto (vacio = el mismo modelo)", "- `/editor <model>` editor model for architect mode (empty = same model)"),
  L("- `/task <objetivo>` tarea larga: la divide en pasos chicos y los ejecuta uno tras otro solo (Detener para frenarla)", "- `/task <goal>` long task: splits it into small steps and runs them one after another on its own (Stop to halt it)"),
  L("- `/bug` adjunta como log lo que tengas copiado (un error, un traceback, la salida de la terminal): queda APARTE del chat, en todos los turnos, hasta que lo quites. `/bug problems` adjunta los errores del panel Problems; `/bug clear` los quita. Tambien con el boton 🐞", "- `/bug` attaches whatever you have copied (an error, a traceback, terminal output) as a log: it stays SEPARATE from the chat, in every turn, until you remove it. `/bug problems` attaches the errors from the Problems panel; `/bug clear` removes them. Also via the 🐞 button"),
  L("- `/undo task` deshace TODOS los pasos de la ultima tarea (`/task`), en orden inverso (`/undo task force` para forzar)", "- `/undo task` undoes ALL steps of the last task (`/task`), in reverse order (`/undo task force` to force)"),
].join("\n");

// Que archivos de `snap` fueron editados A MANO despues de ese turno --
// deshacer los pisaria en silencio, asi que se usa tanto en /undo como en
// /undo task para decidir si hace falta confirmar con "force".
async function manualEditsSince(snap) {
  const changed = [];
  for (const f of snap.files) {
    const now = await currentText(f.path);
    const expected = f.after;
    if (now !== null && expected != null && now.replace(/\r\n/g, "\n") !== expected.replace(/\r\n/g, "\n")) changed.push(f.path);
  }
  return changed;
}

// Revierte UN snapshot ya sacado de la pila: su commit de git (si sigue
// siendo HEAD) y el contenido de sus archivos. Devuelve una linea de texto
// para el resumen. Compartido por undoLast() y undoTask().
async function revertSnapshot(snap) {
  let gitNote = "";
  if (snap.commit) {
    try {
      const r = await gitUtil.undoCommit(workspaceRoot().fsPath, snap.commit);
      gitNote = r.ok ? L(` Commit ${snap.commit.slice(0, 7)} eliminado.`, ` Commit ${snap.commit.slice(0, 7)} removed.`) : ` ${r.reason}`;
    } catch (e) {
      gitNote = L(` No se pudo revertir el commit: ${e.message}`, ` Could not revert the commit: ${e.message}`);
    }
  }
  await restoreFiles(snap);
  for (const f of snap.files) if (f.created) state.chatFiles.delete(f.path);
  return L(`turno #${snap.turnId}: ${snap.files.map((f) => (f.created ? `borrado ${f.path}` : `restaurado ${f.path}`)).join(", ")}.${gitNote}`, `turn #${snap.turnId}: ${snap.files.map((f) => (f.created ? `deleted ${f.path}` : `restored ${f.path}`)).join(", ")}.${gitNote}`);
}

// /undo y /undo task toman el mismo candado que un turno: sin esto, dos
// /undo seguidos (boton + comando) leian el MISMO snapshot del tope antes de
// que el primero hiciera pop, lo revertian dos veces y el segundo pop tiraba
// a la basura el snapshot de OTRO turno, que ya no se podia deshacer nunca.
async function exclusive(fn) {
  if (state.busy) return post({ type: "system", text: L("No se puede deshacer mientras un turno esta en curso.", "Can't undo while a turn is in progress.") });
  state.busy = true;
  try {
    return await fn();
  } finally {
    state.busy = false;
  }
}

function undoLast(force) {
  return exclusive(() => undoLastInner(force));
}

function undoTask(force) {
  return exclusive(() => undoTaskInner(force));
}

async function undoLastInner(force) {
  const snap = state.undoStack[state.undoStack.length - 1];
  if (!snap) return post({ type: "system", text: L("No hay cambios de SovNode para deshacer.", "No SovNode changes to undo.") });
  // Si editaste esos archivos DESPUES del turno, deshacer borraria tu trabajo:
  // se avisa y se pide confirmar (/undo force) en vez de pisarlo en silencio.
  if (!force) {
    const changed = await manualEditsSince(snap);
    if (changed.length) return post({ type: "system", text: L(`Modificaste ${changed.join(", ")} despues del turno #${snap.turnId}. Deshacer perderia esos cambios. Si igual quieres, escribe \`/undo force\`.`, `You modified ${changed.join(", ")} after turn #${snap.turnId}. Undoing would lose those changes. If you still want to, type \`/undo force\`.`) });
  }
  state.undoStack.pop();
  const line = await revertSnapshot(snap);
  sendFilesUpdate();
  post({ type: "system", text: L(`Deshecho el ${line}`, `Undid ${line}`) });
}

// Deshace TODOS los pasos de la ultima tarea (/task) de un solo golpe, en
// orden inverso (el paso mas reciente primero -- asi cada commit de git
// sigue siendo HEAD en el momento de revertirlo, igual que /undo normal).
// Solo agrupa snapshots CONSECUTIVOS al tope de la pila con el mismo
// taskId: una tarea nunca se interrumpe con otro turno en el medio (state.busy
// lo impide), asi que "consecutivos desde el tope" es siempre exactamente
// los pasos de esa tarea.
async function undoTaskInner(force) {
  const top = state.undoStack[state.undoStack.length - 1];
  if (!top) return post({ type: "system", text: L("No hay cambios de SovNode para deshacer.", "No SovNode changes to undo.") });
  if (!top.taskId) return post({ type: "system", text: L("El ultimo cambio no fue parte de una tarea (/task); usa `/undo` a secas.", "The last change wasn't part of a task (/task); use plain `/undo`.") });
  const taskId = top.taskId;
  const group = [];
  for (let i = state.undoStack.length - 1; i >= 0 && state.undoStack[i].taskId === taskId; i--) group.push(state.undoStack[i]);

  if (!force) {
    // Un archivo tocado por VARIOS pasos de la misma tarea va a diferir del
    // `after` de los pasos mas viejos a proposito (el paso siguiente lo
    // siguio editando) -- eso no es una edicion manual. Solo importa si el
    // contenido ACTUAL difiere del `after` del paso MAS RECIENTE que toco
    // ese archivo (el primero que aparece, porque `group` va del mas nuevo
    // al mas viejo).
    const seenPaths = new Set();
    const onlyLatestPerPath = group.map((snap) => ({
      ...snap,
      files: snap.files.filter((f) => (seenPaths.has(f.path) ? false : (seenPaths.add(f.path), true))),
    }));
    const changed = new Set();
    for (const snap of onlyLatestPerPath) for (const p of await manualEditsSince(snap)) changed.add(p);
    if (changed.size) return post({ type: "system", text: L(`Modificaste ${[...changed].join(", ")} despues de la tarea. Deshacerla completa perderia esos cambios. Si igual quieres, escribe \`/undo task force\`.`, `You modified ${[...changed].join(", ")} after the task. Undoing it entirely would lose those changes. If you still want to, type \`/undo task force\`.`) });
  }

  state.undoStack.length -= group.length;
  const lines = [];
  for (const snap of group) lines.push(await revertSnapshot(snap));
  sendFilesUpdate();
  post({ type: "system", text: L(`Deshecha la tarea completa (${group.length} paso${group.length === 1 ? "" : "s"}):\n`, `Undid the whole task (${group.length} step${group.length === 1 ? "" : "s"}):\n`) + lines.map((l) => `- ${l}`).join("\n") });
}

async function handleSlash(text) {
  const [cmd, ...rest] = text.trim().split(/\s+/);
  const arg = rest.join(" ");
  switch (cmd) {
    case "/help":
      return post({ type: "system", text: HELP() });
    case "/add": {
      if (!arg) return post({ type: "system", text: L("Uso: `/add ruta/archivo.ext` o `/add src/**/*.js`", "Usage: `/add path/file.ext` or `/add src/**/*.js`") });
      if (!workspaceRoot()) return post({ type: "system", text: L("Abre una carpeta primero.", "Open a folder first.") });
      const found = await vscode.workspace.findFiles(arg.replace(/\\/g, "/"), "**/{node_modules,.git}/**", 50);
      if (!found.length) return post({ type: "system", text: L(`No encontre archivos para \`${arg}\`.`, `No files found for \`${arg}\`.`) });
      for (const u of found) state.chatFiles.add(relPathOf(u));
      sendFilesUpdate();
      return post({ type: "system", text: L(`Agregados: ${found.map(relPathOf).join(", ")}`, `Added: ${found.map(relPathOf).join(", ")}`) });
    }
    case "/drop":
      if (arg === "all" || !arg) state.chatFiles.clear();
      else state.chatFiles.delete(arg.replace(/\\/g, "/"));
      sendFilesUpdate();
      return post({ type: "system", text: arg && arg !== "all" ? L(`Quitado ${arg}.`, `Removed ${arg}.`) : L("Quitados todos los archivos agregados (el activo se sigue incluyendo).", "Removed all added files (the active one is still included).") });
    case "/files":
      return post({ type: "system", text: contextPaths().map((f) => `- \`${f.path}\`${f.active ? L(" (activo)", " (active)") : ""}`).join("\n") || L("No hay archivos en el chat.", "No files in the chat.") });
    case "/undo":
      if (arg === "task" || arg === "task force") return undoTask(arg === "task force");
      return undoLast(arg === "force");
    case "/clear":
      state.history = [];
      state.logs = []; // conversacion nueva = sin los logs del bug anterior
      state.archBases.clear();
      sendLogsUpdate();
      return post({ type: "cleared" });
    case "/bug": {
      // /bug              -> adjunta lo que tengas copiado (ej. de la terminal)
      // /bug problems     -> adjunta los errores del panel Problems
      // /bug clear        -> quita todos los logs
      // /bug <texto>      -> adjunta ese texto como log
      if (arg === "clear") { state.logs = []; sendLogsUpdate(); return post({ type: "system", text: L("Logs quitados del chat.", "Logs removed from the chat.") }); }
      if (arg === "problems") return attachProblems();
      if (!arg) return attachLog(await vscode.env.clipboard.readText(), "", L("el portapapeles", "the clipboard"));
      return attachLog(arg, "", "el comando");
    }
    case "/map": {
      const map = await getRepoMap();
      return post({ type: "system", text: "```\n" + (renderRepoMap(map, [], undefined, undefined, contextPaths().map((f) => f.path)) || L("(mapa vacio: no hay archivos de codigo soportados)", "(empty map: no supported code files)")) + "\n```" });
    }
    case "/cost": {
      const s = state.session;
      const k = s.cost;
      return post({ type: "system", text: L(`**Sesion:** ${s.turns} turnos · in ${s.usage.promptTokens || 0} tok (cache ${s.usage.cachedTokens || 0}) · out ${s.usage.outputTokens || 0} · razonamiento ${s.usage.thoughtTokens || 0}\n**Costo:** input ${fmtUsd(k.inputUsd)} + cache ${fmtUsd(k.cachedUsd)} + output ${fmtUsd(k.outputUsd)} + razonamiento ${fmtUsd(k.thoughtUsd)} = **${fmtUsd(k.totalUsd)}**`, `**Session:** ${s.turns} turns · in ${s.usage.promptTokens || 0} tok (cache ${s.usage.cachedTokens || 0}) · out ${s.usage.outputTokens || 0} · reasoning ${s.usage.thoughtTokens || 0}\n**Cost:** input ${fmtUsd(k.inputUsd)} + cache ${fmtUsd(k.cachedUsd)} + output ${fmtUsd(k.outputUsd)} + reasoning ${fmtUsd(k.thoughtUsd)} = **${fmtUsd(k.totalUsd)}**`) });
    }
    case "/log":
      return vscode.commands.executeCommand("sovnodeAider.showUsageLog");
    case "/diag":
      return runDiagnostics();
    case "/architect": {
      const on = arg === "on" ? true : arg === "off" ? false : !cfg().get("architect");
      await cfg().update("architect", on, vscode.ConfigurationTarget.Global);
      const ed = (cfg().get("editorModel") || "").trim() || cfg().get("model");
      await postConfig();
      return post({ type: "system", text: on ? L(`Modo arquitecto **activado**: ${cfg().get("model")} planea → ${ed} escribe el codigo. Cambia el editor con \`/editor <modelo>\`.`, `Architect mode **on**: ${cfg().get("model")} plans → ${ed} writes the code. Change the editor with \`/editor <model>\`.`) : L("Modo arquitecto **desactivado**: un solo modelo planea y edita.", "Architect mode **off**: a single model plans and edits.") });
    }
    case "/agent": {
      const on = arg === "on" ? true : arg === "off" ? false : !cfg().get("agentMode");
      await cfg().update("agentMode", on, vscode.ConfigurationTarget.Global);
      await postConfig();
      const b = Number(cfg().get("taskBudgetUSD")) || 0;
      return post({ type: "system", text: on ? L(`Modo agente **activado** para \`/task\`: si un paso falla, reintenta con el error real (hasta ${AGENT_MAX_ATTEMPTS - 1} veces) y si se traba en el mismo error replanifica lo que falta. Presupuesto por tarea: ${b ? fmtUsd(b) + " (al llegar, pregunta)" : "sin tope"}. Cuesta mas que el modo normal cuando algo falla.`, `Agent mode **on** for \`/task\`: if a step fails, it retries with the real error (up to ${AGENT_MAX_ATTEMPTS - 1} times) and if it gets stuck on the same error it replans the rest. Budget per task: ${b ? fmtUsd(b) + " (asks when reached)" : "no cap"}. Costs more than normal mode when something fails.`) : L("Modo agente **desactivado**: `/task` se detiene en el primer paso que falla (mas barato, vos decidis).", "Agent mode **off**: `/task` stops at the first failing step (cheaper, you decide).") });
    }
    case "/auto": {
      if (arg === "off") {
        const t = await autoTiers();
        await cfg().update("model", t ? t.medio : MODEL_CHOICES[0], vscode.ConfigurationTarget.Global);
        await postConfig();
        return post({ type: "system", text: L(`Modo Auto **desactivado**: modelo fijo \`${cfg().get("model")}\`.`, `Auto mode **off**: fixed model \`${cfg().get("model")}\`.`) });
      }
      await cfg().update("model", AUTO, vscode.ConfigurationTarget.Global);
      await postConfig();
      const t = await autoTiers();
      return post({ type: "system", text: t
        ? L(`Modo Auto **activado**. Niveles: barato \`${t.barato}\` · medio \`${t.medio}\` · fuerte \`${t.fuerte}\` (entre los modelos con API key, por precio; fijalos con el ajuste \`sovnodeAider.autoModels\`). Cada turno elige el nivel por reglas: contexto grande, pedido largo o dificil, error adjunto, turno anterior fallido. Nivel fuerte = arquitecto (fuerte planea, medio escribe). En /task el fuerte planifica; con modo agente los pasos van con el barato y escalan al fuerte si fallan. Ignora /architect, /editor y /stepmodel mientras este activo.`, `Auto mode **on**. Levels: cheap \`${t.barato}\` · medium \`${t.medio}\` · strong \`${t.fuerte}\` (among models with an API key, by price; pin them with the \`sovnodeAider.autoModels\` setting). Each turn picks the level by rules: large context, long or hard request, attached error, previous turn failed. Strong level = architect (strong plans, medium writes). In /task the strong one plans; with agent mode the steps use the cheap one and escalate to strong if they fail. Ignores /architect, /editor and /stepmodel while active.`)
        : L("Modo Auto activado, pero no hay ninguna API key guardada todavia (🔑).", "Auto mode on, but no API key is saved yet (🔑).") });
    }
    case "/stepmodel": {
      await cfg().update("agentStepModel", arg, vscode.ConfigurationTarget.Global);
      return post({ type: "system", text: arg ? L(`Modo agente: los pasos los hace \`${arg}\`; ${cfg().get("model")} planifica y entra solo si un paso falla.`, `Agent mode: steps are done by \`${arg}\`; ${cfg().get("model")} plans and steps in only if a step fails.`) : L("Modo agente: los pasos usan el modelo principal (sin modelo barato).", "Agent mode: steps use the main model (no cheap model).") });
    }
    case "/editor": {
      await cfg().update("editorModel", arg, vscode.ConfigurationTarget.Global);
      await postConfig();
      return post({ type: "system", text: arg ? L(`Modelo editor: \`${arg}\`.`, `Editor model: \`${arg}\`.`) : L("Modelo editor: el mismo que el principal.", "Editor model: same as the main one.") });
    }
    case "/format": {
      // /format            -> que formato se usaria ahora y por que
      // /format <formato>  -> fijarlo (auto | search-replace | udiff | whole)
      if (arg) {
        const f = editFormats.normalizeFormat(arg);
        if (!f) return post({ type: "system", text: L(`Formato desconocido: \`${arg}\`. Opciones: \`auto\`, \`search-replace\`, \`udiff\`, \`whole\`.`, `Unknown format: \`${arg}\`. Options: \`auto\`, \`search-replace\`, \`udiff\`, \`whole\`.`) });
        await cfg().update("editFormat", f, vscode.ConfigurationTarget.Global);
      }
      const model = cfg().get("model");
      const ed = cfg().get("architect") ? ((cfg().get("editorModel") || "").trim() || model) : model;
      const setting = cfg().get("editFormat") || "auto";
      const r = resolveEditFormat(setting, ed, 0);
      const autoNote = setting === "auto" ? L("\n\n`auto` elige por el modelo que escribe el codigo: modelos chicos (lite/luna/haiku/mini) → archivo completo (si los archivos en el chat no pasan 12k caracteres; si pasan, SEARCH/REPLACE), OpenAI → diff unificado, el resto → SEARCH/REPLACE. Cambialo con `/format search-replace|udiff|whole|auto`.", "\n\n`auto` picks by the model that writes the code: small models (lite/luna/haiku/mini) → whole file (if the files in the chat stay under 12k characters; otherwise SEARCH/REPLACE), OpenAI → unified diff, the rest → SEARCH/REPLACE. Change it with `/format search-replace|udiff|whole|auto`.") : "";
      return post({ type: "system", text: L(`Formato de edicion: **${FORMAT_LABEL[r.format]}** (\`${setting}\`, para \`${ed}\`): ${r.reason}.${autoNote}`, `Edit format: **${FORMAT_LABEL[r.format]}** (\`${setting}\`, for \`${ed}\`): ${r.reason}.${autoNote}`) });
    }
    case "/task":
      if (!arg) return post({ type: "system", text: L("Uso: `/task <lo que quieres lograr>` (ej: `/task agrega login con email y contrasena`)", "Usage: `/task <what you want to achieve>` (e.g. `/task add email and password login`)") });
      return runTask(arg);
    default:
      return post({ type: "system", text: L(`Comando desconocido: ${cmd}. Escribe /help.`, `Unknown command: ${cmd}. Type /help.`) });
  }
}

async function onWebviewMessage(msg) {
  switch (msg.type) {
    case "ready": {
      const { hasKey, missingProvider } = await keyStatus();
      return post({
        type: "init",
        lang: i18n.lang(),
        model: cfg().get("model"),
        effort: cfg().get("effort"),
        architect: Boolean(cfg().get("architect")),
        editorModel: (cfg().get("editorModel") || "").trim(),
        editorChoices: editorModelChoices(),
        models: [...new Set([...MODEL_CHOICES, cfg().get("model")])],
        // Agrupado por proveedor para el <select> del modelo principal (con
        // <optgroup>, ver renderModelGroups en chat.js) -- puramente
        // cosmetico, el valor que importa sigue siendo el string del modelo.
        modelGroups: { [L("Automatico", "Automatic")]: [AUTO], Gemini: MODEL_CHOICES_GEMINI, OpenAI: MODEL_CHOICES_OPENAI, Anthropic: MODEL_CHOICES_ANTHROPIC },
        hasKey, missingProvider,
        files: contextPaths(),
        logs: logSummary(),
        session: state.session,
      });
    }
    case "send": {
      const text = (msg.text || "").trim();
      if (!text) return;
      if (text.startsWith("/")) return guardedSlash(text);
      return runTurn(text);
    }
    case "cancel":
      if (state.abort) state.abort.abort();
      return;
    // Logs de bug (panel 🐞 del chat). No toman el candado del turno: solo
    // cambian lo que se manda en el PROXIMO turno (el actual ya armo su
    // contexto), igual que agregar un archivo.
    case "attachLog":
      return attachLog(msg.text, msg.label, "el panel de logs");
    case "logFromClipboard":
      return attachLog(await vscode.env.clipboard.readText(), msg.label, L("el portapapeles", "the clipboard"));
    case "logFromProblems":
      return attachProblems();
    case "dropLog":
      if (Number.isInteger(msg.index) && msg.index >= 0 && msg.index < state.logs.length) state.logs.splice(msg.index, 1);
      return sendLogsUpdate();
    case "previewLog": {
      const l = state.logs[msg.index];
      if (!l) return;
      const doc = await vscode.workspace.openTextDocument({ content: l.text, language: "log" });
      return vscode.window.showTextDocument(doc, { preview: true });
    }
    case "setModel":
      return cfg().update("model", msg.value, vscode.ConfigurationTarget.Global);
    case "setEffort":
      return cfg().update("effort", msg.value, vscode.ConfigurationTarget.Global);
    case "setEditorModel":
      return cfg().update("editorModel", msg.value, vscode.ConfigurationTarget.Global);
    case "setKey":
      return vscode.commands.executeCommand("sovnodeAider.setApiKey");
    case "addActive": {
      const rel = activeRelPath();
      if (rel) state.chatFiles.add(rel);
      return sendFilesUpdate();
    }
    case "dropFile":
      state.chatFiles.delete(msg.path);
      return sendFilesUpdate();
    case "openFile": {
      const doc = await vscode.workspace.openTextDocument(uriOf(msg.path));
      const line = Math.max(0, (msg.line || 1) - 1);
      return vscode.window.showTextDocument(doc, { selection: new vscode.Range(line, 0, line, 0) });
    }
    case "showDiff": {
      const before = vscode.Uri.from({ scheme: BEFORE_SCHEME, path: "/" + msg.path, query: `turn=${msg.turnId}` });
      return vscode.commands.executeCommand("vscode.diff", before, uriOf(msg.path), `${path.posix.basename(msg.path)} (antes ↔ despues, turno #${msg.turnId})`);
    }
    case "undo":
      return undoLast();
    case "slash":
      // Mismo candado que "send": antes este camino (botones del webview) se
      // lo salteaba, y un /clear en medio de un turno vaciaba el historial
      // justo antes de que el turno en curso le escribiera su respuesta.
      return guardedSlash(String(msg.text || ""));
    case "copyText":
      await vscode.env.clipboard.writeText(msg.text || "");
      vscode.window.setStatusBarMessage(msg.quiet ? "SovNode: copiado al portapapeles." : "SovNode: diagnostico copiado al portapapeles.", 3000);
      return;
    case "showLog":
      return vscode.commands.executeCommand("sovnodeAider.showUsageLog");
  }
}

// Comandos de solo lectura que se pueden usar con un turno en curso; el resto
// (/clear, /add, /architect, /undo...) cambia estado que el turno esta usando.
const SLASH_OK_WHILE_BUSY = ["/help", "/files", "/cost", "/log", "/diag", "/map", "/bug"]; // /bug solo afecta al PROXIMO turno
function guardedSlash(text) {
  const cmd = text.trim().split(/\s+/)[0];
  if (state.busy && !SLASH_OK_WHILE_BUSY.includes(cmd)) {
    return post({ type: "system", text: L(`Espera a que termine el turno actual para usar ${cmd}.`, `Wait for the current turn to finish before using ${cmd}.`) });
  }
  return handleSlash(text);
}

// ---------------------------------------------------------------- webview
let chatProvider = null;
class ChatViewProvider {
  resolveWebviewView(webviewView) {
    view = webviewView;
    this.render(webviewView);
  }
  render(webviewView) {
    const media = vscode.Uri.joinPath(extContext.extensionUri, "media");
    webviewView.webview.options = { enableScripts: true, localResourceRoots: [media] };
    const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const css = webviewView.webview.asWebviewUri(vscode.Uri.joinPath(media, "chat.css"));
    const js = webviewView.webview.asWebviewUri(vscode.Uri.joinPath(media, "chat.js"));
    const csp = webviewView.webview.cspSource;
    webviewView.webview.html = `<!DOCTYPE html>
<html lang="${i18n.lang()}"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp}; script-src 'nonce-${nonce}'; font-src ${csp};">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}"></head>
<body>
<header id="top">
  <div class="bar">
    <div class="brand"><span class="logo">◆</span><span>SovNode</span><span id="status" class="status" title="${L("Listo", "Ready")}"></span></div>
    <div class="actions">
      <button class="icon" id="btnAgent" title="${L("Modo agente (/agent): /task reintenta y replanifica solo cuando algo falla", "Agent mode (/agent): /task retries and replans only when something fails")}">🤖</button>
      <button class="icon" id="btnArch" title="${L("Modo arquitecto (/architect): un modelo planea, otro escribe el codigo", "Architect mode (/architect): one model plans, another writes the code")}">🏛</button>
      <button class="icon" id="btnKey" title="API key (Gemini/OpenAI/Anthropic)">🔑</button>
      <button class="icon" id="btnUndo" title="${L("Deshacer ultimo cambio (/undo)", "Undo last change (/undo)")}">↶</button>
      <button class="icon" id="btnClear" title="${L("Nueva conversacion (/clear)", "New conversation (/clear)")}">＋</button>
    </div>
  </div>
  <div class="bar selects">
    <label class="field grow" title="${L("Modelo principal (el proveedor se detecta por el nombre)", "Main model (the provider is detected from the name)")}"><span>${L("Modelo", "Model")}</span><select id="model"></select></label>
    <label class="field" title="${L("Effort: presupuesto de razonamiento y techo de salida", "Effort: reasoning budget and output ceiling")}"><span>Effort</span><select id="effort">
      <option value="low">low</option><option value="medium">medium</option><option value="high">high</option><option value="extra">extra</option>
    </select></label>
  </div>
  <div class="bar selects" id="editorRow" hidden>
    <label class="field grow" title="${L("Modelo editor del modo arquitecto (el que escribe el codigo)", "Architect mode editor model (the one that writes the code)")}"><span>Editor</span><select id="editorModel"></select></label>
  </div>
</header>
<div id="session" title="${L("Costo acumulado de esta sesion", "Accumulated cost for this session")}"></div>
<main id="messages">
  <div class="empty" id="empty">
    <div class="logo big">◆</div>
    <h2>SovNode</h2>
    <p>${L("Pedi cambios en tu codigo o que cree archivos nuevos. Vas a ver <b>que</b> cambio, <b>donde</b> y <b>cuanto costo</b> cada turno.", "Ask for changes to your code or for new files. You\'ll see <b>what</b> changed, <b>where</b> and <b>how much</b> each turn cost.")}</p>
    <p class="hint">${L("¿Algo falla? Pega el error con <b>🐞</b> (queda aparte) y conta en el chat que estabas haciendo.", "Something broken? Paste the error with <b>🐞</b> (kept separate) and tell the chat what you were doing.")}</p>
    <div class="examples">
      <button class="ex">${L("Explicame que hace el archivo abierto", "Explain what the open file does")}</button>
      <button class="ex">${L("Crea un index.html con un juego de la serpiente", "Create an index.html with a snake game")}</button>
      <button class="ex">/diag</button>
      <button class="ex">/help</button>
    </div>
  </div>
</main>
<button id="toBottom" class="tobottom" title="${L("Ir al final", "Jump to bottom")}" hidden>↓</button>
<footer>
  <div id="logPanel" class="logpanel" hidden>
    <div class="lp-head"><b>${L("🐞 Adjuntar log de error", "🐞 Attach error log")}</b><span class="muted">${L("Queda aparte del chat y se manda en cada turno hasta que lo quites.", "Kept separate from the chat and sent every turn until you remove it.")}</span></div>
    <textarea id="logText" rows="6" placeholder="${L("Pega aca el error, el traceback o la salida de la terminal...", "Paste the error, traceback or terminal output here...")}"></textarea>
    <input id="logLabel" type="text" placeholder="${L("Nombre (opcional, ej: crash al disparar)", "Name (optional, e.g. crash when shooting)")}">
    <div class="lp-actions">
      <button class="btn primary" id="logAdd">${L("Adjuntar", "Attach")}</button>
      <button class="btn" id="logClip" title="${L("Adjuntar lo que tengas copiado (ej. desde la terminal)", "Attach whatever you have copied (e.g. from the terminal)")}">${L("Desde portapapeles", "From clipboard")}</button>
      <button class="btn" id="logProblems" title="${L("Errores y warnings del panel Problems de VS Code", "Errors and warnings from the VS Code Problems panel")}">${L("Desde Problems", "From Problems")}</button>
      <button class="btn ghost" id="logCancel">${L("Cancelar", "Cancel")}</button>
    </div>
  </div>
  <div id="chips"></div>
  <div class="composer">
    <textarea id="q" rows="1" placeholder="${L("Pedi un cambio, crea archivos, o /help...", "Ask for a change, create files, or /help...")}"></textarea>
    <div class="composer-bar">
      <button class="icon" id="btnLog" title="${L("Adjuntar log de error (/bug)", "Attach error log (/bug)")}">🐞</button>
      <span class="hint">${L("Enter envia · Shift+Enter salto de linea", "Enter sends · Shift+Enter new line")}</span>
      <button id="send" title="${L("Enviar (Enter)", "Send (Enter)")}">➤</button>
      <button id="stop" title="${L("Detener", "Stop")}" hidden>■</button>
    </div>
  </div>
</footer>
<script nonce="${nonce}" src="${js}"></script>
</body></html>`;
    webviewView.webview.onDidReceiveMessage((m) =>
      onWebviewMessage(m).catch((e) => {
        const stack = (e && e.stack) || "(sin stack)";
        log(`[error] mensaje "${m && m.type}" del webview: ${e && e.message}\n${stack}`);
        output.show(true);
        post({ type: "error", text: String((e && e.message) || e), stack: `${stack}\n\n--- contexto ---\naccion: ${m && m.type}\n${diagContext()}` });
      })
    );
    webviewView.onDidDispose(() => (view = null));
  }
}

// ---------------------------------------------------------------- activacion
function activate(context) {
  extContext = context;
  i18n.init({ setting: () => cfg().get("language"), envLang: () => (vscode.env && vscode.env.language) || "en" });
  output = vscode.window.createOutputChannel("SovNode");
  context.subscriptions.push(output);
  initSessionLog();
  state.lastEditor = vscode.window.activeTextEditor || null;

  // Red de seguridad: cualquier excepcion/rechazo que se escape de nuestros
  // try/catch (un bug que no anticipamos) igual queda registrado aqui y
  // visible en el chat, en vez de perderse en un log que nadie mira.
  // "Missing dataLength in event" es un bug conocido, inofensivo, de la
  // instrumentacion de red del inspector de Node que VS Code activa en modo
  // debug (F5) -- aparece con CUALQUIER llamada https mientras se depura,
  // no viene de nuestro codigo, y no interrumpe la respuesta real. Se
  // registra igual (por si acaso) pero sin asustar al usuario en el chat.
  const BENIGN_INSPECTOR_BUG = /Missing dataLength in event/;
  const onUncaught = (label) => (err) => {
    const stack = (err && err.stack) || String(err);
    const benign = BENIGN_INSPECTOR_BUG.test((err && err.message) || String(err));
    log(`[${benign ? "info" : "fatal"}] ${label}${benign ? " (ruido conocido del inspector de VS Code, no afecta nada)" : ""}: ${stack}`);
    if (benign) return;
    output.show(true);
    post({ type: "error", text: L(`Error interno no manejado (${label}): ${(err && err.message) || err}`, `Unhandled internal error (${label}): ${(err && err.message) || err}`), stack: `${stack}\n\n--- contexto ---\n${diagContext()}` });
  };
  // Se registran UNA vez y se quitan al desactivar: antes se acumulaban en
  // cada recarga de la extension.
  const onExc = onUncaught("uncaughtException");
  const onRej = onUncaught("unhandledRejection");
  process.on("uncaughtException", onExc);
  process.on("unhandledRejection", onRej);
  context.subscriptions.push({ dispose: () => { process.off("uncaughtException", onExc); process.off("unhandledRejection", onRej); } });

  const watcher = vscode.workspace.createFileSystemWatcher("**/*");
  const invalidate = () => { repoMapCache = null; repoMapGen++; };
  watcher.onDidChange(invalidate);
  watcher.onDidCreate(invalidate);
  watcher.onDidDelete(invalidate);
  context.subscriptions.push(watcher);

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((ed) => {
      if (ed && ["file", "untitled"].includes(ed.document.uri.scheme)) state.lastEditor = ed;
      sendFilesUpdate();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("sovnodeAider.language") && view && chatProvider) chatProvider.render(view); // textos del HTML
      if (e.affectsConfiguration("sovnodeAider")) postConfig();
    }),
    vscode.workspace.registerTextDocumentContentProvider(BEFORE_SCHEME, {
      provideTextDocumentContent(uri) {
        const turn = /turn=(\d+)/.exec(uri.query);
        return state.beforeStore.get(`${turn ? turn[1] : ""}|${uri.path.replace(/^\//, "")}`) || "";
      },
    }),
    vscode.window.registerWebviewViewProvider("sovnodeAider.chatView", (chatProvider = new ChatViewProvider()), { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand("sovnodeAider.setApiKey", async () => {
      // Multi-proveedor: hay que preguntar CUAL de las 3 API keys se quiere
      // guardar/cambiar -- no hay una sola "la" key como antes de v0.11. El
      // proveedor que falta (si hay uno, segun el modelo/editor configurado
      // ahora mismo) queda primero en la lista para que el caso comun (F5,
      // pulsar 🔑 porque falta una) sea un clic menos.
      const { missingProvider } = await keyStatus();
      const providers = ["gemini", "openai", "anthropic"];
      const order = missingProvider ? [Object.keys(PROVIDER_LABEL).find((p) => PROVIDER_LABEL[p] === missingProvider), ...providers] : providers;
      const seen = new Set();
      const items = [];
      for (const p of order) {
        if (!p || seen.has(p)) continue;
        seen.add(p);
        const has = Boolean(await apiKeyFor(p));
        items.push({ label: PROVIDER_LABEL[p], description: has ? L("ya tiene una key guardada", "already has a saved key") : L("sin key", "no key"), provider: p });
      }
      const picked = await vscode.window.showQuickPick(items, { placeHolder: L("Que proveedor? (el modelo que uses decide cual hace falta -- ver /diag)", "Which provider? (the model you use decides which one is needed -- see /diag)") });
      if (!picked) return;
      const key = await vscode.window.showInputBox({
        prompt: L(`Tu API key de ${picked.label} (se guarda cifrada en el almacen de secretos de VS Code, nunca en texto plano)`, `Your ${picked.label} API key (stored encrypted in VS Code's secret storage, never in plain text)`),
        password: true,
        ignoreFocusOut: true,
      });
      if (key) {
        await context.secrets.store(SECRET_KEY_FOR(picked.provider), key.trim());
        vscode.window.showInformationMessage(L(`SovNode: API key de ${picked.label} guardada.`, `SovNode: ${picked.label} API key saved.`));
        postConfig();
      }
    }),
    vscode.commands.registerCommand("sovnodeAider.openChat", () => vscode.commands.executeCommand("sovnodeAider.chatView.focus")),
    vscode.commands.registerCommand("sovnodeAider.undo", () => undoLast()),
    vscode.commands.registerCommand("sovnodeAider.editProjectMemory", () => openProjectMemory()),
    vscode.commands.registerCommand("sovnodeAider.toggleArchitect", async () => {
      await vscode.commands.executeCommand("sovnodeAider.chatView.focus");
      return handleSlash("/architect");
    }),
    vscode.commands.registerCommand("sovnodeAider.toggleAgent", async () => {
      await vscode.commands.executeCommand("sovnodeAider.chatView.focus");
      return handleSlash("/agent");
    }),
    vscode.commands.registerCommand("sovnodeAider.diagnose", async () => {
      await vscode.commands.executeCommand("sovnodeAider.chatView.focus");
      return runDiagnostics();
    }),
    vscode.commands.registerCommand("sovnodeAider.addActiveFile", () => onWebviewMessage({ type: "addActive" })),
    // Adjuntar log: lo seleccionado en el editor (por ejemplo un .log
    // abierto), o si no hay seleccion, lo que haya en el portapapeles.
    vscode.commands.registerCommand("sovnodeAider.attachLog", async () => {
      const ed = vscode.window.activeTextEditor;
      const sel = ed && !ed.selection.isEmpty ? ed.document.getText(ed.selection) : "";
      await vscode.commands.executeCommand("sovnodeAider.chatView.focus").then(undefined, () => {});
      if (sel) return attachLog(sel, "", L("la seleccion", "the selection"));
      return attachLog(await vscode.env.clipboard.readText(), "", L("el portapapeles", "the clipboard"));
    }),
    // Desde el menu del boton derecho de la TERMINAL: toma lo seleccionado
    // ahi (Terminal.selection existe desde VS Code 1.93; en versiones viejas
    // se copia la seleccion al portapapeles y se lee de ahi).
    vscode.commands.registerCommand("sovnodeAider.attachTerminalSelection", async () => {
      const term = vscode.window.activeTerminal;
      let text = term && typeof term.selection === "string" ? term.selection : "";
      if (!text) {
        await vscode.commands.executeCommand("workbench.action.terminal.copySelection").then(undefined, () => {});
        text = await vscode.env.clipboard.readText();
      }
      await vscode.commands.executeCommand("sovnodeAider.chatView.focus").then(undefined, () => {});
      return attachLog(text, "", L("la terminal", "the terminal"));
    }),
    vscode.commands.registerCommand("sovnodeAider.showUsageLog", async () => {
      output.show(true);
      try {
        const doc = await vscode.workspace.openTextDocument(usageLogUri());
        await vscode.window.showTextDocument(doc, { preview: true });
      } catch (_) {
        vscode.window.showInformationMessage(L("Todavia no hay turnos registrados.", "No turns recorded yet."));
      }
    }),
    vscode.commands.registerCommand("sovnodeAider.showSessionLog", async () => {
      if (!sessionLogUri) return vscode.window.showInformationMessage(L("El log de esta sesion todavia no se pudo crear.", "This session's log could not be created yet."));
      try {
        const doc = await vscode.workspace.openTextDocument(sessionLogUri);
        await vscode.window.showTextDocument(doc, { preview: true });
      } catch (_) {
        vscode.window.showInformationMessage(L("Todavia no hay nada registrado en esta sesion.", "Nothing recorded in this session yet."));
      }
    })
  );
  log("SovNode activado. Cada turno se registra aqui con tokens, latencia y costo.");
}

function deactivate() {}

module.exports = { activate, deactivate, _test: { projectMemoryText, initSessionLog, pruneOldSessionLogs, warnIfExpensive, state } };
