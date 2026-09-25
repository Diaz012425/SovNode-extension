"use strict";

const https = require("https");
const { renderBase } = require("./archBase");
const { formatInstructions } = require("./editFormats");
const { StringDecoder } = require("string_decoder");

// Mismo mapeo effort -> presupuesto de razonamiento / techo de salida que
// GEMINI_THINKING_BUDGET_BY_EFFORT en app_en.py. Los tokens de razonamiento
// salen del MISMO presupuesto de output: sin tope, una respuesta larga (por
// ejemplo, crear un archivo entero) se corta a la mitad.
const THINKING_BUDGET_BY_EFFORT = { low: 512, medium: 1024, high: 2048, extra: 4096 };
const OUTPUT_CEILING_BY_EFFORT = { low: 8192, medium: 16384, high: 32768, extra: 65536 };

// El prompt de sistema se arma por FORMATO de edicion (v0.12): la parte de
// "como editar" sale de editFormats.js (SEARCH/REPLACE, diff unificado o
// archivo completo); el resto -- que contexto recibe, como explicar el
// cambio -- es igual para los tres.
const PROMPT_INTRO = `Eres SovNode, un asistente de programacion dentro de VS Code. Respondes en el idioma del usuario.

CONTEXTO QUE RECIBES
- Un MAPA DEL REPOSITORIO: rutas de archivos con sus funciones/clases y numero de linea (no su contenido).
- ARCHIVOS EN EL CHAT: el contenido completo y actual de los archivos que puedes editar.`;

const PROMPT_EXPLAIN = `EXPLICA SIEMPRE QUE HICISTE Y DONDE
Antes de los cambios, escribe una seccion corta con este formato:
**Que voy a cambiar**
- \`ruta/archivo.ext\` -> que cambia, en que funcion/clase/seccion, y por que (una linea por cambio).
Despues de los cambios, si aplica, una linea "**Como probarlo:**" con el paso concreto.
Escribi estos titulos ("Que voy a cambiar", "Como probarlo") traducidos al idioma del usuario (en ingles: "What I'll change", "How to test").

Si el pedido es solo una pregunta o explicacion, responde en prosa (markdown), sin cambios de codigo.`;

function systemPromptFor(format) {
  return `${PROMPT_INTRO}\n\n${formatInstructions(format)}\n\n${PROMPT_EXPLAIN}`;
}

const SYSTEM_PROMPT = systemPromptFor("search-replace");


// MODO ARQUITECTO (como el de Aider): un primer modelo "arquitecto" razona el
// cambio y escribe un PLAN concreto, sin tocar codigo; despues un modelo
// "editor" (puede ser uno mas barato) lo convierte en cambios de codigo (en el formato de edicion que toque).
const ARCHITECT_PROMPT = `Eres el ARQUITECTO de SovNode, un asistente de programacion dentro de VS Code. Respondes en el idioma del usuario.

Tu trabajo es PENSAR y PLANIFICAR el cambio; otro modelo (el EDITOR) lo va a implementar siguiendo tu plan al pie de la letra.
NO escribas codigo de edicion (ni bloques SEARCH/REPLACE, ni diffs, ni archivos completos).

CONTEXTO QUE RECIBES
- Un MAPA DEL REPOSITORIO (rutas + funciones/clases, sin contenido).
- ARCHIVOS EN EL CHAT: contenido actual. Normalmente llega como VERSION BASE + CAMBIOS: el archivo completo esta
  en "ARCHIVOS BASE" (al principio) y al final solo el diff de lo que cambio desde entonces. Razona sobre el
  archivo ACTUAL (base + diff); nunca planees cambios sobre codigo que el diff ya quito.
- Si para planificar necesitas ver un archivo que esta en el mapa pero no en el chat, responde UNICAMENTE con:
  NECESITO_ARCHIVOS: ruta/uno.ext, ruta/dos.ext

FORMATO DEL PLAN (los titulos en NEGRITA son un EJEMPLO en espanol: traducilos siempre al idioma del pedido -- si es en ingles, usa exactamente "**Plan**", "**Order and dependencies:**", "**How to test:**"; el contenido del plan tambien va en ese idioma, no solo los titulos)
**Plan**
1. \`ruta/archivo.ext\` (editar | crear) -> que cambia exactamente, en que funcion/clase/seccion, y por que.
   Incluye firmas, nombres, y los fragmentos de codigo clave cuando ayuden a que el editor no adivine.
2. ...
**Orden y dependencias:** (si importa el orden entre archivos)
**Como probarlo:** paso concreto.

Reglas:
- Se especifico: el editor no ve tu razonamiento, solo este plan.
- Minimo cambio necesario; no propongas refactors que el usuario no pidio.
- Si el pedido es solo una pregunta/explicacion y NO requiere cambiar codigo, escribe en la PRIMERA linea
  exactamente: SIN_CAMBIOS
  y despues responde normalmente en prosa.`;

