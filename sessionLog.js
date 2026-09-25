"use strict";

// Registros: usage.jsonl (una linea por turno, para siempre), el log de esta
// sesion de VS Code (detalle completo) y el contexto de entorno que acompana
// cada error (diagContext).
const vscode = require("vscode");
const { fmtUsd } = require("./pricing");
const { state, rt, cfg, log } = require("./state");

// Datos del entorno que suelen explicar un error: version de VS Code/Node,
// si el depurador (F5) esta activo, proxy, carpetas abiertas, config.
function diagContext() {
  let inspectorOn = false;
  try { inspectorOn = Boolean(require("inspector").url()); } catch (_) { /* sin inspector */ }
  const folders = vscode.workspace.workspaceFolders || [];
  const proxy = vscode.workspace.getConfiguration("http").get("proxy") || process.env.HTTPS_PROXY || process.env.https_proxy || "(ninguno)";
  return [
    `extension: sovnode-aider ${(rt.extContext && rt.extContext.extension && rt.extContext.extension.packageJSON.version) || "?"}`,
    `VS Code ${vscode.version} · Node ${process.versions.node} · Electron ${process.versions.electron || "-"} · ${process.platform}/${process.arch}`,
    `depurador (F5) activo: ${inspectorOn ? "si" : "no"}`,
    `proxy: ${proxy}`,
    `carpetas abiertas: ${folders.length}${folders.length > 1 ? " (multi-root: SovNode usa solo la primera)" : ""}`,
    `log de esta sesion: ${sessionLogUri ? sessionLogUri.fsPath : "(sin crear todavia)"}`,
    `modelo: ${cfg().get("model")} · effort: ${cfg().get("effort")} · streaming: ${cfg().get("streaming")} · autoCommit: ${cfg().get("autoCommit")}`,
  ].join("\n");
}

// ---------------------------------------------------------------- usage.jsonl
function usageLogUri() {
  return vscode.Uri.joinPath(rt.extContext.globalStorageUri, "usage.jsonl");
}

// Escrituras en cola (una a la vez): dos read-modify-write simultaneos
// perdian registros.
let usageLogQueue = Promise.resolve();
function appendUsageLog(record) {
  usageLogQueue = usageLogQueue.then(async () => {
    try {
      await vscode.workspace.fs.createDirectory(rt.extContext.globalStorageUri);
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
  return vscode.Uri.joinPath(rt.extContext.globalStorageUri, "sessions");
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

function getSessionLogUri() {
  return sessionLogUri;
}

module.exports = {
  diagContext, usageLogUri, appendUsageLog, initSessionLog, pruneOldSessionLogs,
  appendSessionLog, getSessionLogUri, logTurn,
};
