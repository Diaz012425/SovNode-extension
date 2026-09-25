"use strict";

const path = require("path");

// Motor de edicion SEARCH/REPLACE -- port de edit mode de SovNode-Web
// (app_en.py: parse_edit_blocks / apply_one_edit / apply_edits), ahora
// MULTI-ARCHIVO y con CREACION de archivos, igual que el formato de Aider:
//
//   ruta/relativa/del/archivo.ext
//   ```edit
//   <<<<<<< SEARCH
//   texto EXACTO que existe hoy en ese archivo   (vacio = crear archivo / agregar al final)
//   =======
//   texto de reemplazo
//   >>>>>>> REPLACE
//   ```
//
// La ruta va en la linea justo antes del fence. Si falta, el bloque se
// asigna al archivo por defecto (el activo del editor), igual que la v0.1.
//
// Este modulo es PURO (no importa vscode): recibe funciones para leer
// archivos, asi se puede testear con node sin abrir VS Code.

// SEARCH vacio es valido (crear archivo), por eso los \n antes de ======= y
// >>>>>>> REPLACE son opcionales. El fence de cierre tambien es opcional:
// si el modelo se corta justo al final, no perdemos un bloque que por lo
// demas esta completo.
const EDIT_BLOCK_RE = /```[^\n]*\n<<<<<<< SEARCH\n([\s\S]*?)\n?>>>>>>> REPLACE[^\n]*(?:\n```)?/g;
const DIVIDER = "=======";

// Parte el cuerpo de un bloque en SEARCH/REPLACE. Si hay UNA sola linea
// "=======" no hay dudas. Si hay varias (un titulo de Markdown/RST
// subrayado con "=======", o un conflicto de merge dentro del codigo), no se
// puede saber cual es el separador solo leyendo el texto: antes se tomaba
// siempre la primera, y con SEARCH "Titulo\n=======\ncuerpo" el SEARCH
// quedaba en "Titulo" y se escribia basura EN SILENCIO. Ahora se devuelven
// todos los cortes posibles y applyEdits elige el que calza en el archivo.
function splitBlockBody(body) {
  const lines = body.split("\n");
  const cuts = [];
  lines.forEach((l, i) => { if (l === DIVIDER) cuts.push(i); });
  return cuts.map((i) => ({ search: lines.slice(0, i).join("\n"), replace: lines.slice(i + 1).join("\n") }));
}

function normalizeNewlines(s) {
  return String(s == null ? "" : s).replace(/\r\n/g, "\n");
}

// Limpia la linea de ruta que el modelo pone antes del bloque: acepta
// `ruta`, **ruta**, "Archivo: ruta", "ruta:" , "### ruta", etc.
function cleanPathLine(line) {
  let p = line.trim();
  // Ruta entre backticks dentro de una frase: "Crea `src/util.py`:"
  const tick = /`([^`\n]+)`/.exec(p);
  if (tick && /\.[A-Za-z0-9]+$/.test(tick[1].trim())) p = tick[1];
  p = p.trim();
  p = p.replace(/^#+\s*/, "");
  p = p.replace(/^(?:archivo|file|ruta|path)\s*:\s*/i, "");
  p = p.replace(/^[*_`"']+|[*_`"']+$/g, "");
  p = p.replace(/:$/, "").trim();
  p = p.replace(/\\/g, "/");
  if (!p || p.length > 200) return null;
  // Con espacios SOLO si termina en extension ("base de dooom.py"): asi una
  // frase normal ("Listo, aqui va") nunca se confunde con una ruta.
  if (/\s/.test(p)) {
    if (!/^[\p{L}\p{N}_.\-\/@+ ]+\.[A-Za-z0-9]+$/u.test(p) || p.split(/\s+/).length > 6) return null;
  } else if (!/^[\p{L}\p{N}_.\-\/@+]+$/u.test(p)) return null;
  // (\p{L} y no \w: \w es solo ASCII, y "código.py" o "configuración.js" no
  // se reconocian como ruta -- el bloque caia al archivo ACTIVO y editaba
  // otro archivo que tuviera el mismo texto.)
  // Debe parecer un archivo: tener extension (index.html), o carpeta
  // (src/x), o ser un nombre conocido sin extension. "hola." o "Listo" no.
  const looksLikeFile = /\.[A-Za-z0-9]+$/.test(p) || /[\p{L}\p{N}_-]\/[\p{L}\p{N}_.-]/u.test(p) || /^(Makefile|Dockerfile|LICENSE|Procfile|Gemfile|Rakefile)$/.test(p);
  return looksLikeFile ? p.replace(/^\.\//, "") : null;
}

