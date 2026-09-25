"use strict";
const { L } = require("./i18n");

// Formatos de edicion alternativos (v0.12, como Aider): ademas de los
// bloques SEARCH/REPLACE de siempre, el modelo puede editar con un DIFF
// UNIFICADO o reescribiendo el ARCHIVO COMPLETO. Cual conviene depende del
// modelo -- los chicos se equivocan copiando SEARCH exactos y rinden mejor
// reescribiendo el archivo entero; los de OpenAI estan muy entrenados en
// diffs -- asi que por defecto ("auto") se elige solo por el nombre del
// modelo que ESCRIBE el codigo (el editor, en modo arquitecto).
//
// Todo lo de aca es PURO (no importa vscode), igual que editEngine.js: los
// tres formatos terminan convertidos al MISMO tipo de "edit" que ya aplica
// editEngine.applyEdits (search/replace sobre el texto actual, o `whole`
// para un archivo completo), asi que todo lo que ya existia -- todo-o-nada
// multi-archivo, ronda de reparacion, verificacion, undo, commits, tarjetas
// de cambios en la UI -- funciona igual con cualquier formato.

const { parseEditBlocks, cleanPathLine } = require("./editEngine");

const FORMATS = ["search-replace", "udiff", "whole"];
const FORMAT_LABEL = { "search-replace": "SEARCH/REPLACE", udiff: "diff unificado", whole: "archivo completo" };
const FORMAT_ALIASES = {
  "search-replace": "search-replace", searchreplace: "search-replace", sr: "search-replace", search: "search-replace", diff: "search-replace", bloques: "search-replace",
  udiff: "udiff", unified: "udiff", "unified-diff": "udiff", patch: "udiff",
  whole: "whole", entero: "whole", completo: "whole", full: "whole", "whole-file": "whole",
  auto: "auto",
};

// Modelos "chicos": copiar SEARCH exactos es justo lo que peor hacen, y
// reescribir el archivo entero les sale mucho mas confiable (misma
// observacion que llevo a Aider a usar "whole" con modelos debiles).
const WEAK_MODEL_RE = /(flash-lite|-lite\b|-luna\b|haiku|-mini\b|-nano\b)/i;
// ...pero reescribir archivos enteros cuesta tokens de salida y se corta si
// el archivo es grande: por encima de esto (suma de los archivos en el
// chat), "auto" vuelve a SEARCH/REPLACE aunque el modelo sea chico.
const WHOLE_MAX_CHARS = 12000;

function normalizeFormat(value) {
  const k = String(value || "").trim().toLowerCase();
  return FORMAT_ALIASES[k] || null;
}

// Decide el formato para UN turno. `setting` es sovnodeAider.editFormat
// ("auto" o uno fijo), `model` el modelo que escribe el codigo, y
// `contextChars` el tamanio total de los archivos en el chat. Devuelve
// tambien el POR QUE, que se muestra en la UI y en /format.
function resolveEditFormat(setting, model, contextChars = 0) {
  const fixed = normalizeFormat(setting);
  if (fixed && fixed !== "auto") return { format: fixed, reason: L("fijado en sovnodeAider.editFormat", "set in sovnodeAider.editFormat") };
  const m = String(model || "");
  if (WEAK_MODEL_RE.test(m)) {
    if (contextChars <= WHOLE_MAX_CHARS) return { format: "whole", reason: L(`${m} es un modelo chico: reescribir el archivo entero le sale mas confiable que copiar SEARCH exactos`, `${m} is a small model: rewriting the whole file is more reliable for it than copying exact SEARCH blocks`) };
    return { format: "search-replace", reason: L(`${m} es chico, pero los archivos en el chat pasan ${WHOLE_MAX_CHARS} caracteres: reescribirlos enteros seria caro y se cortaria`, `${m} is small, but the files in the chat exceed ${WHOLE_MAX_CHARS} characters: rewriting them whole would be expensive and get cut off`) };
  }
  if (/^(gpt-|o[0-9]|chatgpt-)/i.test(m)) return { format: "udiff", reason: L(`los modelos de OpenAI estan muy entrenados en diffs unificados`, `OpenAI models are heavily trained on unified diffs`) };
  return { format: "search-replace", reason: L("default para modelos grandes", "default for large models") };
}

