"use strict";

// Idioma de la interfaz (v0.28): espanol o ingles.
// sovnodeAider.language = "auto" (default: sigue el idioma de VS Code; es* ->
// espanol, cualquier otro -> ingles) | "es" | "en".
// Uso: L("texto en espanol", "English text"). Los dos textos van juntos en el
// mismo lugar del codigo a proposito: es imposible agregar un mensaje nuevo y
// olvidarse de la traduccion.
// Lo que va AL MODELO (prompts, resultados de herramientas) no se traduce:
// los prompts ya le piden responder en el idioma del usuario.

let getSetting = () => "auto";
let getEnvLang = () => "en";

function init({ setting, envLang }) {
  if (setting) getSetting = setting;
  if (envLang) getEnvLang = envLang;
}

function lang() {
  const s = String(getSetting() || "auto").toLowerCase();
  if (s === "es" || s === "en") return s;
  return /^es\b|^es-/i.test(String(getEnvLang() || "")) || String(getEnvLang() || "").toLowerCase() === "es" ? "es" : "en";
}

const L = (es, en) => (lang() === "es" ? es : en);

// Idioma en que el USUARIO escribio el pedido (v0.29.2). Los prompts estan en
// espanol y "responde en el idioma del usuario" no alcanzaba: el editor recibe
// el pedido envuelto en espanol y contestaba en espanol aunque escribieras en
// ingles. Heuristica barata (sin llamada extra): caracteres propios del
// espanol + palabras funcionales frecuentes de cada idioma. Empate o texto sin
// senales (ej. solo codigo) -> el idioma de la interfaz.
const ES_WORDS = /\b(el|la|los|las|de|del|que|para|con|una|un|por|en|es|y|como|pero|agrega|crea|arregla|cambia|haz|hace|quiero|porque|cuando|donde|esta|este|esto|archivo|funcion|hola|gracias|mejora|necesito)\b/gi;
const EN_WORDS = /\b(the|an|of|to|and|with|for|in|is|it|that|this|add|create|fix|change|make|should|must|when|where|file|function|have|has|use|using|only|each|which|hi|hello|thanks|please|improve|need)\b/gi;
function detectLang(text, fallback = lang()) {
  const t = String(text || "");
  let es = (t.match(ES_WORDS) || []).length + ((t.match(/[ñ¿¡áéíóú]/gi) || []).length ? 3 : 0);
  let en = (t.match(EN_WORDS) || []).length;
  if (es === en) return fallback;
  return es > en ? "es" : "en";
}

module.exports = { init, lang, L, detectLang };
