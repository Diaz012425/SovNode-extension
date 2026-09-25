"use strict";

const vscode = require("vscode");
const path = require("path");
const treesitter = require("./treesitter");

// Repo map real, en dos fases (ver architecture.md):
//   FASE 1 (ya en produccion desde v0.6): el ranking de importancia de
//   archivos dejo de ser un conteo simple de menciones y paso a ser un
//   PageRank de verdad sobre un grafo dirigido archivo-a-archivo, con dos
//   fuentes de aristas: 1) imports/requires REALES resueltos a un archivo
//   del workspace (peso alto), y 2) menciones de un simbolo definido en
//   otro archivo (peso bajo, heuristico de texto). Soporta PageRank
//   "personalizado" hacia los archivos que ya estan en el chat.
//   FASE 2 (esta version): la EXTRACCION de simbolos e imports pasa por
//   tree-sitter de verdad (treesitter.js, via WASM con "web-tree-sitter",
//   sin compilar nada nativo) en vez de regex -- ya no confunde un string
//   o un comentario que "parece" una definicion con una real, y entiende
//   metodos dentro de clases, interfaces, etc. Es la PRIMERA dependencia
//   npm del proyecto: hace falta correr "npm install" una vez antes de F5.
//   Si esa dependencia no esta instalada (o el .wasm no carga por lo que
//   sea), este archivo cae solo de vuelta al extractor por regex de
//   siempre (extractSymbolsRegex/importSpecifiersRegex mas abajo) -- la
//   extension nunca se rompe por esto, en el peor caso el mapa queda con
//   la calidad que ya tenia antes de esta fase. `/diag` reporta cual de
//   los dos modos esta activo.
//
// FASE 3 (esta version): resolucion de imports para Java/Kotlin (por
// paquete declarado + nombre de tipo), C# (por namespace declarado) y Go
// (por el modulo de go.mod + directorio) -- ver resolveJavaKotlinImport,
// resolveCsharpImport y resolveGoImport mas abajo. A diferencia de JS/Python
// (resolveImport, un import = un archivo), estos son best-effort y pueden
// resolver a VARIOS archivos a la vez (un import con wildcard, o un
// namespace/paquete repartido en varios archivos) -- el peso del import se
// reparte entre esos archivos, y si son demasiados (probablemente una
// coincidencia de nombre demasiado generica) se descarta y queda solo el
// heuristico de menciones de texto, igual que antes de esta fase.

const IGNORE_DIRS = new Set([
  "node_modules", "__pycache__", ".git", "dist", "build", "out",
  ".venv", "venv", "env", ".next", ".nuxt", "target", "vendor",
  ".pytest_cache", ".mypy_cache", "coverage",
]);

const MAX_FILES = 300;
const MAX_FILE_BYTES = 200 * 1024; // skip anything bigger -- likely generated/binary-ish
const IMPORT_EDGE_WEIGHT = 5; // import/require resuelto a un archivo real
const MENTION_EDGE_WEIGHT = 1; // heuristico de texto (por simbolo compartido)

