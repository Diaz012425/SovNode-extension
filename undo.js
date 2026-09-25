"use strict";

// /undo y /undo task: revierte los snapshots que apila cada turno (archivos y,
// si sigue siendo HEAD, su commit de git).
const gitUtil = require("./git");
const { L } = require("./i18n");
const { state, workspaceRoot, post } = require("./state");
const { currentText, restoreFiles, sendFilesUpdate } = require("./workspaceFiles");

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

module.exports = { manualEditsSince, revertSnapshot, exclusive, undoLast, undoTask };
