"use strict";

// Modo Auto (v0.27): SovNode elige el modelo de cada operacion con REGLAS,
// sin gastar una llamada extra en "analizar la tarea". Un modelo que analiza
// tampoco sabe de antemano que tan dificil va a ser: adivina igual que una
// regla, pero cobrando. Modulo PURO (sin vscode): testeable con node solo.
//
// 1) Niveles: barato / medio / fuerte, sacados de los modelos para los que
//    HAY API key, ordenados por precio de salida (el precio es el unico dato
//    objetivo que tenemos de "cuanto modelo es"). El usuario puede fijar
//    cualquiera con sovnodeAider.autoModels.
// 2) Nivel del pedido: puntaje por senales baratas (tamano del contexto,
//    palabras de dificultad, log de error adjunto, turno anterior fallido).
// 3) Operacion: en un turno, nivel fuerte => arquitecto (fuerte planea,
//    medio escribe); si no, un solo modelo del nivel. En /task el fuerte
//    planifica y los pasos se enrutan solos (o barato + escalado en modo
//    agente) -- eso lo arma extension.js con estos datos.

const { L } = require("./i18n");
const LEVELS = ["barato", "medio", "fuerte"];

// candidates: [{model, price:{output}}]; available(model) -> bool (hay key);
// overrides: {barato, medio, fuerte} opcionales (se usan si hay key).
function pickTiers(candidates, available, overrides = {}) {
  const ok = (candidates || []).filter((c) => available(c.model)).sort((a, b) => a.price.output - b.price.output);
  if (!ok.length) return null;
  const auto = {
    barato: ok[0].model,
    medio: ok[Math.floor((ok.length - 1) / 2)].model,
    fuerte: ok[ok.length - 1].model,
  };
  const tiers = { ...auto };
  for (const lvl of LEVELS) {
    const m = overrides && typeof overrides[lvl] === "string" ? overrides[lvl].trim() : "";
    if (m && available(m)) tiers[lvl] = m;
  }
  return tiers;
}

const HARD_WORDS = /\b(refactori[zc]\w*|redise[nñ]\w*|arquitectura|migr[ae]\w*|reestructur\w*|optimiz\w*|concurren\w*|race condition|deadlock|seguridad|vulnerab\w*|por qu[eé] (falla|no anda|no funciona)|rendimiento|performance|memory leak)\b/i;

// signals: {question, fileCount, fileChars, hasLogs, prevFailed}
// -> {level: "barato"|"medio"|"fuerte", score, reasons:[string]}
function routeLevel(sig) {
  const reasons = [];
  let score = 0;
  const q = String((sig && sig.question) || "");
  if ((sig.fileChars || 0) > 40000 || (sig.fileCount || 0) >= 4) { score++; reasons.push(L(`contexto grande (${sig.fileCount} archivo(s), ${Math.round((sig.fileChars || 0) / 1000)}k caracteres)`, `large context (${sig.fileCount} file(s), ${Math.round((sig.fileChars || 0) / 1000)}k chars)`)); }
  if (q.length > 600) { score++; reasons.push(L("pedido largo", "long request")); }
  const hard = HARD_WORDS.exec(q);
  if (hard) { score++; reasons.push(L(`pedido dificil ("${hard[0]}")`, `hard request ("${hard[0]}")`)); }
  if (sig.hasLogs) { score++; reasons.push(L("hay un error/log adjunto", "an error/log is attached")); }
  if (sig.prevFailed) { score++; reasons.push(L("el turno anterior fallo", "the previous turn failed")); }
  const level = score >= 3 ? "fuerte" : score >= 1 ? "medio" : "barato";
  if (!reasons.length) reasons.push(L("pedido simple", "simple request"));
  return { level, score, reasons };
}

// Plan de modelos de UN turno normal.
function planTurn(tiers, route) {
  if (route.level === "fuerte" && tiers.fuerte !== tiers.medio) {
    return { model: tiers.fuerte, editModel: tiers.medio, architect: true };
  }
  const m = tiers[route.level];
  return { model: m, editModel: m, architect: false };
}

module.exports = { pickTiers, routeLevel, planTurn, LEVELS, HARD_WORDS };