const EDITOR_NOTE = "PLAN DEL ARQUITECTO (implementalo completo y exactamente, en el formato de edicion de tus instrucciones; no agregues cambios fuera del plan):";

// MODO TAREA (pasos autonomos): un primer modelo divide un pedido grande en
// una lista corta de pasos chicos; despues cada paso se ejecuta como un
// turno normal (planea/edita/verifica/commitea) uno tras otro, sin que el
// usuario tenga que ir pidiendo "sigue" despues de cada uno.
function taskPlanPrompt(maxSteps) {
  return `Eres el PLANIFICADOR de tareas largas de SovNode, un asistente de programacion dentro de VS Code. Respondes en el idioma del usuario.

El usuario pidio algo que puede ser grande o tocar varios archivos. Tu unico trabajo es partirlo en una lista
de PASOS chicos, cada uno una unidad de trabajo que se pueda implementar y verificar por separado (compila,
no rompe lo anterior). Cada paso se le va a pasar, uno a la vez y en orden, a otro modelo que SI edita codigo.

CONTEXTO QUE RECIBES
- Un MAPA DEL REPOSITORIO (rutas + funciones/clases, sin contenido).
- ARCHIVOS EN EL CHAT: contenido completo y actual.
- Si para planificar necesitas ver un archivo que esta en el mapa pero no en el chat, responde UNICAMENTE con:
  NECESITO_ARCHIVOS: ruta/uno.ext, ruta/dos.ext

REGLAS
- Entre 1 y ${maxSteps} pasos. Si el pedido ya es chico y no hace falta dividirlo, responde con UN SOLO paso
  que sea el pedido completo.
- Cada paso puede depender de los anteriores (el modelo que edita ve un resumen de lo ya hecho), pero nunca
  de pasos MUY posteriores.
- No escribas codigo ni cambios de codigo: solo la lista de pasos.
- Se concreto: nombra archivos y funciones cuando lo sepas, no pasos vagos como "mejorar el codigo".

FORMATO (nada mas que esto, un paso por linea):
1. descripcion concreta del paso
2. descripcion concreta del paso
...`;
}

const TASK_STEP_NOTE = "Esto es UN PASO de una tarea mas grande, dividida por el planificador. Implementa SOLO este paso (no te adelantes a los siguientes), en el formato de edicion de tus instrucciones, si aplica.";


// Logs adjuntos (errores, stack traces, salida de terminal) que el usuario
// pego aparte con 🐞 o /bug: van en su propio bloque, DESPUES de los
// archivos y antes del pedido, para que el chat quede libre para explicar
// que paso ("al apretar espacio se cierra el juego") sin mezclar el texto
// de la pregunta con 300 lineas de traceback.
function renderLogs(logs) {
  if (!logs || !logs.length) return "";
  const body = logs.map((l, i) => {
    const f = l.text.includes("```") ? "````" : "```"; // un log con ``` adentro no rompe el bloque
    return `### Log ${i + 1}: ${l.label}\n${f}text\n${l.text}\n${f}`;
  }).join("\n\n");
  return `LOGS / ERRORES ADJUNTOS POR EL USUARIO (salida REAL del programa o de la terminal; usalos para encontrar la causa antes de proponer cambios, y explica en la respuesta que significa el error):\n\n${body}`;
}