// --------------------------------------------------------------- prompts
const COMMON_RULES = `REGLAS COMUNES
- Crea archivos SOLO cuando el usuario lo pide o cuando el cambio pedido claramente lo requiere.
  Puedes crear carpetas nuevas simplemente usando una ruta que las incluya (ej: src/motor/render.js).
- Puedes cambiar varios archivos en una misma respuesta.
- Solo puedes EDITAR archivos cuyo contenido aparece en "ARCHIVOS EN EL CHAT".
  Si necesitas editar un archivo que esta en el mapa pero no en el chat, NO adivines su contenido:
  responde UNICAMENTE con una linea:
  NECESITO_ARCHIVOS: ruta/uno.ext, ruta/dos.ext
  y el sistema te los agregara automaticamente.
- Nunca borres codigo que el usuario no pidio borrar.`;

const INSTRUCTIONS = {
  "search-replace": `COMO EDITAR Y CREAR ARCHIVOS (formato: bloques SEARCH/REPLACE)
Cada bloque va precedido, en su propia linea, de la RUTA RELATIVA del archivo (relativa a la raiz del
proyecto), sin comillas ni texto extra:

ruta/del/archivo.ext
\`\`\`edit
<<<<<<< SEARCH
(copia EXACTA de lineas que existen hoy en ese archivo: mismo espaciado e indentacion; la menor
cantidad de lineas que identifique el lugar sin ambiguedad)
=======
(texto de reemplazo)
>>>>>>> REPLACE
\`\`\`

- CREAR un archivo nuevo: usa la ruta nueva y deja SEARCH VACIO; REPLACE lleva el archivo completo.
- Un archivo puede llevar varios bloques. El SEARCH tiene que aparecer UNA sola vez en el archivo:
  si el texto se repite, agrega lineas vecinas hasta que sea unico.
- Nunca reimprimas un archivo existente completo: usa bloques pequenos.`,

  udiff: `COMO EDITAR Y CREAR ARCHIVOS (formato: diff unificado)
Cada cambio es un diff unificado dentro de un bloque \`\`\`diff, con la RUTA RELATIVA (relativa a la raiz
del proyecto) en las lineas --- y +++:

\`\`\`diff
--- ruta/del/archivo.ext
+++ ruta/del/archivo.ext
@@ ... @@
 linea de contexto sin cambios (empieza con UN espacio)
-linea que se borra
+linea que se agrega
 otra linea de contexto
\`\`\`

- No hacen falta numeros de linea en @@ (escribe "@@ ... @@"): el cambio se ubica por el CONTEXTO.
- Las lineas de contexto (espacio) y las que se borran (-) tienen que existir HOY en el archivo, copiadas
  exactas. Pon 2-3 lineas de contexto antes y despues de cada cambio, y preferi reemplazar un bloque
  logico entero (una funcion, un if) con - y + antes que tocar lineas sueltas dispersas.
- Un archivo puede llevar varios hunks (@@); varios archivos van en bloques \`\`\`diff separados.
- CREAR un archivo nuevo: "--- /dev/null" y "+++ ruta/nueva.ext", con un solo hunk donde TODAS las lineas
  empiezan con +.
- No se pueden borrar archivos enteros con un diff.`,

  whole: `COMO EDITAR Y CREAR ARCHIVOS (formato: archivo completo)
Para cambiar un archivo lo escribes ENTERO, ya modificado: la RUTA RELATIVA (relativa a la raiz del
proyecto) en su propia linea y justo debajo un bloque de codigo con TODO el contenido nuevo:

ruta/del/archivo.ext
\`\`\`
(contenido COMPLETO del archivo, de la primera a la ultima linea)
\`\`\`

- NUNCA abrevies: nada de "// ... resto del codigo igual ...", "# (sin cambios)" ni "...". Lo que no
  escribas se BORRA del archivo. Aunque el cambio sea chico, reescribe el archivo completo.
- CREAR un archivo nuevo: mismo formato, con la ruta nueva.
- Reescribe SOLO los archivos que cambian; no repitas archivos que quedan igual.
- Si el archivo contiene lineas con \`\`\` (por ejemplo un README), abre y cierra el bloque con \`\`\`\`
  (cuatro acentos) para que no se corte.
- No pongas una ruta arriba de un bloque de codigo que NO sea un archivo completo (para ejemplos,
  usa bloques sin ruta).`,
};

