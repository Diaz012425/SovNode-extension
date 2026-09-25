"use strict";

// Comandos del chat (/help, /add, /undo, /task, ...) y el candado que decide
// cuales se pueden usar con un turno en curso.
const vscode = require("vscode");
const editFormats = require("./editFormats");
const { resolveEditFormat, FORMAT_LABEL } = editFormats;
const { renderRepoMap } = require("./repoMap");
const { fmtUsd } = require("./pricing");
const { L } = require("./i18n");
const { state, cfg, workspaceRoot, post } = require("./state");
const { AUTO, MODEL_CHOICES, autoTiers, postConfig } = require("./models");
const { getRepoMap } = require("./context");
const { relPathOf, contextPaths, sendFilesUpdate, addUserChatFile } = require("./workspaceFiles");
const { sendLogsUpdate, attachLog, attachProblems } = require("./logAttach");
const { undoLast, undoTask } = require("./undo");
const { runDiagnostics } = require("./diagnostics");
const { runTask, AGENT_MAX_ATTEMPTS } = require("./agent");

const HELP = () => [
  L("**Comandos**", "**Commands**"),
  L("- `/add <ruta o glob>` agrega archivos al chat (ej: `/add src/**/*.js`)", "- `/add <path or glob>` adds files to the chat (e.g. `/add src/**/*.js`)"),
  L("- `/drop <ruta>` o `/drop all` quita archivos del chat", "- `/drop <path>` or `/drop all` removes files from the chat"),
  L("- `/files` lista los archivos en el chat", "- `/files` lists the files in the chat"),
  L("- `/undo` deshace el ultimo cambio de SovNode (y su commit si sigue siendo el ultimo)", "- `/undo` undoes SovNode's last change (and its commit if it's still the latest)"),
  L("- `/clear` borra el historial de la conversacion (no toca archivos)", "- `/clear` clears the conversation history (doesn't touch files)"),
  L("- `/map` muestra el mapa del repositorio que ve el modelo", "- `/map` shows the repository map the model sees"),
  L("- `/cost` costo acumulado de la sesion", "- `/cost` accumulated session cost"),
  L("- `/log` abre el log completo de uso (JSONL)", "- `/log` opens the full usage log (JSONL)"),
  L("- `/diag` diagnostico: API key, conexion real con el proveedor (Gemini/OpenAI/Anthropic), modelo, git, entorno", "- `/diag` diagnostics: API key, real connection to the provider (Gemini/OpenAI/Anthropic), model, git, environment"),
  L("- `/undo force` deshace aunque hayas editado el archivo despues", "- `/undo force` undoes even if you edited the file afterwards"),
  L("- `/architect` (o `/architect on|off`) modo arquitecto: un modelo planea y otro escribe el codigo", "- `/architect` (or `/architect on|off`) architect mode: one model plans and another writes the code"),
  L("- `/format` muestra el formato de edicion (SEARCH/REPLACE, diff unificado o archivo completo) y por que; `/format auto|search-replace|udiff|whole` lo fija", "- `/format` shows the edit format (SEARCH/REPLACE, unified diff or whole file) and why; `/format auto|search-replace|udiff|whole` sets it"),
  L("- `/editor <modelo>` modelo editor para el modo arquitecto (vacio = el mismo modelo)", "- `/editor <model>` editor model for architect mode (empty = same model)"),
  L("- `/task <objetivo>` tarea larga: la divide en pasos chicos y los ejecuta uno tras otro solo (Detener para frenarla)", "- `/task <goal>` long task: splits it into small steps and runs them one after another on its own (Stop to halt it)"),
  L("- `/bug` adjunta como log lo que tengas copiado (un error, un traceback, la salida de la terminal): queda APARTE del chat, en todos los turnos, hasta que lo quites. `/bug problems` adjunta los errores del panel Problems; `/bug clear` los quita. Tambien con el boton 🐞", "- `/bug` attaches whatever you have copied (an error, a traceback, terminal output) as a log: it stays SEPARATE from the chat, in every turn, until you remove it. `/bug problems` attaches the errors from the Problems panel; `/bug clear` removes them. Also via the 🐞 button"),
  L("- `/undo task` deshace TODOS los pasos de la ultima tarea (`/task`), en orden inverso (`/undo task force` para forzar)", "- `/undo task` undoes ALL steps of the last task (`/task`), in reverse order (`/undo task force` to force)"),
].join("\n");