// [extension(s), [ [regex, symbolType], ... ] ] -- regex must have exactly
// one capture group: the symbol name.
const LANG_PATTERNS = [
  [[".py"], [
    [/^\s*(?:async\s+)?def\s+(\w+)\s*\(/gm, "function"],
    [/^\s*class\s+(\w+)\s*[:(]/gm, "class"],
  ]],
  [[".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"], [
    [/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s+(\w+)\s*\(/gm, "function"],
    [/^\s*(?:export\s+)?class\s+(\w+)/gm, "class"],
    [/^\s*(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\(?[\w,\s{}]*\)?\s*=>/gm, "function"],
  ]],
  [[".java", ".cs", ".kt"], [
    // Sin "\s*...(|\s)*" (dos cuantificadores peleandose por los mismos
    // espacios) ni "[^;]*" sin tope cruzando lineas: esas dos formas eran
    // cuadraticas y un archivo de 4000 lineas bloqueaba el Extension Host
    // mas de un segundo POR PATRON (el regex es sincrono).
    [/^[ \t]*(?:(?:public|private|protected|internal|static|abstract|sealed|final|data|open)\s+)*(?:class|interface|record)\s+(\w+)/gm, "class"],
    [/^[ \t]*(?:(?:public|private|protected|internal|static|final|abstract|override|async|virtual)\s+)*[\w<>\[\],?]+\s+(\w+)\s*\([^;{}]{0,400}\)\s*\{/gm, "function"],
  ]],
  [[".go"], [
    [/^\s*func\s+(?:\([^)]*\)\s*)?(\w+)\s*\(/gm, "function"],
    [/^\s*type\s+(\w+)\s+struct/gm, "class"],
  ]],
];

// Regex de imports por lenguaje -- igual que arriba, se usan solo para
// ENCONTRAR el texto del specifier; la resolucion a un archivo real la hace
// resolveImport() de abajo, por lenguaje.
const IMPORT_PATTERNS = {
  js: [
    /\bimport\s+(?:[\w*\s{},]+\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bexport\s+(?:[\w*\s{},]+)\s+from\s+['"]([^'"]+)['"]/g,
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  ],
  py: [
    /^\s*from\s+([.\w]+)\s+import\s+/gm,
    /^\s*import\s+([.\w]+)/gm,
  ],
  // Java y Kotlin comparten sintaxis de import lo bastante parecida para una
  // sola regex: `;` final opcional (Kotlin no lo requiere), `static`
  // opcional (solo Java), y un wildcard `.*` opcional al final.
  javakt: [
    /^\s*import\s+(?:static\s+)?([\w.*]+)/gm,
  ],
  csharp: [
    /^\s*(?:global\s+)?using\s+(?:static\s+)?([\w.]+)\s*;/gm,
  ],
};
const JS_EXTS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];

// Go agrupa imports entre parentesis (`import (\n "fmt"\n "os"\n)`) ademas
// de la forma de una linea (`import "fmt"`, con alias opcional) -- ninguna
// de las dos calza con el patron lineal de arriba, asi que tiene su propia
// funcion en vez de una entrada mas en IMPORT_PATTERNS.
function goImportSpecifiersRegex(text) {
  const specs = [];
  const blockRe = /import\s*\(([\s\S]*?)\)/g;
  let bm;
  while ((bm = blockRe.exec(text)) !== null) {
    const strRe = /"([^"]+)"/g;
    let sm;
    while ((sm = strRe.exec(bm[1])) !== null) specs.push(sm[1]);
  }
  const singleRe = /^\s*import\s+(?:\w+\s+)?"([^"]+)"/gm;
  let sm2;
  while ((sm2 = singleRe.exec(text)) !== null) specs.push(sm2[1]);
  return specs;
}

function patternsForExt(ext) {
  for (const [exts, patterns] of LANG_PATTERNS) {
    if (exts.includes(ext)) return patterns;
  }
  return null;
}

// NOTA: sigue siendo un extractor por regex, no un parser real (tree-sitter
// es el proximo paso, ver comentario de arriba del archivo). Puede
// confundir un string o un comentario que "parece" una definicion con una
// real; no tiene AST ni entiende scope.
function extractSymbolsRegex(text, ext) {
  const patterns = patternsForExt(ext);
  if (!patterns) return [];
  const symbols = [];
  // Indice de saltos de linea UNA vez + busqueda binaria: antes cada match
  // hacia text.slice(0, i).split("\n") -- cuadratico en archivos grandes.
  const nl = [];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) nl.push(i);
  const lineAt = (idx) => {
    let lo = 0, hi = nl.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (nl[mid] < idx) lo = mid + 1; else hi = mid; }
    return lo + 1;
  };
  for (const [re, type] of patterns) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m[0] === "") { re.lastIndex++; continue; }
      const line = lineAt(m.index);
      symbols.push({ name: m[1], type, line });
    }
  }
  return symbols;
}

function importSpecifiersRegex(text, ext) {
  if (ext === ".go") return goImportSpecifiersRegex(text);
  const patterns = JS_EXTS.includes(ext) ? IMPORT_PATTERNS.js
    : ext === ".py" ? IMPORT_PATTERNS.py
    : ext === ".java" || ext === ".kt" ? IMPORT_PATTERNS.javakt
    : ext === ".cs" ? IMPORT_PATTERNS.csharp
    : null;
  if (!patterns) return [];
  const specs = [];
  for (const re of patterns) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) specs.push(m[1]);
  }
  return specs;
}

