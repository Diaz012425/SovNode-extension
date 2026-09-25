"use strict";

// FASE 2 del repo map real (ver architecture.md): esto reemplaza el
// extractor de simbolos por regex de repoMap.js por un parser de verdad
// (tree-sitter, via WASM con "web-tree-sitter" -- no requiere compilar nada
// nativo, corre igual en Windows/Mac/Linux). Es la PRIMERA dependencia npm
// del proyecto: hay que correr "npm install" una vez antes de F5.
//
// Diseño defensivo a proposito: si el usuario todavia no corrio
// "npm install" (o algo del wasm no carga), TODO este modulo se apaga solo
// -- getParser() devuelve null y repoMap.js cae de vuelta al extractor por
// regex de siempre. La extension nunca se rompe por esto; en el peor caso,
// el repo map es el mismo "honesto pero limitado" que ya era antes de esta
// fase. `/diag` reporta si tree-sitter esta activo o no.

const fs = require("fs");

const EXT_TO_GRAMMAR = {
  ".py": "python",
  ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
  ".ts": "typescript",
  ".tsx": "tsx",
  ".java": "java",
  ".cs": "c_sharp",
  ".kt": "kotlin",
  ".go": "go",
};

// Nombre del archivo .wasm dentro de tree-sitter-wasms/out/ para cada
// "grammar" logico de arriba (coinciden salvo que aca se explicitan).
const WASM_NAME = {
  python: "python", javascript: "javascript", typescript: "typescript", tsx: "tsx",
  java: "java", c_sharp: "c_sharp", kotlin: "kotlin", go: "go",
};

let TS = null; // { Parser, Language, Query } una vez cargado, o false si no esta disponible
let initPromise = null;
const langCache = new Map(); // grammar -> Language | null (null = no se pudo cargar)
const queryCache = new Map(); // "grammar:kind" -> Query | null

async function ensureInit() {
  if (TS === false) return false;
  if (TS) return true;
  if (!initPromise) {
    initPromise = (async () => {
      let mod;
      try {
        mod = require("web-tree-sitter");
      } catch (e) {
        TS = false; // "web-tree-sitter" no esta instalado (falta "npm install")
        return false;
      }
      try {
        const wasmBinary = fs.readFileSync(require.resolve("web-tree-sitter/tree-sitter.wasm"));
        await mod.Parser.init({ wasmBinary });
        TS = mod;
        return true;
      } catch (e) {
        TS = false; // el .wasm base no se pudo leer/inicializar
        return false;
      }
    })();
  }
  return initPromise;
}

async function getLanguage(grammar) {
  if (langCache.has(grammar)) return langCache.get(grammar);
  let lang = null;
  try {
    const file = require.resolve(`tree-sitter-wasms/out/tree-sitter-${WASM_NAME[grammar]}.wasm`);
    lang = await TS.Language.load(fs.readFileSync(file));
  } catch (e) {
    lang = null; // falta esa gramatica puntual (paquete parcial, version vieja, etc.)
  }
  langCache.set(grammar, lang);
  return lang;
}

function getQuery(grammar, lang, kind, source) {
  const key = `${grammar}:${kind}`;
  if (queryCache.has(key)) return queryCache.get(key);
  let q = null;
  try {
    q = new TS.Query(lang, source);
  } catch (e) {
    q = null;
  }
  queryCache.set(key, q);
  return q;
}

