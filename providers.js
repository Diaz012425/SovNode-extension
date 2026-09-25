"use strict";

const https = require("https");
const { StringDecoder } = require("string_decoder");
const { OUTPUT_CEILING_BY_EFFORT } = require("./gemini");

// "Extended thinking" de Anthropic (v0.17): antes NUNCA se activaba, asi que
// Claude respondia "de una" sin una fase previa de razonamiento (a
// diferencia de Gemini/OpenAI, que siempre piensan segun el effort). Se
// activa solo en effort alto/extra: es la diferencia de calidad mas grande
// que un cliente le puede dar al mismo modelo, pero cuesta tokens de mas, asi
// que en low/medium se deja apagado (respuesta directa, mas barata).
// Minimo de la API: 1024. max_tokens tiene que ser mayor al presupuesto
// (incluye los tokens de pensamiento): con el techo de high/extra sobra.
const ANTHROPIC_THINKING_BUDGET = { high: 4096, extra: 10000 };

// v0.29.3: Anthropic empezo a rechazar `thinking.type: "enabled"` en modelos
// nuevos (ej. claude-sonnet-5 tal como lo resolvio el usuario) con HTTP 400:
// "thinking.type.enabled is not supported for this model. Use
// thinking.type.adaptive and output_config.effort...". No sabemos de
// antemano que modelos exigen el formato nuevo (cambia con cada release de
// Anthropic), asi que no hardcodeamos una lista: extension.js detecta ESTE
// error puntual (mismo patron que nativeToolsOff en v0.25) y reintenta la
// MISMA llamada con `adaptiveThinking: true`, recordandolo por modelo para
// el resto de la sesion. Mapeo de effort (no hay "extra" del lado de
// Anthropic todavia): lo mas fuerte que soporta el modelo.
const ANTHROPIC_ADAPTIVE_EFFORT = { high: "high", extra: "high", medium: "medium", low: "low" };

// Soporte multi-proveedor (como Aider): el nombre del modelo decide con que
// proveedor hablar, sin que el usuario tenga que elegir un proveedor aparte
// -- lo mismo que hace LiteLLM/Aider por convencion de prefijo. Gemini sigue
// siendo el default para cualquier nombre que no matchee los otros dos
// (preserva el comportamiento de antes de esta version para todo el mundo
// que no toco `sovnodeAider.model`).
function providerForModel(model) {
  const m = String(model || "");
  if (/^(gpt-|o[0-9]|chatgpt-)/i.test(m)) return "openai";
  if (/^claude-/i.test(m)) return "anthropic";
  return "gemini";
}

// Mismo Buffer-siempre, nunca res.setEncoding() que gemini.js -- ver el
// comentario "CAUSA RAIZ" de ese archivo: el crash historico ("Parse Error:
// JS Exception") viene de la instrumentacion de red del inspector de Node
// bajo el depurador de VS Code (F5), no es especifico de la API de Gemini.
// Cualquier llamada HTTPS nueva en esta extension debe evitar setEncoding
// por la misma razon.
const toBuf = (c) => (Buffer.isBuffer(c) ? c : Buffer.from(String(c), "utf8"));

function detachAbort(req, signal, reject) {
  if (!signal) return;
  const onAbort = () => {
    reject(new Error("Cancelado por el usuario."));
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

function httpsJson({ hostname, path: p, method, headers, body, signal, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path: p, method, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(toBuf(c)));
      res.on("end", () => {
        try { resolve({ statusCode: res.statusCode, raw: Buffer.concat(chunks).toString("utf8") }); } catch (e) { reject(e); }
      });
      res.on("error", reject);
    });
    req.on("error", (err) => {
      if (err && (err.name === "AbortError" || err.code === "ABORT_ERR")) reject(new Error("Cancelado por el usuario."));
      else reject(err);
    });
    if (timeoutMs) req.setTimeout(timeoutMs, () => req.destroy(new Error(`sin respuesta en ${timeoutMs / 1000}s`)));
    detachAbort(req, signal, reject);
    if (body != null) req.write(body);
    req.end();
  });
}

