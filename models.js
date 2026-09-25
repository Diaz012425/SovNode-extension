"use strict";

// Modelos y proveedores: API keys por proveedor, modo Auto, el punto de
// entrada unico a cualquier LLM (callLLM), la lista de modelos del selector y
// el estado de config que se le manda al webview.
const { streamGemini } = require("./gemini");
const { providerForModel, callProvider, PROVIDER_LABEL } = require("./providers");
const { priceFor } = require("./pricing");
const router = require("./router");
const i18n = require("./i18n");
const { L } = i18n;
const { state, rt, cfg, post } = require("./state");

// Multi-proveedor (v0.11, como Aider): el nombre del modelo decide el
// proveedor (providerForModel en providers.js), asi que cada uno necesita su
// propia API key -- se guardan por separado en el almacen de secretos de VS
// Code, una entrada por proveedor. LEGACY_GEMINI_KEY es la clave vieja de
// antes de esta version (una sola key, siempre Gemini); se sigue leyendo
// como fallback para no romper a nadie que ya tenia la suya guardada, pero
// las keys nuevas (de cualquier proveedor, Gemini incluido) se guardan bajo
// SECRET_KEY_FOR(provider).
const LEGACY_GEMINI_KEY = "sovnodeAider.geminiApiKey";
const SECRET_KEY_FOR = (provider) => `sovnodeAider.apiKey.${provider}`;
async function apiKeyFor(provider) {
  const k = await rt.extContext.secrets.get(SECRET_KEY_FOR(provider));
  if (k) return k;
  if (provider === "gemini") return rt.extContext.secrets.get(LEGACY_GEMINI_KEY);
  return undefined;
}

// Revisa que TODOS los modelos de la lista (tipicamente [model, editModel])
// tengan API key para su proveedor. Devuelve el nombre del proveedor que
// falta (para el mensaje de error) o null si esta todo bien -- se llama una
// sola vez al arrancar un turno/tarea en vez de fallar a mitad de camino.
async function missingApiKeyFor(models) {
  // "auto" (v0.27): solo falta algo si no hay NINGUNA key (Auto elige entre
  // los modelos con key).
  if (models.includes(AUTO)) {
    if (!(await autoTiers())) return "algun proveedor (Gemini, OpenAI o Anthropic)";
    models = models.filter((m) => m !== AUTO);
  }
  const providers = [...new Set(models.map(providerForModel))];
  for (const p of providers) if (!(await apiKeyFor(p))) return PROVIDER_LABEL[p];
  return null;
}

// ---------------------------------------------------------------- modo Auto (v0.27)
const AUTO = "auto";
const isAuto = () => cfg().get("model") === AUTO;
// Niveles barato/medio/fuerte entre los modelos con API key (ver router.js).
async function autoTiers() {
  const overrides = cfg().get("pricing");
  const has = {};
  for (const p of ["gemini", "openai", "anthropic"]) has[p] = Boolean(await apiKeyFor(p));
  const available = (m) => { try { return has[providerForModel(m)]; } catch (_) { return false; } };
  return router.pickTiers(MODEL_CHOICES.map((model) => ({ model, price: priceFor(model, overrides) })), available, cfg().get("autoModels") || {});
}

// Punto de entrada unico a cualquier modelo, de cualquier proveedor: resuelve
// el proveedor por el nombre del modelo (providerForModel) y su API key, y
// devuelve siempre la misma forma de resultado (text/thoughts/usage/...) sin
// importar si vino de Gemini, OpenAI o Anthropic. Gemini sigue yendo directo
// a gemini.js (streamGemini) -- es el camino original, ya probado a fondo
// por el harness, y no hacia falta pasarlo por el dispatcher generico.
async function callLLM(opts) {
  const provider = providerForModel(opts.model);
  const apiKey = await apiKeyFor(provider);
  if (!apiKey) throw new Error(`Falta la API key de ${PROVIDER_LABEL[provider]}.`);
  // "Extended thinking" de Anthropic (v0.17, ver providers.js): antes nunca
  // se activaba, asi que Claude respondia sin la fase de razonamiento previo
  // que si tienen Gemini/OpenAI segun el effort. Solo en high/extra (cuesta
  // tokens de mas) y solo Anthropic (los otros dos ya piensan por su cuenta).
  const thinkingEnabled = provider === "anthropic" && (opts.effort === "high" || opts.effort === "extra") && cfg().get("extendedThinking") !== false;
  const adaptiveThinking = provider === "anthropic" && state.thinkingAdaptive.has(opts.model);
  const args = { ...opts, apiKey, thinkingEnabled, adaptiveThinking };
  return provider === "gemini" ? streamGemini(args) : callProvider(provider, args);
}

