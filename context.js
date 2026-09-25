"use strict";

// Lo que se le manda al modelo ademas del pedido: mapa del repo (con su
// cache), memoria del proyecto, contexto enfocado de archivos grandes y la
// ventana de historial.
const vscode = require("vscode");
const { planFocus, renderFocused } = require("./focus");
const { buildRepoMap, renderRepoMap, renderFocusMap, extractFocusNames } = require("./repoMap");
const { L } = require("./i18n");
const { state, cfg, workspaceRoot } = require("./state");
const { contextPaths } = require("./workspaceFiles");

// ---------------------------------------------------------------- memoria del proyecto
// Mapa del repo cacheable (v0.21). Antes el mapa iba DENTRO del mensaje final
// (archivos + pedido, distinto cada turno), y encima ordenado segun lo que
// nombraba la pregunta y con "linea N" que cambia con cada edicion: nunca era
// texto identico, nunca se cacheaba, se pagaba entero en cada llamada.
// Ahora: mapa estable (sin lineas, sin orden por pedido) en su propio bloque
// al principio -> cache; y lo que depende del pedido (simbolos nombrados, con
// su linea actual) va chiquito en el mensaje final.
// sovnodeAider.repoMapCache=false vuelve al modo viejo.
// Memoria del proyecto (v0.22.0): archivo que escribe EL USUARIO
// (.sovnode/memoria.md) con convenciones, decisiones y "no toques X". Se lee
// cada turno y va como PRIMER par [user][model] del pedido: es lo que menos
// cambia, asi que queda al principio del prefijo cacheable (antes de la base
// del arquitecto y del mapa). Sin archivo = costo cero. No lleva ancla
// propia de Anthropic (ya hay 4: system/base/mapa/historial); queda cubierta
// por la siguiente ancla que haya. El modelo NO la edita solo: una edicion por
// turno romperia el cache de todo lo que viene despues (misma leccion que
// v0.21.1/v0.21.2). Tope de tamano para que no se coma el presupuesto.
const PROJECT_MEMORY_REL = ".sovnode/memoria.md";
const PROJECT_MEMORY_MAX_CHARS = 6000;
const PROJECT_MEMORY_TEMPLATE = `# Memoria del proyecto
<!-- SovNode manda este archivo en CADA pedido (es barato: va cacheado, pero no es gratis).
     Mantenelo corto: solo lo que el modelo no puede deducir leyendo el codigo.
     Borra estos comentarios y los ejemplos que no apliquen. Archivo vacio = no se manda nada. -->

## Convenciones
- 

## Decisiones tomadas (y por que)
- 

## No tocar / cuidado con
- 
`;
function projectMemoryText() {
  if (cfg().get("projectMemory") === false) return "";
  const root = workspaceRoot();
  if (!root || root.scheme !== "file") return "";
  let raw;
  try {
    raw = require("fs").readFileSync(require("path").join(root.fsPath, PROJECT_MEMORY_REL), "utf8");
  } catch (_) {
    return "";
  }
  // sin comentarios HTML ni lineas-plantilla vacias ("- "): la plantilla recien
  // creada sin completar no cuesta nada
  const body = raw.replace(/<!--[\s\S]*?-->/g, "").split("\n").filter((l) => !/^\s*-\s*$/.test(l)).join("\n").trim();
  if (!body.replace(/^#.*$/gm, "").trim()) return "";
  const clipped = body.length > PROJECT_MEMORY_MAX_CHARS ? body.slice(0, PROJECT_MEMORY_MAX_CHARS) + "\n[...memoria recortada: el archivo supera el tope; acortalo]" : body;
  return `MEMORIA DEL PROYECTO (notas del usuario sobre este repo: convenciones, decisiones y restricciones. Respetalas; si un pedido las contradice, avisalo):\n\n${clipped}`;
}

async function openProjectMemory() {
  const root = workspaceRoot();
  if (!root) {
    vscode.window.showWarningMessage(L("SovNode: abri una carpeta primero.", "SovNode: open a folder first."));
    return;
  }
  const uri = vscode.Uri.joinPath(root, ...PROJECT_MEMORY_REL.split("/"));
  try {
    await vscode.workspace.fs.stat(uri);
  } catch (_) {
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(root, ".sovnode"));
    await vscode.workspace.fs.writeFile(uri, Buffer.from(PROJECT_MEMORY_TEMPLATE, "utf8"));
  }
  await vscode.window.showTextDocument(uri);
}

function repoMapParts(map, question) {
  const focusNames = extractFocusNames(question, map);
  if (cfg().get("repoMapCache") === false) {
    const personalize = contextPaths().map((f) => f.path);
    return { text: renderRepoMap(map, focusNames, undefined, undefined, personalize), cached: "", focus: "", memory: projectMemoryText() };
  }
  // OJO: el bloque "cached" NUNCA debe recibir personalizeFiles (contextPaths,
  // los archivos que estan en el chat ahora mismo). Un bug de la v0.21.0 lo
  // personalizaba igual que el modo viejo -- eso reordena el mapa (PageRank
  // distinto) cada vez que agregas/sacas un archivo del chat, que es
  // MUCHISIMO mas seguido que un cambio real de codigo. Rompia el "prefijo
  // identico" a cada rato, y como el mapa va ANTES del historial, romperlo
  // tambien forzaba reescribir el ancla de historial -- Anthropic cobra la
  // reescritura de cache a 1.25x en vez de leerla a 0.1x, asi que cada
  // agregado de archivo terminaba costando MAS que si esto no existiera.
  // Sin personalizar, el orden depende solo del mapa (estable mientras no
  // cambies codigo de verdad), que es justo la garantia que se buscaba.
  return {
    text: "",
    cached: renderRepoMap(map, [], undefined, undefined, undefined, { noLines: true }),
    memory: projectMemoryText(),
    focus: renderFocusMap(map, focusNames),
  };
}

// ---------------------------------------------------------------- repo map
// repoMapGen sube con cada cambio de archivos: si un archivo cambia MIENTRAS
// se construye el mapa, ese resultado ya nace viejo y no se guarda en cache.
let repoMapGen = 0;
let repoMapCache = null;
let repoMapBuilding = null;
async function getRepoMap() {
  if (repoMapCache) return repoMapCache.map;
  const gen = repoMapGen;
  if (!repoMapBuilding) repoMapBuilding = buildRepoMap().finally(() => (repoMapBuilding = null));
  const map = await repoMapBuilding;
  if (gen === repoMapGen) repoMapCache = { map }; // envuelto: un mapa null (sin codigo) tambien se cachea
  return map;
}

// Lo llama el watcher de archivos (activate): el proximo getRepoMap() lo
// reconstruye, y uno que se este construyendo ahora ya no se guarda.
function invalidateRepoMap() {
  repoMapCache = null;
  repoMapGen++;
}

// ---------------------------------------------------------------- contexto enfocado
// Reemplaza los archivos grandes por un extracto de las partes relevantes
// (focus.js). No se enfoca nunca con formato "archivo completo" (el modelo
// reescribiria el archivo solo con lo que vio) ni los que el modelo pidio
// ver enteros. El extracto va en f.rendered; f.content queda intacto.
function applyFocus(files, text, map, fullPaths, selection, editFormat) {
  const minLines = Math.max(0, Math.floor(Number(cfg().get("focusLargeFiles")) || 0));
  if (!minLines || editFormat === "whole") return files;
  const logText = state.logs.map((l) => l.text).join("\n");
  return files.map((f) => {
    if (fullPaths.has(f.path)) return f;
    const entry = map && map.entries ? map.entries.find((e) => e.relPath === f.path) : null;
    const plan = planFocus(f.content, {
      relPath: f.path, symbols: entry ? entry.symbols : [], text, logText,
      selection: f.active ? selection : null, minLines,
    });
    if (!plan.focused) return f;
    return { ...f, rendered: renderFocused(f.path, f.content, plan, f.active), focus: { shown: plan.shownLines, total: plan.totalLines, reasons: plan.reasons, ranges: plan.ranges } };
  });
}

// ---------------------------------------------------------------- historial
// Ultimos N turnos (N*2 mensajes). Ojo: slice(-0) es slice(0) y devolvia TODO
// el historial -- con maxHistoryTurns = 0 se mandaba justo lo contrario de
// lo pedido.
//
// v0.21.2: antes esto era slice(-n) a secas -- una ventana deslizante que
// tira el turno mas viejo y agrega el nuevo en CADA turno. Pasado el turno N,
// el "historial" nunca era el mismo bloque dos veces seguidas: ni el cacheo
// automatico de Gemini/OpenAI (que necesita el mismo prefijo exacto) ni el
// cache_control de Anthropic (que ahi reescribe a 1.25x en vez de leer a
// 0.1x) podian agarrar nunca. Cualquier sesion mas larga que maxHistoryTurns
// pagaba el historial a precio de reescritura de cache en casi todos los
// turnos -- el mismo mecanismo que el bug del mapa del repo, pero en la
// parte que mas pesa de una sesion larga.
//
// Fix: podar de a LOTES, no de a 1 turno por turno. Mientras no se pase del
// margen (HISTORY_PRUNE_SLACK_TURNS turnos de mas), no se poda nada -- el
// historial solo CRECE, y un prefijo que crece agregando al final se cachea
// perfecto en los tres proveedores. Recien cuando se pasa del margen se poda
// de una vez hasta volver a maxHistoryTurns, y ahi queda quieto otra vez
// varios turnos hasta la proxima poda. El contexto retenido en promedio es
// el mismo (fluctua entre N y N+margen en vez de ser siempre N); lo que
// cambia es que el prefijo deja de cortarse en cada turno.
const HISTORY_PRUNE_SLACK_TURNS = 4;
function historyWindow() {
  const nTurns = Math.max(0, Math.floor(Number(cfg().get("maxHistoryTurns")) || 0));
  if (!nTurns) return [];
  const n = 2 * nTurns;
  if (state.history.length > n + 2 * HISTORY_PRUNE_SLACK_TURNS) state.history.splice(0, state.history.length - n);
  return state.history.slice(); // copia: nadie debe mutar el buffer real
}

module.exports = {
  PROJECT_MEMORY_REL, projectMemoryText, openProjectMemory,
  repoMapParts, getRepoMap, invalidateRepoMap, applyFocus, historyWindow,
};