const REPO_MAP_ACK = "Recibido: tengo el mapa del repositorio.";
const PROJECT_MEMORY_ACK = "Recibido: tengo la memoria del proyecto.";
// repoMapCached (v0.21): mapa ESTABLE (sin lineas ni orden por pedido) en su
// propio par [user][model] al principio, antes del historial -- asi es prefijo
// identico turno a turno y el proveedor lo cobra como cache. repoMapText (el
// modo viejo) sigue yendo dentro del mensaje final. repoMapFocus: la parte que
// depende del pedido, siempre en el mensaje final.
function buildContents({ question, files, history, repoMapText, repoMapCached, repoMapFocus, extraNote, logs, baseFiles, projectMemory, replyLang }) {
  const contents = [];
  // Memoria del proyecto (v0.22): lo MAS estable de todo -> primer par.
  if (projectMemory) {
    contents.push({ role: "user", parts: [{ text: projectMemory }] });
    contents.push({ role: "model", parts: [{ text: PROJECT_MEMORY_ACK }] });
  }
  // Base del arquitecto (archBase.js): va PRIMERO, antes del historial, para
  // que sea el prefijo identico que el proveedor cachea turno a turno. La
  // respuesta fija del "modelo" mantiene la alternancia user/model.
  const baseText = renderBase(baseFiles);
  if (baseText) {
    contents.push({ role: "user", parts: [{ text: baseText }] });
    contents.push({ role: "model", parts: [{ text: "Recibido: tengo la version base de los archivos." }] });
  }
  if (repoMapCached) {
    contents.push({ role: "user", parts: [{ text: repoMapCached }] });
    contents.push({ role: "model", parts: [{ text: REPO_MAP_ACK }] });
  }
  for (const turn of history || []) {
    contents.push({ role: turn.role === "assistant" ? "model" : "user", parts: [{ text: turn.content }] });
  }
  const blocks = [];
  if (repoMapText) blocks.push(repoMapText);
  if (repoMapFocus) blocks.push(repoMapFocus);
  if (files && files.length) {
    const fileTexts = files.map((f) => f.rendered || `### ${f.path}${f.active ? "  (archivo activo en el editor)" : ""}\n\`\`\`\n${f.content}\n\`\`\``);
    blocks.push(`ARCHIVOS EN EL CHAT (contenido actual, los unicos que puedes editar con SEARCH no vacio; los marcados EXTRACTO muestran solo partes):\n\n${fileTexts.join("\n\n")}`);
  } else {
    blocks.push("ARCHIVOS EN EL CHAT: ninguno. Puedes crear archivos nuevos (SEARCH vacio) o pedir archivos con NECESITO_ARCHIVOS.");
  }
  const logText = renderLogs(logs);
  if (logText) blocks.push(logText);
  if (extraNote) blocks.push(extraNote);
  blocks.push(`Pedido del usuario: ${question}`);
  // v0.29.2: idioma explicito, en el mensaje final (no rompe ningun cache).
  if (replyLang === "en") blocks.push("RESPONSE LANGUAGE: English. Write ALL prose in English (explanations, plan, section titles such as \"What I'll change\" / \"How to test\", and code comments), even though these instructions are in Spanish.");
  else if (replyLang === "es") blocks.push("IDIOMA DE LA RESPUESTA: espanol.");
  contents.push({ role: "user", parts: [{ text: blocks.join("\n\n") }] });
  return contents;
}

// Herramientas nativas (v0.25): las rondas de herramientas viajan en un
// formato interno comun a los 3 proveedores -- turno del modelo con
// `native: {provider, payload}` (su respuesta CRUDA, que hay que devolverle
// tal cual: Gemini 3 exige su thoughtSignature, Anthropic sus bloques de
// thinking) y turno de resultados con `toolResults: [{id, apiId, name,
// result}]`. Aca se traduce al formato de Gemini y se descartan campos que
// la API no conoce.
function geminiContents(contents) {
  return (contents || []).map((t) => {
    if (t.native && t.native.provider === "gemini" && Array.isArray(t.native.payload) && t.native.payload.length) return { role: "model", parts: t.native.payload };
    if (t.toolResults) {
      return {
        role: "user",
        parts: t.toolResults.map((x) => ({ functionResponse: { ...(x.apiId ? { id: x.apiId } : {}), name: x.name, response: { result: x.result } } })),
      };
    }
    return { role: t.role, parts: (t.parts || []).map((p) => ({ text: p.text || "" })) };
  });
}