// --------------------------------------------------------------- consultas
// Una query de tree-sitter por "familia" de gramatica. `name: (_)` en vez
// de `name: (identifier)` donde hace falta porque TypeScript usa el tipo de
// nodo `type_identifier` para nombres de clase/interfaz en vez de
// `identifier` como JS/Python -- son gramaticas hermanas pero no identicas.
const SYMBOL_QUERIES = {
  python: `
    (function_definition name: (identifier) @func.name)
    (class_definition name: (identifier) @class.name)
  `,
  javascript: `
    (function_declaration name: (identifier) @func.name)
    (class_declaration name: (_) @class.name)
    (method_definition name: (property_identifier) @method.name)
    (variable_declarator name: (identifier) @func.name value: (arrow_function))
  `,
  typescript: `
    (function_declaration name: (identifier) @func.name)
    (class_declaration name: (_) @class.name)
    (interface_declaration name: (type_identifier) @class.name)
    (method_definition name: (property_identifier) @method.name)
    (variable_declarator name: (identifier) @func.name value: (arrow_function))
  `,
  tsx: `
    (function_declaration name: (identifier) @func.name)
    (class_declaration name: (_) @class.name)
    (interface_declaration name: (type_identifier) @class.name)
    (method_definition name: (property_identifier) @method.name)
    (variable_declarator name: (identifier) @func.name value: (arrow_function))
  `,
  java: `
    (class_declaration name: (identifier) @class.name)
    (interface_declaration name: (identifier) @class.name)
    (record_declaration name: (identifier) @class.name)
    (method_declaration name: (identifier) @func.name)
  `,
  c_sharp: `
    (class_declaration name: (identifier) @class.name)
    (interface_declaration name: (identifier) @class.name)
    (record_declaration name: (identifier) @class.name)
    (method_declaration name: (identifier) @func.name)
  `,
  kotlin: `
    (class_declaration (type_identifier) @class.name)
    (function_declaration (simple_identifier) @func.name)
  `,
  go: `
    (function_declaration name: (identifier) @func.name)
    (method_declaration name: (field_identifier) @func.name)
    (type_spec name: (type_identifier) @class.name type: (struct_type))
  `,
};

// Imports: para JS/TS/TSX y Python se capturan ya con la forma final (el
// specifier solo) porque repoMap.js sabe resolverlos directo a un archivo
// por ruta relativa. Para Java/Kotlin/C#/Go, repoMap.js SI resuelve (via
// paquete/namespace/go.mod, ver resolveJavaKotlinImport/resolveCsharpImport/
// resolveGoImport), pero necesita la declaracion completa (con el paquete
// calificado), asi que aca se captura el nodo import/using entero
// (`@import.decl`) y se limpia la palabra clave/`;`/alias en extract() de
// abajo -- no vale la pena una query mas fina por gramatica para eso.
const IMPORT_QUERIES = {
  python: `
    (import_statement name: (dotted_name) @import.spec)
    (import_from_statement module_name: (_) @import.spec)
  `,
  javascript: `
    (import_statement source: (string) @import.spec)
    (export_statement source: (string) @import.spec)
    (call_expression function: (identifier) @call.callee arguments: (arguments . (string) @call.arg))
    (call_expression function: (import) arguments: (arguments . (string) @import.spec))
  `,
  typescript: `
    (import_statement source: (string) @import.spec)
    (export_statement source: (string) @import.spec)
    (call_expression function: (identifier) @call.callee arguments: (arguments . (string) @call.arg))
    (call_expression function: (import) arguments: (arguments . (string) @import.spec))
  `,
  tsx: `
    (import_statement source: (string) @import.spec)
    (export_statement source: (string) @import.spec)
    (call_expression function: (identifier) @call.callee arguments: (arguments . (string) @call.arg))
    (call_expression function: (import) arguments: (arguments . (string) @import.spec))
  `,
  java: `(import_declaration) @import.decl`,
  kotlin: `(import_header) @import.decl`,
  c_sharp: `(using_directive) @import.decl`,
  go: `(import_spec path: (interpreted_string_literal) @import.spec)`,
};

// Limpia un nodo de declaracion de import/using entero (java/kotlin/c#) a
// solo el nombre calificado: saca la palabra clave (`import`/`using`),
// `static`/`global`, el `;` final, y un alias (`as X` en Kotlin, `X = Y` en
// C#) si lo trae -- lo que sobra es lo que repoMap.js espera como specifier.
function cleanImportDecl(text) {
  let t = text.trim()
    .replace(/^global\s+/, "")
    .replace(/^import\s+/, "")
    .replace(/^using\s+/, "")
    .replace(/^static\s+/, "")
    .replace(/;\s*$/, "")
    .trim();
  if (t.includes("=")) return null; // alias de C# ("using X = Y;"): no vale la pena resolverlo
  t = t.replace(/\s+as\s+\S+$/, ""); // alias de Kotlin
  return t || null;
}