// Resuelve un specifier de import/require de JS/TS a una ruta relativa del
// workspace, probando extensiones y "index.*" -- solo imports relativos
// ("./foo", "../foo"); un specifier "bare" (paquete de npm) se ignora, no
// es un archivo de este repo.
function resolveJsImport(fromRelPath, spec, relPathSet) {
  if (!spec.startsWith(".")) return null;
  const fromDir = path.posix.dirname(fromRelPath);
  const base = path.posix.normalize(path.posix.join(fromDir, spec));
  const candidates = [base];
  for (const e of JS_EXTS) candidates.push(base + e);
  for (const e of JS_EXTS) candidates.push(path.posix.join(base, "index" + e));
  for (const c of candidates) if (relPathSet.has(c)) return c;
  return null;
}

// Resuelve un modulo de Python (relativo con puntos al frente, o absoluto
// dentro del propio workspace) a una ruta de archivo. Best-effort: si el
// modulo no se puede mapear a un archivo del repo (paquete instalado,
// stdlib, o resolucion ambigua), se ignora en vez de inventar un destino.
function resolvePyImport(fromRelPath, moduleSpec, relPathSet) {
  const m = /^(\.*)(.*)$/.exec(moduleSpec || "");
  const dots = m[1].length;
  const rest = m[2];
  const parts = rest ? rest.split(".").filter(Boolean) : [];
  let baseDir;
  if (dots > 0) {
    baseDir = path.posix.dirname(fromRelPath);
    for (let i = 1; i < dots; i++) baseDir = path.posix.dirname(baseDir);
    if (baseDir === ".") baseDir = "";
  } else {
    baseDir = "";
  }
  const base = parts.length ? path.posix.normalize(path.posix.join(baseDir, parts.join("/"))) : baseDir;
  const candidates = [base + ".py", path.posix.join(base, "__init__.py")];
  for (const c of candidates) if (relPathSet.has(c)) return c;
  // Import absoluto que no matcheo desde la raiz: probar por sufijo (por si
  // el "root" real de paquetes esta un nivel mas adentro que la raiz del
  // workspace, caso comun con carpetas tipo src/).
  if (dots === 0 && parts.length) {
    const suffix = "/" + parts.join("/") + ".py";
    for (const rp of relPathSet) if (rp.endsWith(suffix)) return rp;
  }
  return null;
}

function resolveImport(fromRelPath, spec, ext, relPathSet) {
  if (JS_EXTS.includes(ext)) return resolveJsImport(fromRelPath, spec, relPathSet);
  if (ext === ".py") return resolvePyImport(fromRelPath, spec, relPathSet);
  return null;
}

// Un import/using en estos 4 lenguajes no apunta a una ruta relativa como en
// JS/Python -- apunta a un paquete/namespace/modulo calificado, que puede
// coincidir con VARIOS archivos del repo (o ninguno, si es una libreria
// externa). Por eso estas resoluciones devuelven un array, no un solo
// archivo: `addEdge` reparte el peso del import entre los que matcheen.
const MAX_MULTI_TARGETS = 6; // si matchean mas que esto, probablemente el nombre es demasiado generico -- se descarta y queda solo el heuristico de menciones

// --- Java / Kotlin: import com.foo.Bar -> se busca el archivo cuyo paquete
// declarado (`package com.foo;`) + nombre de tipo (una clase/interfaz/record
// definida ahi, o el nombre del archivo por la convencion de "un tipo
// publico por archivo") arme ese mismo nombre calificado.
function javaKotlinPackageOf(text) {
  const m = /^\s*package\s+([\w.]+)/m.exec(text);
  return m ? m[1] : "";
}

