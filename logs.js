"use strict";

// Logs de bugs adjuntos al chat (boton 🐞, /bug, comando "Adjuntar log de
// error"). Modulo PURO (sin vscode) para poder testearlo con node.
//
// Idea: el error va APARTE, como un adjunto que queda en el contexto de los
// turnos siguientes hasta que lo quites, y el chat queda libre para contar
// que estabas haciendo cuando fallo. Asi no hay que pegar 300 lineas de
// traceback adentro de la pregunta (ni se guardan en el historial: los logs
// se mandan frescos en cada turno mientras sigan adjuntos, y la pregunta
// sola va al historial).

const MAX_LOG_CHARS = 12000; // por log
const HEAD_CHARS = 2000; // del principio (el comando / primera excepcion)
const MAX_TOTAL_CHARS = 30000; // entre todos los logs adjuntos
const MAX_LOGS = 5;

// Colores y movimientos de cursor de la terminal (\x1b[31m ...): solo
// ensucian y cuestan tokens.
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

// Secretos tipicos que aparecen en una salida de terminal o un volcado de
// variables de entorno. Se tapan ANTES de que el log salga de tu maquina.
const SECRET_PATTERNS = [
  [/\bAIza[0-9A-Za-z_\-]{30,}/g, "AIza…(oculto)"], // Google / Gemini
  [/\bsk-(?:ant-|proj-)?[0-9A-Za-z_\-]{20,}/g, "sk-…(oculto)"], // OpenAI / Anthropic
  [/\bgh[pousr]_[0-9A-Za-z]{30,}/g, "gh_…(oculto)"], // GitHub
  [/\bxox[abposr]-[0-9A-Za-z\-]{10,}/g, "xox…(oculto)"], // Slack
  [/\bAKIA[0-9A-Z]{16}\b/g, "AKIA…(oculto)"], // AWS access key
  [/(\bBearer\s+)[A-Za-z0-9._~+\/=\-]{16,}/gi, "$1…(oculto)"],
  [/((?:api[_-]?key|secret|token|password|passwd|pwd)["']?\s*[:=]\s*["']?)[^\s"',;…]{6,}/gi, "$1…(oculto)"], // (sin "…": no volver a tapar lo ya tapado)
];

function redactSecrets(text) {
  let count = 0;
  let out = text;
  for (const [re, rep] of SECRET_PATTERNS) {
    out = out.replace(re, (...args) => {
      count++;
      // "$1" en el reemplazo: se arma a mano porque replace con funcion no lo expande.
      return rep.includes("$1") ? rep.replace("$1", args[1]) : rep;
    });
  }
  return { text: out, redacted: count };
}

// Recorta un log largo dejando el PRINCIPIO (que comando fallo, primera
// excepcion) y sobre todo el FINAL (la mayoria de los errores termina con
// la linea que importa: "TypeError: ...", "SyntaxError", el exit code).
function truncateLog(text, max = MAX_LOG_CHARS) {
  if (text.length <= max) return { text, truncated: 0 };
  const tail = max - HEAD_CHARS;
  const cut = text.length - HEAD_CHARS - tail;
  return {
    text: `${text.slice(0, HEAD_CHARS)}\n\n[... ${cut.toLocaleString("es")} caracteres del medio omitidos ...]\n\n${text.slice(text.length - tail)}`,
    truncated: cut,
  };
}

// Deja un log listo para adjuntar. Devuelve null si no hay nada util.
function prepareLog(raw, label) {
  let text = String(raw == null ? "" : raw).replace(/\r\n?/g, "\n").replace(ANSI_RE, "");
  text = text.replace(/[ \t]+$/gm, "").replace(/\n{4,}/g, "\n\n\n").trim();
  if (!text) return null;
  const red = redactSecrets(text);
  const tr = truncateLog(red.text);
  return {
    label: String(label || "").trim().slice(0, 80) || guessLabel(tr.text),
    text: tr.text,
    chars: tr.text.length,
    originalChars: text.length,
    truncated: tr.truncated,
    redacted: red.redacted,
  };
}

// Nombre corto para el chip: la ultima linea que parece un error, si hay.
function guessLabel(text) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const err = [...lines].reverse().find((l) => /(error|exception|traceback|failed|fatal|panic|errno|undefined|cannot|no se pudo)/i.test(l));
  const pick = err || lines[lines.length - 1] || "log";
  return pick.length > 60 ? pick.slice(0, 57) + "..." : pick;
}

