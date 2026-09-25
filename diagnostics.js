"use strict";

// /diag: API keys, conexion real con cada proveedor en uso, repo map, git y
// entorno, en palabras simples.
const { pingGemini } = require("./gemini");
const { providerForModel, pingProvider, PROVIDER_LABEL } = require("./providers");
const treesitter = require("./treesitter");
const gitUtil = require("./git");
const { L } = require("./i18n");
const { cfg, workspaceRoot, log, post } = require("./state");
const { apiKeyFor } = require("./models");
const { getRepoMap } = require("./context");
const { activeRelPath } = require("./workspaceFiles");
const { diagContext } = require("./sessionLog");

// /diag: revisa TODO lo que puede fallar, de afuera hacia adentro, y dice en
// palabras simples que esta bien y que no. Se puede copiar entero.
async function runDiagnostics() {
  const lines = [L("**Diagnostico de SovNode**", "**SovNode diagnostics**"), ""];
  const ok = (b) => (b ? "✅" : "❌");
  // Multi-proveedor: se chequean todos los modelos configurados que
  // realmente estan en uso (principal + editor del modo arquitecto, si esta
  // activo), cada uno con la API key y la conexion de SU proveedor -- no
  // tiene sentido reportar solo Gemini si el usuario esta usando GPT-6 o
  // Claude para alguno de los dos.
  const architect = Boolean(cfg().get("architect"));
  const model = cfg().get("model");
  const editModel = architect ? ((cfg().get("editorModel") || "").trim() || model) : model;
  const modelsInUse = [...new Set([model, editModel])];
  const providersInUse = [...new Set(modelsInUse.map(providerForModel))];
  const root = workspaceRoot();
  for (const p of providersInUse) {
    const key = await apiKeyFor(p);
    lines.push(L(`${ok(Boolean(key))} API key de ${PROVIDER_LABEL[p]} guardada${key ? ` (termina en …${key.slice(-4)})` : " — pulsa 🔑"}`, `${ok(Boolean(key))} ${PROVIDER_LABEL[p]} API key saved${key ? ` (ends in …${key.slice(-4)})` : " — press 🔑"}`));
  }
  lines.push(L(`${ok(Boolean(root))} Carpeta abierta${root ? `: ${root.fsPath}` : " — File > Open Folder"}`, `${ok(Boolean(root))} Folder open${root ? `: ${root.fsPath}` : " — File > Open Folder"}`));
  const tsAvailable = await treesitter.isAvailable();
  lines.push(L(`${tsAvailable ? "✅" : "ℹ️"} Repo map: ${tsAvailable ? "tree-sitter real disponible" : 'modo regex de respaldo -- corre "npm install" en la carpeta de la extension para el parseo real'}`, `${tsAvailable ? "✅" : "ℹ️"} Repo map: ${tsAvailable ? "real tree-sitter available" : 'fallback regex mode -- run "npm install" in the extension folder for real parsing'}`));
  if (root) {
    const isGit = await gitUtil.isRepo(root.fsPath);
    lines.push(L(`${isGit ? "✅" : "ℹ️"} Git: ${isGit ? "repo detectado (auto-commit activo)" : "no es un repo git (sin auto-commit; /undo funciona igual)"}`, `${isGit ? "✅" : "ℹ️"} Git: ${isGit ? "repo detected (auto-commit on)" : "not a git repo (no auto-commit; /undo still works)"}`));
    try {
      const map = await getRepoMap();
      if (map) {
        const t = map.treeSitter || { used: 0, total: 0 };
        const parserNote = t.total === 0
          ? ""
          : t.used === t.total
            ? L(" (parseo real con tree-sitter)", " (real tree-sitter parsing)")
            : t.used === 0
              ? L(" (modo regex: falta \"npm install\" en la carpeta de la extension, o el .wasm no cargo)", " (regex mode: \"npm install\" missing in the extension folder, or the .wasm didn't load)")
              : L(` (${t.used}/${t.total} archivos con tree-sitter, el resto con regex)`, ` (${t.used}/${t.total} files with tree-sitter, the rest with regex)`);
        lines.push(L(`ℹ️ Mapa del repo: ${map.entries.length} archivos de codigo${parserNote}`, `ℹ️ Repo map: ${map.entries.length} code files${parserNote}`));
      } else {
        lines.push(L("ℹ️ Mapa del repo: sin archivos de codigo soportados", "ℹ️ Repo map: no supported code files"));
      }
    } catch (e) {
      lines.push(L(`❌ Mapa del repo fallo: ${e.message}`, `❌ Repo map failed: ${e.message}`));
    }
  }
  const act = activeRelPath();
  lines.push(L(`ℹ️ Archivo activo: ${act || "ninguno (se pueden crear archivos igual)"}`, `ℹ️ Active file: ${act || "none (you can still create files)"}`));
  for (const m of modelsInUse) {
    const provider = providerForModel(m);
    const key = await apiKeyFor(provider);
    if (!key) continue; // ya se avisa arriba que falta la key de este proveedor
    const label = PROVIDER_LABEL[provider];
    const p = provider === "gemini" ? await pingGemini({ apiKey: key, model: m }) : await pingProvider(provider, { apiKey: key, model: m });
    if (p.ok) {
      lines.push(L(`✅ Conexion con ${label} (\`${m}\`): HTTP 200${p.ms ? ` en ${p.ms} ms` : ""}`, `✅ Connection to ${label} (\`${m}\`): HTTP 200${p.ms ? ` in ${p.ms} ms` : ""}`));
      if (p.modelExists != null) lines.push(L(`${ok(p.modelExists)} Modelo \`${m}\` ${p.modelExists ? "disponible" : `NO existe para tu key. Algunos disponibles: ${(p.sampleModels || []).join(", ")}`}`, `${ok(p.modelExists)} Model \`${m}\` ${p.modelExists ? "available" : `does NOT exist for your key. Some available: ${(p.sampleModels || []).join(", ")}`}`));
    } else if (p.status) {
      const e = String(p.apiError || "?");
      const hint = /api key|API_KEY|permission|unauthori/i.test(e) ? L(" — la API key es invalida o no tiene permiso", " — the API key is invalid or lacks permission")
        : /allowlist|proxy|blocked|forbidden/i.test(e) ? L(` — algo en tu red (proxy, firewall, VPN) bloquea a ${label}`, ` — something on your network (proxy, firewall, VPN) is blocking ${label}`)
        : p.status === 429 ? L(" — limite de uso/cuota alcanzado", " — usage/quota limit reached") : "";
      lines.push(L(`❌ ${label} respondio HTTP ${p.status}: ${e}${hint}`, `❌ ${label} responded HTTP ${p.status}: ${e}${hint}`));
    } else {
      lines.push(L(`❌ No hay conexion con ${label}: ${p.networkError} — revisa internet, proxy, VPN o antivirus`, `❌ No connection to ${label}: ${p.networkError} — check internet, proxy, VPN or antivirus`));
    }
  }
  lines.push("", "```", diagContext(), "```");
  const text = lines.join("\n");
  log(text);
  post({ type: "system", text, copy: text });
}

module.exports = { runDiagnostics };