// Convierte el mismo formato de `contents` que usa buildContents() de
// gemini.js (role "user"/"model", parts:[{text}]) a mensajes de texto plano
// -- lo reusan tanto OpenAI como Anthropic, cada uno con su propio wrapper.
function flattenContents(contents) {
  return (contents || []).map((turn) => ({
    role: turn.role === "model" ? "assistant" : "user",
    text: (turn.parts || []).map((p) => p.text || "").join("\n"),
    native: turn.native || null,
    toolResults: turn.toolResults || null,
  }));
}

// ------------------------------------------------------------- Anthropic
// Messages API: https://docs.anthropic.com/.../messages -- estable hace
// años, misma forma para todos los modelos claude-*. NOTA (limitacion
// conocida de esta primera version del soporte multi-proveedor): no se
// activa "extended thinking" todavia, asi que `thoughts` siempre viene
// vacio para Claude (a diferencia de Gemini). El "effort" solo controla el
// techo de tokens de salida (mismo mapeo que Gemini, OUTPUT_CEILING_BY_EFFORT).
const ANTHROPIC_VERSION = "2023-06-01";

// Anthropic NO cachea nada solo (a diferencia de Gemini/OpenAI, que hacen
// caching implicito automatico): hay que marcar explicitamente que bloque
// cachear con "cache_control". Sin esto, cache_read_input_tokens siempre
// viene en 0 aunque el system prompt y el historial sean identicos turno a
// turno -- que es justo lo que se veia antes de este cambio.
//
// Marcamos DOS anclas, cada una "cachea todo el prefijo hasta aca":
//   1) el system prompt: identico siempre que no cambies de formato de
//      edicion, asi que se cachea turno a turno para toda la sesion.
//   2) el ultimo turno de HISTORIAL (no el actual): el turno actual siempre
//      trae el archivo/pedido nuevo, nunca va a calzar con una cache vieja,
//      pero todo lo anterior a el (system + turnos previos) si, y ademas
//      esta misma request pasa a ser "historial" en la proxima llamada, con
//      lo cual la marca de esta vez habilita el cache hit de la que viene.
function anthropicBody({ contents, effort, systemPrompt, model, stream, thinkingEnabled, adaptiveThinking, toolDefs, toolChoiceNone }) {
  const maxTokens = OUTPUT_CEILING_BY_EFFORT[effort] || OUTPUT_CEILING_BY_EFFORT.medium;
  const budget = ANTHROPIC_THINKING_BUDGET[effort];
  // Con "thinking" activo, la API exige temperature/top_p SIN mandar (unico
  // valor permitido es el default) -- ya no los mandamos, asi que no hay que
  // tocar nada mas aca.
  // Dos formatos segun el modelo (ver ANTHROPIC_ADAPTIVE_EFFORT arriba): el
  // viejo manda un presupuesto de tokens fijo, el nuevo deja que el propio
  // modelo decida cuanto pensar segun un nivel de "effort".
  const thinking = thinkingEnabled && budget ? (adaptiveThinking ? { type: "adaptive" } : { type: "enabled", budget_tokens: budget }) : null;
  const outputConfig = thinking && adaptiveThinking ? { effort: ANTHROPIC_ADAPTIVE_EFFORT[effort] || "medium" } : null;
  const flat = flattenContents(contents);
  const lastHistoryIdx = flat.length - 2; // el ultimo (length-1) es el turno nuevo, nunca se cachea
  // Base del arquitecto (archBase.js): su propio punto de cache, asi sigue
  // cacheada aunque el historial crezca o se recorte.
  // v0.21: lo mismo para el mapa del repo cacheado. Anthropic acepta hasta 4
  // anclas: system + base + mapa + ultimo historial = 4 justas.
  const ackIdx = new Set();
  flat.forEach((t, i) => {
    if (i < flat.length - 1 && t.role === "assistant" && /^Recibido: tengo (la version base|el mapa del repositorio)/.test(t.text)) ackIdx.add(i);
  });
  // Rondas de herramientas nativas (v0.25): el turno del modelo va CRUDO
  // (tool_use + thinking con su firma: Anthropic exige devolverlos tal cual)
  // y el de resultados como bloques tool_result.
  const blocksOf = (t) => {
    if (t.native && t.native.provider === "anthropic" && Array.isArray(t.native.payload)) return t.native.payload.map((b) => ({ ...b }));
    if (t.toolResults) return t.toolResults.map((x) => ({ type: "tool_result", tool_use_id: x.id, content: x.result }));
    return null;
  };
  const messages = flat.map((t, i) => {
    const blocks = blocksOf(t);
    const anchor = i === lastHistoryIdx || ackIdx.has(i);
    if (blocks) {
      const last = blocks[blocks.length - 1];
      if (anchor && last && ["text", "tool_use", "tool_result"].includes(last.type)) blocks[blocks.length - 1] = { ...last, cache_control: { type: "ephemeral" } };
      return { role: t.role, content: blocks };
    }
    if (anchor) {
      return { role: t.role, content: [{ type: "text", text: t.text, cache_control: { type: "ephemeral" } }] };
    }
    return { role: t.role, content: t.text };
  });
  const tools = toolDefs && toolDefs.length ? toolDefs.map((d) => ({ name: d.name, description: d.description, input_schema: d.parameters })) : undefined;
  return JSON.stringify({
    model,
    max_tokens: maxTokens,
    system: systemPrompt ? [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }] : undefined,
    messages,
    tools,
    tool_choice: tools && toolChoiceNone ? { type: "none" } : undefined,
    stream: Boolean(stream),
    thinking: thinking || undefined,
    output_config: outputConfig || undefined,
  });
}