// Agrega un log a la lista respetando los topes. Devuelve {logs, note}
// (note = aviso para el usuario si algo se recorto o se descarto).
function addLog(list, log) {
  const logs = [...list, log];
  const notes = [];
  while (logs.length > MAX_LOGS) {
    logs.shift();
    notes.push(`Solo se guardan ${MAX_LOGS} logs; se quito el mas viejo.`);
  }
  let total = logs.reduce((n, l) => n + l.chars, 0);
  while (total > MAX_TOTAL_CHARS && logs.length > 1) {
    total -= logs.shift().chars;
    notes.push("Entre todos los logs se pasaban del tope; se quito el mas viejo.");
  }
  if (log.truncated) notes.push(`El log era largo: se quedaron el principio y el final (${log.truncated.toLocaleString("es")} caracteres del medio omitidos).`);
  if (log.redacted) notes.push(`Se ocultaron ${log.redacted} dato(s) que parecian claves o tokens antes de mandarlo al modelo.`);
  return { logs, note: notes.join(" ") };
}

// Diagnosticos del panel "Problems" de VS Code en texto plano, como los
// mostraria un compilador. `items`: [{path, diagnostics:[{severity, line, col, message, source}]}]
// severity: 0 error, 1 warning (los de info/hint no se incluyen).
function formatDiagnostics(items) {
  const lines = [];
  for (const it of items) {
    for (const d of it.diagnostics) {
      if (d.severity > 1) continue;
      lines.push(`${it.path}:${d.line}:${d.col} ${d.severity === 0 ? "error" : "warning"}${d.source ? ` [${d.source}]` : ""}: ${d.message.replace(/\s+/g, " ")}`);
    }
  }
  return lines.join("\n");
}

// Salida de un comando de verificacion que fallo (test/build/lint): en vez
// de recortar a lo bruto (los primeros N caracteres, que en un test runner
// suelen ser solo el nombre de la suite, no el error), se quedan las lineas
// que importan -- las que parecen un error real -- + un poco de contexto
// alrededor, y se avisa cuanto se omitio. Si no hay ninguna linea asi
// (formato de salida raro) se cae al recorte simple de siempre.
const RELEVANT_LINE_RE = /(error|exception|traceback|failed|fail:|assert|expected|received|\.(?:py|js|ts|jsx|tsx|go|rs|java|rb):\d+|line \d+|panic|errno|✗|✕)/i;
function compressVerifyOutput(raw, max = MAX_LOG_CHARS) {
  const text = String(raw == null ? "" : raw).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\r\n?/g, "\n");
  if (text.length <= max) return text;
  const lines = text.split("\n");
  const keep = new Set();
  lines.forEach((l, i) => {
    if (RELEVANT_LINE_RE.test(l)) for (let k = Math.max(0, i - 1); k <= Math.min(lines.length - 1, i + 1); k++) keep.add(k);
  });
  // Siempre el final: la mayoria de los runners termina con el resumen.
  for (let k = Math.max(0, lines.length - 15); k < lines.length; k++) keep.add(k);
  if (!keep.size) return truncateLog(text, max).text;
  const idx = [...keep].sort((a, b) => a - b);
  const out = [];
  let prev = -2;
  for (const i of idx) {
    if (i > prev + 1) out.push(prev === -2 ? undefined : "[...]");
    out.push(lines[i]);
    prev = i;
  }
  const joined = out.filter((x) => x !== undefined).join("\n");
  return joined.length <= max ? joined : truncateLog(joined, max).text;
}

module.exports = { prepareLog, addLog, redactSecrets, truncateLog, guessLabel, formatDiagnostics, compressVerifyOutput, MAX_LOG_CHARS, MAX_LOGS, MAX_TOTAL_CHARS };