function requestBody(contents, effort, systemPrompt, toolDefs, toolChoiceNone) {
  const thinkingBudget = THINKING_BUDGET_BY_EFFORT[effort] || THINKING_BUDGET_BY_EFFORT.medium;
  const maxOutputTokens = OUTPUT_CEILING_BY_EFFORT[effort] || OUTPUT_CEILING_BY_EFFORT.medium;
  const tools = toolDefs && toolDefs.length ? [{ functionDeclarations: toolDefs.map((d) => ({ name: d.name, description: d.description, parameters: d.parameters })) }] : undefined;
  return JSON.stringify({
    contents: geminiContents(contents),
    systemInstruction: { parts: [{ text: systemPrompt || SYSTEM_PROMPT }] },
    tools,
    toolConfig: tools && toolChoiceNone ? { functionCallingConfig: { mode: "NONE" } } : undefined,
    generationConfig: { maxOutputTokens, thinkingConfig: { thinkingBudget, includeThoughts: true } },
  });
}

// "Parse Error: JS Exception" con un stack 100% interno de Node (TLSSocket /
// _http_client, sin una sola linea de este archivo) NO es un bug de este
// codigo: es llhttp fallando al interpretar los bytes crudos de la
// respuesta -- lo tipico cuando un antivirus con inspeccion HTTPS, un proxy
// corporativo o una VPN interceptan la conexion y rompen el
// "chunked transfer-encoding" que usa el streaming (SSE). Por eso el fix
// real no es "arreglar el parseo", es DEJAR de depender de streaming cuando
// eso pasa: se reintenta con una llamada normal (una sola respuesta JSON
// completa, con Content-Length), mucho mas dificil de romper para ese tipo
// de interceptores.
// Siempre Buffer, venga como venga el chunk (defensivo: Node real manda Buffers).
const toBuf = (c) => (Buffer.isBuffer(c) ? c : Buffer.from(String(c), "utf8"));

function isTransportGlitch(err) {
  const msg = String((err && err.message) || err || "");
  return /Parse Error|ECONNRESET|EPIPE|socket hang up|HPE_|ECONNREFUSED|read ECONNRESET/i.test(msg);
}

// CAUSA RAIZ del "Parse Error: JS Exception" (reproducida y confirmada):
// al depurar con F5, VS Code activa el rastreo de red del inspector de Node,
// que agrega su propio listener 'data' a cada respuesta y reporta
// chunk.byteLength. Si llamamos res.setEncoding("utf8"), los chunks llegan
// como string, byteLength es undefined, el inspector lanza "Missing
// dataLength in event" y, como eso ocurre DENTRO del parser HTTP, Node lo
// convierte en "Parse Error: JS Exception" y la peticion muere. Por eso:
// siempre se reciben Buffers y se decodifican aca (StringDecoder para el
// streaming, Buffer.concat para respuestas completas).

// Cancela la peticion "a mano" (req.destroy) en vez de pasar `signal`
// directo en las opciones de https.request. Node integra ese `signal` con
// su propia maquinaria interna de aborto, que en la ventana de depuracion
// de VS Code (el "Extension Development Host" que abre F5) convive mal con
// la instrumentacion de red del inspector de Node -- la combinacion de
// ambas cosas es una causa conocida de fallos como "Parse Error: JS
// Exception" y "Missing dataLength in event", sin relacion con esta
// extension. Escuchando el abort por fuera se logra lo mismo (cortar la
// peticion si el usuario cancela) sin activar ese camino interno.
function detachAbort(req, signal, reject) {
  if (!signal) return;
  const onAbort = () => {
    reject(new Error("Cancelado por el usuario.")); // primero: gana a cualquier error que genere destroy()
    req.destroy();
  };
  if (signal.aborted) return onAbort();
  signal.addEventListener("abort", onAbort, { once: true });
  // Sacar el listener cuando la request termina (bien o mal): en /task UNA
  // sola senal sirve a todas las llamadas de la tarea, y sin esto se
  // acumulaban listeners (cada uno reteniendo su req y su reject) hasta el
  // MaxListenersExceededWarning de Node.
  req.once("close", () => signal.removeEventListener("abort", onAbort));
}

