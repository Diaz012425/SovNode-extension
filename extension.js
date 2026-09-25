"use strict";

// Punto de entrada de la extension: activate() conecta todo (canal de salida,
// log de sesion, watcher del mapa, webview, comandos). La logica vive en:
//   state.js          estado compartido y helpers (cfg, post, log)
//   models.js         API keys, modo Auto, callLLM, lista de modelos
//   workspaceFiles.js leer/escribir archivos del proyecto
//   context.js        mapa del repo, memoria del proyecto, foco, historial
//   sessionLog.js     usage.jsonl, log de sesion, diagContext
//   turn.js           un turno de chat, por fases
//   agent.js          /task y modo agente
//   slash.js          comandos del chat
//   undo.js           /undo y /undo task
//   chatView.js       el webview del chat
//   logAttach.js      logs de bugs adjuntos (🐞)
//   execRunner.js     comandos que pide el modelo
//   diagnostics.js    /diag
const vscode = require("vscode");
const { PROVIDER_LABEL } = require("./providers");
const { affectsRepoMap } = require("./repoMap");
const i18n = require("./i18n");
const { L } = i18n;
const { state, rt, cfg, log, post } = require("./state");
const { SECRET_KEY_FOR, apiKeyFor, keyStatus, postConfig, warnIfExpensive } = require("./models");
const { projectMemoryText, openProjectMemory, invalidateRepoMap } = require("./context");
const { sendFilesUpdate } = require("./workspaceFiles");
const { diagContext, usageLogUri, initSessionLog, pruneOldSessionLogs, getSessionLogUri } = require("./sessionLog");
const { attachLog } = require("./logAttach");
const { undoLast } = require("./undo");
const { runDiagnostics } = require("./diagnostics");
const { handleSlash } = require("./slash");
const { ChatViewProvider, onWebviewMessage, BEFORE_SCHEME } = require("./chatView");

