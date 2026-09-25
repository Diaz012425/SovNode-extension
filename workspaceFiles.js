"use strict";

// Archivos del proyecto: rutas (validacion, relativas), lectura/escritura a
// traves de VS Code (misma codificacion que el original) y la lista de
// archivos que estan en el chat.
const vscode = require("vscode");
const path = require("path");
const { state, cfg, workspaceRoot, post } = require("./state");

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

// ---------------------------------------------------------------- archivos automaticos
// Los archivos del chat van ENTEROS en cada llamada, en el mensaje final (la
// parte que nunca se cachea). Los que agrega SovNode solo -- los que crea, o
// los que el modelo pide con NECESITO_ARCHIVOS -- antes se quedaban para
// siempre: veinte turnos despues de crear un proyecto se seguian pagando todos
// en cada pedido aunque se hablara de uno solo. Ahora, si pasan
// chatFileIdleTurns turnos sin que se editen, se nombren en el pedido o en un
// log, ni esten abiertos en el editor, salen del chat: siguen en el mapa del
// repo y el modelo los puede volver a pedir. Los que agrega el usuario (/add,
// boton) quedan fijos hasta /drop.
function addAutoChatFile(rel, turn) {
  if (state.chatFiles.has(rel) && !state.autoChatFiles.has(rel)) return; // ya lo habia agregado el usuario: queda fijo
  state.chatFiles.add(rel);
  state.autoChatFiles.set(rel, turn);
}

function addUserChatFile(rel) {
  state.chatFiles.add(rel);
  state.autoChatFiles.delete(rel);
}

function touchAutoChatFiles(paths, turn) {
  for (const p of paths) if (state.autoChatFiles.has(p)) state.autoChatFiles.set(p, turn);
}

// `text`: el pedido + logs adjuntos (nombrar un archivo lo mantiene).
// Devuelve las rutas que se sacaron del chat.
function pruneIdleChatFiles(text, turn) {
  const idleTurns = Math.max(0, Math.floor(Number(cfg().get("chatFileIdleTurns")) || 0));
  const mentioned = String(text || "").toLowerCase();
  const active = activeRelPath();
  const dropped = [];
  for (const [p, last] of state.autoChatFiles) {
    if (!state.chatFiles.has(p)) { state.autoChatFiles.delete(p); continue; } // /drop, /undo, borrado
    if (p === active || mentioned.includes(p.toLowerCase()) || mentioned.includes(path.posix.basename(p).toLowerCase())) {
      state.autoChatFiles.set(p, turn);
      continue;
    }
    if (idleTurns && turn - last > idleTurns) {
      state.chatFiles.delete(p);
      state.autoChatFiles.delete(p);
      dropped.push(p);
    }
  }
  return dropped;
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

module.exports = {
  activeEditor, relPathOf, activeRelPath, validatePath, uriOf, readRel, exists,
  contextPaths, loadContextFiles, currentSelection, sendFilesUpdate,
  addAutoChatFile, addUserChatFile, touchAutoChatFiles, pruneIdleChatFiles,
  writeChangeSet, currentText, restoreFiles,
};
