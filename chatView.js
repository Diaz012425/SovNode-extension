"use strict";

// El panel de chat (webview): su HTML y los mensajes que manda.
const vscode = require("vscode");
const path = require("path");
const i18n = require("./i18n");
const { L } = i18n;
const { state, rt, cfg, log, post } = require("./state");
const { AUTO, MODEL_CHOICES, MODEL_CHOICES_GEMINI, MODEL_CHOICES_OPENAI, MODEL_CHOICES_ANTHROPIC, editorModelChoices, keyStatus } = require("./models");
const { activeRelPath, uriOf, contextPaths, sendFilesUpdate, addUserChatFile } = require("./workspaceFiles");
const { logSummary, sendLogsUpdate, attachLog, attachProblems } = require("./logAttach");
const { diagContext } = require("./sessionLog");
const { undoLast } = require("./undo");
const { runTurn } = require("./turn");
const { guardedSlash } = require("./slash");

// Esquema de los documentos "antes" del boton "Ver diff" (el proveedor de
// contenido se registra en activate).
const BEFORE_SCHEME = "sovnode-before";

async function onWebviewMessage(msg) {
  switch (msg.type) {
    case "ready": {
      const { hasKey, missingProvider } = await keyStatus();
      return post({
        type: "init",
        lang: i18n.lang(),
        model: cfg().get("model"),
        effort: cfg().get("effort"),
        architect: Boolean(cfg().get("architect")),
        editorModel: (cfg().get("editorModel") || "").trim(),
        editorChoices: editorModelChoices(),
        models: [...new Set([...MODEL_CHOICES, cfg().get("model")])],
        // Agrupado por proveedor para el <select> del modelo principal (con
        // <optgroup>, ver renderModelGroups en chat.js) -- puramente
        // cosmetico, el valor que importa sigue siendo el string del modelo.
        modelGroups: { [L("Automatico", "Automatic")]: [AUTO], Gemini: MODEL_CHOICES_GEMINI, OpenAI: MODEL_CHOICES_OPENAI, Anthropic: MODEL_CHOICES_ANTHROPIC },
        hasKey, missingProvider,
        files: contextPaths(),
        logs: logSummary(),
        session: state.session,
      });
    }
    case "send": {
      const text = (msg.text || "").trim();
      if (!text) return;
      if (text.startsWith("/")) return guardedSlash(text);
      return runTurn(text);
    }
    case "cancel":
      if (state.abort) state.abort.abort();
      return;
    // Logs de bug (panel 🐞 del chat). No toman el candado del turno: solo
    // cambian lo que se manda en el PROXIMO turno (el actual ya armo su
    // contexto), igual que agregar un archivo.
    case "attachLog":
      return attachLog(msg.text, msg.label, "el panel de logs");
    case "logFromClipboard":
      return attachLog(await vscode.env.clipboard.readText(), msg.label, L("el portapapeles", "the clipboard"));
    case "logFromProblems":
      return attachProblems();
    case "dropLog":
      if (Number.isInteger(msg.index) && msg.index >= 0 && msg.index < state.logs.length) state.logs.splice(msg.index, 1);
      return sendLogsUpdate();
    case "previewLog": {
      const l = state.logs[msg.index];
      if (!l) return;
      const doc = await vscode.workspace.openTextDocument({ content: l.text, language: "log" });
      return vscode.window.showTextDocument(doc, { preview: true });
    }
    case "setModel":
      return cfg().update("model", msg.value, vscode.ConfigurationTarget.Global);
    case "setEffort":
      return cfg().update("effort", msg.value, vscode.ConfigurationTarget.Global);
    case "setEditorModel":
      return cfg().update("editorModel", msg.value, vscode.ConfigurationTarget.Global);
    case "setKey":
      return vscode.commands.executeCommand("sovnodeAider.setApiKey");
    case "addActive": {
      const rel = activeRelPath();
      if (rel) addUserChatFile(rel);
      return sendFilesUpdate();
    }
    case "dropFile":
      state.chatFiles.delete(msg.path);
      return sendFilesUpdate();
    case "openFile": {
      const doc = await vscode.workspace.openTextDocument(uriOf(msg.path));
      const line = Math.max(0, (msg.line || 1) - 1);
      return vscode.window.showTextDocument(doc, { selection: new vscode.Range(line, 0, line, 0) });
    }
    case "showDiff": {
      const before = vscode.Uri.from({ scheme: BEFORE_SCHEME, path: "/" + msg.path, query: `turn=${msg.turnId}` });
      return vscode.commands.executeCommand("vscode.diff", before, uriOf(msg.path), `${path.posix.basename(msg.path)} (antes ↔ despues, turno #${msg.turnId})`);
    }
    case "undo":
      return undoLast();
    case "slash":
      // Mismo candado que "send": antes este camino (botones del webview) se
      // lo salteaba, y un /clear en medio de un turno vaciaba el historial
      // justo antes de que el turno en curso le escribiera su respuesta.
      return guardedSlash(String(msg.text || ""));
    case "copyText":
      await vscode.env.clipboard.writeText(msg.text || "");
      vscode.window.setStatusBarMessage(msg.quiet ? "SovNode: copiado al portapapeles." : "SovNode: diagnostico copiado al portapapeles.", 3000);
      return;
    case "showLog":
      return vscode.commands.executeCommand("sovnodeAider.showUsageLog");
  }
}

