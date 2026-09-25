"use strict";

// Estado compartido de la extension: la sesion de chat (state), las
// referencias que fija activate() / el webview (rt) y los helpers minimos que
// usan todos los modulos (cfg, workspaceRoot, log, post). Todo lo mutable vive
// en estos dos objetos -- los modulos nunca guardan una copia propia, asi que
// siempre ven el valor actual.
const vscode = require("vscode");

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

// Referencias de runtime: las fija activate() (extContext, output) y el
// webview al resolverse (view, chatProvider).
const rt = {
  view: null,
  output: null,
  extContext: null,
  chatProvider: null,
};

function cfg() {
  return vscode.workspace.getConfiguration("sovnodeAider");
}

function workspaceRoot() {
  const f = vscode.workspace.workspaceFolders;
  return f && f.length ? f[0].uri : null;
}

function log(line) {
  if (rt.output) rt.output.appendLine(line);
}

function post(msg) {
  if (rt.view) rt.view.webview.postMessage(msg);
}

module.exports = { state, rt, cfg, workspaceRoot, log, post };
