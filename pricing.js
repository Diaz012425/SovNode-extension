"use strict";

// Precios USD por millon de tokens (input, output). Misma tabla que
// GEMINI_PRICING_USD_PER_MTOK en app_en.py, para que el costo que muestra
// la extension y el de SovNode-Web salgan de los mismos numeros.
// Los precios de Google cambian: se pueden sobrescribir en Settings con
// "sovnodeAider.pricing" sin tocar codigo.
// Fuente: ai.google.dev/gemini-api/docs/pricing (consultado sept 2026, tier
// pagado estandar). Los 3.6/3.7/3.8-flash tienen precio promocional hasta el
// 31-dic-2026 (se duplica el 1-ene-2027). 2.5 ya no aparece en esa pagina:
// se dejan sus ultimos precios publicados.
const DEFAULT_PRICING = {
  "gemini-3.8-flash": { input: 0.75, output: 3.75 },
  "gemini-3.7-flash": { input: 0.75, output: 3.75 },
  "gemini-3.6-flash": { input: 0.75, output: 3.75 },
  "gemini-3.5-flash": { input: 1.5, output: 9.0 },
  "gemini-3.5-flash-lite": { input: 0.3, output: 2.5 },
  "gemini-3.1-flash-lite": { input: 0.25, output: 1.5 },
  "gemini-3.1-pro-preview": { input: 2.0, output: 12.0 }, // prompts <=200k tokens
  "gemini-2.5-pro": { input: 1.25, output: 10.0 }, // prompts <=200k tokens
  // gemini-2.5-flash: Google la dio de baja para cuentas nuevas (HTTP 404
  // "no longer available to new users", visto sept 2026) -- sacada del
  // selector en extension.js. Si algun config viejo la sigue teniendo puesta
  // como modelo, la llamada real va a fallar igual (eso lo controla Google,
  // no este archivo); esta entrada queda solo por si hace falta calcular el
  // costo de un log viejo que ya la uso.
  "gemini-2.5-flash": { input: 0.3, output: 2.5 },
  // OpenAI (v0.11, soporte multi-proveedor). Fuente: developers.openai.com/api/docs/pricing
  // (consultado sept 2026, tier estandar). Estos precios cambian seguido --
  // igual que con Gemini, se pueden sobrescribir en sovnodeAider.pricing.
  "gpt-6-astra": { input: 10.0, output: 50.0 },
  "gpt-6-sol": { input: 2.0, output: 10.0 },
  "gpt-6-luna": { input: 0.1, output: 0.5 },
  // Anthropic (v0.11). Fuente: platform.claude.com/docs/.../pricing (consultado
  // sept 2026, tier estandar, sin descuentos de batch/cache/data residency).
  "claude-opus-5-5": { input: 4.0, output: 20.0 },
  "claude-sonnet-5": { input: 2.0, output: 10.0 },
  "claude-haiku-4-5-20251001": { input: 1.0, output: 5.0 },
};
const FALLBACK_MODEL = "gemini-3.6-flash";

// Los tokens leidos de cache implicita de Gemini se cobran con descuento.
// Google publica el precio de cache como 10% del input en los modelos 3.x.
// Anthropic tambien cobra sus lecturas de cache al 10% del input (mismo
// factor, coincidencia conveniente). OpenAI en cambio descuenta 50% en
// cached input, no 10% -- por ahora se usa el mismo factor global para los
// 3 proveedores (simplificacion conocida: subestima levemente el ahorro
// real en OpenAI). Sobrescribible con sovnodeAider.pricing si hace falta
// exactitud.
const CACHE_WRITE_FACTOR = 1.25; // Anthropic: escribir en cache (5 min) cuesta 1.25x el input
const DEFAULT_CACHE_FACTOR = 0.1; // cache cuesta 10% del input (ej. 0.075 vs 0.75)

function priceFor(model, overrides) {
  const base = DEFAULT_PRICING[model] || DEFAULT_PRICING[FALLBACK_MODEL];
  const ov = (overrides && overrides[model]) || {};
  // Merge por campo: sobrescribir solo "input" no deja "output" en 0.
  const p = { ...base, ...ov };
  return { input: Number(p.input) || 0, output: Number(p.output) || 0, known: Boolean(DEFAULT_PRICING[model] || (overrides && overrides[model])) };
}

// usage: { promptTokens, cachedTokens, outputTokens, thoughtTokens }
// Gemini cobra los tokens de razonamiento ("thoughts") como OUTPUT aunque
// no se vean -- por eso se desglosan aparte: suelen ser una parte grande
// del costo y ocultarlos daria un numero falso.
function computeCost(model, usage, opts = {}) {
  const price = priceFor(model, opts.overrides);
  const cacheFactor = opts.cacheFactor == null ? DEFAULT_CACHE_FACTOR : opts.cacheFactor;
  const prompt = usage.promptTokens || 0;
  const cached = Math.min(usage.cachedTokens || 0, prompt);
  // Escritura en cache (solo Anthropic, con cache_control): se cobra 1.25x el
  // input normal. Es parte del prompt total, asi que sale de "fresh".
  const written = Math.min(usage.cacheWriteTokens || 0, prompt - cached);
  const fresh = prompt - cached - written;
  const out = usage.outputTokens || 0;
  const thoughts = usage.thoughtTokens || 0;
  const inputUsd = (fresh * price.input + written * price.input * CACHE_WRITE_FACTOR) / 1e6;
  const cachedUsd = (cached * price.input * cacheFactor) / 1e6;
  const outputUsd = (out * price.output) / 1e6;
  const thoughtUsd = (thoughts * price.output) / 1e6;
  const noCacheUsd = (prompt * price.input) / 1e6 + outputUsd + thoughtUsd;
  const totalUsd = inputUsd + cachedUsd + outputUsd + thoughtUsd;
  return {
    priceInput: price.input,
    priceOutput: price.output,
    priceKnown: price.known,
    inputUsd, cachedUsd, outputUsd, thoughtUsd, totalUsd,
    savedByCacheUsd: noCacheUsd - totalUsd,
  };
}

function addUsage(a, b) {
  return {
    promptTokens: (a.promptTokens || 0) + (b.promptTokens || 0),
    cachedTokens: (a.cachedTokens || 0) + (b.cachedTokens || 0),
    cacheWriteTokens: (a.cacheWriteTokens || 0) + (b.cacheWriteTokens || 0),
    outputTokens: (a.outputTokens || 0) + (b.outputTokens || 0),
    thoughtTokens: (a.thoughtTokens || 0) + (b.thoughtTokens || 0),
  };
}

function addCost(a, b) {
  const out = {};
  for (const k of ["inputUsd", "cachedUsd", "outputUsd", "thoughtUsd", "totalUsd", "savedByCacheUsd"]) out[k] = (a[k] || 0) + (b[k] || 0);
  return out;
}

function fmtUsd(v) {
  if (!v) return "$0";
  if (v < 0.0001) return "<$0.0001";
  if (v < 0.01) return "$" + v.toFixed(5);
  return "$" + v.toFixed(4);
}

module.exports = { DEFAULT_PRICING, computeCost, addUsage, addCost, fmtUsd, priceFor };