// Bloques de contenido de Anthropic -> llamadas nativas + respuesta cruda.
function anthropicCalls(blocks) {
  const uses = (blocks || []).filter((b) => b.type === "tool_use");
  if (!uses.length) return {};
  return {
    toolCalls: uses.map((b) => ({ id: b.id, apiId: b.id, name: b.name, args: b.input || {} })),
    native: { provider: "anthropic", payload: blocks },
  };
}

function anthropicErrorFromBody(statusCode, raw) {
  let msg = raw.slice(0, 400);
  try {
    const d = JSON.parse(raw);
    msg = (d.error && d.error.message) || msg;
  } catch (_) { /* no era JSON */ }
  return new Error(`Anthropic devolvio HTTP ${statusCode}: ${msg}`);
}

// "max_tokens" de Anthropic -> "MAX_TOKENS" (valor de Gemini, el que mira
// extension.js para avisar que la respuesta se corto por el limite).
const normStop = (r) => (r === "max_tokens" ? "MAX_TOKENS" : r || null);

// OJO: en Anthropic `input_tokens` NO incluye los tokens leidos de cache ni
// los escritos en cache (en Gemini/OpenAI el total de prompt SI los incluye).
// Antes se tomaba input_tokens como total y computeCost hacia
// min(cache_read, prompt): con 50 de input y 10.000 leidos de cache se
// cobraban 50 tokens "de cache" y 9.950 desaparecian del costo. Ahora el
// total de prompt se arma sumando las tres partes, igual que los otros dos
// proveedores, y la escritura en cache (que Anthropic cobra 1.25x) va aparte.
function anthropicUsage(u) {
  u = u || {};
  const read = u.cache_read_input_tokens || 0;
  const write = u.cache_creation_input_tokens || 0;
  return {
    promptTokens: (u.input_tokens || 0) + read + write,
    cachedTokens: read,
    cacheWriteTokens: write,
    outputTokens: u.output_tokens || 0,
    thoughtTokens: 0, // ver nota de "extended thinking" arriba
  };
}