function parseEditBlocks(answer, defaultPath) {
  const text = normalizeNewlines(answer);
  const edits = [];
  let m;
  EDIT_BLOCK_RE.lastIndex = 0;
  while ((m = EDIT_BLOCK_RE.exec(text)) !== null) {
    const before = text.slice(0, m.index).replace(/\n+$/, "");
    const lastLine = before.slice(before.lastIndexOf("\n") + 1);
    const explicit = cleanPathLine(lastLine);
    const path = explicit || defaultPath || null;
    const cuts = splitBlockBody(m[1]);
    if (!cuts.length) continue; // sin "=======": no es un bloque valido
    const edit = { path, explicitPath: Boolean(explicit), search: cuts[0].search, replace: cuts[0].replace, blockStart: m.index, blockEnd: m.index + m[0].length };
    if (cuts.length > 1) edit.alternatives = cuts;
    edits.push(edit);
  }
  return edits;
}

function hasEditBlocks(answer) {
  return /<<<<<<< SEARCH/.test(answer || "");
}

// Quita los bloques de edicion (y la linea de ruta que los precede) de la
// respuesta, para mostrar solo la explicacion en prosa. Los bloques se
// muestran aparte como tarjetas de cambios.
function stripEditBlocks(answer, edits) {
  const text = normalizeNewlines(answer);
  if (!edits || !edits.length) return text;
  let out = "";
  let cursor = 0;
  for (const e of edits) {
    let start = e.blockStart;
    const before = text.slice(cursor, start).replace(/\n+$/, "");
    const lastNl = before.lastIndexOf("\n");
    const lastLine = before.slice(lastNl + 1);
    const keep = cleanPathLine(lastLine) ? before.slice(0, Math.max(0, lastNl)) : before;
    out += keep + "\n";
    cursor = e.blockEnd;
  }
  out += text.slice(cursor);
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

function normalizeWs(s) {
  return s.replace(/[ \t]+/g, " ").replace(/[ \t]+$/gm, "");
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Cascada de matching (de mas estricto a mas tolerante), identica a la v0.1:
//   1. bloque de lineas completas exacto
//   2. bloque de lineas completas tolerante a espacios/tabs
//   3. substring de UNA linea con limite de palabra (\b) -- "return 1" nunca
//      calza dentro de "return 10".
function findSearchSpan(original, search) {
  const lines = original.split("\n");
  const searchLines = search.split("\n");
  const n = searchLines.length;
  const offsetOf = (i) => lines.slice(0, i).join("\n").length + (i > 0 ? 1 : 0);

  // Cada nivel exige coincidencia UNICA: si el texto aparece 2+ veces no se
  // adivina (antes se tomaba la primera y un edit podia caer en la funcion
  // equivocada sin aviso) -- se reporta como ambiguo y la ronda de
  // reparacion le pide al modelo un SEARCH mas especifico.
  // Si es ambiguo se devuelven igual todas las posiciones (`hits`): un diff
  // unificado puede traer el numero de linea en el @@ y con eso se elige
  // (ver pickByLineHint) -- SEARCH/REPLACE no trae pista y sigue fallando.
  const collect = (test, tolerant) => {
    const hits = [];
    for (let i = 0; i + n <= lines.length; i++) {
      const cand = lines.slice(i, i + n).join("\n");
      if (test(cand)) hits.push({ start: offsetOf(i), end: offsetOf(i) + cand.length, wholeLines: true, tolerant });
    }
    return hits;
  };
  let hits = collect((c) => c === search, false);
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) return { ambiguous: hits.length, hits };
  const normSearch = normalizeWs(search);
  hits = collect((c) => normalizeWs(c) === normSearch, true);
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) return { ambiguous: hits.length, hits };
  if (n === 1 && search.trim()) {
    const pattern = (/^\w/.test(search) ? "\\b" : "") + escapeRegex(search) + (/\w$/.test(search) ? "\\b" : "");
    const all = [...original.matchAll(new RegExp(pattern, "g"))].map((m) => ({ start: m.index, end: m.index + m[0].length, tolerant: true, wholeLines: false }));
    if (all.length === 1) return all[0];
    if (all.length > 1) return { ambiguous: all.length, hits: all };
  }
  return null;
}

function lineOf(text, offset) {
  return text.slice(0, offset).split("\n").length;
}