// Llamada de bajo nivel, compartida por el modo streaming y el modo normal.
// `sse: true` pide streamGenerateContent con Server-Sent Events; `sse:
// false` pide generateContent (una sola respuesta). onChunk(rawString) se
// llama con cada pedazo de bytes tal como llega (streaming) o una sola vez
// con el body completo (no streaming).
function rawRequest({ apiKey, model, contents, effort, signal, sse, systemPrompt, toolDefs, toolChoiceNone }) {
  return new Promise((resolve, reject) => {
    const body = requestBody(contents, effort, systemPrompt, toolDefs, toolChoiceNone);
    const req = https.request(
      {
        hostname: "generativelanguage.googleapis.com",
        path: `/v1beta/models/${encodeURIComponent(model)}:${sse ? "streamGenerateContent?alt=sse" : "generateContent"}`,
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey, "Content-Length": Buffer.byteLength(body) },
        // OJO: no se pasa `signal` aca a proposito -- ver detachAbort().
      },
      (res) => {
        // NUNCA res.setEncoding(): ver "CAUSA RAIZ" arriba.
        const chunks = [];
        try {
          res.on("data", (c) => chunks.push(toBuf(c)));
          res.on("end", () => {
            try { resolve({ statusCode: res.statusCode, raw: Buffer.concat(chunks).toString("utf8") }); } catch (e) { reject(e); }
          });
          res.on("error", reject);
        } catch (e) {
          reject(e);
        }
      }
    );
    req.on("error", (err) => {
      if (err && (err.name === "AbortError" || err.code === "ABORT_ERR")) reject(new Error("Cancelado por el usuario."));
      else reject(err);
    });
    detachAbort(req, signal, reject);
    req.write(body);
    req.end();
  });
}

function errorFromBody(statusCode, raw) {
  let msg = raw.slice(0, 400);
  try {
    const d = JSON.parse(raw);
    msg = (Array.isArray(d) ? d[0] : d).error.message || msg;
  } catch (_) { /* respuesta no JSON */ }
  return new Error(`Gemini devolvio HTTP ${statusCode}: ${msg}`);
}

// Extrae texto/pensamientos/uso de UN objeto de respuesta de Gemini (un
// evento SSE ya parseado, o el body completo de generateContent -- misma
// forma en ambos casos). Ignora eventos "keep-alive" sin forma de objeto
// real (ver nota de mas abajo).
function collectFromCandidate(data, acc) {
  if (!data || typeof data !== "object") return;
  if (data.promptFeedback && data.promptFeedback.blockReason) acc.blockReason = data.promptFeedback.blockReason;
  if (data.usageMetadata) acc.usageMeta = data.usageMetadata;
  const cand = (data.candidates || [])[0];
  if (!cand) return;
  if (cand.finishReason) acc.finishReason = cand.finishReason;
  for (const p of (cand.content && cand.content.parts) || []) {
    if (p.functionCall) {
      acc.calls.push(p); // crudo: conserva thoughtSignature para devolverlo
      continue;
    }
    if (!p.text) continue;
    if (acc.firstTokenMs === null) acc.firstTokenMs = Date.now() - acc.started;
    if (p.thought) { acc.thoughts += p.text; acc.onThought && acc.onThought(p.text); }
    else { acc.text += p.text; acc.onText && acc.onText(p.text); }
  }
}

// Llamadas nativas + la respuesta cruda a devolver en la ronda siguiente.
function finalizeCalls(acc) {
  if (!acc.calls.length) return {};
  const toolCalls = acc.calls.map((p, i) => ({ id: p.functionCall.id || `g${i}`, apiId: p.functionCall.id || null, name: p.functionCall.name, args: p.functionCall.args || {} }));
  const payload = [...(acc.text ? [{ text: acc.text }] : []), ...acc.calls];
  return { toolCalls, native: { provider: "gemini", payload } };
}

function finalizeUsage(acc) {
  const u = acc.usageMeta || {};
  return {
    promptTokens: u.promptTokenCount || 0,
    cachedTokens: u.cachedContentTokenCount || 0,
    outputTokens: u.candidatesTokenCount || 0,
    thoughtTokens: u.thoughtsTokenCount || 0,
  };
}

