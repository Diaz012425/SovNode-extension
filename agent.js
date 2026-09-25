"use strict";

// /task y modo agente: un modelo planifica pasos chicos y cada paso corre como
// un turno normal (runTurnInner); en modo agente, con reintentos, replanteo y
// presupuesto por tarea.
const vscode = require("vscode");
const path = require("path");
const { buildContents, taskPlanPrompt } = require("./gemini");
const { computeCost, addUsage, addCost, fmtUsd } = require("./pricing");
const i18n = require("./i18n");
const { L } = i18n;
const { state, cfg, workspaceRoot, post } = require("./state");
const { missingApiKeyFor, isAuto, autoTiers, callLLM, warnIfExpensive } = require("./models");
const { getRepoMap, repoMapParts } = require("./context");
const { validatePath, exists, loadContextFiles, sendFilesUpdate, addAutoChatFile } = require("./workspaceFiles");
const { diagContext } = require("./sessionLog");
const { runTurnInner, parseFileRequest, MAX_FILE_REQUEST_ROUNDS } = require("./turn");

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
      for (const w of wanted) if (!validatePath(w) && (await exists(w))) { addAutoChatFile(path.posix.normalize(w), state.turnCounter + 1); added.push(w); }
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

module.exports = { runTask, parseSteps, AGENT_MAX_ATTEMPTS };