function countLines(s) {
  if (!s) return 0;
  return s.replace(/\n$/, "").split("\n").length;
}

// Entre varias coincidencias, la mas cercana a la linea que dijo el modelo
// (el "-N" del @@ de un diff). Solo si es la UNICA mas cercana y esta a
// menos de 50 lineas: si no, se sigue tratando como ambiguo -- nunca se
// adivina entre dos lugares igual de probables.
function pickByLineHint(hits, text, hint) {
  if (!hint || !hits || !hits.length) return null;
  const scored = hits.map((h) => ({ h, d: Math.abs(lineOf(text, h.start) - hint) })).sort((a, b) => a.d - b.d);
  if (scored[0].d > 50) return null;
  if (scored.length > 1 && scored[1].d === scored[0].d) return null;
  return scored[0].h;
}

// Resumen de un reemplazo de archivo entero: primera linea que cambia y
// cuantas lineas salen/entran (recortando el prefijo y el sufijo iguales).
function diffSummary(a, b) {
  const A = a.split("\n");
  const B = b.split("\n");
  let p = 0;
  while (p < A.length && p < B.length && A[p] === B[p]) p++;
  let s = 0;
  while (s < A.length - p && s < B.length - p && A[A.length - 1 - s] === B[B.length - 1 - s]) s++;
  if (p === A.length && p === B.length) return null;
  return { line: p + 1, removed: A.length - p - s, added: B.length - p - s };
}

