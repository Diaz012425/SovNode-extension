"use strict";

// Contexto enfocado (v0.15): en un archivo GRANDE, en vez de mandar las
// 1500 lineas en cada turno, se mandan solo las partes que el pedido toca
// (las funciones/clases que nombra, las lineas que aparecen en un log de
// error, la seleccion del editor) + las primeras lineas (imports/constantes)
// + un indice de lo que NO se mando (nombre y linea de cada funcion), para
// que el modelo sepa que existe y pueda pedirlo.
//
// Modulo PURO (sin vscode) para poder testearlo con node.
//
// Reglas de seguridad (para no empeorar la calidad):
// - Si el pedido no nombra nada concreto ("mejora este codigo"), va el
//   archivo ENTERO: no hay forma de adivinar que parte importa.
// - Si lo elegido ya es mas del 60% del archivo, va entero (el ahorro no
//   vale la confusion de ver fragmentos).
// - Nunca con formato "archivo completo" (el modelo reescribiria el archivo
//   solo con los fragmentos que vio). Eso lo controla extension.js.
// - El modelo puede pedir el archivo entero con NECESITO_ARCHIVOS, y la
//   ronda de reparacion siempre recibe el archivo completo.

const MAX_BLOCK_LINES = 250; // un bloque mas largo que esto no se manda entero por una sola mencion
const BIG_BLOCK_HEAD = 60; // ...se manda su comienzo (firma + primeras lineas)
const LINE_WINDOW = 25; // lineas alrededor de una linea suelta (log, seleccion) fuera de toda funcion
const HEAD_MAX = 60; // imports / constantes del principio
const MERGE_GAP = 6; // dos rangos a menos de esto se unen
const FULL_RATIO = 0.6;
const MAX_TOKEN_HITS = 8; // un identificador que aparece en mas lineas que esto es demasiado generico

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const indentOf = (l) => /^[ \t]*/.exec(l)[0].replace(/\t/g, "    ").length;
const isBlank = (l) => !l.trim();
const isCloser = (l) => /^\s*(?:[}\])]+[;,)]*|end\b|fi\b|done\b|esac\b)/.test(l);

// Fin (inclusive, 0-based) del bloque que empieza en `start`: la siguiente
// linea no vacia con sangria <= la del encabezado. Si esa linea es un cierre
// (`}`, `end`) pertenece al bloque.
function blockEnd(lines, start) {
  const base = indentOf(lines[start]);
  let last = start;
  for (let i = start + 1; i < lines.length; i++) {
    if (isBlank(lines[i])) continue;
    if (indentOf(lines[i]) <= base) {
      // Encabezado de varias lineas ("def f(\n  a,\n):") o llave en la linea siguiente: sigue.
      if (/^(?:[)\]]+\s*(?:->[^:{]*)?[:{]|\{)\s*$/.test(lines[i].trim())) { last = i; continue; }
      if (isCloser(lines[i])) return i;
      return last;
    }
    last = i;
  }
  return last;
}

// Decoradores / comentarios pegados arriba de una definicion.
function blockStart(lines, def) {
  let s = def;
  while (s > 0 && def - s < 5 && /^\s*(?:@|#|\/\/|\/\*|\*|""")/.test(lines[s - 1]) && !isBlank(lines[s - 1])) s--;
  return s;
}

// Si el mapa del repo esta apagado o no tiene este archivo: definiciones
// tipicas a ojo (def/class/function/fn/func/metodos con llave), suficiente
// para cortar el archivo en bloques.
const DEF_RE = /^\s*(?:export\s+)?(?:default\s+)?(?:pub(?:\([^)]*\))?\s+)?(?:public\s+|private\s+|protected\s+|static\s+|async\s+|abstract\s+|final\s+|override\s+)*(?:def|class|function\*?|fn|func|interface|struct|enum|trait|impl|module|sub)\s+([A-Za-z_$][\w$]*)/;
const JS_FN_RE = /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/;
function guessSymbols(lines) {
  const out = [];
  lines.forEach((l, i) => {
    const m = DEF_RE.exec(l) || JS_FN_RE.exec(l);
    if (m) out.push({ name: m[1], line: i + 1 });
  });
  return out;
}

// symbols: [{name, line(1-based)}] del mapa del repo para ESTE archivo.
function definitionsOf(lines, symbols) {
  const defs = [];
  if (!symbols || !symbols.length) symbols = guessSymbols(lines);
  for (const s of symbols || []) {
    const i = (s.line || 0) - 1;
    if (i < 0 || i >= lines.length) continue;
    const end = blockEnd(lines, i);
    defs.push({ name: s.name, def: i, start: blockStart(lines, i), end });
  }
  return defs.sort((a, b) => a.def - b.def);
}

// Lineas (1-based) de ESTE archivo que aparecen en un log: "File ".../x.py", line 12",
// "x.js:12:5", "at f (x.js:12:5)", "x.py:12".
function logLines(logText, relPath) {
  if (!logText) return [];
  const base = relPath.split("/").pop();
  const out = new Set();
  const b = escapeRe(base);
  const res = [
    new RegExp(`${b}["']?,\\s*line\\s+(\\d+)`, "gi"),
    new RegExp(`${b}:(\\d+)`, "g"),
    new RegExp(`${b}\\((\\d+)[,)]`, "g"),
  ];
  for (const re of res) {
    let m;
    while ((m = re.exec(logText))) out.add(Number(m[1]));
  }
  return [...out];
}

// Palabras del pedido que parecen codigo: `entre_backticks`, snake_case,
// camelCase, a.b, llamada(). Las palabras comunes no cuentan.
function codeTokens(text) {
  const out = new Set();
  for (const m of text.matchAll(/`([^`\n]{2,60})`/g)) {
    for (const t of m[1].match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) || []) out.add(t);
  }
  for (const t of text.match(/[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+|[A-Za-z]*_[A-Za-z0-9_]+|[a-z]+[A-Z][A-Za-z0-9]*|[A-Za-z_][A-Za-z0-9_]{2,}(?=\()/g) || []) {
    for (const p of t.split(".")) if (p.length >= 3) out.add(p);
  }
  return [...out];
}

/**
 * Decide que mandar de un archivo.
 * @param {string} content
 * @param {object} o {relPath, symbols, text (pedido + plan), logText, selection:{start,end} 1-based, minLines}
 * @returns {{focused:false, reason} | {focused:true, ranges:[[a,b]], outline, shownLines, totalLines, reasons}}
 */
function planFocus(content, o) {
  const lines = content.split("\n");
  const total = lines.length;
  if (!o.minLines || total < o.minLines) return { focused: false, reason: "chico" };
  const text = o.text || "";
  const defs = definitionsOf(lines, o.symbols);
  const ranges = [];
  const reasons = [];

  const addBlock = (d, why) => {
    const len = d.end - d.start + 1;
    ranges.push([d.start, len > MAX_BLOCK_LINES ? Math.min(d.end, d.def + BIG_BLOCK_HEAD) : d.end]);
    reasons.push(why);
  };
  // Bloque mas interno (y no gigante) que contiene la linea i; si no hay, una ventana.
  const addLine = (i, why) => {
    const inner = defs.filter((d) => d.start <= i && i <= d.end && d.end - d.start + 1 <= MAX_BLOCK_LINES)
      .sort((a, b) => (a.end - a.start) - (b.end - b.start))[0];
    if (inner) ranges.push([inner.start, inner.end]);
    else ranges.push([Math.max(0, i - LINE_WINDOW), Math.min(total - 1, i + LINE_WINDOW)]);
    reasons.push(why);
  };

  // 1) Funciones/clases de este archivo nombradas en el pedido, el plan o el log.
  const hay = `${text}\n${o.logText || ""}`;
  for (const d of defs) {
    if (d.name.length < 3) continue;
    if (new RegExp(`\\b${escapeRe(d.name)}\\b`).test(hay)) addBlock(d, d.name);
  }
  // 2) Lineas de este archivo citadas en un log de error.
  for (const n of logLines(o.logText, o.relPath)) if (n >= 1 && n <= total) addLine(n - 1, `log L${n}`);
  // 3) Seleccion del editor.
  if (o.selection) {
    const a = Math.max(0, o.selection.start - 1);
    const b = Math.min(total - 1, o.selection.end - 1);
    if (b - a + 1 <= MAX_BLOCK_LINES) {
      ranges.push([a, b]);
      const inner = defs.filter((d) => d.start <= a && b <= d.end && d.end - d.start + 1 <= MAX_BLOCK_LINES).sort((x, y) => (x.end - x.start) - (y.end - y.start))[0];
      if (inner) ranges.push([inner.start, inner.end]);
      reasons.push("seleccion");
    }
  }
  // 4) Identificadores que parecen codigo y aparecen en pocas lineas del archivo.
  const defNames = new Set(defs.map((d) => d.name));
  for (const t of codeTokens(text)) {
    if (defNames.has(t)) continue;
    const re = new RegExp(`\\b${escapeRe(t)}\\b`);
    const hits = [];
    for (let i = 0; i < total && hits.length <= MAX_TOKEN_HITS; i++) if (re.test(lines[i])) hits.push(i);
    if (!hits.length || hits.length > MAX_TOKEN_HITS) continue;
    for (const i of hits) addLine(i, t);
  }

  if (!ranges.length) return { focused: false, reason: "el pedido no nombra ninguna parte concreta del archivo" };

  // Cabecera: imports / constantes hasta la primera definicion.
  const firstDef = defs.length ? defs[0].start : HEAD_MAX;
  if (firstDef > 0) ranges.push([0, Math.min(firstDef, HEAD_MAX) - 1]);

  // Unir rangos.
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [a, b] of ranges) {
    const last = merged[merged.length - 1];
    if (last && a <= last[1] + MERGE_GAP) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  const shown = merged.reduce((n, [a, b]) => n + b - a + 1, 0);
  if (shown > total * FULL_RATIO) return { focused: false, reason: "lo relevante es casi todo el archivo" };

  // Indice de lo que NO se mando.
  const inShown = (i) => merged.some(([a, b]) => a <= i && i <= b);
  const outline = defs.filter((d) => !inShown(d.def)).map((d) => ({ line: d.def + 1, text: lines[d.def].trim().slice(0, 120) }));

  return {
    focused: true,
    ranges: merged.map(([a, b]) => [a + 1, b + 1]),
    outline,
    shownLines: shown,
    totalLines: total,
    reasons: [...new Set(reasons)],
  };
}

// Texto que ve el modelo para un archivo enfocado.
function renderFocused(relPath, content, plan, active) {
  const lines = content.split("\n");
  const fence = content.includes("```") ? "````" : "```";
  const parts = [];
  let prevEnd = 0;
  for (const [a, b] of plan.ranges) {
    if (a > prevEnd + 1) parts.push(`(... lineas ${prevEnd + 1}-${a - 1} NO incluidas ...)`);
    parts.push(`[lineas ${a}-${b}]\n${fence}\n${lines.slice(a - 1, b).join("\n")}\n${fence}`);
    prevEnd = b;
  }
  if (prevEnd < lines.length) parts.push(`(... lineas ${prevEnd + 1}-${lines.length} NO incluidas ...)`);
  const outline = plan.outline.length
    ? `\nDefiniciones en las partes NO incluidas (linea: firma):\n${plan.outline.slice(0, 120).map((o) => `  ${o.line}: ${o.text}`).join("\n")}${plan.outline.length > 120 ? `\n  ... y ${plan.outline.length - 120} mas` : ""}\n`
    : "";
  return `### ${relPath}${active ? "  (archivo activo en el editor)" : ""}  — EXTRACTO: ${plan.shownLines} de ${plan.totalLines} lineas
Solo ves las partes relevantes para este pedido. Tus bloques SEARCH deben copiar texto de estos fragmentos
(nunca de los marcadores "[lineas ...]" ni "(... NO incluidas ...)"). Si necesitas ver o cambiar codigo que no
esta aca, pedi ese rango con HERRAMIENTAS (leer: ${relPath} DESDE-HASTA, usando los numeros del indice; mas barato)
o, si necesitas todo, responde UNICAMENTE con: NECESITO_ARCHIVOS: ${relPath}   y te lo mando completo.
${outline}
${parts.join("\n\n")}`;
}

module.exports = { planFocus, renderFocused, logLines, codeTokens, blockEnd, guessSymbols };
