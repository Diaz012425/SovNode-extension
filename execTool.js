"use strict";

// Ejecutar comandos a mitad del turno (v0.20): la mitad que le faltaba al
// bucle de herramientas -- el modelo puede correr el script o los tests,
// VER el error real y corregir, en vez de solo leer/buscar y adivinar.
//
// Esto es mas peligroso que leer/buscar (tools.js): un comando puede borrar
// o mandar datos. Reglas de seguridad, todas en este modulo PURO (sin
// vscode, para poder testearlas sin ejecutar nada de verdad):
//
// - SIEMPRE se le pide confirmacion al usuario antes de correr un comando
//   (salvo que ya haya elegido "confiar" en ese comando exacto esta sesion,
//   o que matchee un prefijo de sovnodeAider.execAllowlist).
// - Nada de encadenar comandos: ";", "&&", "||", "|", backticks, "$(...)",
//   redirecciones ">"/"<", saltos de linea. Un pedido de HERRAMIENTAS es UN
//   comando simple, tokenizado a mano (nunca se corre con shell:true).
// - Una lista chica de patrones siempre bloqueados (borrado masivo, formateo,
//   apagar la maquina, etc.), pase lo que pase, ni se le pregunta al usuario.
// - Tiempo maximo por ejecucion (se mata el proceso) y salida acotada +
//   secretos tapados (reusa logs.js) antes de que la vea el modelo.
// - Un solo "ejecutar" por ronda de herramientas (se ignoran los demas
//   pedidos de esa ronda): cada ejecucion es su propio paso, visible aparte.

const { redactSecrets, truncateLog } = require("./logs");

const MAX_CMD_CHARS = 300;
const MAX_OUTPUT_CHARS = 6000;
const DEFAULT_TIMEOUT_MS = 20000;
const MAX_TIMEOUT_MS = 120000;