// "Archivo completo" con partes abreviadas ("// ... resto igual ..."): si se
// escribiera tal cual, se BORRARIA todo lo abreviado. Se detectan lineas de
// comentario con ese tipo de frase (o "..." solo en una linea) que NO
// estaban ya en el original.
function lazyLines(content, original) {
  const orig = new Set(String(original || "").split("\n").map((l) => l.trim()));
  const out = [];
  const strong = /(resto del|rest of (the )?(code|file|class|function|module)|existing code|c[oó]digo existente|sin cambios|unchanged|lo dem[aá]s|igual que antes|same as before|previous code|c[oó]digo anterior|(remaining|other) (code|methods|functions))/i;
  const weak = /(resto|rest|remaining|existing|igual|same|unchanged|anterior|previous|etc)/i;
  for (const line of content.split("\n")) {
    const t = line.trim();
    if (!t || orig.has(t)) continue;
    const bare = /^(\.\.\.|…)$/.test(t);
    const isComment = /^(\/\/|#|\/\*|\*|<!--|--|;|%|')/.test(t);
    const ellipsis = /(\.\.\.|…)/.test(t);
    if (bare || (isComment && (strong.test(t) || (ellipsis && weak.test(t))))) out.push(t);
  }
  return out;
}

// Aplica los edits de UN archivo. original === null significa "el archivo
// no existe". Todo-o-nada: si un SEARCH no calza, no se aplica nada.
// Devuelve tambien, por cada edit, la linea donde cayo y cuantas lineas
// quito/agrego -- eso es lo que la UI usa para decir "DONDE" cambio.
function applyEdits(original, edits) {
  const exists = original !== null && original !== undefined;
  // BOM y fin de linea del archivo ORIGINAL: todo el matching trabaja sobre
  // texto sin BOM y con \n, y al final se restaura lo que tenia. Antes un
  // BOM al principio hacia fallar cualquier SEARCH de la primera linea (y la
  // reescritura completa lo borraba), y un archivo CRLF volvia en LF: git
  // mostraba TODAS las lineas cambiadas.
  const raw = exists ? String(original) : "";
  const bom = raw.startsWith("\uFEFF");
  const crlfCount = (raw.match(/\r\n/g) || []).length;
  const crlf = crlfCount > 0 && crlfCount >= ((raw.match(/\n/g) || []).length - crlfCount);
  const finish = (res) => {
    if (!res.ok || res.patched == null || !exists) return res;
    let p = res.patched;
    if (crlf) p = p.replace(/\r?\n/g, "\r\n");
    if (bom) p = "\uFEFF" + p;
    return { ...res, patched: p };
  };
  return finish(applyEditsLF(exists, normalizeNewlines(bom ? raw.slice(1) : raw), original, edits));
}

function applyEditsLF(exists, base, original, edits) {
  let patched = exists ? base : "";
  const failures = [];
  const located = [];
  let created = false;
  let appendText = "";
  const changes = [];

  const fail = (reason, e) => ({ ok: false, failures: [{ search: e ? e.search || "" : "", display: e && e.display, whole: Boolean(e && e.whole), reason }], patched: exists ? original : null, tolerantCount: 0, changes: [], created: false });

  const invalid = edits.find((e) => e.invalid);
  if (invalid) return fail(invalid.invalid, invalid);

  // Formato "archivo completo": un solo edit por archivo que trae el
  // contenido entero -- no se busca nada, se reemplaza todo.
  const wholeEdits = edits.filter((e) => e.whole);
  if (wholeEdits.length) {
    const e = wholeEdits[0];
    if (edits.length > 1) return fail("Ese archivo aparece mas de una vez en la respuesta; escribilo UNA sola vez, entero.", e);
    let content = normalizeNewlines(e.content);
    if (!exists) {
      if (content && !content.endsWith("\n")) content += "\n";
      return { ok: true, failures: [], patched: content, tolerantCount: 0, created: true, changes: [{ kind: "create", line: 1, removed: 0, added: countLines(content), search: "", replace: content }] };
    }
    const orig = base;
    if (content.startsWith("\uFEFF")) content = content.slice(1);
    if (!content.trim()) return fail("El archivo completo vino vacio; si de verdad hay que vaciarlo, pediselo al usuario.", e);
    const lazy = lazyLines(content, orig);
    if (lazy.length) return fail(`El archivo viene abreviado ("${lazy[0].slice(0, 80)}"): en este formato lo que no se escribe se BORRA. Escribilo completo, sin resumir nada.`, e);
    // Respetar si el original terminaba o no en salto de linea: si no, cada
    // reescritura mostraria un cambio fantasma en la ultima linea.
    if (orig.endsWith("\n") && !content.endsWith("\n")) content += "\n";
    if (!orig.endsWith("\n") && content.endsWith("\n")) content = content.replace(/\n+$/, "");
    const d = diffSummary(orig, content);
    return { ok: true, failures: [], patched: d ? content : orig, tolerantCount: 0, created: false, changes: d ? [{ kind: "rewrite", ...d, search: "", replace: "" }] : [] };
  }

  const overlaps = (span, list) => list.some((l) => span.start < l.end && l.start < span.end);
  const locate = (text, search, hint) => {
    let span = findSearchSpan(text, search);
    if (span && span.ambiguous && hint) span = pickByLineHint(span.hits, text, hint) || span;
    return span;
  };
  // Planes B de un hunk de diff que no calzo entero (ver hunkFallbacks en
  // editFormats.js): cada set tiene que ubicarse COMPLETO, sin ambiguedad y
  // sin pisarse con nada, o no se usa.
  const tryFallbacks = (e) => {
    for (const set of e.fallbacks || []) {
      const subs = [];
      let okSet = true;
      for (const sub of set) {
        const search = normalizeNewlines(sub.search);
        const replace = normalizeNewlines(sub.replace);
        let span = search.trim() ? locate(patched, search, sub.lineHint) : null;
        if (!span || span.ambiguous) { okSet = false; break; }
        if (span.wholeLines && replace === "" && patched[span.end] === "\n") span = { ...span, end: span.end + 1 };
        if (overlaps(span, located) || overlaps(span, subs)) { okSet = false; break; }
        subs.push({ ...span, replace, search, tolerant: true });
      }
      if (okSet && subs.length) return subs;
    }
    return null;
  };

  for (const e of edits) {
    const search = normalizeNewlines(e.search);
    const replace = normalizeNewlines(e.replace);
    if (e.createOnly && exists) {
      // "--- /dev/null" dice "archivo NUEVO": si ya existe, agregarlo al
      // final duplicaba el contenido entero.
      failures.push({ search, display: e.display, reason: "El diff crea el archivo (--- /dev/null) pero ese archivo YA existe; para cambiarlo, usa un hunk con lineas de contexto." });
      continue;
    }
    if (!search.trim()) {
      // SEARCH vacio: crear archivo, o agregar al final si ya existe.
      if (exists && patched.trim() && replace.trim() && replace.includes(patched.trim())) {
        // "Crear" un archivo que ya existe con ese mismo contenido (el modelo
        // se olvido de que ya estaba): agregar al final lo duplicaba.
        failures.push({ search, display: e.display, reason: "Ese archivo YA existe y ya tiene ese contenido; para cambiarlo usa un SEARCH con el texto actual (SEARCH vacio agrega al final)." });
        continue;
      }
      // Bug real (v0.29.4): "crea index.html: una pagina autocontenida..."
      // sobre un index.html que YA tenia otra app (ej. un juego anterior) se
      // interpretaba como "agregar al final", fusionando dos <html> completos
      // en un solo archivo y rompiendo los dos (ids/listeners duplicados). El
      // modelo penso que estaba creando un archivo nuevo sin darse cuenta de
      // que ya habia contenido. Señal barata y generica (sin parsear HTML de
      // verdad): si TANTO el archivo actual como lo que se agrega arrancan un
      // documento entero (<!DOCTYPE html> o <html ...>), agregar dos es casi
      // siempre un error -- se corta y se le pide al modelo que mire el
      // archivo actual y decida si hay que REEMPLAZARLO (SEARCH con el
      // contenido de hoy) en vez de agregarle un segundo documento.
      const looksLikeFullHtmlDoc = (t) => /<!doctype\s+html|<html[\s>]/i.test(String(t || "").slice(0, 500));
      if (exists && patched.trim() && looksLikeFullHtmlDoc(patched) && looksLikeFullHtmlDoc(replace)) {
        failures.push({ search, display: e.display, reason: "Ese archivo YA tiene una pagina HTML completa (<html>) y lo que se agrego es OTRA pagina completa; un SEARCH vacio las hubiera fusionado en un archivo roto con dos <html>. Si el pedido es reemplazar el archivo, usa un SEARCH con el contenido ACTUAL completo (o el formato de archivo entero); si es agregar algo puntual, agregalo dentro del documento existente, no como un segundo <html>." });
        continue;
      }
      if (!exists && !created) {
        created = true;
        appendText += replace;
        changes.push({ kind: "create", line: 1, removed: 0, added: countLines(replace), search, replace });
      } else {
        const base = patched + appendText;
        const sep = base && !base.endsWith("\n") ? "\n" : "";
        const line = countLines(base) + 1;
        appendText += sep + replace;
        changes.push({ kind: "append", line, removed: 0, added: countLines(replace), search, replace });
      }
      continue;
    }
    if (!exists) {
      failures.push({ search, display: e.display, reason: e.format === "udiff" ? "El archivo no existe; para crearlo el diff tiene que usar \"--- /dev/null\" y solo lineas con +." : "El archivo no existe, pero el bloque SEARCH no esta vacio (para crear un archivo, SEARCH debe ir vacio)." });
      continue;
    }
    let span;
    let search2 = search;
    let replace2 = replace;
    if (e.alternatives) {
      // Varias lineas "=======" en el bloque: se prueba cada corte y se usa
      // el que calza de forma unica en el archivo; si calzan varios, el de
      // SEARCH mas largo (el mas especifico). Si ninguno, falla normal.
      const ok = [];
      for (const c of e.alternatives) {
        const s2 = normalizeNewlines(c.search);
        if (!s2.trim()) continue;
        const sp = locate(patched, s2, e.lineHint);
        if (sp && !sp.ambiguous) ok.push({ sp, s2, r2: normalizeNewlines(c.replace) });
      }
      ok.sort((a, b) => b.s2.length - a.s2.length);
      if (ok.length) { span = ok[0].sp; search2 = ok[0].s2; replace2 = ok[0].r2; }
      else span = locate(patched, search, e.lineHint);
    } else {
      span = locate(patched, search, e.lineHint);
    }
    if ((!span || span.ambiguous) && e.fallbacks && e.fallbacks.length) {
      const subs = tryFallbacks(e);
      if (subs) { located.push(...subs); continue; }
    }
    if (span && span.ambiguous) {
      failures.push({ search, display: e.display, reason: `Ese texto aparece ${span.ambiguous} veces en el archivo; ${e.format === "udiff" ? "el hunk necesita mas lineas de contexto" : "el SEARCH necesita lineas vecinas"} para ser unico.` });
      continue;
    }
    // Borrar lineas completas: tambien se come el salto de linea siguiente;
    // si no, queda una linea en blanco donde estaba el codigo borrado.
    if (span && span.wholeLines && replace2 === "" && patched[span.end] === "\n") span = { ...span, end: span.end + 1 };
    if (!span) {
      failures.push({ search, display: e.display, reason: e.format === "udiff" ? "Las lineas de contexto / borradas (-) de ese hunk no estan asi en el archivo actual (ni tolerando espacios, ni partiendo el hunk)." : "No se encontro ese texto exacto (ni tolerando espacios) en el archivo actual." });
      continue;
    }
    if (overlaps(span, located)) {
      failures.push({ search, display: e.display, reason: "Dos bloques del mismo archivo apuntan al mismo texto (se solapan)." });
      continue;
    }
    located.push({ ...span, replace: replace2, search: search2 });
  }
  if (failures.length) return { ok: false, failures, patched: exists ? original : null, tolerantCount: 0, changes: [], created: false };
  // (cualquier edit con `fallbacks` ya quedo ubicado arriba, entero o partido)

  let tolerantCount = 0;
  // Lineas calculadas sobre el original, antes de parchear.
  for (const loc of located) {
    changes.push({ kind: "edit", line: lineOf(patched, loc.start), removed: countLines(patched.slice(loc.start, loc.end)), added: countLines(loc.replace), search: loc.search, replace: loc.replace, tolerant: loc.tolerant });
  }
  located.sort((a, b) => b.start - a.start);
  for (const loc of located) {
    if (loc.tolerant) tolerantCount++;
    patched = patched.slice(0, loc.start) + loc.replace + patched.slice(loc.end);
  }
  patched += appendText;
  // Salto de linea final: al crear, siempre; al agregar al final de un
  // archivo que terminaba en \n, tambien (si no, quedaba sin \n final).
  if ((created || (appendText && base.endsWith("\n"))) && patched && !patched.endsWith("\n")) patched += "\n";
  changes.sort((a, b) => a.line - b.line);
  return { ok: true, failures: [], patched, tolerantCount, changes, created };
}

// Agrupa edits por archivo preservando el orden de aparicion.
// "src/./a.js" y "src/a.js" (y en Windows "Src/A.js") son el MISMO archivo;
// agruparlos por separado hacia que un cambio pisara al otro.
function groupByPath(edits) {
  const groups = new Map();
  for (const e of edits) {
    const norm = e.path ? path.posix.normalize(e.path.replace(/\\/g, "/")) : "";
    const key = process.platform === "win32" ? norm.toLowerCase() : norm;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ ...e, path: norm || null });
  }
  const out = new Map();
  for (const list of groups.values()) out.set(list[0].path || "", list);
  return out;
}