// Modo streaming (SSE): texto y pensamientos van llegando en vivo via
// onText/onThought.
async function streamOnce({ apiKey, model, contents, effort, signal, onText, onThought, systemPrompt, toolDefs, toolChoiceNone }) {
  const started = Date.now();
  const acc = { text: "", thoughts: "", finishReason: null, usageMeta: {}, blockReason: null, firstTokenMs: null, started, onText, onThought, calls: [] };
  return new Promise((resolve, reject) => {
    const body = requestBody(contents, effort, systemPrompt, toolDefs, toolChoiceNone);
    const req = https.request(
      {
        hostname: "generativelanguage.googleapis.com",
        path: `/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`,
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey, "Content-Length": Buffer.byteLength(body) },
        // OJO: no se pasa `signal` aca a proposito -- ver detachAbort().
      },
      (res) => {
        // NUNCA res.setEncoding(): ver "CAUSA RAIZ" arriba.
        if (res.statusCode !== 200) {
          const chunks = [];
          res.on("data", (c) => chunks.push(toBuf(c)));
          res.on("end", () => {
            try { reject(errorFromBody(res.statusCode, Buffer.concat(chunks).toString("utf8"))); } catch (e) { reject(e); }
          });
          res.on("error", reject);
          return;
        }
        let buf = "";
        const decoder = new StringDecoder("utf8"); // une caracteres multibyte (tildes, emojis) partidos entre chunks
        const handleEvent = (json) => {
          let data;
          try { data = JSON.parse(json); } catch (_) { return; }
          // Gemini a veces manda lineas "keep-alive" (ej. "data: null") para
          // mantener viva la conexion mientras piensa -- no son un evento
          // real, solo se ignoran.
          collectFromCandidate(data, acc);
        };
        // Cualquier excepcion aca adentro, si no se atrapa, puede escaparse
        // como una excepcion SINCRONA en medio del parser HTTP de Node --
        // try/catch + reject() en vez de dejarla escapar sin control.
        res.on("data", (chunk) => {
          try {
            buf += decoder.write(toBuf(chunk)).replace(/\r\n/g, "\n");
            let idx;
            while ((idx = buf.indexOf("\n\n")) !== -1) {
              const evt = buf.slice(0, idx);
              buf = buf.slice(idx + 2);
              const dataLines = evt.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim());
              if (dataLines.length) handleEvent(dataLines.join("\n"));
            }
          } catch (e) {
            reject(e);
          }
        });
        res.on("end", () => {
          try {
            buf += decoder.end();
            if (buf.trim().startsWith("data:")) handleEvent(buf.trim().slice(5).trim());
            if (acc.blockReason) return reject(new Error(`Gemini bloqueo la respuesta: ${acc.blockReason}`));
            resolve({
              text: acc.text, thoughts: acc.thoughts, finishReason: acc.finishReason,
              latencyMs: Date.now() - started, firstTokenMs: acc.firstTokenMs, usage: finalizeUsage(acc), ...finalizeCalls(acc),
            });
          } catch (e) {
            reject(e);
          }
        });
        res.on("error", reject);
      }
    );
    req.on("error", (err) => {
      if (err && (err.name === "AbortError" || err.code === "ABORT_ERR")) reject(new Error("Cancelado por el usuario."));
      else reject(err);
    });
    detachAbort(req, signal, reject);
    req.write(body);
    req.end();
  });
}

// Modo de respaldo SIN streaming: una sola respuesta JSON completa (con
// Content-Length, sin chunked encoding). Se usa automaticamente cuando el
// streaming falla por un problema de transporte (ver isTransportGlitch).
// No hay texto incremental real, pero se llama onText/onThought una vez con
// el resultado completo para que la UI igual se vea consistente.
async function nonStreamOnce({ apiKey, model, contents, effort, signal, onText, onThought, systemPrompt, toolDefs, toolChoiceNone }) {
  const started = Date.now();
  const { statusCode, raw } = await rawRequest({ apiKey, model, contents, effort, signal, sse: false, systemPrompt, toolDefs, toolChoiceNone });
  if (statusCode !== 200) throw errorFromBody(statusCode, raw);
  let data;
  try { data = JSON.parse(raw); } catch (e) {
    throw new Error(`Respuesta no-JSON de Gemini (modo sin streaming): ${raw.slice(0, 300)}`);
  }
  const acc = { text: "", thoughts: "", finishReason: null, usageMeta: {}, blockReason: null, firstTokenMs: null, started, onText: null, onThought: null, calls: [] };
  collectFromCandidate(data, acc);
  if (acc.blockReason) throw new Error(`Gemini bloqueo la respuesta: ${acc.blockReason}`);
  if (acc.thoughts && onThought) onThought(acc.thoughts);
  if (acc.text && onText) onText(acc.text);
  return {
    text: acc.text, thoughts: acc.thoughts, finishReason: acc.finishReason,
    latencyMs: Date.now() - started, firstTokenMs: acc.firstTokenMs, usage: finalizeUsage(acc), ...finalizeCalls(acc),
  };
}

