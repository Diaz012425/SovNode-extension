"use strict";

// Micro-herramientas (v0.18, + "ejecutar" en v0.20): el modelo puede pedir,
// A MITAD de un turno, leer un rango de lineas, buscar un texto/simbolo, o
// correr un comando (compilar, un test puntual) y VER el resultado, en vez
// de adivinar o pedir un archivo entero.
//
// Protocolo de TEXTO (no las "tools" nativas de cada API): funciona igual
// con Gemini, OpenAI y Anthropic, y reusa el mismo patron que
// NECESITO_ARCHIVOS. El modelo responde UNICAMENTE con:
//
//   HERRAMIENTAS:
//   leer: ruta/archivo.py 120-180
//   buscar: draw_map
//   ejecutar: npm test
//
// "ejecutar" es mas delicado (corre algo de verdad): el usuario tiene que
// aprobarlo cada vez (ver execTool.js); si no aprueba, se le avisa al
// modelo y sigue sin haberse ejecutado nada.
//
// Protecciones de costo (todas desde el arranque):
// - Tope de rondas por turno segun el Effort (1/2/3/5; toolsMaxRounds lo pisa).
// - Lo que el modelo YA tiene (en el contexto o de una ronda anterior) no se
//   reenvia: se le avisa que ya lo tiene.
// - Tope de pedidos por ronda y de tamanio de cada resultado: nunca "dame
//   el archivo entero" por esta via.
// - Los resultados NO van al historial: sirven para este turno y se tiran
//   (el historial guarda solo la pregunta y la explicacion final).
// - Se usa solo si hace falta: el mapa, el recorte por foco y la base del
//   arquitecto siguen yendo primero; esto es para cuando no alcanzo.
//
// Modulo PURO (sin vscode): la lectura de archivos se inyecta.

const MAX_REQUESTS_PER_ROUND = 5;
const MAX_EXEC_PER_ROUND = 1; // cada ejecucion se aprueba aparte: una por ronda, y sola (no se mezcla con leer/buscar)
const MAX_READ_LINES = 200; // por pedido de "leer"
const MAX_SEARCH_HITS = 20;
const MAX_SEARCH_FILES = 400;
const MAX_FILE_BYTES = 400 * 1024;
const MAX_LIST_FILES = 60; // "archivos:" devuelve como mucho esto
const MAX_REGEX_LINE = 2000; // lineas mas largas no se prueban con regex (minificados, y evita regex patologicas)