// Planifica un cambio multi-archivo SIN escribir nada: para cada archivo,
// lee su contenido actual con readFile(path) -> string|null y calcula el
// resultado. Todo-o-nada a nivel de TODA la respuesta: si un solo archivo
// falla, no se escribe ninguno (igual que finalize_edits del backend).
async function planChangeSet(edits, readFile, validatePath) {
  const files = [];
  const failures = [];
  for (const [path, fileEdits] of groupByPath(edits)) {
    if (!path) {
      failures.push({ path: "(sin ruta)", search: fileEdits[0].search, reason: "El bloque no indica en que archivo va, y no hay un archivo activo en el editor." });
      continue;
    }
    const pathError = validatePath ? validatePath(path) : null;
    if (pathError) {
      failures.push({ path, search: fileEdits[0].search, reason: pathError });
      continue;
    }
    if (fileEdits.some((e) => e.explicitPath === false && !e.search.trim())) {
      // Nunca "crear / agregar al final" sobre el archivo activo por descarte:
      // si el modelo no dijo donde va un archivo nuevo, falla (y la ronda de
      // reparacion le pide la ruta) en vez de pegar el archivo en el tuyo.
      failures.push({ path, search: "", reason: "Un bloque que CREA un archivo no indica su ruta (la linea justo arriba del bloque debe ser la ruta, ej: game/index.html)." });
      continue;
    }
    const before = await readFile(path);
    const res = applyEdits(before, fileEdits);
    if (!res.ok) {
      for (const f of res.failures) failures.push({ path, ...f });
      continue;
    }
    // Formato "archivo completo" que reescribio un archivo identico al
    // actual (pasa seguido: el modelo repite un archivo que no cambia): no
    // se escribe ni se commitea nada para ese archivo. Solo para "whole": en
    // SEARCH/REPLACE/diff un bloque que no cambia nada es deliberado y se
    // respeta como antes.
    if (before !== null && fileEdits.every((e) => e.whole) && res.patched === before) continue;
    files.push({ path, before, after: res.patched, created: before === null, changes: res.changes, tolerantCount: res.tolerantCount });
  }
  return { ok: failures.length === 0, files, failures };
}

module.exports = { parseEditBlocks, hasEditBlocks, stripEditBlocks, applyEdits, planChangeSet, findSearchSpan, cleanPathLine, lazyLines, diffSummary, pickByLineHint };