// Llamada a Gemini. Por defecto usa el modo SIN streaming: en algunas redes
// (antivirus con inspeccion HTTPS, proxy corporativo, VPN) el streaming
// (SSE / "chunked transfer-encoding") llega corrupto y hace que el parser
// HTTP de Node explote con una excepcion que ni siquiera puede atraparse
// como rechazo de promesa (pasa por completo por fuera de try/catch y de
// los eventos 'error') -- no hay forma de "reintentar despues" porque para
// cuando eso pasa ya no hay ninguna promesa pendiente a la que engancharse.
// Por eso, en vez de un fallback reactivo, el modo normal (una sola
// respuesta JSON completa, con Content-Length) es la ruta principal:
// funciona igual de bien, solo sin texto letra-por-letra en vivo. Si en tu
// red el streaming SI es estable, se puede activar con la opcion
// sovnodeAider.streaming en Settings; y si aun asi llegara a fallar (el
// streaming es de por si menos confiable en redes con proxys/antivirus
// intrusivos), se reintenta automaticamente en modo normal.
async function streamGemini(opts) {
  if (!opts.streaming) return nonStreamOnce(opts);
  try {
    return await streamOnce(opts);
  } catch (err) {
    if (!isTransportGlitch(err)) throw err;
    opts.onReset && opts.onReset(); // borra el texto parcial para no mostrarlo duplicado
    const r = await nonStreamOnce(opts);
    r.usedFallback = true;
    r.fallbackReason = String((err && err.message) || err);
    return r;
  }
}

// Prueba de conexion para /diag: pide la lista de modelos (GET, sin costo de
// tokens) y reporta estado HTTP, latencia, y si el modelo configurado existe.
function pingGemini({ apiKey, model, timeoutMs = 15000 }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const req = https.request(
      { hostname: "generativelanguage.googleapis.com", path: "/v1beta/models?pageSize=1000", method: "GET", headers: { "x-goog-api-key": apiKey } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(toBuf(c)));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let models = [];
          let apiError = null;
          try {
            const d = JSON.parse(raw);
            models = (d.models || []).map((m) => String(m.name || "").replace(/^models\//, ""));
            if (d.error) apiError = d.error.message;
          } catch (_) { apiError = raw.slice(0, 200); }
          resolve({ ok: res.statusCode === 200, status: res.statusCode, ms: Date.now() - started, modelExists: models.includes(model), modelCount: models.length, sampleModels: models.filter((m) => /gemini/.test(m)).slice(0, 12), apiError });
        });
        res.on("error", (e) => resolve({ ok: false, status: null, ms: Date.now() - started, networkError: e.message }));
      }
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`sin respuesta en ${timeoutMs / 1000}s`)));
    req.on("error", (e) => resolve({ ok: false, status: null, ms: Date.now() - started, networkError: `${e.code || ""} ${e.message}`.trim() }));
    req.end();
  });
}

module.exports = { requestBody, collectFromCandidate, finalizeCalls, REPO_MAP_ACK, PROJECT_MEMORY_ACK, pingGemini, streamGemini, buildContents, isTransportGlitch, SYSTEM_PROMPT, systemPromptFor, ARCHITECT_PROMPT, EDITOR_NOTE, taskPlanPrompt, TASK_STEP_NOTE, THINKING_BUDGET_BY_EFFORT, OUTPUT_CEILING_BY_EFFORT };