async function anthropicNonStream({ apiKey, model, contents, effort, signal, onText, onThought, systemPrompt, thinkingEnabled, adaptiveThinking, toolDefs, toolChoiceNone }) {
  const started = Date.now();
  const body = anthropicBody({ contents, effort, systemPrompt, model, stream: false, thinkingEnabled, adaptiveThinking, toolDefs, toolChoiceNone });
  const { statusCode, raw } = await httpsJson({
    hostname: "api.anthropic.com", path: "/v1/messages", method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION, "content-length": Buffer.byteLength(body) },
    body, signal,
  });
  if (statusCode !== 200) throw anthropicErrorFromBody(statusCode, raw);
  let data;
  try { data = JSON.parse(raw); } catch (e) { throw new Error(`Respuesta no-JSON de Anthropic: ${raw.slice(0, 300)}`); }
  const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  const thoughts = (data.content || []).filter((b) => b.type === "thinking").map((b) => b.thinking || "").join("");
  if (thoughts && onThought) onThought(thoughts);
  if (text && onText) onText(text);
  return {
    text, thoughts, finishReason: normStop(data.stop_reason),
    latencyMs: Date.now() - started, firstTokenMs: null, usage: anthropicUsage(data.usage), ...anthropicCalls(data.content),
  };
}

