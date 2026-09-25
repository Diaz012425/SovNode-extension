"use strict";

// Integracion con git al estilo Aider: cada cambio aplicado por SovNode
// queda como un commit propio (facil de ver con git log y de deshacer con
// /undo). Solo actua si la carpeta YA es un repo git -- nunca hace git init
// por su cuenta -- y solo commitea los archivos que SovNode toco, nunca
// otros cambios que tengas a medio hacer.

const { execFile } = require("child_process");

function git(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message || "").trim()));
      resolve(stdout.trim());
    });
  });
}

async function isRepo(cwd) {
  try {
    return (await git(cwd, ["rev-parse", "--is-inside-work-tree"])) === "true";
  } catch (_) {
    return false;
  }
}

async function commitFiles(cwd, relPaths, message) {
  await git(cwd, ["add", "--", ...relPaths]);
  await git(cwd, ["commit", "-m", message, "--", ...relPaths]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

async function head(cwd) {
  try { return await git(cwd, ["rev-parse", "HEAD"]); } catch (_) { return null; }
}

// Deshace el commit de SovNode SOLO si sigue siendo el ultimo (HEAD). Mixed
// reset: el commit desaparece pero el arbol de trabajo queda igual; el
// llamador despues restaura el contenido previo de los archivos.
async function undoCommit(cwd, hash) {
  const h = await head(cwd);
  if (h !== hash) return { ok: false, reason: "Ya hay commits posteriores al de SovNode; no se toca el historial de git (los archivos si se restauran)." };
  await git(cwd, ["reset", "--mixed", "-q", "HEAD~1"]);
  return { ok: true };
}

module.exports = { isRepo, commitFiles, undoCommit };