function formatInstructions(format) {
  return `${INSTRUCTIONS[format] || INSTRUCTIONS["search-replace"]}\n\n${COMMON_RULES}`;
}

function repairInstruction(format) {
  if (format === "udiff") return "Algunos hunks de tu diff anterior no se pudieron aplicar. Vuelve a escribir la respuesta COMPLETA (explicacion + TODOS los diffs, tambien los que si calzaron), corrigiendo los hunks: las lineas de contexto y las que empiezan con - deben ser copia exacta del contenido actual mostrado, con 2-3 lineas de contexto unicas alrededor de cada cambio.";
  if (format === "whole") return "Algunos archivos de tu respuesta anterior no se pudieron aplicar. Vuelve a escribir la respuesta COMPLETA (explicacion + TODOS los archivos que cambian), cada uno ENTERO y sin abreviar nada, con la ruta en la linea de arriba del bloque y el bloque bien cerrado.";
  return "Algunos bloques SEARCH/REPLACE de tu respuesta anterior no se pudieron aplicar. Vuelve a escribir la respuesta COMPLETA (explicacion + TODOS los bloques), corrigiendo los SEARCH para que sean copia exacta del contenido actual mostrado.";
}

function verifyFixInstruction(format) {
  if (format === "udiff") return "Los cambios que aplicaste no pasan la verificacion automatica. Corrige el problema con nuevos diffs unificados sobre el contenido ACTUAL de los archivos (mostrado abajo).";
  if (format === "whole") return "Los cambios que aplicaste no pasan la verificacion automatica. Corrige el problema reescribiendo ENTEROS solo los archivos que hay que arreglar, partiendo del contenido ACTUAL mostrado abajo.";
  return "Los cambios que aplicaste no pasan la verificacion automatica. Corrige el problema con nuevos bloques SEARCH/REPLACE sobre el contenido ACTUAL de los archivos (mostrado abajo), sin reescribir el archivo completo.";
}

// Como se le muestra al modelo un edit que fallo, en la ronda de reparacion.
function describeFailure(f, format) {
  if (format === "whole" || f.whole) return `- ${f.path}: ${f.reason}`;
  if (format === "udiff" && f.display) return `- ${f.path}: ${f.reason}\n  hunk que fallo:\n${f.display}`;
  return `- ${f.path}: ${f.reason}\n  SEARCH que fallo:\n${f.search}`;
}

