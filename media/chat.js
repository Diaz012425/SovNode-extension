// UI del chat de SovNode (webview). Sin dependencias externas.
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const messagesEl = $("messages");
  const qEl = $("q");
  let LANG = "es";
  const tr = (es, en) => (LANG === "en" ? en : es);
  const turns = new Map(); // turnId -> {el, thoughtsEl, liveEl, phaseEl, ctxEl}

  // ------------------------------------------------------------ utilidades
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const fmtUsd = (v) => (!v ? "$0" : v < 0.0001 ? "<$0.0001" : v < 0.01 ? "$" + v.toFixed(5) : "$" + v.toFixed(4));
  const fmtN = (n) => (n || 0).toLocaleString(LANG);
  const fmtMs = (ms) => (ms == null ? "-" : ms < 1000 ? ms + " ms" : (ms / 1000).toFixed(1) + " s");

  function inline(s) {
    return esc(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
      .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<i>$2</i>");
  }

  // Markdown minimo: bloques de codigo (con boton Copiar), titulos, listas
  // (con y sin numero), separadores y parrafos. Todo pasa por esc(): el
  // texto del modelo NUNCA se inserta como HTML crudo.
  const codeStore = []; // texto real de cada bloque, para "Copiar"
  function md(text) {
    const out = [];
    const lines = String(text || "").split("\n");
    let i = 0;
    let para = [];
    let list = [];
    let listTag = "ul";
    const flushPara = () => { if (para.length) { out.push("<p>" + inline(para.join(" ")) + "</p>"); para = []; } };
    const flushList = () => { if (list.length) { out.push(`<${listTag}>` + list.map((l) => "<li>" + inline(l) + "</li>").join("") + `</${listTag}>`); list = []; } };
    while (i < lines.length) {
      const line = lines[i];
      const fence = /^(`{3,})\s*([\w.+#-]*)/.exec(line);
      if (fence) {
        flushPara(); flushList();
        const close = new RegExp("^" + fence[1] + "\\s*$");
        const buf = [];
        i++;
        while (i < lines.length && !close.test(lines[i])) buf.push(lines[i++]);
        const code = buf.join("\n");
        const id = codeStore.push(code) - 1;
        out.push(`<div class="codeblock"><div class="cb-head"><span>${esc(fence[2] || tr("codigo", "code"))}</span><button class="fbtn cb-copy" data-code="${id}">${tr("Copiar", "Copy")}</button></div><pre><code>${esc(code)}</code></pre></div>`);
        i++;
        continue;
      }
      const h = /^(#{1,4})\s+(.*)$/.exec(line);
      if (h) { flushPara(); flushList(); out.push("<h4>" + inline(h[2]) + "</h4>"); i++; continue; }
      if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { flushPara(); flushList(); out.push("<hr>"); i++; continue; }
      const li = /^\s*([-*]|\d+[.)])\s+(.*)$/.exec(line);
      if (li) {
        const tag = /\d/.test(li[1]) ? "ol" : "ul";
        flushPara();
        if (list.length && tag !== listTag) flushList();
        listTag = tag;
        list.push(li[2]);
        i++;
        continue;
      }
      if (!line.trim()) { flushPara(); flushList(); i++; continue; }
      flushList();
      para.push(line);
      i++;
    }
    flushPara(); flushList();
    return out.join("");
  }

  function hideEmpty() { const e = $("empty"); if (e) e.remove(); }
  // Auto-scroll SOLO si ya estabas abajo: antes cada token del streaming te
  // arrastraba al final aunque estuvieras leyendo algo mas arriba.
  let stick = true;
  const nearBottom = () => messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 60;
  messagesEl.addEventListener("scroll", () => { stick = nearBottom(); $("toBottom").hidden = stick; });
  function scroll(force) {
    if (force) stick = true;
    if (stick) messagesEl.scrollTop = messagesEl.scrollHeight;
    else $("toBottom").hidden = false;
  }
  $("toBottom").addEventListener("click", () => scroll(true));
  // "Copiar" de los bloques de codigo (delegado: los bloques se crean despues)
  messagesEl.addEventListener("click", (e) => {
    const b = e.target.closest && e.target.closest(".cb-copy");
    if (!b) return;
    vscode.postMessage({ type: "copyText", text: codeStore[Number(b.dataset.code)] || "", quiet: true });
    b.textContent = tr("Copiado ✓", "Copied ✓");
    setTimeout(() => (b.textContent = tr("Copiar", "Copy")), 1400);
  });
  function el(tag, cls, html) { const d = document.createElement(tag); if (cls) d.className = cls; if (html != null) d.innerHTML = html; return d; }

  const tasks = new Map(); // taskId -> {el, listEl, statusEl, steps, current}

  function renderTaskSteps(t) {
    t.listEl.innerHTML = (t.steps || []).map((s, i) => {
      const cls = i < t.current ? "done" : i === t.current ? "active" : "";
      const mark = i < t.current ? "✓" : i === t.current ? "▶" : `${i + 1}.`;
      return `<li class="${cls}"><span class="mark">${mark}</span> ${esc(s)}</li>`;
    }).join("");
  }

  function addMsg(cls, html) {
    hideEmpty();
    const d = el("div", "msg " + cls, html);
    messagesEl.appendChild(d);
    scroll();
    return d;
  }

  // ------------------------------------------------------------ composer
  function autoResize() {
    qEl.style.height = "auto";
    const h = Math.min(qEl.scrollHeight, 200);
    qEl.style.height = h + "px";
    qEl.style.overflowY = qEl.scrollHeight > 200 ? "auto" : "hidden";
  }
  let busy = false;
  function send(text) {
    const t = (text != null ? text : qEl.value).trim();
    if (!t) return;
    // Mientras hay un turno en curso solo se permiten comandos de consulta;
    // el host igual lo valida, esto evita el doble-Enter accidental.
    if (busy && !t.startsWith("/")) return;
    if (!t.startsWith("/")) {
      const extra = currentLogs.length ? tr(`<span class="logs-used">🐞 con ${currentLogs.length} log${currentLogs.length === 1 ? "" : "s"} adjunto${currentLogs.length === 1 ? "" : "s"}</span>`, `<span class="logs-used">🐞 with ${currentLogs.length} log${currentLogs.length === 1 ? "" : "s"} attached</span>`) : "";
      addMsg("user", esc(t) + extra);
    } else addMsg("system", "<code>" + esc(t) + "</code>");
    scroll(true);
    qEl.value = "";
    autoResize();
    vscode.postMessage({ type: "send", text: t });
  }
  qEl.addEventListener("input", autoResize);
  qEl.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } });
  $("send").addEventListener("click", () => send());
  $("stop").addEventListener("click", () => vscode.postMessage({ type: "cancel" }));
  $("btnKey").addEventListener("click", () => vscode.postMessage({ type: "setKey" }));
  $("btnArch").addEventListener("click", () => vscode.postMessage({ type: "slash", text: "/architect" }));
  $("btnAgent").addEventListener("click", () => vscode.postMessage({ type: "slash", text: "/agent" }));
  // Modelo principal agrupado por proveedor (<optgroup>) -- puramente para
  // que el desplegable no sea una lista plana de 13 nombres sin relacion
  // aparente entre si; el valor que se manda con "setModel" sigue siendo
  // solo el string del modelo, el proveedor lo infiere el backend por el
  // nombre (providerForModel en providers.js).
  function renderModelGroups(groups, current) {
    const sel = $("model");
    const known = new Set(Object.values(groups || {}).flat());
    let html = Object.entries(groups || {})
      .map(([label, models]) => `<optgroup label="${esc(label)}">${models.map((x) => `<option value="${esc(x)}" ${x === current ? "selected" : ""}>${x === "auto" ? tr("Auto (elige SovNode)", "Auto (SovNode picks)") : esc(x)}</option>`).join("")}</optgroup>`)
      .join("");
    if (!known.has(current)) html += `<option selected>${esc(current)}</option>`; // modelo custom escrito a mano en settings.json
    sel.innerHTML = html;
  }
  // Ordenada del mas barato al mas caro (ya viene ordenada por output desde
  // extension.js); el valor final lo fija renderArch() justo despues, asi
  // que aca no hace falta preservar la seleccion anterior.
  function renderEditorChoices(choices) {
    $("editorModel").innerHTML = '<option value="">' + tr("(mismo que el principal)", "(same as main)") + '</option>' + (choices || [])
      .map((c) => `<option value="${esc(c.model)}">${esc(c.model)} — ${esc(fmtUsd(c.price.output))}/M tok out</option>`)
      .join("");
  }
  function renderArch(m) {
    const ag = $("btnAgent");
    ag.classList.toggle("on", Boolean(m.agentMode));
    ag.title = m.agentMode
      ? tr("Modo agente ACTIVADO: /task reintenta y replanifica cuando algo falla (clic para desactivar)", "Agent mode ON: /task retries and replans when something fails (click to turn off)")
      : tr("Modo agente (/agent): /task reintenta y replanifica solo cuando algo falla", "Agent mode (/agent): /task retries and replans only when something fails");
    const b = $("btnArch");
    b.classList.toggle("on", Boolean(m.architect));
    b.title = m.architect
      ? tr(`Modo arquitecto ACTIVADO: ${m.model} planea → ${m.editorModel || m.model} escribe (clic para desactivar)`, `Architect mode ON: ${m.model} plans → ${m.editorModel || m.model} writes (click to turn off)`)
      : tr("Modo arquitecto (/architect): un modelo planea, otro escribe el codigo", "Architect mode (/architect): one model plans, another writes the code");
    if (m.editorChoices) renderEditorChoices(m.editorChoices);
    $("editorRow").hidden = !m.architect;
    $("editorModel").value = m.editorModel || "";
  }
  $("btnUndo").addEventListener("click", () => vscode.postMessage({ type: "undo" }));
  $("btnClear").addEventListener("click", () => vscode.postMessage({ type: "slash", text: "/clear" }));
  $("model").addEventListener("change", (e) => vscode.postMessage({ type: "setModel", value: e.target.value }));
  $("effort").addEventListener("change", (e) => vscode.postMessage({ type: "setEffort", value: e.target.value }));
  $("editorModel").addEventListener("change", (e) => vscode.postMessage({ type: "setEditorModel", value: e.target.value }));
  document.querySelectorAll(".ex").forEach((b) => b.addEventListener("click", () => send(b.textContent)));

  function setBusy(b) {
    busy = b;
    $("send").hidden = b;
    $("stop").hidden = !b;
    $("status").classList.toggle("busy", b);
    $("status").title = b ? tr("Trabajando...", "Working...") : tr("Listo", "Ready");
  }

  // ------------------------------------------------------------ logs de bug
  // El error va APARTE (panel 🐞 -> chip), y el chat queda para contar que
  // estabas haciendo. El host lo manda en cada turno hasta que lo quites.
  let currentLogs = [];
  function openLogPanel(prefill) {
    $("logPanel").hidden = false;
    if (prefill != null) $("logText").value = prefill;
    $("logText").focus();
  }
  function closeLogPanel() {
    $("logPanel").hidden = true;
    $("logText").value = "";
    $("logLabel").value = "";
  }
  $("btnLog").addEventListener("click", () => ($("logPanel").hidden ? openLogPanel() : closeLogPanel()));
  $("logCancel").addEventListener("click", closeLogPanel);
  $("logAdd").addEventListener("click", () => {
    const text = $("logText").value;
    if (!text.trim()) { $("logText").focus(); return; }
    vscode.postMessage({ type: "attachLog", text, label: $("logLabel").value });
    closeLogPanel();
    qEl.focus();
  });
  $("logClip").addEventListener("click", () => { vscode.postMessage({ type: "logFromClipboard", label: $("logLabel").value }); closeLogPanel(); qEl.focus(); });
  $("logProblems").addEventListener("click", () => { vscode.postMessage({ type: "logFromProblems" }); closeLogPanel(); qEl.focus(); });
  $("logText").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) $("logAdd").click(); if (e.key === "Escape") closeLogPanel(); });

  // Cronometro del turno en curso (en la linea de fase).
  let timer = null;
  function startTimer(t) {
    const started = Date.now();
    clearInterval(timer);
    timer = setInterval(() => {
      const e = t.phaseEl && t.phaseEl.querySelector(".elapsed");
      if (!e || !t.phaseEl.isConnected) return clearInterval(timer);
      e.textContent = fmtMs(Date.now() - started);
    }, 500);
  }

  // ------------------------------------------------------------ chips de contexto
  let currentFiles = [];
  function renderChips(files) {
    if (files) currentFiles = files; else files = currentFiles;
    const c = $("chips");
    c.innerHTML = "";
    currentLogs.forEach((l, i) => {
      const chip = el("div", "chip log");
      chip.title = tr(`Log adjunto (${fmtN(l.chars)} car.${l.truncated ? ", recortado" : ""}${l.redacted ? ", claves ocultas" : ""}). Clic para verlo. Se manda en cada turno hasta que lo quites.`, `Attached log (${fmtN(l.chars)} chars${l.truncated ? ", truncated" : ""}${l.redacted ? ", secrets hidden" : ""}). Click to view it. Sent with every turn until you remove it.`);
      const lab = el("span", null, "🐞 " + esc(l.label));
      lab.addEventListener("click", () => vscode.postMessage({ type: "previewLog", index: i }));
      const x = el("button", null, "✕");
      x.title = tr("Quitar este log", "Remove this log");
      x.addEventListener("click", () => vscode.postMessage({ type: "dropLog", index: i }));
      chip.append(lab, x);
      c.appendChild(chip);
    });
    for (const f of files || []) {
      const chip = el("div", "chip" + (f.active ? " active" : ""));
      chip.title = f.active ? tr("Archivo activo del editor (se incluye automaticamente)", "Active editor file (included automatically)") : tr("Archivo agregado al chat", "File added to chat");
      chip.appendChild(el("span", null, esc(f.path)));
      if (!f.active) {
        const x = el("button", null, "✕");
        x.title = tr("Quitar del chat", "Remove from chat");
        x.addEventListener("click", () => vscode.postMessage({ type: "dropFile", path: f.path }));
        chip.appendChild(x);
      }
      c.appendChild(chip);
    }
    const add = el("div", "chip add", tr("+ fijar archivo activo", "+ pin active file"));
    add.title = tr("Mantener el archivo activo en el chat aunque cambies de pestaña (o usa /add ruta)", "Keep the active file in the chat even if you switch tabs (or use /add path)");
    add.addEventListener("click", () => vscode.postMessage({ type: "addActive" }));
    c.appendChild(add);
  }

  function renderSession(s) {
    if (!s || !s.turns) { $("session").textContent = ""; return; }
    const u = s.usage || {};
    $("session").textContent = tr(`Sesion: ${s.turns} turno${s.turns === 1 ? "" : "s"}`, `Session: ${s.turns} turn${s.turns === 1 ? "" : "s"}`) + ` · ${fmtN(u.promptTokens)} in · ${fmtN((u.outputTokens || 0) + (u.thoughtTokens || 0))} out · ${fmtUsd((s.cost || {}).totalUsd)}`;
  }

  // ------------------------------------------------------------ turnos
  function startTurn(m) {
    hideEmpty();
    const d = el("div", "msg assistant");
    d.appendChild(el("div", "role", `<span class="av">◆</span>SovNode <span class="tag">${esc(m.model)} · ${esc(m.effort)}${m.architect ? tr(" · 🏛 arquitecto", " · 🏛 architect") : ""}</span>`));
    const ctxEl = el("div", "ctx");
    const phaseEl = el("div", "phase", '<span class="dot"></span><span class="ptxt">' + tr("Pensando...", "Thinking...") + '</span><span class="elapsed"></span>');
    // Pensamientos plegados por default: estan para quien quiera mirarlos,
    // no para empujar la respuesta fuera de la pantalla.
    const thoughtsEl = el("details", "thoughts");
    thoughtsEl.innerHTML = "<summary>" + tr("Pensamientos", "Thoughts") + "</summary><div class='body'></div>";
    thoughtsEl.hidden = true;
    const liveEl = el("div", "live");
    d.append(ctxEl, phaseEl, thoughtsEl, liveEl);
    messagesEl.appendChild(d);
    const t = { el: d, ctxEl, phaseEl, thoughtsEl, liveEl };
    turns.set(m.turnId, t);
    setBusy(true);
    startTimer(t);
    scroll(true);
  }

  function fileCard(turnId, f) {
    const card = el("div", "fcard");
    const added = f.changes.reduce((a, c) => a + c.added, 0);
    const removed = f.changes.reduce((a, c) => a + c.removed, 0);
    const head = el("div", "fhead");
    head.innerHTML = `<span class="badge ${f.created ? "create" : "edit"}">${f.created ? tr("nuevo", "new") : tr("editado", "edited")}</span>
      <span class="fpath" title="${tr("Abrir", "Open")}">${esc(f.path)}</span>
      <span class="stat"><span class="a">+${added}</span> <span class="d">-${removed}</span></span>`;
    head.querySelector(".fpath").addEventListener("click", () => vscode.postMessage({ type: "openFile", path: f.path, line: (f.changes[0] || {}).line || 1 }));
    if (!f.created) {
      const diff = el("button", "fbtn", "diff");
      diff.title = tr("Ver antes/despues lado a lado", "View before/after side by side");
      diff.addEventListener("click", () => vscode.postMessage({ type: "showDiff", path: f.path, turnId }));
      head.appendChild(diff);
    }
    card.appendChild(head);
    const hunks = el("div", "hunks");
    for (const c of f.changes) {
      const kind = c.kind === "create" ? tr("archivo nuevo", "new file") : c.kind === "append" ? tr("agregado al final", "appended at end") : c.kind === "rewrite" ? tr("archivo reescrito (desde aca cambia)", "file rewritten (changes from here)") : tr("reemplazo", "replacement");
      const h = el("details", "hunk");
      h.innerHTML = `<summary>${tr("Linea", "Line")} ${c.line}: ${kind} · <span class="stat"><span class="a">+${c.added}</span> <span class="d">-${c.removed}</span></span>${c.tolerant ? tr(" · (tolerando espacios)", " · (whitespace-tolerant)") : ""}</summary>` +
        (c.search && c.search.trim() ? `<pre class="minus">${esc(c.search.split("\n").map((l) => "- " + l).join("\n"))}</pre>` : "") +
        `<pre class="plus">${esc(c.replace.split("\n").slice(0, 60).map((l) => "+ " + l).join("\n"))}${c.replace.split("\n").length > 60 ? "\n+ ..." : ""}</pre>`;
      h.querySelector("summary").addEventListener("dblclick", () => vscode.postMessage({ type: "openFile", path: f.path, line: c.line }));
      hunks.appendChild(h);
    }
    card.appendChild(hunks);
    return card;
  }

  function costBlock(m) {
    const u = m.usage || {};
    const k = m.cost || {};
    const totalMs = (m.calls || []).reduce((a, c) => a + (c.latencyMs || 0), 0);
    const d = el("details", "cost");
    d.innerHTML = `<summary><b>${fmtUsd(k.totalUsd)}</b><span>${fmtN(u.promptTokens)} in</span><span>${fmtN(u.outputTokens)} out</span><span>${fmtN(u.thoughtTokens)} ${tr("razonamiento", "reasoning")}</span><span>${fmtMs(totalMs)}</span><span>${(m.calls || []).length} ${tr("llamada", "call")}${(m.calls || []).length === 1 ? "" : "s"}</span></summary>
      <div class="costgrid">
        <span class="k">${tr("Input nuevo", "New input")}</span><span class="v">${fmtN((u.promptTokens || 0) - (u.cachedTokens || 0))} tok · ${fmtUsd(k.inputUsd)}</span>
        <span class="k">${tr("Input en cache", "Cached input")}</span><span class="v">${fmtN(u.cachedTokens)} tok · ${fmtUsd(k.cachedUsd)} (${tr("ahorro", "saved")} ${fmtUsd(k.savedByCacheUsd)})</span>
        <span class="k">${tr("Output visible", "Visible output")}</span><span class="v">${fmtN(u.outputTokens)} tok · ${fmtUsd(k.outputUsd)}</span>
        <span class="k">${tr("Razonamiento", "Reasoning")}</span><span class="v">${fmtN(u.thoughtTokens)} tok · ${fmtUsd(k.thoughtUsd)}</span>
        <span class="k">${tr("Total turno", "Turn total")}</span><span class="v"><b>${fmtUsd(k.totalUsd)}</b></span>
      </div>
      <div class="calls">${(m.calls || []).map((c) => `<div>· ${esc(c.kind)}: ${fmtN(c.usage.promptTokens)} in / ${fmtN(c.usage.outputTokens)} out / ${fmtN(c.usage.thoughtTokens)} ${tr("raz", "reas")} · ${fmtMs(c.latencyMs)} (${tr("1er token", "1st token")} ${fmtMs(c.firstTokenMs)}) · ${esc(c.finishReason || "-")} · ${fmtUsd(c.cost.totalUsd)}</div>`).join("")}</div>`;
    return d;
  }

  function endTurn(m) {
    const t = turns.get(m.turnId);
    setBusy(false);
    if (!t) return;
    t.phaseEl.remove();
    t.liveEl.remove();
    clearInterval(timer);
    if (t.archEl) t.archEl.remove(); // el plan queda en la respuesta final
    if (t.thoughtsEl.hidden === false) t.thoughtsEl.open = false;
    if (m.prose) t.el.appendChild(el("div", "md", md(m.prose)));
    if (m.filesChanged && m.filesChanged.length) {
      const box = el("div", "changes");
      for (const f of m.filesChanged) box.appendChild(fileCard(m.turnId, f));
      t.el.appendChild(box);
    }
    if (m.failures && m.failures.length) {
      const card = el("div", "fcard");
      card.appendChild(el("div", "fhead", tr(`<span class="badge fail">no aplicado</span><span>Ningun archivo fue modificado</span>`, `<span class="badge fail">not applied</span><span>No files were modified</span>`)));
      for (const f of m.failures) card.appendChild(el("div", "failure", `<b>${esc(f.path)}</b>: ${esc(f.reason)}`));
      t.el.appendChild(card);
    }
    for (const n of m.notes || []) t.el.appendChild(el("div", "notes" + (/^Commit|^Verificacion OK/.test(n) ? " ok" : ""), (/^Commit|^Verificacion OK/.test(n) ? "✓ " : "⚠ ") + esc(n)));
    if (m.calls && m.calls.length) t.el.appendChild(costBlock(m));
    renderSession(m.session);
    scroll();
  }

  const FORMAT_NAMES = () => ({ "search-replace": "SEARCH/REPLACE", udiff: tr("diff unificado", "unified diff"), whole: tr("archivo completo", "whole file") });
  window.addEventListener("message", (event) => {
    const m = event.data;
    const t = turns.get(m.turnId);
    switch (m.type) {
      case "init":
        LANG = m.lang === "en" ? "en" : "es";
        renderModelGroups(m.modelGroups, m.model);
        $("effort").value = m.effort;
        renderArch(m);
        $("btnKey").classList.toggle("warn", !m.hasKey);
        if (!m.hasKey) addMsg("system", tr(`Falta tu API key de ${m.missingProvider || "el proveedor configurado"}: pulsa 🔑 arriba.`, `Missing your ${m.missingProvider || "configured provider"} API key: click 🔑 above.`));
        currentLogs = m.logs || [];
        renderChips(m.files);
        renderSession(m.session);
        break;
      case "logs":
        currentLogs = m.logs || [];
        renderChips();
        break;
      case "config":
        LANG = m.lang === "en" ? "en" : "es";
        if (![...$("model").options].some((o) => o.value === m.model)) $("model").insertAdjacentHTML("beforeend", `<option>${esc(m.model)}</option>`);
        $("model").value = m.model;
        $("effort").value = m.effort;
        renderArch(m);
        $("btnKey").classList.toggle("warn", !m.hasKey);
        break;
      case "hasKey":
        $("btnKey").classList.toggle("warn", !m.value);
        break;
      case "files":
        renderChips(m.files);
        break;
      case "turnStart":
        startTurn(m);
        break;
      case "context":
        if (t) {
          const c = m.context;
          const pills = [];
          for (const f of [...(c.archFiles || []), ...c.files]) {
            if (f.archBase) pills.push(`<span class="pill focus" title="${tr(`Arquitecto: archivo base (cacheado) + ${f.archBase.changed} lineas de cambios${f.archBase.rebased ? " · base nueva este turno (todavia sin cache)" : ""}`, `Architect: base file (cached) + ${f.archBase.changed} changed lines${f.archBase.rebased ? " · new base this turn (not cached yet)" : ""}`)}">📌 ${esc(f.path)} · ${f.archBase.rebased ? tr("base nueva", "new base") : tr(`base + ${f.archBase.changed} lin.`, `base + ${f.archBase.changed} lines`)}</span>`);
            else if (f.focus) pills.push(`<span class="pill focus" title="${tr(`Extracto: ${f.focus.shown} de ${f.focus.total} lineas (${esc((f.focus.reasons || []).join(", "))}) · ${fmtN(f.chars)} car.`, `Excerpt: ${f.focus.shown} of ${f.focus.total} lines (${esc((f.focus.reasons || []).join(", "))}) · ${fmtN(f.chars)} chars`)}">🎯 ${esc(f.path)} · ${f.focus.shown}/${f.focus.total} ${tr("lin.", "lines")}</span>`);
            else pills.push(`<span class="pill" title="${esc(f.path)} · ${fmtN(f.chars)} ${tr("car.", "chars")}">📄 ${esc(f.path)}</span>`);
          }
          if (!c.files.length) pills.push('<span class="pill">' + tr("sin archivos", "no files") + '</span>');
          for (const l of c.logs || []) pills.push(`<span class="pill log" title="${fmtN(l.chars)} ${tr("car.", "chars")}">🐞 ${esc(l.label)}</span>`);
          pills.push(`<span class="pill" title="${tr("Mapa del repositorio", "Repository map")}">${tr("mapa", "map")} ${fmtN(c.repoMapChars)} ${tr("car.", "chars")}</span>`);
          pills.push(`<span class="pill" title="${tr("Mensajes previos reenviados", "Previous messages resent")}">${tr("historial", "history")} ${c.historyMsgs}</span>`);
          if (c.editFormat) pills.push(`<span class="pill" title="${esc(c.editFormatReason || "")}">${tr("formato", "format")}: ${esc(FORMAT_NAMES()[c.editFormat] || c.editFormat)}</span>`);
          t.ctxEl.innerHTML = pills.join("");
        }
        break;
      case "phase":
        if (t) t.phaseEl.querySelector(".ptxt").textContent = m.text;
        break;
      case "thought":
        if (t) {
          t.thoughtsEl.hidden = false;
          const body = t.thoughtsEl.querySelector(".body");
          body.textContent += m.text;
          body.scrollTop = 1e9;
          t.thoughtsEl.querySelector("summary").textContent = tr(`Pensamientos (${fmtN(body.textContent.length)} car.)`, `Thoughts (${fmtN(body.textContent.length)} chars)`);
          scroll();
        }
        break;
      case "delta":
        if (t) { t.phaseEl.querySelector(".ptxt").textContent = tr("Escribiendo...", "Writing..."); t.liveEl.textContent += m.text; t.liveEl.scrollTop = 1e9; scroll(); }
        break;
      case "resetStream":
        if (t) t.liveEl.textContent = "";
        break;
      case "info":
        if (t) t.el.insertBefore(el("div", "notes info", "ℹ " + esc(m.text)), t.phaseEl);
        else if (m.taskId != null) addMsg("system", "ℹ " + esc(m.text));
        break;
      case "archPlan": {
        if (!t) break;
        const d = el("details", "thoughts archplan");
        d.open = true;
        d.innerHTML = "<summary>" + tr("🏛 Plan del arquitecto", "🏛 Architect's plan") + "</summary>";
        d.appendChild(el("div", "md", md(m.text)));
        t.el.insertBefore(d, t.phaseEl);
        t.archEl = d;
        scroll();
        break;
      }
      case "verifyResult": {
        if (!t) break;
        const bad = (m.results || []).filter((r) => r.ok === false);
        const ok = (m.results || []).filter((r) => r.ok === true);
        const skipped = (m.results || []).filter((r) => r.skipped);
        if (bad.length) {
          const card = el("div", "fcard");
          card.appendChild(el("div", "fhead", tr(`<span class="badge fail">verificacion</span><span>${bad.length} archivo(s) con error</span>`, `<span class="badge fail">verification</span><span>${bad.length} file(s) with errors</span>`)));
          for (const r of bad) card.appendChild(el("div", "failure", `<b>${esc(r.path)}</b>: ${esc(r.reason || "error")}`));
          t.el.insertBefore(card, t.phaseEl);
        } else if (ok.length || skipped.length) {
          const parts = [];
          if (ok.length) parts.push(`${ok.length} ok`);
          if (skipped.length) parts.push(tr(`${skipped.length} sin verificador`, `${skipped.length} without verifier`));
          t.el.insertBefore(el("div", "notes", tr("✓ Verificacion: ", "✓ Verification: ") + esc(parts.join(", "))), t.phaseEl);
        }
        scroll();
        break;
      }
      case "verifyCommand": {
        if (!t) break;
        if (m.ok) {
          t.el.insertBefore(el("div", "notes", tr(`✓ Comando de verificacion ("${esc(m.command)}") OK`, `✓ Verification command ("${esc(m.command)}") OK`)), t.phaseEl);
        } else {
          const card = el("div", "fcard");
          card.appendChild(el("div", "fhead", tr(`<span class="badge fail">verificacion</span><span>Comando "${esc(m.command)}" fallo</span>`, `<span class="badge fail">verification</span><span>Command "${esc(m.command)}" failed</span>`)));
          card.appendChild(el("div", "failure", `<pre>${esc((m.output || "").slice(0, 2000))}</pre>`));
          t.el.insertBefore(card, t.phaseEl);
        }
        scroll();
        break;
      }
      case "turnEnd":
        endTurn(m);
        break;
      case "idle":
        setBusy(false);
        break;
      case "error": {
        // No toca el estado ocupado: el host manda "idle" cuando el turno de
        // verdad termino (un error ajeno no debe esconder el boton Detener).
        if (t) { t.phaseEl.remove(); t.liveEl.remove(); clearInterval(timer); }
        const full = m.text + (m.stack ? "\n\n" + m.stack : "");
        const box = el("div", "msg error", `<div class="etitle">⚠ ${esc(m.text)}</div>`);
        if (m.stack) box.appendChild(el("details", null, `<summary>${tr("Ver detalle tecnico", "Show technical details")}</summary><pre>${esc(m.stack)}</pre>`));
        const btns = el("div", "row-btns");
        const copy = el("button", "fbtn", tr("Copiar diagnostico", "Copy diagnostics"));
        copy.addEventListener("click", () => { vscode.postMessage({ type: "copyText", text: full }); copy.textContent = tr("Copiado ✓", "Copied ✓"); setTimeout(() => (copy.textContent = tr("Copiar diagnostico", "Copy diagnostics")), 1500); });
        // El error de SovNode mismo tambien se puede adjuntar como log, para
        // preguntarle al modelo que paso sin copiar/pegar nada.
        const att = el("button", "fbtn", tr("🐞 Adjuntar como log", "🐞 Attach as log"));
        att.title = tr("Adjunta este error como log y explica en el chat que estabas haciendo", "Attach this error as a log and explain in the chat what you were doing");
        att.addEventListener("click", () => { vscode.postMessage({ type: "attachLog", text: full, label: m.text.slice(0, 60) }); att.textContent = tr("Adjuntado ✓", "Attached ✓"); att.disabled = true; qEl.focus(); });
        btns.append(copy, att);
        box.appendChild(btns);
        hideEmpty();
        messagesEl.appendChild(box);
        scroll();
        break;
      }
      case "system": {
        const d = addMsg("system", md(m.text));
        if (m.copy) {
          const b = el("button", "fbtn", tr("Copiar diagnostico", "Copy diagnostics"));
          b.style.marginTop = "6px";
          b.addEventListener("click", () => { vscode.postMessage({ type: "copyText", text: m.copy }); b.textContent = tr("Copiado ✓", "Copied ✓"); });
          d.appendChild(b);
        }
        break;
      }
      case "taskStart": {
        hideEmpty();
        const box = el("div", "task");
        box.appendChild(el("div", "task-head", `🧭 <b>${tr("Tarea:", "Task:")}</b> ${esc(m.objective)} <span class="tag">${esc(m.model)}</span>`));
        const statusEl = el("div", "task-status", tr("Planificando los pasos...", "Planning the steps..."));
        const listEl = el("ol", "task-steps");
        box.append(statusEl, listEl);
        messagesEl.appendChild(box);
        tasks.set(m.taskId, { el: box, listEl, statusEl, steps: [], current: 0 });
        scroll();
        break;
      }
      case "taskPhase": {
        const tk = tasks.get(m.taskId);
        if (tk) tk.statusEl.textContent = m.text;
        break;
      }
      case "taskPlan": {
        const tk = tasks.get(m.taskId);
        if (!tk) break;
        tk.steps = m.steps;
        tk.statusEl.textContent = tr(`${m.steps.length} paso(s) planeados.`, `${m.steps.length} step(s) planned.`);
        renderTaskSteps(tk);
        scroll();
        break;
      }
      case "taskStep": {
        const tk = tasks.get(m.taskId);
        if (!tk) break;
        tk.current = m.index;
        tk.statusEl.textContent = tr(`Paso ${m.index + 1} de ${m.total}...`, `Step ${m.index + 1} of ${m.total}...`);
        renderTaskSteps(tk);
        scroll();
        break;
      }
      case "taskEnd": {
        const tk = tasks.get(m.taskId);
        if (!tk) break;
        tk.current = m.ok ? tk.steps.length : tk.current;
        renderTaskSteps(tk);
        tk.statusEl.textContent = m.ok
          ? tr(`✓ Tarea completa: ${m.total} de ${m.total} paso(s).`, `✓ Task complete: ${m.total} of ${m.total} step(s).`)
          : tr(`⚠ Tarea detenida en el paso ${Math.min(m.done + 1, m.total)} de ${m.total}${m.reason ? ": " + m.reason : ""}`, `⚠ Task stopped at step ${Math.min(m.done + 1, m.total)} of ${m.total}${m.reason ? ": " + m.reason : ""}`);
        tk.el.classList.toggle("task-done", Boolean(m.ok));
        tk.el.classList.toggle("task-stopped", !m.ok);
        tasks.delete(m.taskId);
        scroll();
        break;
      }
      case "cleared":
        messagesEl.innerHTML = "";
        addMsg("system", tr("Conversacion nueva. Los archivos no se tocaron; usa /undo para revertir cambios.", "New conversation. Files were not touched; use /undo to revert changes."));
        break;
    }
  });

  autoResize();
  vscode.postMessage({ type: "ready" });
})();