class ChatViewProvider {
  resolveWebviewView(webviewView) {
    rt.view = webviewView;
    this.render(webviewView);
  }
  render(webviewView) {
    const media = vscode.Uri.joinPath(rt.extContext.extensionUri, "media");
    webviewView.webview.options = { enableScripts: true, localResourceRoots: [media] };
    const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const css = webviewView.webview.asWebviewUri(vscode.Uri.joinPath(media, "chat.css"));
    const js = webviewView.webview.asWebviewUri(vscode.Uri.joinPath(media, "chat.js"));
    const csp = webviewView.webview.cspSource;
    webviewView.webview.html = `<!DOCTYPE html>
<html lang="${i18n.lang()}"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp}; script-src 'nonce-${nonce}'; font-src ${csp};">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}"></head>
<body>
<header id="top">
  <div class="bar">
    <div class="brand"><span class="logo">◆</span><span>SovNode</span><span id="status" class="status" title="${L("Listo", "Ready")}"></span></div>
    <div class="actions">
      <button class="icon" id="btnAgent" title="${L("Modo agente (/agent): /task reintenta y replanifica solo cuando algo falla", "Agent mode (/agent): /task retries and replans only when something fails")}">🤖</button>
      <button class="icon" id="btnArch" title="${L("Modo arquitecto (/architect): un modelo planea, otro escribe el codigo", "Architect mode (/architect): one model plans, another writes the code")}">🏛</button>
      <button class="icon" id="btnKey" title="API key (Gemini/OpenAI/Anthropic)">🔑</button>
      <button class="icon" id="btnUndo" title="${L("Deshacer ultimo cambio (/undo)", "Undo last change (/undo)")}">↶</button>
      <button class="icon" id="btnClear" title="${L("Nueva conversacion (/clear)", "New conversation (/clear)")}">＋</button>
    </div>
  </div>
  <div class="bar selects">
    <label class="field grow" title="${L("Modelo principal (el proveedor se detecta por el nombre)", "Main model (the provider is detected from the name)")}"><span>${L("Modelo", "Model")}</span><select id="model"></select></label>
    <label class="field" title="${L("Effort: presupuesto de razonamiento y techo de salida", "Effort: reasoning budget and output ceiling")}"><span>Effort</span><select id="effort">
      <option value="low">low</option><option value="medium">medium</option><option value="high">high</option><option value="extra">extra</option>
    </select></label>
  </div>
  <div class="bar selects" id="editorRow" hidden>
    <label class="field grow" title="${L("Modelo editor del modo arquitecto (el que escribe el codigo)", "Architect mode editor model (the one that writes the code)")}"><span>Editor</span><select id="editorModel"></select></label>
  </div>
</header>
<div id="session" title="${L("Costo acumulado de esta sesion", "Accumulated cost for this session")}"></div>
<main id="messages">
  <div class="empty" id="empty">
    <div class="logo big">◆</div>
    <h2>SovNode</h2>
    <p>${L("Pedi cambios en tu codigo o que cree archivos nuevos. Vas a ver <b>que</b> cambio, <b>donde</b> y <b>cuanto costo</b> cada turno.", "Ask for changes to your code or for new files. You\'ll see <b>what</b> changed, <b>where</b> and <b>how much</b> each turn cost.")}</p>
    <p class="hint">${L("¿Algo falla? Pega el error con <b>🐞</b> (queda aparte) y conta en el chat que estabas haciendo.", "Something broken? Paste the error with <b>🐞</b> (kept separate) and tell the chat what you were doing.")}</p>
    <div class="examples">
      <button class="ex">${L("Explicame que hace el archivo abierto", "Explain what the open file does")}</button>
      <button class="ex">${L("Crea un index.html con un juego de la serpiente", "Create an index.html with a snake game")}</button>
      <button class="ex">/diag</button>
      <button class="ex">/help</button>
    </div>
  </div>
</main>
<button id="toBottom" class="tobottom" title="${L("Ir al final", "Jump to bottom")}" hidden>↓</button>
<footer>
  <div id="logPanel" class="logpanel" hidden>
    <div class="lp-head"><b>${L("🐞 Adjuntar log de error", "🐞 Attach error log")}</b><span class="muted">${L("Queda aparte del chat y se manda en cada turno hasta que lo quites.", "Kept separate from the chat and sent every turn until you remove it.")}</span></div>
    <textarea id="logText" rows="6" placeholder="${L("Pega aca el error, el traceback o la salida de la terminal...", "Paste the error, traceback or terminal output here...")}"></textarea>
    <input id="logLabel" type="text" placeholder="${L("Nombre (opcional, ej: crash al disparar)", "Name (optional, e.g. crash when shooting)")}">
    <div class="lp-actions">
      <button class="btn primary" id="logAdd">${L("Adjuntar", "Attach")}</button>
      <button class="btn" id="logClip" title="${L("Adjuntar lo que tengas copiado (ej. desde la terminal)", "Attach whatever you have copied (e.g. from the terminal)")}">${L("Desde portapapeles", "From clipboard")}</button>
      <button class="btn" id="logProblems" title="${L("Errores y warnings del panel Problems de VS Code", "Errors and warnings from the VS Code Problems panel")}">${L("Desde Problems", "From Problems")}</button>
      <button class="btn ghost" id="logCancel">${L("Cancelar", "Cancel")}</button>
    </div>
  </div>
  <div id="chips"></div>
  <div class="composer">
    <textarea id="q" rows="1" placeholder="${L("Pedi un cambio, crea archivos, o /help...", "Ask for a change, create files, or /help...")}"></textarea>
    <div class="composer-bar">
      <button class="icon" id="btnLog" title="${L("Adjuntar log de error (/bug)", "Attach error log (/bug)")}">🐞</button>
      <span class="hint">${L("Enter envia · Shift+Enter salto de linea", "Enter sends · Shift+Enter new line")}</span>
      <button id="send" title="${L("Enviar (Enter)", "Send (Enter)")}">➤</button>
      <button id="stop" title="${L("Detener", "Stop")}" hidden>■</button>
    </div>
  </div>
</footer>
<script nonce="${nonce}" src="${js}"></script>
</body></html>`;
    webviewView.webview.onDidReceiveMessage((m) =>
      onWebviewMessage(m).catch((e) => {
        const stack = (e && e.stack) || "(sin stack)";
        log(`[error] mensaje "${m && m.type}" del webview: ${e && e.message}\n${stack}`);
        rt.output.show(true);
        post({ type: "error", text: String((e && e.message) || e), stack: `${stack}\n\n--- contexto ---\naccion: ${m && m.type}\n${diagContext()}` });
      })
    );
    webviewView.onDidDispose(() => (rt.view = null));
  }
}

module.exports = { ChatViewProvider, onWebviewMessage, BEFORE_SCHEME };