// Aviso de modelo caro (v0.20.2): un turno normal con un modelo de output
// arriba de este precio (Sonnet $10, Opus $20 por M) sale varias veces mas
// caro que con un flash barato (Gemini 3.6 $3.75, GPT-6 Luna $0.50) haciendo
// el mismo trabajo -- el ahorro de contexto/cache ayuda pero no cambia esa
// proporcion. Es solo un aviso (una vez por modelo por sesion de VS Code),
// no bloquea nada: el usuario puede elegir el modelo caro a proposito.
const EXPENSIVE_OUTPUT_PRICE = 8; // USD por millon de tokens de salida
function warnIfExpensive(models, pricingOverrides) {
  for (const m of new Set((models || []).filter(Boolean))) {
    if (state.warnedExpensiveModels.has(m)) continue;
    const price = priceFor(m, pricingOverrides);
    if (!price || price.output < EXPENSIVE_OUTPUT_PRICE) continue;
    state.warnedExpensiveModels.add(m);
    post({
      type: "system",
      text: L(`⚠️ Modelo caro activo: ${m} ($${price.output.toFixed(2)}/M tok de salida). Los turnos con este modelo pueden salir varias veces mas caros que con un modelo flash barato haciendo el mismo trabajo. Este aviso no se repite en lo que queda de esta sesion de VS Code.`, `⚠️ Expensive model active: ${m} ($${price.output.toFixed(2)}/M output tok). Turns with this model can cost several times more than a cheap flash model doing the same work. This warning won't repeat for the rest of this VS Code session.`),
    });
  }
}
// Un grupo de modelos por proveedor -- el selector del webview los muestra
// todos juntos (con <optgroup>, ver renderModelChoices en chat.js), pero
// mezclarlos entre modelo principal y editor del modo arquitecto funciona
// perfecto: cada llamada resuelve su propio proveedor y su propia API key.
// gemini-2.5-flash sacado del selector (v0.20.2): Google la dio de baja para
// cuentas nuevas (HTTP 404 "no longer available to new users", visto en un
// turno real de un usuario). gemini-2.5-pro sigue -- no dio ese error.
const MODEL_CHOICES_GEMINI = ["gemini-3.6-flash", "gemini-3.8-flash", "gemini-3.5-flash", "gemini-3.1-flash-lite", "gemini-3.1-pro-preview", "gemini-2.5-pro"];
const MODEL_CHOICES_OPENAI = ["gpt-6-sol", "gpt-6-astra", "gpt-6-luna"];
const MODEL_CHOICES_ANTHROPIC = ["claude-sonnet-5", "claude-opus-5-5", "claude-haiku-4-5-20251001"];
const MODEL_CHOICES = [...MODEL_CHOICES_GEMINI, ...MODEL_CHOICES_OPENAI, ...MODEL_CHOICES_ANTHROPIC];

// Herramientas nativas (v0.25): por defecto si (nativeTools), salvo que ese
// modelo ya las haya rechazado en esta sesion.
function nativeToolsFor(m) {
  return cfg().get("nativeTools") !== false && !state.nativeToolsOff.has(m);
}

// Lista de modelos para el selector de editor del modo arquitecto, ordenada
// del mas barato al mas caro por precio de OUTPUT (que suele dominar el
// costo real de una respuesta) -- asi el usuario ve de un vistazo cual
// conviene para abaratar el modo arquitecto sin tener que ir a mirar
// pricing.js. Usa los mismos precios (con los overrides del usuario) que
// ya se usan para calcular el costo real de cada turno.
function editorModelChoices() {
  const overrides = cfg().get("pricing");
  return MODEL_CHOICES
    .map((model) => ({ model, price: priceFor(model, overrides) }))
    .sort((a, b) => a.price.output - b.price.output);
}

// Modelos realmente en uso ahora mismo (principal, y editor si el modo
// arquitecto esta activo) y si falta alguna API key para ellos -- lo
// comparten postConfig() y el caso "ready", asi el boton 🔑 se pone en
// rojo (y el aviso dice de que proveedor) sin importar si el modelo activo
// es de Gemini, OpenAI o Anthropic.
async function keyStatus() {
  const model = cfg().get("model");
  const architect = Boolean(cfg().get("architect"));
  const editModel = architect ? ((cfg().get("editorModel") || "").trim() || model) : model;
  const missingProvider = await missingApiKeyFor([model, editModel]);
  return { hasKey: !missingProvider, missingProvider };
}

async function postConfig() {
  const { hasKey, missingProvider } = await keyStatus();
  post({
    type: "config",
    lang: i18n.lang(),
    model: cfg().get("model"),
    effort: cfg().get("effort"),
    architect: Boolean(cfg().get("architect")),
    agentMode: Boolean(cfg().get("agentMode")),
    editorModel: (cfg().get("editorModel") || "").trim(),
    editorChoices: editorModelChoices(),
    hasKey,
    missingProvider,
  });
}

module.exports = {
  LEGACY_GEMINI_KEY, SECRET_KEY_FOR, apiKeyFor, missingApiKeyFor,
  AUTO, isAuto, autoTiers, callLLM, warnIfExpensive, nativeToolsFor,
  MODEL_CHOICES, MODEL_CHOICES_GEMINI, MODEL_CHOICES_OPENAI, MODEL_CHOICES_ANTHROPIC,
  editorModelChoices, keyStatus, postConfig,
};