async function handleSlash(text) {
  const [cmd, ...rest] = text.trim().split(/\s+/);
  const arg = rest.join(" ");
  switch (cmd) {
    case "/help":
      return post({ type: "system", text: HELP() });
    case "/add": {
      if (!arg) return post({ type: "system", text: L("Uso: `/add ruta/archivo.ext` o `/add src/**/*.js`", "Usage: `/add path/file.ext` or `/add src/**/*.js`") });
      if (!workspaceRoot()) return post({ type: "system", text: L("Abre una carpeta primero.", "Open a folder first.") });
      const found = await vscode.workspace.findFiles(arg.replace(/\\/g, "/"), "**/{node_modules,.git}/**", 50);
      if (!found.length) return post({ type: "system", text: L(`No encontre archivos para \`${arg}\`.`, `No files found for \`${arg}\`.`) });
      for (const u of found) addUserChatFile(relPathOf(u));
      sendFilesUpdate();
      return post({ type: "system", text: L(`Agregados: ${found.map(relPathOf).join(", ")}`, `Added: ${found.map(relPathOf).join(", ")}`) });
    }
    case "/drop":
      if (arg === "all" || !arg) state.chatFiles.clear();
      else state.chatFiles.delete(arg.replace(/\\/g, "/"));
      sendFilesUpdate();
      return post({ type: "system", text: arg && arg !== "all" ? L(`Quitado ${arg}.`, `Removed ${arg}.`) : L("Quitados todos los archivos agregados (el activo se sigue incluyendo).", "Removed all added files (the active one is still included).") });
    case "/files":
      return post({ type: "system", text: contextPaths().map((f) => `- \`${f.path}\`${f.active ? L(" (activo)", " (active)") : ""}`).join("\n") || L("No hay archivos en el chat.", "No files in the chat.") });
    case "/undo":
      if (arg === "task" || arg === "task force") return undoTask(arg === "task force");
      return undoLast(arg === "force");
    case "/clear":
      state.history = [];
      state.logs = []; // conversacion nueva = sin los logs del bug anterior
      state.archBases.clear();
      sendLogsUpdate();
      return post({ type: "cleared" });
    case "/bug": {
      // /bug              -> adjunta lo que tengas copiado (ej. de la terminal)
      // /bug problems     -> adjunta los errores del panel Problems
      // /bug clear        -> quita todos los logs
      // /bug <texto>      -> adjunta ese texto como log
      if (arg === "clear") { state.logs = []; sendLogsUpdate(); return post({ type: "system", text: L("Logs quitados del chat.", "Logs removed from the chat.") }); }
      if (arg === "problems") return attachProblems();
      if (!arg) return attachLog(await vscode.env.clipboard.readText(), "", L("el portapapeles", "the clipboard"));
      return attachLog(arg, "", "el comando");
    }
    case "/map": {
      const map = await getRepoMap();
      return post({ type: "system", text: "```\n" + (renderRepoMap(map, [], undefined, undefined, contextPaths().map((f) => f.path)) || L("(mapa vacio: no hay archivos de codigo soportados)", "(empty map: no supported code files)")) + "\n```" });
    }
    case "/cost": {
      const s = state.session;
      const k = s.cost;
      return post({ type: "system", text: L(`**Sesion:** ${s.turns} turnos · in ${s.usage.promptTokens || 0} tok (cache ${s.usage.cachedTokens || 0}) · out ${s.usage.outputTokens || 0} · razonamiento ${s.usage.thoughtTokens || 0}\n**Costo:** input ${fmtUsd(k.inputUsd)} + cache ${fmtUsd(k.cachedUsd)} + output ${fmtUsd(k.outputUsd)} + razonamiento ${fmtUsd(k.thoughtUsd)} = **${fmtUsd(k.totalUsd)}**`, `**Session:** ${s.turns} turns · in ${s.usage.promptTokens || 0} tok (cache ${s.usage.cachedTokens || 0}) · out ${s.usage.outputTokens || 0} · reasoning ${s.usage.thoughtTokens || 0}\n**Cost:** input ${fmtUsd(k.inputUsd)} + cache ${fmtUsd(k.cachedUsd)} + output ${fmtUsd(k.outputUsd)} + reasoning ${fmtUsd(k.thoughtUsd)} = **${fmtUsd(k.totalUsd)}**`) });
    }
    case "/log":
      return vscode.commands.executeCommand("sovnodeAider.showUsageLog");
    case "/diag":
      return runDiagnostics();
    case "/architect": {
      const on = arg === "on" ? true : arg === "off" ? false : !cfg().get("architect");
      await cfg().update("architect", on, vscode.ConfigurationTarget.Global);
      const ed = (cfg().get("editorModel") || "").trim() || cfg().get("model");
      await postConfig();
      return post({ type: "system", text: on ? L(`Modo arquitecto **activado**: ${cfg().get("model")} planea → ${ed} escribe el codigo. Cambia el editor con \`/editor <modelo>\`.`, `Architect mode **on**: ${cfg().get("model")} plans → ${ed} writes the code. Change the editor with \`/editor <model>\`.`) : L("Modo arquitecto **desactivado**: un solo modelo planea y edita.", "Architect mode **off**: a single model plans and edits.") });
    }
    case "/agent": {
      const on = arg === "on" ? true : arg === "off" ? false : !cfg().get("agentMode");
      await cfg().update("agentMode", on, vscode.ConfigurationTarget.Global);
      await postConfig();
      const b = Number(cfg().get("taskBudgetUSD")) || 0;
      return post({ type: "system", text: on ? L(`Modo agente **activado** para \`/task\`: si un paso falla, reintenta con el error real (hasta ${AGENT_MAX_ATTEMPTS - 1} veces) y si se traba en el mismo error replanifica lo que falta. Presupuesto por tarea: ${b ? fmtUsd(b) + " (al llegar, pregunta)" : "sin tope"}. Cuesta mas que el modo normal cuando algo falla.`, `Agent mode **on** for \`/task\`: if a step fails, it retries with the real error (up to ${AGENT_MAX_ATTEMPTS - 1} times) and if it gets stuck on the same error it replans the rest. Budget per task: ${b ? fmtUsd(b) + " (asks when reached)" : "no cap"}. Costs more than normal mode when something fails.`) : L("Modo agente **desactivado**: `/task` se detiene en el primer paso que falla (mas barato, vos decidis).", "Agent mode **off**: `/task` stops at the first failing step (cheaper, you decide).") });
    }
    case "/auto": {
      if (arg === "off") {
        const t = await autoTiers();
        await cfg().update("model", t ? t.medio : MODEL_CHOICES[0], vscode.ConfigurationTarget.Global);
        await postConfig();
        return post({ type: "system", text: L(`Modo Auto **desactivado**: modelo fijo \`${cfg().get("model")}\`.`, `Auto mode **off**: fixed model \`${cfg().get("model")}\`.`) });
      }
      await cfg().update("model", AUTO, vscode.ConfigurationTarget.Global);
      await postConfig();
      const t = await autoTiers();
      return post({ type: "system", text: t
        ? L(`Modo Auto **activado**. Niveles: barato \`${t.barato}\` · medio \`${t.medio}\` · fuerte \`${t.fuerte}\` (entre los modelos con API key, por precio; fijalos con el ajuste \`sovnodeAider.autoModels\`). Cada turno elige el nivel por reglas: contexto grande, pedido largo o dificil, error adjunto, turno anterior fallido. Nivel fuerte = arquitecto (fuerte planea, medio escribe). En /task el fuerte planifica; con modo agente los pasos van con el barato y escalan al fuerte si fallan. Ignora /architect, /editor y /stepmodel mientras este activo.`, `Auto mode **on**. Levels: cheap \`${t.barato}\` · medium \`${t.medio}\` · strong \`${t.fuerte}\` (among models with an API key, by price; pin them with the \`sovnodeAider.autoModels\` setting). Each turn picks the level by rules: large context, long or hard request, attached error, previous turn failed. Strong level = architect (strong plans, medium writes). In /task the strong one plans; with agent mode the steps use the cheap one and escalate to strong if they fail. Ignores /architect, /editor and /stepmodel while active.`)
        : L("Modo Auto activado, pero no hay ninguna API key guardada todavia (🔑).", "Auto mode on, but no API key is saved yet (🔑).") });
    }
    case "/stepmodel": {
      await cfg().update("agentStepModel", arg, vscode.ConfigurationTarget.Global);
      return post({ type: "system", text: arg ? L(`Modo agente: los pasos los hace \`${arg}\`; ${cfg().get("model")} planifica y entra solo si un paso falla.`, `Agent mode: steps are done by \`${arg}\`; ${cfg().get("model")} plans and steps in only if a step fails.`) : L("Modo agente: los pasos usan el modelo principal (sin modelo barato).", "Agent mode: steps use the main model (no cheap model).") });
    }
    case "/editor": {
      await cfg().update("editorModel", arg, vscode.ConfigurationTarget.Global);
      await postConfig();
      return post({ type: "system", text: arg ? L(`Modelo editor: \`${arg}\`.`, `Editor model: \`${arg}\`.`) : L("Modelo editor: el mismo que el principal.", "Editor model: same as the main one.") });
    }
    case "/format": {
      // /format            -> que formato se usaria ahora y por que
      // /format <formato>  -> fijarlo (auto | search-replace | udiff | whole)
      if (arg) {
        const f = editFormats.normalizeFormat(arg);
        if (!f) return post({ type: "system", text: L(`Formato desconocido: \`${arg}\`. Opciones: \`auto\`, \`search-replace\`, \`udiff\`, \`whole\`.`, `Unknown format: \`${arg}\`. Options: \`auto\`, \`search-replace\`, \`udiff\`, \`whole\`.`) });
        await cfg().update("editFormat", f, vscode.ConfigurationTarget.Global);
      }
      const model = cfg().get("model");
      const ed = cfg().get("architect") ? ((cfg().get("editorModel") || "").trim() || model) : model;
      const setting = cfg().get("editFormat") || "auto";
      const r = resolveEditFormat(setting, ed, 0);
      const autoNote = setting === "auto" ? L("\n\n`auto` elige por el modelo que escribe el codigo: modelos chicos (lite/luna/haiku/mini) → archivo completo (si los archivos en el chat no pasan 12k caracteres; si pasan, SEARCH/REPLACE), OpenAI → diff unificado, el resto → SEARCH/REPLACE. Cambialo con `/format search-replace|udiff|whole|auto`.", "\n\n`auto` picks by the model that writes the code: small models (lite/luna/haiku/mini) → whole file (if the files in the chat stay under 12k characters; otherwise SEARCH/REPLACE), OpenAI → unified diff, the rest → SEARCH/REPLACE. Change it with `/format search-replace|udiff|whole|auto`.") : "";
      return post({ type: "system", text: L(`Formato de edicion: **${FORMAT_LABEL[r.format]}** (\`${setting}\`, para \`${ed}\`): ${r.reason}.${autoNote}`, `Edit format: **${FORMAT_LABEL[r.format]}** (\`${setting}\`, for \`${ed}\`): ${r.reason}.${autoNote}`) });
    }
    case "/task":
      if (!arg) return post({ type: "system", text: L("Uso: `/task <lo que quieres lograr>` (ej: `/task agrega login con email y contrasena`)", "Usage: `/task <what you want to achieve>` (e.g. `/task add email and password login`)") });
      return runTask(arg);
    default:
      return post({ type: "system", text: L(`Comando desconocido: ${cmd}. Escribe /help.`, `Unknown command: ${cmd}. Type /help.`) });
  }
}

// Comandos de solo lectura que se pueden usar con un turno en curso; el resto
// (/clear, /add, /architect, /undo...) cambia estado que el turno esta usando.
const SLASH_OK_WHILE_BUSY = ["/help", "/files", "/cost", "/log", "/diag", "/map", "/bug"]; // /bug solo afecta al PROXIMO turno
function guardedSlash(text) {
  const cmd = text.trim().split(/\s+/)[0];
  if (state.busy && !SLASH_OK_WHILE_BUSY.includes(cmd)) {
    return post({ type: "system", text: L(`Espera a que termine el turno actual para usar ${cmd}.`, `Wait for the current turn to finish before using ${cmd}.`) });
  }
  return handleSlash(text);
}

module.exports = { handleSlash, guardedSlash, SLASH_OK_WHILE_BUSY };