// El texto de un nodo `string` de JS/TS incluye las comillas; el de Python
// (import.spec) no las tiene. Se normaliza aca, una sola vez.
function unquote(s) {
  return s.replace(/^['"`]|['"`]$/g, "");
}

function symbolTypeFor(captureName) {
  if (captureName === "class.name") return "class";
  if (captureName === "method.name") return "function"; // se muestran igual que funciones sueltas
  return "function";
}

function lineOf(node) {
  return node.startPosition.row + 1;
}

// Corre las dos queries (simbolos + imports, si aplica) sobre un arbol ya
// parseado y devuelve el mismo shape que el extractor por regex, para que
// repoMap.js no tenga que distinguir de donde salio.
function extract(grammar, lang, tree) {
  const symbols = [];
  const seen = new Set(); // evita duplicar si dos patrones matchean el mismo nodo
  const symQ = getQuery(grammar, lang, "symbols", SYMBOL_QUERIES[grammar]);
  if (symQ) {
    for (const m of symQ.matches(tree.rootNode)) {
      for (const c of m.captures) {
        const key = `${c.node.startIndex}:${c.node.endIndex}:${c.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        symbols.push({ name: c.node.text, type: symbolTypeFor(c.name), line: lineOf(c.node) });
      }
    }
  }

  const imports = [];
  const importSrc = IMPORT_QUERIES[grammar];
  if (importSrc) {
    const impQ = getQuery(grammar, lang, "imports", importSrc);
    if (impQ) {
      for (const m of impQ.matches(tree.rootNode)) {
        let callee = null;
        let arg = null;
        let direct = null;
        let decl = null;
        for (const c of m.captures) {
          if (c.name === "call.callee") callee = c.node.text;
          else if (c.name === "call.arg") arg = c.node.text;
          else if (c.name === "import.spec") direct = c.node.text;
          else if (c.name === "import.decl") decl = c.node.text;
        }
        if (direct != null) imports.push(unquote(direct));
        // require("./x") es un call_expression cualquiera con un string de
        // primer argumento -- solo cuenta si el callee literalmente se
        // llama "require" (si no, es cualquier otra llamada con un string
        // adelante, como log("hola") o test("describe...", fn)).
        else if (callee === "require" && arg != null) imports.push(unquote(arg));
        else if (decl != null) {
          const cleaned = cleanImportDecl(decl);
          if (cleaned) imports.push(cleaned);
        }
      }
    }
  }

  return { symbols, imports };
}

// Punto de entrada de repoMap.js: parsea `text` con la gramatica de `ext`.
// Devuelve null si tree-sitter no esta disponible (dependencia no
// instalada, wasm faltante) o la extension no tiene gramatica soportada --
// en ambos casos el llamador debe caer al extractor por regex.
async function parseWithTreeSitter(text, ext) {
  const grammar = EXT_TO_GRAMMAR[ext];
  if (!grammar) return null;
  const ok = await ensureInit();
  if (!ok) return null;
  const lang = await getLanguage(grammar);
  if (!lang) return null;
  let tree;
  try {
    tree = parserFor(grammar, lang).parse(text);
  } catch (e) {
    return null; // archivo con sintaxis tan rota que ni tree-sitter la tolera (raro, es tolerante a errores)
  }
  if (!tree) return null;
  // Los arboles viven en el heap de WASM y el GC de JS NO los libera: sin
  // delete() cada reconstruccion del repo map perdia un arbol por archivo y
  // la memoria del Extension Host crecia sin techo en una sesion larga.
  try {
    return extract(grammar, lang, tree);
  } catch (_) {
    return null; // una query que explota en un archivo raro -> regex para ese archivo, nunca un crash del mapa
  } finally {
    try { tree.delete(); } catch (_) { /* version sin delete() */ }
  }
}

// Un parser por gramatica, reutilizado (tambien vive en el heap de WASM:
// crear uno nuevo por archivo, sin delete, era la otra mitad de la fuga).
const parsers = new Map();
function parserFor(grammar, lang) {
  let p = parsers.get(grammar);
  if (!p) {
    p = new TS.Parser();
    p.setLanguage(lang);
    parsers.set(grammar, p);
  }
  return p;
}

// Para /diag: si esto devuelve true, el repo map esta usando parseo real;
// si no, esta en modo regex de respaldo (probablemente falta "npm install").
async function isAvailable() {
  return ensureInit();
}

module.exports = { parseWithTreeSitter, isAvailable, EXT_TO_GRAMMAR };