// ---------------------------------------------------------------- activacion
function activate(context) {
  rt.extContext = context;
  i18n.init({ setting: () => cfg().get("language"), envLang: () => (vscode.env && vscode.env.language) || "en" });
  rt.output = vscode.window.createOutputChannel("SovNode");
  context.subscriptions.push(rt.output);
  initSessionLog();
  state.lastEditor = vscode.window.activeTextEditor || null;

  // Red de seguridad: cualquier excepcion/rechazo que se escape de nuestros
  // try/catch (un bug que no anticipamos) igual queda registrado aqui y
  // visible en el chat, en vez de perderse en un log que nadie mira.
  // "Missing dataLength in event" es un bug conocido, inofensivo, de la
  // instrumentacion de red del inspector de Node que VS Code activa en modo
  // debug (F5) -- aparece con CUALQUIER llamada https mientras se depura,
  // no viene de nuestro codigo, y no interrumpe la respuesta real. Se
  // registra igual (por si acaso) pero sin asustar al usuario en el chat.
  const BENIGN_INSPECTOR_BUG = /Missing dataLength in event/;
  const onUncaught = (label) => (err) => {
    const stack = (err && err.stack) || String(err);
    const benign = BENIGN_INSPECTOR_BUG.test((err && err.message) || String(err));
    log(`[${benign ? "info" : "fatal"}] ${label}${benign ? " (ruido conocido del inspector de VS Code, no afecta nada)" : ""}: ${stack}`);
    if (benign) return;
    rt.output.show(true);
    post({ type: "error", text: L(`Error interno no manejado (${label}): ${(err && err.message) || err}`, `Unhandled internal error (${label}): ${(err && err.message) || err}`), stack: `${stack}\n\n--- contexto ---\n${diagContext()}` });
  };
  // Se registran UNA vez y se quitan al desactivar: antes se acumulaban en
  // cada recarga de la extension.
  const onExc = onUncaught("uncaughtException");
  const onRej = onUncaught("unhandledRejection");
  process.on("uncaughtException", onExc);
  process.on("unhandledRejection", onRej);
  context.subscriptions.push({ dispose: () => { process.off("uncaughtException", onExc); process.off("unhandledRejection", onRej); } });

  const watcher = vscode.workspace.createFileSystemWatcher("**/*");
  // Solo lo que puede cambiar el mapa: un commit (.git/), npm install o un
  // build ya no lo tiran abajo entero (ver affectsRepoMap en repoMap.js).
  const invalidate = (kind) => (uri) => { if (affectsRepoMap(uri.fsPath, kind)) invalidateRepoMap(); };
  watcher.onDidChange(invalidate("change"));
  watcher.onDidCreate(invalidate("create"));
  watcher.onDidDelete(invalidate("delete"));
  context.subscriptions.push(watcher);

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((ed) => {
      if (ed && ["file", "untitled"].includes(ed.document.uri.scheme)) state.lastEditor = ed;
      sendFilesUpdate();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("sovnodeAider.language") && rt.view && rt.chatProvider) rt.chatProvider.render(rt.view); // textos del HTML
      if (e.affectsConfiguration("sovnodeAider")) postConfig();
    }),
    vscode.workspace.registerTextDocumentContentProvider(BEFORE_SCHEME, {
      provideTextDocumentContent(uri) {
        const turn = /turn=(\d+)/.exec(uri.query);
        return state.beforeStore.get(`${turn ? turn[1] : ""}|${uri.path.replace(/^\//, "")}`) || "";
      },
    }),
    vscode.window.registerWebviewViewProvider("sovnodeAider.chatView", (rt.chatProvider = new ChatViewProvider()), { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand("sovnodeAider.setApiKey", async () => {
      // Multi-proveedor: hay que preguntar CUAL de las 3 API keys se quiere
      // guardar/cambiar -- no hay una sola "la" key como antes de v0.11. El
      // proveedor que falta (si hay uno, segun el modelo/editor configurado
      // ahora mismo) queda primero en la lista para que el caso comun (F5,
      // pulsar 🔑 porque falta una) sea un clic menos.
      const { missingProvider } = await keyStatus();
      const providers = ["gemini", "openai", "anthropic"];
      const order = missingProvider ? [Object.keys(PROVIDER_LABEL).find((p) => PROVIDER_LABEL[p] === missingProvider), ...providers] : providers;
      const seen = new Set();
      const items = [];
      for (const p of order) {
        if (!p || seen.has(p)) continue;
        seen.add(p);
        const has = Boolean(await apiKeyFor(p));
        items.push({ label: PROVIDER_LABEL[p], description: has ? L("ya tiene una key guardada", "already has a saved key") : L("sin key", "no key"), provider: p });
      }
      const picked = await vscode.window.showQuickPick(items, { placeHolder: L("Que proveedor? (el modelo que uses decide cual hace falta -- ver /diag)", "Which provider? (the model you use decides which one is needed -- see /diag)") });
      if (!picked) return;
      const key = await vscode.window.showInputBox({
        prompt: L(`Tu API key de ${picked.label} (se guarda cifrada en el almacen de secretos de VS Code, nunca en texto plano)`, `Your ${picked.label} API key (stored encrypted in VS Code's secret storage, never in plain text)`),
        password: true,
        ignoreFocusOut: true,
      });
      if (key) {
        await context.secrets.store(SECRET_KEY_FOR(picked.provider), key.trim());
        vscode.window.showInformationMessage(L(`SovNode: API key de ${picked.label} guardada.`, `SovNode: ${picked.label} API key saved.`));
        postConfig();
      }
    }),
    vscode.commands.registerCommand("sovnodeAider.openChat", () => vscode.commands.executeCommand("sovnodeAider.chatView.focus")),
    vscode.commands.registerCommand("sovnodeAider.undo", () => undoLast()),
    vscode.commands.registerCommand("sovnodeAider.editProjectMemory", () => openProjectMemory()),
    vscode.commands.registerCommand("sovnodeAider.toggleArchitect", async () => {
      await vscode.commands.executeCommand("sovnodeAider.chatView.focus");
      return handleSlash("/architect");
    }),
    vscode.commands.registerCommand("sovnodeAider.toggleAgent", async () => {
      await vscode.commands.executeCommand("sovnodeAider.chatView.focus");
      return handleSlash("/agent");
    }),
    vscode.commands.registerCommand("sovnodeAider.diagnose", async () => {
      await vscode.commands.executeCommand("sovnodeAider.chatView.focus");
      return runDiagnostics();
    }),
    vscode.commands.registerCommand("sovnodeAider.addActiveFile", () => onWebviewMessage({ type: "addActive" })),
    // Adjuntar log: lo seleccionado en el editor (por ejemplo un .log
    // abierto), o si no hay seleccion, lo que haya en el portapapeles.
    vscode.commands.registerCommand("sovnodeAider.attachLog", async () => {
      const ed = vscode.window.activeTextEditor;
      const sel = ed && !ed.selection.isEmpty ? ed.document.getText(ed.selection) : "";
      await vscode.commands.executeCommand("sovnodeAider.chatView.focus").then(undefined, () => {});
      if (sel) return attachLog(sel, "", L("la seleccion", "the selection"));
      return attachLog(await vscode.env.clipboard.readText(), "", L("el portapapeles", "the clipboard"));
    }),
    // Desde el menu del boton derecho de la TERMINAL: toma lo seleccionado
    // ahi (Terminal.selection existe desde VS Code 1.93; en versiones viejas
    // se copia la seleccion al portapapeles y se lee de ahi).
    vscode.commands.registerCommand("sovnodeAider.attachTerminalSelection", async () => {
      const term = vscode.window.activeTerminal;
      let text = term && typeof term.selection === "string" ? term.selection : "";
      if (!text) {
        await vscode.commands.executeCommand("workbench.action.terminal.copySelection").then(undefined, () => {});
        text = await vscode.env.clipboard.readText();
      }
      await vscode.commands.executeCommand("sovnodeAider.chatView.focus").then(undefined, () => {});
      return attachLog(text, "", L("la terminal", "the terminal"));
    }),
    vscode.commands.registerCommand("sovnodeAider.showUsageLog", async () => {
      rt.output.show(true);
      try {
        const doc = await vscode.workspace.openTextDocument(usageLogUri());
        await vscode.window.showTextDocument(doc, { preview: true });
      } catch (_) {
        vscode.window.showInformationMessage(L("Todavia no hay turnos registrados.", "No turns recorded yet."));
      }
    }),
    vscode.commands.registerCommand("sovnodeAider.showSessionLog", async () => {
      const sessionLogUri = getSessionLogUri();
      if (!sessionLogUri) return vscode.window.showInformationMessage(L("El log de esta sesion todavia no se pudo crear.", "This session's log could not be created yet."));
      try {
        const doc = await vscode.workspace.openTextDocument(sessionLogUri);
        await vscode.window.showTextDocument(doc, { preview: true });
      } catch (_) {
        vscode.window.showInformationMessage(L("Todavia no hay nada registrado en esta sesion.", "Nothing recorded in this session yet."));
      }
    })
  );
  log("SovNode activado. Cada turno se registra aqui con tokens, latencia y costo.");
}

function deactivate() {}

module.exports = { activate, deactivate, _test: { projectMemoryText, initSessionLog, pruneOldSessionLogs, warnIfExpensive, state } };