// --------------------------------------------------------------- fences
// Recorre los bloques de codigo (```). Un fence de N acentos solo se cierra
// con una linea de N o mas acentos SOLOS: asi "```python" adentro de un
// README (que abre, no cierra) no corta el bloque, y un archivo con ```
// adentro se puede envolver en ```` como pide el prompt de "whole".
function scanFences(text) {
  const lines = text.split("\n");
  const lineStarts = [];
  let off = 0;
  for (const l of lines) { lineStarts.push(off); off += l.length + 1; }
  const fences = [];
  let open = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!open) {
      const m = /^(`{3,})(.*)$/.exec(l);
      if (m && !m[2].includes("`")) open = { ticks: m[1].length, info: m[2].trim(), line: i };
    } else {
      const m = /^(`{3,})\s*$/.exec(l);
      if (m && m[1].length >= open.ticks) {
        fences.push({ info: open.info, line: open.line, start: lineStarts[open.line], end: lineStarts[i] + l.length, bodyLines: lines.slice(open.line + 1, i), bodyFirstLine: open.line + 1, closed: true });
        open = null;
      }
    }
  }
  if (open) fences.push({ info: open.info, line: open.line, start: lineStarts[open.line], end: text.length, bodyLines: lines.slice(open.line + 1), bodyFirstLine: open.line + 1, closed: false });
  return { lines, lineStarts, fences };
}

// Ultima linea no vacia antes de `lineIdx`, si parece una ruta. Con
// `strict` la linea tiene que ser SOLO la ruta (con **, #, ` o ":" como
// mucho): en formato "archivo completo" una frase como "Abre `index.html` y
// pega esto:" arriba de un ejemplo NO puede tomarse como "reescribi
// index.html con este ejemplo".
function pathBefore(lines, lineIdx, strict) {
  for (let i = lineIdx - 1; i >= 0; i--) {
    if (!lines[i].trim()) continue;
    const p = cleanPathLine(lines[i]);
    if (!p || !strict) return p;
    const bare = lines[i].trim().replace(/^#+\s*/, "").replace(/^(?:archivo|file|ruta|path)\s*:\s*/i, "")
      .replace(/[*_`"']/g, "").replace(/:$/, "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
    return bare === p ? p : null;
  }
  return null;
}

// --------------------------------------------------------------- udiff
function headerPath(s) {
  const p = s.replace(/\t.*$/, "").trim(); // "ruta\t2024-01-01 ..." (timestamp de diff -u)
  return p === "/dev/null" ? "/dev/null" : p;
}

// Parsea lineas de un diff unificado. Tolerante con lo que los modelos
// suelen hacer mal: @@ sin numeros, lineas en blanco de contexto sin el
// espacio adelante, un hunk sin @@ justo despues de ---/+++, lineas "diff
// --git"/"index" sueltas. Lo que NO acepta: arrancar un hunk implicito en
// cualquier lado -- una vez que aparece prosa, una viñeta "- algo" ya no se
// toma como linea borrada (solo @@ o un nuevo ---/+++ reabren).
// ¿"--- x" / "+++ y" en la linea i es un encabezado de archivo? Fuera de un
// hunk, si. DENTRO de uno, "--- viejo" puede ser una linea borrada que
// empieza con "-- " (comentario SQL/Lua/Haskell) seguida de una agregada que
// empieza con "++": antes eso se tomaba como archivo nuevo y el hunk se
// perdia EN SILENCIO. Dentro de un hunk solo cuenta como encabezado si
// despues viene un @@ o si ambos lados parecen rutas de verdad.
function isFileHeader(lines, i, inHunk) {
  if (!(lines[i].startsWith("--- ") && i + 1 < lines.length && lines[i + 1].startsWith("+++ "))) return false;
  if (!inHunk) return true;
  if (/^@@/.test(lines[i + 2] || "")) return true;
  const looksPath = (x) => {
    const p = headerPath(x);
    return p === "/dev/null" || Boolean(cleanPathLine(p.replace(/^[ab]\//, "")));
  };
  return looksPath(lines[i].slice(4)) && looksPath(lines[i + 1].slice(4));
}

function parseDiffLines(lines) {
  const files = [];
  let cur = null;
  let hunk = null;
  let implicitOk = false;
  let lastLine = -1;
  const flush = () => {
    if (!hunk) return;
    while (hunk.lines.length && hunk.lines[hunk.lines.length - 1].t === " " && !hunk.lines[hunk.lines.length - 1].s.trim()) hunk.lines.pop();
    if (hunk.lines.some((x) => x.t !== " ")) cur.hunks.push(hunk);
    hunk = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (isFileHeader(lines, i, Boolean(hunk))) {
      if (cur) flush();
      cur = { minus: headerPath(l.slice(4)), plus: headerPath(lines[i + 1].slice(4)), hunks: [] };
      files.push(cur);
      i++;
      lastLine = i;
      implicitOk = true;
      continue;
    }
    const at = /^@@(.*?)(@@|$)/.exec(l);
    if (at) {
      if (!cur) { cur = { minus: null, plus: null, hunks: [] }; files.push(cur); }
      flush();
      const m = /-(\d+)/.exec(at[1]);
      hunk = { hint: m ? Number(m[1]) : null, lines: [] };
      lastLine = i;
      implicitOk = false;
      continue;
    }
    if (!cur) continue;
    if (/^(diff --git |index |new file mode|deleted file mode|similarity index|rename (from|to) |old mode|new mode)/.test(l)) { flush(); continue; }
    if (l.startsWith("\\ No newline")) { lastLine = i; continue; }
    const c = l[0];
    const isDiffLine = c === " " || c === "-" || c === "+" || l === "";
    if (isDiffLine && (hunk || (implicitOk && l !== ""))) {
      if (!hunk) hunk = { hint: null, lines: [] };
      hunk.lines.push({ t: l === "" ? " " : c, s: l === "" ? "" : l.slice(1) });
      lastLine = i;
      implicitOk = false;
      continue;
    }
    if (l === "" && !hunk) continue;
    // Prosa u otra cosa: cierra el hunk; de aca en adelante solo @@ o un
    // nuevo encabezado ---/+++ vuelven a abrir uno.
    flush();
    implicitOk = false;
  }
  if (cur) flush();
  return { files, lastLine };
}

function renderHunk(lines) {
  return lines.map((x) => (x.t === " " ? " " : x.t) + x.s).join("\n");
}

function hunkEdit(lines, hint) {
  const search = lines.filter((x) => x.t !== "+").map((x) => x.s).join("\n");
  const replace = lines.filter((x) => x.t !== "-").map((x) => x.s).join("\n");
  const hasSearch = lines.some((x) => x.t !== "+");
  return { search: hasSearch ? search : "", replace, lineHint: hint, display: renderHunk(lines) };
}

// Linea (del archivo original) donde arranca el tramo `from` del hunk, a
// partir del @@ -N: cuenta solo las lineas que existen en el original.
function hintAt(hunk, from) {
  if (hunk.hint == null) return null;
  return hunk.hint + hunk.lines.slice(0, from).filter((x) => x.t !== "+").length;
}

// Parte un hunk en sub-hunks, uno por cada tramo de cambios, con hasta K
// lineas de contexto a cada lado (el contexto entre dos tramos se reparte,
// sin compartir lineas, para que los sub-hunks nunca se solapen).
function splitHunk(hunk, K) {
  const L = hunk.lines;
  const runs = [];
  for (let i = 0; i < L.length; i++) {
    if (L[i].t === " ") continue;
    let j = i;
    while (j + 1 < L.length && L[j + 1].t !== " ") j++;
    runs.push([i, j]);
    i = j;
  }
  const parts = [];
  for (let r = 0; r < runs.length; r++) {
    const [i, j] = runs[r];
    const prevEnd = r > 0 ? runs[r - 1][1] : -1;
    const nextStart = r + 1 < runs.length ? runs[r + 1][0] : L.length;
    const gapBefore = i - prevEnd - 1;
    const gapAfter = nextStart - j - 1;
    const before = r > 0 ? Math.min(K, Math.floor(gapBefore / 2)) : Math.min(K, gapBefore);
    const after = r + 1 < runs.length ? Math.min(K, Math.ceil(gapAfter / 2)) : Math.min(K, gapAfter);
    const from = i - before;
    const slice = L.slice(from, j + 1 + after);
    const e = hunkEdit(slice, hintAt(hunk, from));
    if (!e.search.trim()) return null; // un tramo que solo agrega, sin contexto: no se puede ubicar
    parts.push(e);
  }
  return parts;
}

// Planes B de un hunk que no calzo entero (el refinamiento que mas ayuda con
// diffs de LLMs, igual idea que Aider): 1) sin lineas de contexto en blanco
// en los bordes, 2) partido en sub-hunks con 3 y despues 1 linea de
// contexto -- muchas veces el modelo copio mal UNA linea de contexto lejos
// del cambio, y achicar el contexto la deja afuera.
function hunkFallbacks(hunk) {
  const sets = [];
  const L = hunk.lines;
  let a = 0;
  let b = L.length;
  while (a < b && L[a].t === " " && !L[a].s.trim()) a++;
  while (b > a && L[b - 1].t === " " && !L[b - 1].s.trim()) b--;
  if (a > 0 || b < L.length) {
    const e = hunkEdit(L.slice(a, b), hintAt(hunk, a));
    if (e.search.trim()) sets.push([e]);
  }
  for (const K of [3, 1]) {
    const parts = splitHunk(hunk, K);
    if (parts) sets.push(parts);
  }
  const primary = hunkEdit(L, hunk.hint);
  const seen = new Set([JSON.stringify([[primary.search, primary.replace]])]);
  return sets.filter((s) => {
    const k = JSON.stringify(s.map((e) => [e.search, e.replace]));
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function diffSectionsToEdits(files, span, defaultPath) {
  const edits = [];
  for (const f of files) {
    let minus = f.minus;
    let plus = f.plus;
    // "a/" y "b/" de git: se sacan si ambos lados los traen (o el otro es /dev/null).
    const aOk = minus && minus.startsWith("a/");
    const bOk = plus && plus.startsWith("b/");
    if ((aOk && (bOk || plus === "/dev/null")) || (bOk && minus === "/dev/null")) {
      if (aOk) minus = minus.slice(2);
      if (bOk) plus = plus.slice(2);
    }
    const clean = (p) => (p && p !== "/dev/null" ? cleanPathLine(p) || p.replace(/\\/g, "/").replace(/^\.\//, "") : p);
    minus = clean(minus);
    plus = clean(plus);
    const base = { format: "udiff", blockStart: span.start, blockEnd: span.end };
    if (plus === "/dev/null") {
      edits.push({ ...base, path: minus, explicitPath: true, search: "", replace: "", invalid: "Borrar archivos enteros con un diff no esta soportado; pedile al usuario que lo borre a mano." });
      continue;
    }
    const target = plus || minus || defaultPath || null;
    const explicitPath = Boolean(plus || minus);
    if (minus === "/dev/null") {
      const content = f.hunks.flatMap((h) => h.lines.filter((x) => x.t !== "-").map((x) => x.s)).join("\n");
      // createOnly: "--- /dev/null" significa archivo NUEVO; si ya existe,
      // applyEdits falla en vez de pegarle el contenido al final (duplicado).
      edits.push({ ...base, path: target, explicitPath, search: "", replace: content, createOnly: true, display: f.hunks.map((h) => renderHunk(h.lines)).join("\n") });
      continue;
    }
    for (const h of f.hunks) {
      const e = hunkEdit(h.lines, h.hint);
      edits.push({ ...base, path: target, explicitPath, ...e, fallbacks: hunkFallbacks(h) });
    }
  }
  return edits;
}

function isDiffFence(f) {
  const body = f.bodyLines.join("\n");
  const hasHeaders = /^--- .*\n\+\+\+ /m.test(body);
  return /^(diff|patch|udiff)$/i.test(f.info) ? hasHeaders || /^@@/m.test(body) : hasHeaders;
}

function parseUdiff(text, defaultPath, scan) {
  const { lines, lineStarts, fences } = scan;
  const edits = [];
  for (const f of fences) {
    if (!isDiffFence(f)) continue;
    const { files } = parseDiffLines(f.bodyLines);
    edits.push(...diffSectionsToEdits(files, { start: f.start, end: f.end }, defaultPath));
  }
  if (edits.length) return edits;
  // Sin fence: a veces el modelo pega el diff "suelto". Solo se acepta si
  // arranca con un encabezado ---/+++ de verdad, fuera de cualquier fence.
  const inFence = new Set();
  for (const f of fences) for (let i = f.line; i < f.bodyFirstLine + f.bodyLines.length + 1; i++) inFence.add(i);
  const first = lines.findIndex((l, i) => !inFence.has(i) && l.startsWith("--- ") && i + 1 < lines.length && lines[i + 1].startsWith("+++ "));
  if (first === -1) return [];
  const slice = [];
  for (let i = first; i < lines.length && !inFence.has(i); i++) slice.push(lines[i]);
  const { files, lastLine } = parseDiffLines(slice);
  const endIdx = first + Math.max(lastLine, 0);
  return diffSectionsToEdits(files, { start: lineStarts[first], end: lineStarts[endIdx] + lines[endIdx].length }, defaultPath);
}

// --------------------------------------------------------------- whole
function parseWhole(scan) {
  const { lines, fences } = scan;
  const edits = [];
  for (const f of fences) {
    const p = pathBefore(lines, f.line, true);
    if (!p) continue; // bloque sin ruta arriba: es un ejemplo, no un archivo
    const base = { format: "whole", whole: true, path: p, explicitPath: true, search: "", replace: "", blockStart: f.start, blockEnd: f.end };
    if (!f.closed) {
      // Respuesta cortada (limite de tokens): NUNCA escribir un archivo a medias.
      edits.push({ ...base, invalid: "El bloque del archivo completo quedo sin cerrar (la respuesta se corto?): no se escribe un archivo a medias." });
      continue;
    }
    edits.push({ ...base, content: f.bodyLines.join("\n") });
  }
  return edits;
}

// --------------------------------------------------------------- API
function normalizeNewlines(s) {
  return String(s == null ? "" : s).replace(/\r\n/g, "\n");
}

// Parsea los cambios de una respuesta. Los marcadores SEARCH/REPLACE y los
// diffs con encabezado son inequivocos, asi que se aceptan SIEMPRE, pida lo
// que pida el formato (si un modelo al que se le pidio "whole" igual manda
// SEARCH/REPLACE, se aplica lo que mando). "Archivo completo" en cambio es
// ambiguo (cualquier bloque de codigo con una ruta arriba), asi que solo se
// busca cuando ese ES el formato pedido.
function parseEdits(text, format, defaultPath) {
  const t = normalizeNewlines(text);
  if (/<<<<<<< SEARCH/.test(t)) return parseEditBlocks(t, defaultPath).map((e) => ({ ...e, format: "search-replace", display: e.search }));
  const scan = scanFences(t);
  const ud = parseUdiff(t, defaultPath, scan);
  if (ud.length) return ud;
  if (format === "whole") return parseWhole(scan);
  return [];
}

function hasEdits(text, format) {
  return parseEdits(text, format, null).length > 0;
}

// Quita de la respuesta los bloques de cambios (y la linea de ruta que los
// precede), para mostrar solo la explicacion en prosa -- los cambios se ven
// aparte, como tarjetas por archivo.
function stripEdits(text, edits) {
  const t = normalizeNewlines(text);
  if (!edits || !edits.length) return t;
  const spans = [];
  for (const e of edits) if (e.blockStart != null) spans.push([e.blockStart, e.blockEnd]);
  spans.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
    else merged.push([...s]);
  }
  let out = "";
  let cursor = 0;
  for (const [start, end] of merged) {
    const before = t.slice(cursor, start).replace(/\n+$/, "");
    const lastNl = before.lastIndexOf("\n");
    const lastLine = before.slice(lastNl + 1);
    out += (cleanPathLine(lastLine) ? before.slice(0, Math.max(0, lastNl)) : before) + "\n";
    cursor = end;
  }
  out += t.slice(cursor);
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

module.exports = {
  FORMATS, FORMAT_LABEL, WHOLE_MAX_CHARS,
  normalizeFormat, resolveEditFormat, formatInstructions, repairInstruction, verifyFixInstruction, describeFailure,
  parseEdits, hasEdits, stripEdits,
  // para tests
  parseDiffLines, splitHunk, hunkFallbacks, scanFences,
};