async function anthropicStream({ apiKey, model, contents, effort, signal, onText, onThought, systemPrompt, thinkingEnabled, adaptiveThinking, toolDefs, toolChoiceNone }) {
  const started = Date.now();
  const body = anthropicBody({ contents, effort, systemPrompt, model, stream: true, thinkingEnabled, adaptiveThinking, toolDefs, toolChoiceNone });
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "api.anthropic.com", path: "/v1/messages", method: "POST",
        headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION, "content-length": Buffer.byteLength(body) },
      },
      (res) => {
        if (res.statusCode !== 200) {
          const chunks = [];
          res.on("data", (c) => chunks.push(toBuf(c)));
          res.on("end", () => { try { reject(anthropicErrorFromBody(res.statusCode, Buffer.concat(chunks).toString("utf8"))); } catch (e) { reject(e); } });
          res.on("error", reject);
          return;
        }
        let text = "";
        let thoughts = "";
        let firstTokenMs = null;
        let usage = {};
        let stopReason = null;
        let streamError = null;
        let sawStop = false;
        const blocks = []; // bloques completos, reconstruidos del stream (para devolverlos crudos)
        let buf = "";
        const decoder = new StringDecoder("utf8");
        const handleEvent = (dataLine) => {
          let data;
          try { data = JSON.parse(dataLine); } catch (_) { return; }
          if (data.type === "error") {
            // Error A MITAD del stream (ej. overloaded_error): antes se
            // ignoraba y el turno terminaba "bien" con una respuesta cortada
            // -- y el motor de edicion podia aplicar bloques a medio escribir.
            streamError = new Error(`Anthropic corto la respuesta: ${(data.error && data.error.message) || "error desconocido"}`);
          } else if (data.type === "message_stop") {
            sawStop = true;
          } else if (data.type === "content_block_start" && data.content_block) {
            blocks[data.index] = { ...data.content_block };
            if (blocks[data.index].type === "tool_use") { blocks[data.index]._json = ""; }
          } else if (data.type === "content_block_stop") {
            const b = blocks[data.index];
            if (b && b.type === "tool_use") {
              try { b.input = b._json ? JSON.parse(b._json) : b.input || {}; } catch (_) { b.input = {}; }
              delete b._json;
            }
          } else if (data.type === "content_block_delta" && data.delta && data.delta.type === "input_json_delta") {
            const b = blocks[data.index];
            if (b) b._json = (b._json || "") + (data.delta.partial_json || "");
          } else if (data.type === "content_block_delta" && data.delta && data.delta.type === "signature_delta") {
            const b = blocks[data.index];
            if (b) b.signature = (b.signature || "") + (data.delta.signature || "");
          } else if (data.type === "content_block_delta" && data.delta && data.delta.type === "text_delta") {
            if (firstTokenMs === null) firstTokenMs = Date.now() - started;
            if (blocks[data.index]) blocks[data.index].text = (blocks[data.index].text || "") + data.delta.text;
            text += data.delta.text;
            onText && onText(data.delta.text);
          } else if (data.type === "content_block_delta" && data.delta && data.delta.type === "thinking_delta") {
            if (firstTokenMs === null) firstTokenMs = Date.now() - started;
            thoughts += data.delta.thinking || "";
            if (blocks[data.index]) blocks[data.index].thinking = (blocks[data.index].thinking || "") + (data.delta.thinking || "");
            onThought && onThought(data.delta.thinking || "");
          } else if (data.type === "message_start" && data.message && data.message.usage) {
            usage = { ...usage, ...data.message.usage };
          } else if (data.type === "message_delta") {
            if (data.usage) usage = { ...usage, ...data.usage };
            if (data.delta && data.delta.stop_reason) stopReason = data.delta.stop_reason;
          }
        };
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
          } catch (e) { reject(e); }
        });
        res.on("end", () => {
          try {
            buf += decoder.end();
            if (streamError) return reject(streamError);
            // Sin message_stop la conexion se corto a la mitad: se trata como
            // falla de transporte (el mensaje matchea isTransportGlitch) para
            // que streamAnthropic reintente sin streaming, en vez de devolver
            // un texto truncado como si estuviera completo.
            if (!sawStop) return reject(new Error("socket hang up: el stream de Anthropic termino sin message_stop"));
            resolve({ text, thoughts, finishReason: normStop(stopReason), latencyMs: Date.now() - started, firstTokenMs, usage: anthropicUsage(usage), ...anthropicCalls(blocks.filter(Boolean)) });
          } catch (e) { reject(e); }
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

// Mismo criterio que streamGemini: streaming por default, con fallback
// automatico a la llamada sin streaming si el transporte falla (proxy,
// antivirus, VPN que rompe SSE) -- ver isTransportGlitch en gemini.js,
// reusado aca porque el problema no es especifico de Gemini.
async function streamAnthropic(opts) {
  const { isTransportGlitch } = require("./gemini");
  if (!opts.streaming) return anthropicNonStream(opts);
  try {
    return await anthropicStream(opts);
  } catch (err) {
    if (!isTransportGlitch(err)) throw err;
    opts.onReset && opts.onReset();
    const r = await anthropicNonStream(opts);
    r.usedFallback = true;
    r.fallbackReason = String((err && err.message) || err);
    return r;
  }
}

function pingAnthropic({ apiKey, model, timeoutMs = 15000 }) {
  const started = Date.now();
  return httpsJson({
    hostname: "api.anthropic.com", path: "/v1/models?limit=1000", method: "GET",
    headers: { "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION }, timeoutMs,
  }).then(({ statusCode, raw }) => {
    let models = [];
    let apiError = null;
    try {
      const d = JSON.parse(raw);
      models = (d.data || []).map((m) => m.id);
      if (d.error) apiError = d.error.message;
    } catch (_) { apiError = raw.slice(0, 200); }
    return { ok: statusCode === 200, status: statusCode, ms: Date.now() - started, modelExists: models.includes(model), modelCount: models.length, sampleModels: models.slice(0, 12), apiError };
  }).catch((e) => ({ ok: false, status: null, ms: Date.now() - started, networkError: e.message }));
}

// ------------------------------------------------------------- OpenAI
// Responses API (no Chat Completions -- es la que documenta OpenAI para los
// modelos actuales, ver /v1/responses). Solo modo SIN streaming por ahora:
// a diferencia de Anthropic (cuya forma de streaming es estable hace años y
// bien conocida), la forma exacta de los eventos SSE de la Responses API es
// mas nueva; en vez de arriesgar un parseo fragil, esta primera version
// llama siempre a la variante sin streaming y dispara onText una sola vez
// con el resultado completo (mismo patron que nonStreamOnce en gemini.js) --
// funciona igual, solo sin texto letra-por-letra en vivo. Streaming real
// queda como mejora futura una vez que se pueda validar contra trafico real.
function openaiReasoningEffort(effort) {
  // "extra" (el mas alto de SovNode) mapea a "xhigh" de OpenAI -- no hay
  // "extra" en su enum, pero "xhigh" es justamente el escalon arriba de "high".
  return { low: "low", medium: "medium", high: "high", extra: "xhigh" }[effort] || "medium";
}

function openaiBody({ contents, effort, systemPrompt, model, toolDefs, toolChoiceNone }) {
  const maxTokens = OUTPUT_CEILING_BY_EFFORT[effort] || OUTPUT_CEILING_BY_EFFORT.medium;
  const input = [];
  for (const t of flattenContents(contents)) {
    // v0.25: la respuesta cruda (razonamiento + function_call) se devuelve tal
    // cual -- es el patron documentado de la Responses API sin estado.
    if (t.native && t.native.provider === "openai" && Array.isArray(t.native.payload)) { input.push(...t.native.payload); continue; }
    if (t.toolResults) { for (const x of t.toolResults) input.push({ type: "function_call_output", call_id: x.id, output: x.result }); continue; }
    input.push({ role: t.role, content: [{ type: t.role === "assistant" ? "output_text" : "input_text", text: t.text }] });
  }
  const tools = toolDefs && toolDefs.length ? toolDefs.map((d) => ({ type: "function", name: d.name, description: d.description, parameters: d.parameters })) : undefined;
  return JSON.stringify({
    model,
    instructions: systemPrompt || undefined,
    input,
    tools,
    tool_choice: tools && toolChoiceNone ? "none" : undefined,
    max_output_tokens: maxTokens,
    reasoning: { effort: openaiReasoningEffort(effort) },
  });
}

function openaiCalls(output) {
  const fc = (output || []).filter((it) => it.type === "function_call");
  if (!fc.length) return {};
  return {
    toolCalls: fc.map((it) => {
      let args = {};
      try { args = it.arguments ? JSON.parse(it.arguments) : {}; } catch (_) { args = {}; }
      return { id: it.call_id, apiId: it.call_id, name: it.name, args };
    }),
    // Sin los items de razonamiento: devolverlos exige que OpenAI los tenga
    // guardados (store), y con cuentas "zero data retention" eso da 400. Sin
    // ellos la llamada funciona siempre; solo se pierde el razonamiento previo.
    native: { provider: "openai", payload: output.filter((it) => it.type !== "reasoning") },
  };
}

function openaiErrorFromBody(statusCode, raw) {
  let msg = raw.slice(0, 400);
  try {
    const d = JSON.parse(raw);
    msg = (d.error && d.error.message) || msg;
  } catch (_) { /* no era JSON */ }
  return new Error(`OpenAI devolvio HTTP ${statusCode}: ${msg}`);
}

// Junta el texto de todos los items `{type:"message", content:[{type:"output_text"}]}`
// del array `output` -- defensivo ante items de otro tipo (razonamiento,
// llamadas a herramientas) que puedan venir intercalados.
function extractOpenaiText(data) {
  let text = "";
  for (const item of data.output || []) {
    if (item.type !== "message") continue;
    for (const c of item.content || []) if (c.type === "output_text" && c.text) text += c.text;
  }
  // Fallback defensivo: algunos SDKs exponen `output_text` ya concatenado.
  if (!text && typeof data.output_text === "string") text = data.output_text;
  return text;
}

// En OpenAI `output_tokens` YA incluye los de razonamiento (en Gemini
// vienen separados). computeCost cobra output + thoughts, asi que sin restar
// el razonamiento se cobraba dos veces.
function openaiUsage(u) {
  u = u || {};
  const reasoning = (u.output_tokens_details && u.output_tokens_details.reasoning_tokens) || 0;
  return {
    promptTokens: u.input_tokens || 0,
    cachedTokens: (u.input_tokens_details && u.input_tokens_details.cached_tokens) || 0,
    outputTokens: Math.max(0, (u.output_tokens || 0) - reasoning),
    thoughtTokens: reasoning,
  };
}

async function streamOpenAI({ apiKey, model, contents, effort, signal, onText, onThought, systemPrompt, toolDefs, toolChoiceNone }) {
  const started = Date.now();
  const body = openaiBody({ contents, effort, systemPrompt, model, toolDefs, toolChoiceNone });
  const { statusCode, raw } = await httpsJson({
    hostname: "api.openai.com", path: "/v1/responses", method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}`, "content-length": Buffer.byteLength(body) },
    body, signal,
  });
  if (statusCode !== 200) throw openaiErrorFromBody(statusCode, raw);
  let data;
  try { data = JSON.parse(raw); } catch (e) { throw new Error(`Respuesta no-JSON de OpenAI: ${raw.slice(0, 300)}`); }
  const text = extractOpenaiText(data);
  if (text && onText) onText(text);
  return {
    // "incomplete" por max_output_tokens se normaliza a MAX_TOKENS (el valor
    // de Gemini) para que el aviso de "respuesta cortada" funcione igual.
    text, thoughts: "", finishReason: data.status === "incomplete" && data.incomplete_details && data.incomplete_details.reason === "max_output_tokens" ? "MAX_TOKENS" : data.status || null,
    latencyMs: Date.now() - started, firstTokenMs: null, usage: openaiUsage(data.usage), ...openaiCalls(data.output),
  };
}

function pingOpenAI({ apiKey, model, timeoutMs = 15000 }) {
  const started = Date.now();
  return httpsJson({
    hostname: "api.openai.com", path: "/v1/models", method: "GET",
    headers: { authorization: `Bearer ${apiKey}` }, timeoutMs,
  }).then(({ statusCode, raw }) => {
    let models = [];
    let apiError = null;
    try {
      const d = JSON.parse(raw);
      models = (d.data || []).map((m) => m.id);
      if (d.error) apiError = d.error.message;
    } catch (_) { apiError = raw.slice(0, 200); }
    return { ok: statusCode === 200, status: statusCode, ms: Date.now() - started, modelExists: models.includes(model), modelCount: models.length, sampleModels: models.slice(0, 12), apiError };
  }).catch((e) => ({ ok: false, status: null, ms: Date.now() - started, networkError: e.message }));
}

// ------------------------------------------------------------- dispatcher
// Punto de entrada unico para extension.js: elige el proveedor por el
// nombre del modelo y devuelve siempre la misma forma que streamGemini()
// (text, thoughts, finishReason, latencyMs, firstTokenMs, usage). Gemini
// sigue yendo por gemini.js directo (sin pasar por aca) para no tocar el
// camino ya probado -- ver callModel() en extension.js.
async function callProvider(provider, opts) {
  if (provider === "openai") return streamOpenAI(opts);
  if (provider === "anthropic") return streamAnthropic(opts);
  throw new Error(`Proveedor desconocido: ${provider}`);
}

async function pingProvider(provider, opts) {
  if (provider === "openai") return pingOpenAI(opts);
  if (provider === "anthropic") return pingAnthropic(opts);
  throw new Error(`Proveedor desconocido: ${provider}`);
}

const PROVIDER_LABEL = { gemini: "Gemini", openai: "OpenAI", anthropic: "Anthropic" };

module.exports = { providerForModel, callProvider, pingProvider, PROVIDER_LABEL, anthropicBody, openaiBody, anthropicCalls, openaiCalls, ANTHROPIC_ADAPTIVE_EFFORT, _test: { anthropicUsage, openaiUsage, normStop } };
