"use strict";

// Logs de bugs adjuntos al chat (🐞 / /bug): texto pegado, portapapeles,
// panel Problems, y los diagnosticos del Language Server que enriquecen la
// correccion por verificacion.
const vscode = require("vscode");
const path = require("path");
const bugLogs = require("./logs");
const { L } = require("./i18n");
const { state, workspaceRoot, post } = require("./state");
const { relPathOf } = require("./workspaceFiles");

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

module.exports = { logSummary, sendLogsUpdate, attachLog, lspDiagnosticsFor, attachProblems };
