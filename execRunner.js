"use strict";

// Ejecucion de comandos que el modelo pide a mitad de un turno (herramienta
// "ejecutar"): confirmacion del usuario, proceso hijo cancelable con Detener.
const vscode = require("vscode");
const execTool = require("./execTool");
const { L } = require("./i18n");
const { state, cfg, workspaceRoot, post } = require("./state");
const { contextPaths } = require("./workspaceFiles");
const { appendSessionLog } = require("./sessionLog");

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

module.exports = { runExecCommand };