// Cualquiera de estos en el texto CRUDO (antes de tokenizar) -> se rechaza
// sin ejecutar ni preguntar: no son "un comando simple".
// OJO (v0.21.3): el "(?<!=)" antes de ">" es para no bloquear "=>" -- sin eso,
// CUALQUIER "node -e" con una arrow function de JS (rutina, no exotico) se
// rechazaba como si fuera una redireccion (">"), aunque el "ejecutar" mas
// tipico y util (un one-liner de Node para probar algo) las usa todo el
// tiempo. Sigue bloqueando la redireccion real ("> archivo", ">> archivo").
const BLOCKED_SYNTAX_RE = /[;&|`\n\r]|\$\(|<\(|(?<!=)>\s*[^&]|<\s|&&|\|\|/;

// Patrones siempre bloqueados, sin excepcion (ni allowlist ni "confiar" los
// saltea): borrado masivo, formateo de disco, apagar/reiniciar, fork bombs,
// sobreescribir un dispositivo, forzar en el remoto de git.
const DENY_PATTERNS = [
  /\brm\s+.*-[a-z]*r[a-z]*f|\brm\s+.*-[a-z]*f[a-z]*r/i, // rm -rf, rm -fr, rm -Rf...
  /\bdel\s+\/[sS]\b|\brmdir\s+\/[sS]\b/, // Windows: del /s, rmdir /s
  /\bformat\s+[a-zA-Z]:/i, // format C:
  /\bmkfs\b|\bdd\s+if=.*of=\/dev\//i,
  /\b(shutdown|reboot|halt|poweroff)\b/i,
  /:\(\)\s*\{.*:\|:.*\}\s*;/, // fork bomb
  /\bgit\s+push\b.*(--force|-f)\b/i,
  /\bgit\s+(reset|clean)\b.*(--hard|-fdx|-fd)\b/i,
  />\s*\/dev\/sd/i,
];

// Tokeniza respetando comillas simples/dobles. null si las comillas no
// cierran (comando raro / a medio escribir).
function tokenize(cmd) {
  const out = [];
  let cur = "";
  let quote = null;
  let has = false;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      if (c === quote) { quote = null; } else { cur += c; }
      continue;
    }
    if (c === '"' || c === "'") { quote = c; has = true; continue; }
    if (/\s/.test(c)) {
      if (has || cur) out.push(cur);
      cur = ""; has = false;
      continue;
    }
    cur += c; has = true;
  }
  if (quote) return null;
  if (has || cur) out.push(cur);
  return out;
}

/**
 * Valida un pedido "ejecutar: <comando>". No ejecuta nada.
 * @returns {{ok:true, argv:[string]} | {ok:false, blocked:boolean, reason:string}}
 *   blocked=true -> nunca se pregunta (denylist/sintaxis); blocked=false -> se puede preguntar igual.
 */
function validateCommand(raw) {
  const cmd = String(raw || "").trim();
  if (!cmd) return { ok: false, blocked: true, reason: "comando vacio" };
  if (cmd.length > MAX_CMD_CHARS) return { ok: false, blocked: true, reason: `comando demasiado largo (mas de ${MAX_CMD_CHARS} caracteres)` };
  if (BLOCKED_SYNTAX_RE.test(cmd)) return { ok: false, blocked: true, reason: "no se permiten combinaciones de comandos (;, &&, ||, |, backticks, $(...), redirecciones): pedi UN comando simple" };
  for (const re of DENY_PATTERNS) if (re.test(cmd)) return { ok: false, blocked: true, reason: "este tipo de comando esta bloqueado siempre (borrado masivo, formateo, apagar la maquina, forzar en el remoto, etc.)" };
  const argv = tokenize(cmd);
  if (!argv || !argv.length) return { ok: false, blocked: true, reason: "no se pudo interpretar el comando (revisa las comillas)" };
  return { ok: true, argv, cmd };
}

// true si `cmd` matchea alguno de los prefijos de la allowlist (case-sensitive,
// por palabra completa: "npm test" no matchea "npm testx").
function matchesAllowlist(cmd, allowlist) {
  return (allowlist || []).some((p) => {
    p = String(p || "").trim();
    if (!p) return false;
    return cmd === p || cmd.startsWith(p + " ");
  });
}

function timeoutMsFor(setting) {
  const n = Math.floor(Number(setting));
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(n, MAX_TIMEOUT_MS);
}

// Matar el ARBOL completo, no solo el proceso que arrancamos (v0.21.3): un
// "npm test" o un script que a su vez lanza otros procesos dejaba huerfanos
// corriendo si solo se mataba el hijo directo (child.kill() de siempre) --
// el timeout y el boton Detener terminaban sin liberar nada de verdad.
// En POSIX, extension.js arranca el proceso con detached:true, lo que lo
// hace lider de su propio grupo (pgid === pid); matar con el PID en
// NEGATIVO manda la señal a TODO el grupo, no solo al lider. En Windows no
// existe el concepto de grupo asi, pero `taskkill /T` mata el arbol entero
// por PID. SIGKILL/`/F` siempre (no SIGTERM): la garantia que se le da al
// usuario es "se corta", no "se le pide amablemente que corte".
function killProcessTree(child) {
  if (!child || !child.pid || child.killed) return;
  try {
    if (process.platform === "win32") {
      require("child_process").spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
      return;
    }
    process.kill(-child.pid, "SIGKILL");
  } catch (_) {
    // El grupo ya no existe (el proceso ya termino) o no se pudo -- como
    // ultimo recurso, al menos el proceso que arrancamos directamente.
    try { child.kill("SIGKILL"); } catch (_) { /* ya esta muerto */ }
  }
}

// Normaliza para comparar nombres de archivo "a ojo": ignora mayusculas,
// acentos y de-donde-viene los espacios/guiones (para no depender de que el
// modelo haya tipeado el nombre letra por letra).
function normName(s) {
  return String(s || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
}

// Si el comando fallo porque el archivo no existe (ENOENT / "no such file"/
// "cannot find") y uno de los argumentos, comparado sin importar mayusculas/
// espacios, matchea un archivo real del proyecto, se sugiere el nombre real
// -- suele ser justo el caso de "python dooom.py" en vez de "base de dooom.py".
function suggestFilenameFix(argv, output, knownPaths) {
  const looksLikeMissing = /no such file or directory|cannot find the (file|path)|ENOENT|not recognized as an internal/i.test(String(output || ""));
  if (!looksLikeMissing || !knownPaths || !knownPaths.length) return null;
  for (const tok of argv || []) {
    const base = tok.split(/[\\/]/).pop();
    if (!base || !/[.\w]/.test(base)) continue;
    const target = normName(base);
    if (!target || target.length < 3) continue;
    for (const p of knownPaths) {
      const pBase = p.split(/[\\/]/).pop();
      const pNorm = normName(pBase);
      if (pBase === base) continue; // matchea tal cual: no es el problema
      // Igual salvo espacios/mayusculas/acentos, o el nombre pedido es un
      // sufijo del real (el modelo se comio un prefijo con espacios, el caso
      // tipico de "dooom.py" en vez de "base de dooom.py").
      if (pNorm === target || pNorm.endsWith(target)) return p;
    }
  }
  return null;
}

// Da forma a lo que ve el modelo despues de correr el comando: recorta,
// tapa secretos, y deja claro codigo de salida / si se corto por tiempo.
function formatResult(cmd, r) {
  const red = redactSecrets(String(r.output || ""));
  const out = truncateLog(red.text, MAX_OUTPUT_CHARS).text;
  const head = r.timedOut
    ? `se corto por tiempo (mas de ${(r.timeoutMs / 1000).toFixed(0)}s sin terminar)`
    : r.cancelled
      ? "cancelado: el usuario apreto Detener mientras corria"
    : r.blocked
      ? `rechazado: ${r.error}`
      : r.denied
        ? "el usuario NO autorizo este comando"
        : r.error
          ? `no se pudo ejecutar: ${r.error}`
          : `codigo de salida ${r.code}`;
  const suggestion = r.suggestPath ? `\n\nOJO: no existe ese nombre tal cual, pero en el proyecto esta "${r.suggestPath}" (revisa mayusculas/espacios/comillas y proba de nuevo con ese nombre exacto).` : "";
  return `### ejecutar: ${cmd}\n${head}${out ? `\n${"```"}\n${out}\n${"```"}` : ""}${suggestion}`;
}

module.exports = { validateCommand, matchesAllowlist, timeoutMsFor, formatResult, suggestFilenameFix, killProcessTree, tokenize, MAX_OUTPUT_CHARS, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS };
