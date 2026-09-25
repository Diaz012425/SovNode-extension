"use strict";

// Base del arquitecto (v0.16): el arquitecto recibe cada archivo UNA vez
// como "version base" al PRINCIPIO del pedido (antes del historial), y en
// los turnos siguientes solo los CAMBIOS desde esa base, como diff. Como la
// base es identica turno a turno, el proveedor la cobra como cache (Gemini
// implicito, Anthropic con cache_control); lo unico nuevo que se paga es el
// diff + la pregunta.
//
// Solo el arquitecto: planifica, no necesita copiar texto exacto. El editor
// sigue recibiendo el codigo ACTUAL (tiene que calzar sus bloques SEARCH).
//
// Modulo PURO (sin vscode).

const CONTEXT = 2; // lineas de contexto alrededor de cada cambio en el diff
const MAX_DP_CELLS = 4e6; // diff demasiado grande de calcular -> se renueva la base
const REBASE_MIN_LINES = 40;
const REBASE_RATIO = 1 / 3; // si lo cambiado pasa de un tercio del archivo, se renueva la base

// Diff de lineas (LCS sobre la parte del medio, despues de recortar el
// principio y el final comunes -- las ediciones suelen ser locales).
// Devuelve {text, changed} o null si es demasiado grande para calcularlo.
function lineDiff(a, b) {
  const A = a.split("\n");
  const B = b.split("\n");
  let pre = 0;
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0;
  while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
  const a2 = A.slice(pre, A.length - suf);
  const b2 = B.slice(pre, B.length - suf);
  if (!a2.length && !b2.length) return { text: "", changed: 0 };
  const n = a2.length;
  const m = b2.length;
  if (n * m > MAX_DP_CELLS) return null;

  // LCS clasico (tabla de longitudes desde el final).
  const W = m + 1;
  const L = new Uint32Array((n + 1) * W);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      L[i * W + j] = a2[i] === b2[j] ? L[(i + 1) * W + j + 1] + 1 : Math.max(L[(i + 1) * W + j], L[i * W + j + 1]);
    }
  }
  // Operaciones: [tipo, lineaA(0-based global), lineaB, texto]
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a2[i] === b2[j]) { ops.push([" ", pre + i, pre + j, a2[i]]); i++; j++; }
    // Ante empate, primero lo que se quita ("-" antes que "+"), como un diff normal.
    else if (i < n && (j === m || L[(i + 1) * W + j] >= L[i * W + j + 1])) { ops.push(["-", pre + i, pre + j, a2[i]]); i++; }
    else { ops.push(["+", pre + i, pre + j, b2[j]]); j++; }
  }
  // Agregar contexto de los tramos comunes recortados.
  const full = [];
  for (let k = Math.max(0, pre - CONTEXT); k < pre; k++) full.push([" ", k, k, A[k]]);
  full.push(...ops);
  const sa = A.length - suf;
  const sb = B.length - suf;
  for (let k = 0; k < Math.min(suf, CONTEXT); k++) full.push([" ", sa + k, sb + k, A[sa + k]]);

  // Hunks estilo diff unificado.
  const changedIdx = full.map((o, k) => (o[0] !== " " ? k : -1)).filter((k) => k >= 0);
  const hunks = [];
  for (const k of changedIdx) {
    const lo = Math.max(0, k - CONTEXT);
    const hi = Math.min(full.length - 1, k + CONTEXT);
    const last = hunks[hunks.length - 1];
    if (last && lo <= last[1] + 1) last[1] = Math.max(last[1], hi);
    else hunks.push([lo, hi]);
  }
  const out = [];
  for (const [lo, hi] of hunks) {
    const seg = full.slice(lo, hi + 1);
    const aStart = seg[0][1] + 1;
    const bStart = seg[0][2] + 1;
    const aLen = seg.filter((o) => o[0] !== "+").length;
    const bLen = seg.filter((o) => o[0] !== "-").length;
    out.push(`@@ -${aStart},${aLen} +${bStart},${bLen} @@`);
    for (const o of seg) out.push(o[0] + o[3]);
  }
  return { text: out.join("\n"), changed: changedIdx.length };
}

/**
 * Decide que manda el arquitecto para cada archivo y actualiza `bases`
 * (Map ruta -> contenido base) en el lugar.
 * @returns {{base: [{path, content}], files: [file con .rendered y .archBase]}}
 */
function prepareArchitect(files, bases) {
  const outFiles = [];
  for (const f of files) {
    let base = bases.get(f.path);
    let d = base != null ? lineDiff(base, f.content) : null;
    const baseLines = base != null ? base.split("\n").length : 0;
    const tooMuch = !d || d.changed > Math.max(REBASE_MIN_LINES, baseLines * REBASE_RATIO);
    let rebased = false;
    if (base == null || tooMuch) {
      bases.set(f.path, f.content);
      base = f.content;
      d = { text: "", changed: 0 };
      rebased = true;
    }
    const head = `### ${f.path}${f.active ? "  (archivo activo en el editor)" : ""}  — VERSION BASE + CAMBIOS`;
    const body = d.changed
      ? `El contenido completo esta en "ARCHIVOS BASE" (al principio). Desde esa version cambio esto (diff unificado: "-" se quito, "+" se agrego; los numeros de linea son de la base -> actual). El archivo ACTUAL = base + estos cambios:\n\`\`\`diff\n${d.text}\n\`\`\``
      : `Sin cambios desde la version en "ARCHIVOS BASE" (al principio): ese ES el contenido actual.`;
    outFiles.push({ ...f, rendered: `${head}\n${body}`, archBase: { changed: d.changed, rebased } });
  }
  // Bases de archivos que ya no estan en el chat: se olvidan (asi no se
  // mandan de mas). Orden estable por ruta: cualquier cambio de orden
  // rompe el prefijo cacheado.
  const keep = new Set(files.map((f) => f.path));
  for (const p of [...bases.keys()]) if (!keep.has(p)) bases.delete(p);
  const base = [...bases.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1)).map(([p, c]) => ({ path: p, content: c }));
  return { base, files: outFiles };
}

function renderBase(base) {
  if (!base || !base.length) return "";
  const parts = base.map((b) => {
    const fence = b.content.includes("```") ? "````" : "```";
    return `### ${b.path}\n${fence}\n${b.content}\n${fence}`;
  });
  return `ARCHIVOS BASE (version guardada de cada archivo; puede estar desactualizada: los cambios posteriores estan al final, en "ARCHIVOS EN EL CHAT", como diff):\n\n${parts.join("\n\n")}`;
}

module.exports = { lineDiff, prepareArchitect, renderBase, REBASE_MIN_LINES };