// Glob -> RegExp (v0.23): "**" cualquier cantidad de carpetas, "*" dentro de
// una carpeta, "?" un caracter, "{a,b}" alternativas. Sin "/" en el patron,
// matchea el NOMBRE del archivo en cualquier carpeta ("*.json").
function globToRegExp(glob) {
  let g = String(glob || "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!g) return null;
  if (!g.includes("/")) g = "**/" + g;
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        i++;
        if (g[i + 1] === "/") { i++; re += "(?:.*/)?"; } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const end = g.indexOf("}", i);
      if (end < 0) { re += "\\{"; continue; }
      re += "(?:" + g.slice(i + 1, end).split(",").map((x) => x.replace(/[.+^$()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")).join("|") + ")";
      i = end;
    } else re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + re + "$", "i");
}

// "buscar": texto exacto, o /regex/ (flag i opcional). Devuelve una funcion
// linea -> bool, o {error}.
function makeMatcher(query) {
  const m = /^\/(.+)\/(i?)$/.exec(query);
  if (!m) return { test: (l) => l.includes(query), regex: false };
  try {
    const re = new RegExp(m[1], m[2]);
    return { test: (l) => l.length <= MAX_REGEX_LINE && re.test(l), regex: true };
  } catch (e) {
    return { error: `regex invalida (${e.message})` };
  }
}
const MAX_RESULT_CHARS = 16000; // entre todos los resultados de una ronda

function toolsPrompt(execEnabled) {
  return `

HERRAMIENTAS (usalas SOLO si lo que ya tenes no alcanza; cada uso cuesta una llamada extra)
Si para responder bien te falta ver codigo que NO esta en el contexto (otra parte de un archivo, otro archivo,
donde se define o usa algo)${execEnabled ? ", o necesitas correr algo para comprobar un resultado" : ""}, responde
UNICAMENTE con este bloque y nada mas:
HERRAMIENTAS:
leer: ruta/archivo.ext 120-180
buscar: nombre_o_texto
archivos: src/**/*.py${execEnabled ? "\nejecutar: comando" : ""}
- "leer": un rango de lineas (maximo ${MAX_READ_LINES} por pedido). Usa los numeros de linea del extracto / indice / "Simbolos que nombra el pedido" (o busca el nombre primero).
- "buscar": texto exacto (nombre de funcion, variable, mensaje de error); devuelve primero donde se define y
  despues archivo:linea de algunos usos. Busca en TODO el proyecto (codigo, config, docs). Variantes:
  "buscar: /def \\w+_test/i" = expresion regular (entre barras; "i" = sin distinguir mayusculas);
  "buscar: TODO en: src/**/*.js" = solo en los archivos que matchean ese patron.
- "archivos": lista las rutas que matchean un patron (glob: "**" carpetas, "*" nombre; "*.json" = en cualquier
  carpeta). Para descubrir que archivos existen antes de leerlos.${execEnabled ? `
- "ejecutar": UN comando simple (sin ";", "&&", "|", backticks ni redirecciones) para compilar o correr algo puntual
  y ver el resultado real antes de responder. El usuario tiene que aprobarlo: puede tardar o ser rechazado. Como
  mucho uno por bloque, y si lo pedis, que sea LO UNICO en el bloque (no lo mezcles con leer/buscar).
  IMPORTANTE: usa el nombre de archivo EXACTO tal como aparece en "ARCHIVOS EN EL CHAT" / el mapa del repo, letra
  por letra (mayusculas, acentos, espacios incluidos). Si el nombre tiene espacios u otros caracteres raros, ponelo
  entre comillas dobles, ej: ejecutar: python "base de dooom.py". No inventes ni acortes el nombre del archivo.` : ""}
- No pidas lineas que ya tenes en el contexto: no se reenvian.
- Hasta ${MAX_REQUESTS_PER_ROUND} lineas por bloque; pedi todo lo que necesites JUNTO, en un solo bloque.
- Nunca mezcles HERRAMIENTAS con cambios de codigo ni con la respuesta: primero consultas, despues respondes.
- Si ya tenes lo necesario, NO las uses.`;
}

// Devuelve [{kind:"leer", path, from, to} | {kind:"buscar", query}] o null.
function parseToolRequest(text) {
  const m = /^\s*HERRAMIENTAS\s*:\s*$/m.exec(text || "");
  if (!m) return null;
  const after = text.slice(m.index + m[0].length).split("\n");
  const reqs = [];
  for (const rawLine of after) {
    // "ejecutar" se parsea de la linea CRUDA (sin sacar backticks): un
    // comando real puede tener backticks/comillas con sentido propio, y
    // execTool.js necesita verlos tal cual para poder rechazarlos bien.
    const stripped = rawLine.replace(/^[\s\-*•]+/, "").trim();
    let r;
    if ((r = /^ejecutar\s*:\s*(.+)$/i.exec(stripped))) {
      reqs.push({ kind: "ejecutar", cmd: r[1].trim() });
      break; // "ejecutar" siempre solo: se ignora cualquier otra linea del bloque
    }
    const line = stripped.replace(/`/g, "");
    if (!line) { if (reqs.length) break; continue; }
    if ((r = /^leer\s*:\s*(.+?)\s+(\d+)\s*[-–:]\s*(\d+)\s*$/i.exec(line))) {
      const from = Math.max(1, Number(r[2]));
      const to = Math.max(from, Number(r[3]));
      reqs.push({ kind: "leer", path: r[1].replace(/["']/g, "").trim(), from, to });
    } else if ((r = /^leer\s*:\s*(.+?)\s*$/i.exec(line))) {
      reqs.push({ kind: "leer", path: r[1].replace(/["']/g, "").trim(), from: 1, to: MAX_READ_LINES });
    } else if ((r = /^buscar\s*:\s*(.+?)\s*$/i.exec(line))) {
      let q = r[1];
      let glob = null;
      const g = /^(.+?)\s+en\s*:\s*(\S+)$/i.exec(q);
      if (g) { q = g[1]; glob = g[2].replace(/["']/g, ""); }
      q = q.replace(/^["']|["']$/g, "");
      if (q.length >= 2) reqs.push(glob ? { kind: "buscar", query: q, glob } : { kind: "buscar", query: q });
    } else if ((r = /^archivos\s*:\s*(.+?)\s*$/i.exec(line))) {
      reqs.push({ kind: "archivos", glob: r[1].replace(/["']/g, "").trim() });
    } else {
      break; // fin del bloque
    }
    if (reqs.length >= MAX_REQUESTS_PER_ROUND) break;
  }
  return reqs.length ? reqs : null;
}

const MAX_HITS_PER_FILE = 3; // un nombre muy usado no llena los 20 resultados con un solo archivo

// Rangos [a,b] (1-based, inclusive): une y ordena.
function mergeRanges(rs) {
  const out = [];
  for (const [a, b] of [...rs].sort((x, y) => x[0] - y[0])) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}
// Partes de [from,to] que NO estan cubiertas por `covered`.
function subtract(from, to, covered) {
  const out = [];
  let cur = from;
  for (const [a, b] of mergeRanges(covered)) {
    if (b < cur) continue;
    if (a > to) break;
    if (a > cur) out.push([cur, Math.min(a - 1, to)]);
    cur = Math.max(cur, b + 1);
    if (cur > to) break;
  }
  if (cur <= to) out.push([cur, to]);
  return out;
}
const fmtRanges = (rs) => rs.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(", ");

/**
 * Estado de UNA conversacion con herramientas (una llamada + sus rondas).
 * shown: Map ruta -> [[a,b]] lineas del archivo ACTUAL que el modelo ya
 *   tiene en el contexto de esta llamada (archivo entero o extracto).
 * Se va llenando con lo que devuelven las herramientas, para no mandar dos
 * veces lo mismo en rondas siguientes.
 */
function newToolSession(shown) {
  return { shown: new Map([...(shown || new Map())].map(([k, v]) => [k, [...v]])), inRounds: new Map(), searches: new Set() };
}

/**
 * Ejecuta los pedidos. ctx: {readRel(path)->string|null, validatePath(path)->error|null,
 *   listFiles()->[paths] (para buscar), definitions(query)->[{path,line}] (del mapa, opcional)}
 * sess: newToolSession(...) -- dedup contra el contexto y rondas anteriores.
 * Devuelve {text, summary:[string], saved: caracteres que NO se reenviaron}.
 */
async function runTools(reqs, ctx, sess = newToolSession()) {
  const parts = [];
  const summary = [];
  let total = 0;
  let saved = 0;
  const push = (s) => {
    if (total >= MAX_RESULT_CHARS) return;
    const room = MAX_RESULT_CHARS - total;
    const t = s.length > room ? s.slice(0, room) + "\n[... recortado: tope de resultados por ronda ...]" : s;
    parts.push(t);
    total += t.length;
  };
  for (const q of reqs) {
    if (q.kind === "ejecutar") {
      // ctx.runExec(cmd) -> texto ya formateado (execTool.js: pide confirmacion,
      // corre, o rechaza) -- toda la logica de riesgo vive fuera de este
      // modulo generico, en execTool.js + extension.js (necesitan vscode).
      if (!ctx.runExec) { push(`### ejecutar "${q.cmd}": no disponible.`); summary.push(`ejecutar "${q.cmd}" (no disponible)`); continue; }
      const text = await ctx.runExec(q.cmd);
      push(text);
      summary.push(`ejecutar "${q.cmd}"`);
      continue;
    }
    if (q.kind === "leer") {
      const bad = ctx.validatePath(q.path);
      const content = bad ? null : await ctx.readRel(q.path);
      if (content == null) {
        push(`### leer ${q.path}: ${bad || "no existe"}`);
        summary.push(`${q.path} (no existe)`);
        continue;
      }
      const lines = content.split("\n");
      const from = Math.min(q.from, lines.length);
      const to = Math.min(q.to, lines.length, from + MAX_READ_LINES - 1);
      const clipped = q.to > to && to - from + 1 >= MAX_READ_LINES ? ` (recortado a ${MAX_READ_LINES} lineas)` : "";
      const inCtx = sess.shown.get(q.path) || [];
      const inRounds = sess.inRounds.get(q.path) || [];
      const missing = subtract(from, to, [...inCtx, ...inRounds]);
      const have = subtract(from, to, missing.map(([a, b]) => [a, b])); // lo que ya estaba
      const lineChars = (a, b) => lines.slice(a - 1, b).join("\n").length;
      for (const [a, b] of have) saved += lineChars(a, b);
      if (!missing.length) {
        const where = subtract(from, to, inRounds).length === 0 ? "en los resultados de una consulta anterior" : "en el contexto que ya recibiste";
        push(`### ${q.path} lineas ${from}-${to}: YA las tenes ${where} (no se reenvian).`);
        summary.push(`${q.path} ${from}-${to} (ya lo tenia)`);
        continue;
      }
      const fence = content.includes("```") ? "````" : "```";
      const note = have.length ? `\n(las lineas ${fmtRanges(have)} ya las tenes, no se reenvian)` : "";
      const pieces = missing.map(([a, b]) => `[lineas ${a}-${b}]\n${fence}\n${lines.slice(a - 1, b).join("\n")}\n${fence}`);
      push(`### ${q.path} (${lines.length} lineas)${clipped}${note}\n${pieces.join("\n")}`);
      sess.inRounds.set(q.path, mergeRanges([...inRounds, ...missing]));
      summary.push(`${q.path} ${fmtRanges(missing)}${have.length ? ` (+${fmtRanges(have)} ya lo tenia)` : ""}`);
    } else if (q.kind === "archivos") {
      const re = globToRegExp(q.glob);
      const all = re ? (await ctx.listFiles()).filter((p) => re.test(p) && !ctx.validatePath(p)).sort() : [];
      const shown = all.slice(0, MAX_LIST_FILES);
      push(`### archivos "${q.glob}": ${all.length ? `${all.length} archivo(s)${all.length > shown.length ? ` (se muestran ${shown.length}; afina el patron)` : ""}\n${shown.join("\n")}` : "ninguno"}`);
      summary.push(`archivos "${q.glob}" (${all.length})`);
    } else if (q.kind === "buscar") {
      const key = q.glob ? `${q.query} en: ${q.glob}` : q.query;
      const matcher = makeMatcher(q.query);
      if (matcher.error) {
        push(`### buscar "${q.query}": ${matcher.error}`);
        summary.push(`"${q.query}" (regex invalida)`);
        continue;
      }
      if (sess.searches.has(key)) {
        push(`### buscar "${q.query}": ya lo buscaste en una consulta anterior (mira ese resultado).`);
        summary.push(`"${q.query}" (repetida)`);
        continue;
      }
      sess.searches.add(key);
      // Primero DONDE SE DEFINE (lo sabe el mapa del repo), despues los usos.
      const globRe = q.glob ? globToRegExp(q.glob) : null;
      const defs = (matcher.regex || !ctx.definitions ? [] : ctx.definitions(q.query) || []).filter((d) => !globRe || globRe.test(d.path));
      const defKeys = new Set(defs.map((d) => `${d.path}:${d.line}`));
      const hits = [];
      let extra = 0;
      const files = (await ctx.listFiles()).filter((p) => !globRe || globRe.test(p)).slice(0, MAX_SEARCH_FILES);
      for (const p of files) {
        if (ctx.validatePath(p)) continue;
        let content;
        try { content = await ctx.readRel(p); } catch (_) { continue; }
        if (content == null || content.length > MAX_FILE_BYTES || content.includes("\u0000")) continue;
        const lines = content.split("\n");
        let inFile = 0;
        for (let i = 0; i < lines.length; i++) {
          if (!matcher.test(lines[i])) continue;
          const key = `${p}:${i + 1}`;
          const text = `${key}: ${lines[i].trim().slice(0, 160)}`;
          if (defKeys.has(key)) { const d = defs.find((x) => `${x.path}:${x.line}` === key); d.text = text; continue; }
          if (inFile >= MAX_HITS_PER_FILE || hits.length >= MAX_SEARCH_HITS) { extra++; continue; }
          hits.push(text);
          inFile++;
        }
        if (inFile >= MAX_HITS_PER_FILE) {
          const more = lines.filter((l) => matcher.test(l)).length - inFile - defs.filter((d) => d.path === p && d.text).length;
          if (more > 0) hits.push(`${p}: ... y ${more} aparicion(es) mas en este archivo`);
        }
      }
      const defLines = defs.filter((d) => d.text).map((d) => d.text);
      const body = [];
      if (defLines.length) body.push(`Definicion:\n${defLines.join("\n")}`);
      if (hits.length) body.push(`${defLines.length ? "Usos" : "Apariciones"}:\n${hits.join("\n")}`);
      const count = defLines.length + hits.filter((h) => !/\.\.\. y \d+/.test(h)).length;
      // v0.29.1: "sin resultados" a secas no distinguia "no existe" de "no hay
      // archivos": se dice en cuantos se busco (0 = la carpeta abierta esta vacia).
      const noHits = files.length ? `sin resultados (se buscaron ${files.length} archivo(s))` : "sin resultados: la carpeta abierta no tiene archivos (el usuario puede haber abierto la carpeta equivocada)";
      push(`### buscar "${key}": ${body.length ? `${count} resultado(s)${extra ? ` (+${extra} omitidos por el tope)` : ""}\n${body.join("\n")}` : noHits}`);
      summary.push(`"${key}" (${count})`);
    }
  }
  return { text: `RESULTADOS DE HERRAMIENTAS:\n\n${parts.join("\n\n")}`, summary, saved };
}

// Rondas por turno segun el Effort (el que elige barato, elige barato
// tambien aca). Un numero en sovnodeAider.toolsMaxRounds lo pisa.
const ROUNDS_BY_EFFORT = { low: 1, medium: 2, high: 3, extra: 5 };
function roundsFor(setting, effort) {
  if (setting !== null && setting !== undefined && setting !== "" && !Number.isNaN(Number(setting))) return Math.max(0, Math.floor(Number(setting)));
  return ROUNDS_BY_EFFORT[effort] ?? 2;
}


// ------------------------------------------------------------ nativas (v0.25)
// Las mismas 4 herramientas, pero declaradas con el mecanismo NATIVO de cada
// API (functionDeclarations / tools / tools). El modelo las pide como una
// llamada estructurada en vez de escribir "HERRAMIENTAS:" -- los modelos
// grandes estan entrenados para esto y se equivocan menos de formato (menos
// rondas desperdiciadas). La EJECUCION es identica: se traduce cada llamada al
// mismo pedido interno {kind,...} y pasa por runTools (dedup, topes, recortes).
// Las definiciones son fijas por turno -> van en el prefijo cacheable.
function nativeToolDefs(execEnabled) {
  const defs = [
    {
      name: "leer",
      description: `Lee un rango de lineas de un archivo del proyecto (maximo ${MAX_READ_LINES} por llamada). No pidas lineas que ya tenes en el contexto.`,
      parameters: { type: "object", properties: { ruta: { type: "string", description: "Ruta relativa al proyecto, EXACTA." }, desde: { type: "integer", description: "Primera linea (1 = inicio)." }, hasta: { type: "integer", description: "Ultima linea (incluida)." } }, required: ["ruta"] },
    },
    {
      name: "buscar",
      description: "Busca en TODO el proyecto (codigo, config, docs). Devuelve primero donde se define y despues archivo:linea de usos. Texto exacto, o una expresion regular entre barras: /patron/i.",
      parameters: { type: "object", properties: { texto: { type: "string", description: "Texto exacto o /regex/ (flag i opcional)." }, en: { type: "string", description: "Opcional: patron glob para limitar la busqueda, ej: src/**/*.py" } }, required: ["texto"] },
    },
    {
      name: "archivos",
      description: "Lista las rutas del proyecto que coinciden con un patron glob (\"**\" = carpetas, \"*\" = nombre; \"*.json\" = en cualquier carpeta). Para descubrir que archivos existen antes de leerlos.",
      parameters: { type: "object", properties: { patron: { type: "string" } }, required: ["patron"] },
    },
  ];
  if (execEnabled) defs.push({
    name: "ejecutar",
    description: "Corre UN comando simple (sin ;, &&, |, backticks ni redirecciones) para compilar o probar algo y ver el resultado real. El usuario lo aprueba. Pedilo SOLO, sin otras herramientas en la misma ronda. Usa el nombre de archivo EXACTO (entre comillas dobles si tiene espacios).",
    parameters: { type: "object", properties: { comando: { type: "string" } }, required: ["comando"] },
  });
  return defs;
}

function nativeToolsPrompt(execEnabled) {
  return `

HERRAMIENTAS: tenes funciones (leer, buscar, archivos${execEnabled ? ", ejecutar" : ""}) para consultar el proyecto a mitad
de la respuesta. Usalas SOLO si lo que ya tenes no alcanza: cada ronda cuesta una llamada extra. Pedi todo lo
que necesites JUNTO en una misma ronda. Nunca mezcles llamadas a herramientas con cambios de codigo: primero
consultas, despues respondes con los cambios. Si ya tenes lo necesario, no las uses.`;
}

// Llamada nativa {name, args} -> pedido interno de runTools, o {error}.
function toolCallToReq(call) {
  const a = (call && call.args) || {};
  const str = (v) => (typeof v === "string" ? v.trim() : "");
  switch (call && call.name) {
    case "leer": {
      const p = str(a.ruta).replace(/["']/g, "");
      if (!p) return { error: "falta \"ruta\"" };
      const from = Math.max(1, Math.floor(Number(a.desde)) || 1);
      const to = Math.max(from, Math.floor(Number(a.hasta)) || from + MAX_READ_LINES - 1);
      return { req: { kind: "leer", path: p, from, to } };
    }
    case "buscar": {
      const q = str(a.texto);
      if (q.length < 2) return { error: "\"texto\" tiene que tener al menos 2 caracteres" };
      const glob = str(a.en);
      return { req: glob ? { kind: "buscar", query: q, glob } : { kind: "buscar", query: q } };
    }
    case "archivos": {
      const g = str(a.patron);
      return g ? { req: { kind: "archivos", glob: g } } : { error: "falta \"patron\"" };
    }
    case "ejecutar": {
      const c = str(a.comando);
      return c ? { req: { kind: "ejecutar", cmd: c } } : { error: "falta \"comando\"" };
    }
    default:
      return { error: `herramienta desconocida "${call && call.name}"` };
  }
}

module.exports = { nativeToolDefs, nativeToolsPrompt, toolCallToReq, globToRegExp, makeMatcher, parseToolRequest, runTools, newToolSession, roundsFor, subtract, mergeRanges, toolsPrompt, MAX_EXEC_PER_ROUND, MAX_READ_LINES, MAX_REQUESTS_PER_ROUND, MAX_RESULT_CHARS };
