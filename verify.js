"use strict";

// Verificacion automatica tras aplicar cambios, al estilo del auto-lint/test
// de Aider: revisa que lo que SovNode acaba de escribir compile/parsee, y si
// no, junta el error real para que el modelo se corrija solo (ver el bucle
// de reparacion en extension.js). Sin dependencias nuevas: usa el propio
// interprete de Node de VS Code y, si esta instalado, python3/python/py del
// sistema. Un lenguaje sin verificador conocido simplemente se "skippea",
// nunca se inventa un error.

const { spawn } = require("child_process");
const fs = require("fs");

function run(cmd, args, cwd, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd, windowsHide: true });
    } catch (e) {
      return resolve({ ok: false, missing: true, output: e.message });
    }
    let out = "";
    let done = false;
    // Tope a la salida: un comando que escupe megas (o un loop infinito de
    // prints) no puede llenar la memoria del Extension Host.
    const MAX_OUT = 200 * 1024;
    const add = (d) => { if (out.length < MAX_OUT) out += d; };
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      child.kill();
      resolve({ ok: false, timedOut: true, output: `(se corto tras ${timeoutMs / 1000}s sin responder)` });
    }, timeoutMs);
    child.stdout && child.stdout.on("data", add);
    child.stderr && child.stderr.on("data", add);
    child.on("error", (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok: false, missing: e.code === "ENOENT", output: e.message });
    });
    child.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, code, output: out.trim() });
    });
  });
}

// Se detecta una sola vez por sesion cual comando de Python existe (python3,
// python, o en Windows el lanzador "py") -- evita reintentar los que fallan
// en cada turno.
let pythonCmd; // undefined = sin probar, null = ninguno funciona, string = el que sirve
async function findPython() {
  if (pythonCmd !== undefined) return pythonCmd;
  const candidates = process.platform === "win32" ? ["python3", "python", "py"] : ["python3", "python"];
  for (const c of candidates) {
    const r = await run(c, ["--version"], undefined, 4000);
    // Solo si REALMENTE respondio bien: en Windows, "python3"/"python" pueden
    // ser el stub de la Microsoft Store (sale con codigo 9009 sin hacer nada);
    // aceptarlo hacia que CADA .py se reportara como error de sintaxis falso.
    if (r.ok) { pythonCmd = c; return c; }
  }
  pythonCmd = null;
  return null;
}

const EXT_LANG = {
  ".py": "python",
  // .jsx NO: `node --check` no entiende JSX y marcaba como roto cualquier
  // componente valido (dos rondas de correccion pagadas para nada). Mejor
  // "sin verificador" que un fallo inventado.
  ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript",
  ".json": "json",
};

function extOf(p) {
  const i = p.lastIndexOf(".");
  return i === -1 ? "" : p.slice(i).toLowerCase();
}

// Verifica UN archivo ya escrito en disco (absPath). Devuelve:
//  {skipped:true}                        -- no hay verificador para esta extension
//  {ok:true}                             -- compila/parsea bien
//  {ok:false, reason}                    -- error real, con el mensaje del compilador/interprete
async function checkFile(absPath, relPath) {
  const ext = extOf(absPath);
  const lang = EXT_LANG[ext];
  if (!lang) return { skipped: true };

  if (lang === "json") {
    try {
      JSON.parse(fs.readFileSync(absPath, "utf8"));
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  }

  if (lang === "javascript") {
    // process.execPath: el propio Node de VS Code, siempre disponible, en
    // vez de asumir que "node" esta en el PATH del sistema.
    const r = await run(process.execPath, ["--check", absPath], undefined, 10000);
    if (r.missing) return { skipped: true, reason: "no se encontro Node para verificar" };
    return r.ok ? { ok: true } : { ok: false, reason: r.output || "error de sintaxis" };
  }

  if (lang === "python") {
    const py = await findPython();
    if (!py) return { skipped: true, reason: "python no esta instalado o no esta en el PATH" };
    // compile() hace el mismo chequeo que py_compile pero SIN escribir
    // __pycache__/ en la carpeta del usuario.
    const r = await run(py, ["-c", "import sys; compile(open(sys.argv[1], 'rb').read(), sys.argv[1], 'exec')", absPath], undefined, 10000);
    return r.ok ? { ok: true } : { ok: false, reason: r.output || "error de sintaxis" };
  }

  return { skipped: true };
}

// Verifica una lista de {path, absPath} recien escritos. Devuelve
// {ok, results, failures} -- failures trae {path, reason} listo para
// mostrarle al modelo, igual que las fallas de SEARCH/REPLACE.
async function verifyFiles(files) {
  const results = [];
  const failures = [];
  for (const f of files) {
    const res = await checkFile(f.absPath, f.path);
    results.push({ path: f.path, ...res });
    if (res.ok === false) failures.push({ path: f.path, reason: res.reason });
  }
  return { ok: failures.length === 0, results, failures };
}

// Corre un comando de verificacion propio del proyecto (tests, lint), tal
// como el usuario lo escriba en Settings -- via shell, igual que si lo
// tipeara en su terminal.
function runProjectCommand(command, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const { exec } = require("child_process");
    const child = exec(command, { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const output = `${stdout || ""}${stderr || ""}`.trim();
      if (!err) return resolve({ ok: true, output });
      // Salida mas grande que maxBuffer: Node mata el proceso (killed=true),
      // pero NO fue por tiempo -- mostrar lo que alcanzo a salir.
      if (err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return resolve({ ok: false, output: `${output.slice(0, 8000)}\n(salida demasiado larga, cortada)` });
      if (err.killed || err.signal) return resolve({ ok: false, timedOut: true, output: output || "(se corto por tiempo)" });
      resolve({ ok: false, output: output || err.message });
    });
    child.on("error", (e) => resolve({ ok: false, missing: true, output: e.message }));
  });
}

module.exports = { verifyFiles, checkFile, runProjectCommand, findPython };