function buildJavaKotlinIndex(entries) {
  const byQualifiedName = new Map(); // "paquete.Tipo" -> relPath
  const byPackage = new Map(); // paquete -> [relPath...] (para imports con wildcard)
  for (const e of entries) {
    if (e.ext !== ".java" && e.ext !== ".kt") continue;
    const pkg = javaKotlinPackageOf(e.text);
    if (!byPackage.has(pkg)) byPackage.set(pkg, []);
    byPackage.get(pkg).push(e.relPath);
    const baseName = path.posix.basename(e.relPath).replace(/\.(java|kt)$/, "");
    const names = new Set([baseName]);
    for (const s of e.symbols) if (s.type === "class") names.add(s.name);
    for (const name of names) byQualifiedName.set(pkg ? `${pkg}.${name}` : name, e.relPath);
  }
  return { byQualifiedName, byPackage };
}

function resolveJavaKotlinImport(spec, index) {
  if (!spec) return [];
  if (spec.endsWith(".*")) {
    const files = index.byPackage.get(spec.slice(0, -2)) || [];
    return files.length && files.length <= MAX_MULTI_TARGETS ? files : [];
  }
  const hit = index.byQualifiedName.get(spec);
  return hit ? [hit] : [];
}

// --- C#: using Foo.Bar; -> todos los archivos que declaran ese namespace
// (bloque `namespace Foo.Bar { ... }` o, desde C# 10, "file-scoped"
// `namespace Foo.Bar;`). No hay un "un tipo por archivo" tan estricto como
// en Java, asi que aca directamente se resuelve a nivel namespace.
function csharpNamespacesOf(text) {
  const names = new Set();
  const re = /^\s*namespace\s+([\w.]+)\s*[{;]/gm;
  let m;
  while ((m = re.exec(text)) !== null) names.add(m[1]);
  return names;
}

function buildCsharpIndex(entries) {
  const byNamespace = new Map();
  for (const e of entries) {
    if (e.ext !== ".cs") continue;
    for (const ns of csharpNamespacesOf(e.text)) {
      if (!byNamespace.has(ns)) byNamespace.set(ns, []);
      byNamespace.get(ns).push(e.relPath);
    }
  }
  return { byNamespace };
}

function resolveCsharpImport(spec, index) {
  const files = index.byNamespace.get(spec) || [];
  return files.length && files.length <= MAX_MULTI_TARGETS ? files : [];
}

// --- Go: un import path resuelve a un PAQUETE (carpeta), no a un archivo
// suelto -- se pela el prefijo del modulo declarado en go.mod (si hay) y lo
// que queda es la ruta relativa a esa carpeta; sin go.mod (o si el import no
// matchea el modulo, tipico de un import externo) se prueba por sufijo
// contra las carpetas reales, mismo truco que el fallback de Python.
function buildGoIndex(entries, goModule) {
  const byDir = new Map(); // "" = raiz del workspace
  for (const e of entries) {
    if (e.ext !== ".go") continue;
    const dir = path.posix.dirname(e.relPath);
    const key = dir === "." ? "" : dir;
    if (!byDir.has(key)) byDir.set(key, []);
    byDir.get(key).push(e.relPath);
  }
  return { byDir, goModule };
}

function resolveGoImport(spec, index) {
  let dir = null;
  if (index.goModule && (spec === index.goModule || spec.startsWith(index.goModule + "/"))) {
    dir = spec === index.goModule ? "" : spec.slice(index.goModule.length + 1);
  } else {
    for (const d of index.byDir.keys()) {
      if (d && (d === spec || spec.endsWith("/" + d))) { dir = d; break; }
    }
  }
  if (dir === null) return [];
  const files = index.byDir.get(dir) || [];
  return files.length && files.length <= MAX_MULTI_TARGETS ? files : [];
}

// Lee `module <nombre>` de go.mod en la raiz del workspace, si existe. No es
// parte de LANG_PATTERNS/listSourceFiles (go.mod no es codigo), asi que se
// busca aparte -- solo vale la pena si el repo tiene algun archivo .go.
async function readGoModule() {
  try {
    const uris = await vscode.workspace.findFiles("go.mod", `**/{${Array.from(IGNORE_DIRS).map((d) => d + "/**").join(",")}}`, 5);
    const root = uris.find((u) => path.posix.dirname(vscode.workspace.asRelativePath(u)) === ".");
    if (!root) return null;
    const text = Buffer.from(await vscode.workspace.fs.readFile(root)).toString("utf8");
    const m = /^\s*module\s+(\S+)/m.exec(text);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

async function listSourceFiles() {
  // vscode.workspace.findFiles already respects .gitignore-style excludes
  // when files.exclude/search.exclude are set, but we double up with our
  // own directory blocklist since a fresh repo may not have those configured.
  const exclude = `**/{${Array.from(IGNORE_DIRS).map((d) => d + "/**").join(",")}}`;
  const supportedExts = new Set(LANG_PATTERNS.flatMap(([exts]) => exts));
  // Se piden SOLO extensiones de codigo: antes se pedian "**/*" con tope y se
  // filtraba despues, y en proyectos con muchas imagenes/assets el tope se
  // llenaba de archivos que no son codigo y el mapa quedaba casi vacio.
  const include = `**/*.{${[...supportedExts].map((e) => e.slice(1)).join(",")}}`;
  const uris = await vscode.workspace.findFiles(include, exclude, MAX_FILES * 2);
  return uris
    .filter((u) => supportedExts.has(extOf(u.fsPath)))
    .slice(0, MAX_FILES);
}

function extOf(p) {
  const i = p.lastIndexOf(".");
  return i === -1 ? "" : p.slice(i);
}

function addEdge(edges, from, to, weight) {
  if (from === to) return;
  let targets = edges.get(from);
  if (!targets) edges.set(from, (targets = new Map()));
  targets.set(to, (targets.get(to) || 0) + weight);
}

// PageRank personalizado (power iteration) sobre un grafo dirigido y
// pesado de archivos. Si `personalizeFiles` viene vacio, es PageRank
// uniforme comun; si trae archivos, el teleport (y la masa de los nodos
// sin salida) se reparte solo entre esos archivos -- el mismo truco que
// usa Aider para priorizar los archivos que ya estan en el chat.
function pageRank(relPaths, edges, { personalizeFiles, damping = 0.85, maxIter = 50, tol = 1e-6 } = {}) {
  const n = relPaths.length;
  const scores = new Map();
  if (!n) return scores;
  const idx = new Map(relPaths.map((p, i) => [p, i]));

  let personalize = new Float64Array(n).fill(1 / n);
  const boosted = (personalizeFiles || []).map((p) => idx.get(p)).filter((i) => i != null);
  if (boosted.length) {
    personalize = new Float64Array(n);
    for (const i of boosted) personalize[i] = 1 / boosted.length;
  }

  const outWeight = new Float64Array(n);
  for (const [from, targets] of edges) {
    const fi = idx.get(from);
    if (fi == null) continue;
    for (const w of targets.values()) outWeight[fi] += w;
  }

  let rank = new Float64Array(n).fill(1 / n);
  for (let iter = 0; iter < maxIter; iter++) {
    const next = new Float64Array(n);
    let danglingMass = 0;
    for (let i = 0; i < n; i++) if (outWeight[i] === 0) danglingMass += rank[i];
    for (let i = 0; i < n; i++) next[i] = (1 - damping) * personalize[i] + damping * danglingMass * personalize[i];
    for (const [from, targets] of edges) {
      const fi = idx.get(from);
      if (fi == null || outWeight[fi] === 0) continue;
      const share = rank[fi] / outWeight[fi];
      for (const [to, w] of targets) {
        const ti = idx.get(to);
        if (ti == null) continue;
        next[ti] += damping * share * w;
      }
    }
    let diff = 0;
    for (let i = 0; i < n; i++) diff += Math.abs(next[i] - rank[i]);
    rank = next;
    if (diff < tol) break;
  }
  for (let i = 0; i < n; i++) scores.set(relPaths[i], rank[i]);
  return scores;
}

// Builds the map: reads every matched file once, extracts symbols e
// imports, arma el grafo archivo-a-archivo, y calcula un PageRank uniforme
// (el "orden por defecto"; renderRepoMap puede recalcularlo personalizado
// sin volver a leer nada, reusando `graph`). Returns null if the workspace
// has no folder open (nothing to map) or nothing supported was found.
async function buildRepoMap() {
  const files = await listSourceFiles();
  if (!files.length) return null;

  const entries = []; // {relPath, ext, symbols, importSpecs, usedTreeSitter, text}
  let treeSitterUsed = 0;
  let treeSitterTotal = 0;
  for (const uri of files) {
    let stat;
    try {
      stat = await vscode.workspace.fs.stat(uri);
    } catch {
      continue;
    }
    if (stat.size > MAX_FILE_BYTES) continue;
    let text;
    try {
      text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
    } catch {
      continue;
    }
    const relPath = vscode.workspace.asRelativePath(uri);
    const ext = extOf(uri.fsPath);

    // Tree-sitter primero (parseo real); si no esta disponible para esta
    // extension (dependencia no instalada, gramatica faltante, extension
    // sin soporte) cae al extractor por regex de siempre. Nunca se mezclan
    // a medias en un mismo archivo: o se pudo parsear entero, o se usa el
    // regex entero -- asi no hay simbolos "reales" y "adivinados" sueltos
    // juntos sin que se sepa cual es cual.
    if (treesitter.EXT_TO_GRAMMAR[ext]) treeSitterTotal++;
    const parsed = await treesitter.parseWithTreeSitter(text, ext);
    let symbols, importSpecs, usedTreeSitter;
    if (parsed) {
      symbols = parsed.symbols;
      importSpecs = parsed.imports;
      usedTreeSitter = true;
      treeSitterUsed++;
    } else {
      symbols = extractSymbolsRegex(text, ext);
      importSpecs = importSpecifiersRegex(text, ext);
      usedTreeSitter = false;
    }
    entries.push({ relPath, ext, symbols, importSpecs, usedTreeSitter, text });
  }

  const relPathSet = new Set(entries.map((e) => e.relPath));
  const edges = new Map(); // relPath -> Map(relPath -> peso)

  // 1) Imports/requires reales, resueltos a un archivo del repo. JS/TS/TSX y
  // Python resuelven a un solo archivo por ruta relativa (resolveImport);
  // Java/Kotlin (paquete+tipo), C# (namespace) y Go (modulo de go.mod +
  // carpeta) pueden resolver a varios archivos a la vez, repartiendo el
  // peso entre ellos -- ver comentario de la fase 3 al inicio del archivo.
  const javaKtIndex = buildJavaKotlinIndex(entries);
  const csIndex = buildCsharpIndex(entries);
  const goModule = entries.some((e) => e.ext === ".go") ? await readGoModule() : null;
  const goIndex = buildGoIndex(entries, goModule);
  for (const entry of entries) {
    for (const spec of entry.importSpecs) {
      const direct = resolveImport(entry.relPath, spec, entry.ext, relPathSet);
      if (direct) { addEdge(edges, entry.relPath, direct, IMPORT_EDGE_WEIGHT); continue; }
      let multi = [];
      if (entry.ext === ".java" || entry.ext === ".kt") multi = resolveJavaKotlinImport(spec, javaKtIndex);
      else if (entry.ext === ".cs") multi = resolveCsharpImport(spec, csIndex);
      else if (entry.ext === ".go") multi = resolveGoImport(spec, goIndex);
      if (!multi.length) continue;
      const weight = IMPORT_EDGE_WEIGHT / multi.length;
      for (const target of multi) addEdge(edges, entry.relPath, target, weight);
    }
  }

  // 2) Heuristico de menciones de texto (cheap stand-in cuando no hay
  // import real, o para lenguajes sin resolver todavia): para cada simbolo
  // definido en `owner`, cuenta en que OTROS archivos aparece su nombre, y
  // agrega una arista "ese otro archivo depende de owner". Sigue siendo
  // texto plano: puede confundir un string literal con un uso real.
  for (const owner of entries) {
    for (const sym of owner.symbols) {
      let refCount = 0;
      for (const other of entries) {
        if (other === owner) continue;
        if (other.text.includes(sym.name)) {
          refCount++;
          addEdge(edges, other.relPath, owner.relPath, MENTION_EDGE_WEIGHT);
        }
      }
      sym.refCount = refCount;
    }
  }

  const relPaths = entries.map((e) => e.relPath);
  const defaultScores = pageRank(relPaths, edges, {});
  for (const entry of entries) entry.score = defaultScores.get(entry.relPath) || 0;
  entries.sort((a, b) => b.score - a.score);

  return {
    entries,
    graph: { relPaths, edges },
    builtAt: Date.now(),
    treeSitter: { used: treeSitterUsed, total: treeSitterTotal },
  };
}

// Renders a compact text block for the prompt: file paths + their top
// symbols (name, type, line), NOT full file contents -- that's the whole
// point of a map versus just dumping every file into context. `focusNames`
// (symbols literally mentioned in the user's question, same idea as
// extract_symbol_candidates in app_en.py) get their files pinned first.
// `personalizeFiles` (rutas ya en el chat: activo + agregados) sesga el
// PageRank hacia lo que el usuario ya esta mirando -- se recalcula aca,
// barato, sin releer nada del disco.
// opts.noLines (v0.21, cache del mapa): sin "linea N" -- los numeros de linea
// cambian con CUALQUIER edicion arriba del simbolo, y eso rompia el texto
// identico turno a turno que el proveedor necesita para cachear el mapa.
function renderRepoMap(map, focusNames, maxFiles = 15, maxSymbolsPerFile = 12, personalizeFiles, opts = {}) {
  if (!map || !map.entries.length) return "";
  const focus = new Set(focusNames || []);
  const scores = personalizeFiles && personalizeFiles.length && map.graph
    ? pageRank(map.graph.relPaths, map.graph.edges, { personalizeFiles })
    : null;
  const scoreOf = (e) => (scores ? scores.get(e.relPath) || 0 : e.score || 0);

  const ranked = scores ? [...map.entries].sort((a, b) => scoreOf(b) - scoreOf(a)) : map.entries;
  const withFocus = ranked.filter((e) => e.symbols.some((s) => focus.has(s.name)));
  const rest = ranked.filter((e) => !withFocus.includes(e));
  const ordered = [...withFocus, ...rest].slice(0, maxFiles);

  const lines = ["Mapa del repositorio (solo firmas, no el contenido completo -- pide el archivo si necesitas verlo entero):"];
  for (const entry of ordered) {
    if (!entry.symbols.length) continue;
    lines.push(`\n### ${entry.relPath}`);
    const top = [...entry.symbols].sort((a, b) => b.refCount - a.refCount).slice(0, maxSymbolsPerFile);
    for (const s of top) {
      const ref = s.refCount ? `referenciado en ${s.refCount} otro${s.refCount === 1 ? "" : "s"} archivo${s.refCount === 1 ? "" : "s"}` : "";
      if (opts.noLines) lines.push(`- ${s.type} ${s.name}${ref ? ` (${ref})` : ""}`);
      else lines.push(`- ${s.type} ${s.name} (linea ${s.line}${ref ? `, ${ref}` : ""})`);
    }
  }
  return lines.join("\n");
}

// Parte del mapa que depende del PEDIDO (v0.21): los simbolos que la pregunta
// nombra literalmente, con su archivo y linea actual. Va en el mensaje final
// (el que cambia siempre); el mapa general, estable, va cacheado aparte.
function renderFocusMap(map, focusNames, maxHits = 20) {
  if (!map || !map.entries.length || !focusNames || !focusNames.length) return "";
  const focus = new Set(focusNames);
  const hits = [];
  for (const e of map.entries) for (const s of e.symbols) if (focus.has(s.name)) hits.push(`- ${e.relPath}:${s.line} ${s.type} ${s.name}`);
  if (!hits.length) return "";
  return `Simbolos que nombra el pedido (archivo:linea actual):\n${hits.slice(0, maxHits).join("\n")}`;
}

// Which known symbol names does the user's question literally mention?
// Same purpose as app_en.py's extract_symbol_candidates + exact_symbol_context
// (prefer a deterministic, literal match over the fuzzy ranking) -- here
// checked against the real set of symbols the map already found, instead
// of guessing from a naming-convention regex.
function extractFocusNames(question, map) {
  if (!map) return [];
  const names = new Set();
  for (const entry of map.entries) for (const s of entry.symbols) names.add(s.name);
  const found = [];
  for (const name of names) {
    const re = new RegExp("\\b" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b");
    if (re.test(question)) found.push(name);
  }
  return found;
}

module.exports = { buildRepoMap, renderRepoMap, renderFocusMap, extractFocusNames, pageRank };
