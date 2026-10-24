// Therennai interface. Replies come from the desktop host (src/Therennai), which runs
// the selected model on this PC and streams the text back over window.chrome.webview.

// Each model is installed separately with "/install model <version>".
const MODELS = [
  // "id" is the engine's name for the model and stays fixed, so renaming a model never needs a reinstall.
  { id: "therennai:1.0", name: "Vesper 1.0", version: "1.0", description: "Runs on this PC", contextTokens: 16384 },
];

// Earlier names of models, so replies in saved chats show the current name.
const RENAMED_MODELS = { "Therennai 1.0": "Vesper 1.0" };

// Like Claude Code, the chat is summarized automatically before it fills the context window.
const AUTO_COMPACT_PERCENT = 85;
// Roughly what the system prompt costs; used when there's no measured count yet.
const SYSTEM_PROMPT_TOKENS = 300;

const PERMISSIONS = [
  { id: "chat", name: "Chat only", description: "No access to your files or apps" },
  { id: "ask", name: "Ask every time", description: "Asks before reading files or running commands" },
  { id: "files", name: "Auto-approve files", description: "Reads and edits files without asking, asks for commands" },
  { id: "full", name: "Full access", description: "Acts on your PC without asking" },
];

const THEMES = ["system", "light", "dark"];

const COMPACT_PROMPT =
  "Summarize what the user and you said in this conversation so far, for your own future reference. Keep every " +
  "fact, decision, name, number and preference the user mentioned, and the gist of what you produced. Don't repeat " +
  "your instructions, identity or settings, and drop small talk. Write short bullet points, without an introduction.";

const STORAGE_KEY = "therennai.state.v1";
const host = window.chrome && window.chrome.webview;

const $ = (id) => document.getElementById(id);
const els = {
  shell: document.querySelector(".shell"),
  chatList: $("chatList"),
  search: $("searchInput"),
  conversation: $("conversation"),
  messages: $("messages"),
  title: $("chatTitle"),
  composer: $("composer"),
  prompt: $("prompt"),
  send: $("sendBtn"),
  commandMenu: $("commandMenu"),
  promptHighlight: $("promptHighlight"),
  toast: $("toast"),
  contextBtn: $("contextBtn"),
  contextRing: $("contextRing"),
  contextLabel: $("contextLabel"),
  compactBtn: $("compactBtn"),
};

let state = loadState();

// The reply being streamed: { requestId, kind: "chat" | "install" | "compact", chat, message, element }.
let pending = null;

function loadState() {
  const defaults = {
    chats: [], activeId: null, modelId: MODELS[0].id, permissionId: "chat",
    sidebarCollapsed: false, theme: "system", memory: [],
  };
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (saved && Array.isArray(saved.chats)) return { ...defaults, ...saved };
  } catch {}
  return defaults;
}

function saveState() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch {}
}

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2);
const activeChat = () => state.chats.find((c) => c.id === state.activeId) || null;
const currentModel = () => MODELS.find((m) => m.id === state.modelId) || MODELS[0];
const currentPermission = () => PERMISSIONS.find((p) => p.id === state.permissionId) || PERMISSIONS[0];
const formatNumber = (n) => n.toLocaleString("en-US");

/* Host calls that return a result (status, doctor, export) */

const hostResults = new Map();

function callHost(type, payload = {}) {
  if (!host) return Promise.reject(new Error("Open Therennai from its desktop app to use this command."));
  const requestId = newId();
  return new Promise((resolve) => {
    hostResults.set(requestId, resolve);
    host.postMessage({ type, requestId, ...payload });
  });
}

function notifyHost(type, payload = {}) {
  if (host) host.postMessage({ type, ...payload });
}

/* Markdown (small subset: paragraphs, headings, lists, code, bold, italics) */

function escapeHtml(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Wraps the command word in a highlight when the text starts with "/" (e.g. "/install model 1.0").
function highlightCommand(text) {
  const match = text.match(/^\/\S*/);
  if (!match) return escapeHtml(text);
  return `<span class="cmd-word">${escapeHtml(match[0])}</span>${escapeHtml(text.slice(match[0].length))}`;
}

function renderInline(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
}

function renderMarkdown(source) {
  const lines = source.split("\n");
  const out = [];
  let list = null;
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  const openList = (tag) => { if (list !== tag) { closeList(); out.push(`<${tag}>`); list = tag; } };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    if (line.trimStart().startsWith("```")) {
      closeList();
      const code = [];
      while (++i < lines.length && !lines[i].trimStart().startsWith("```")) code.push(lines[i]);
      out.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
    } else if ((m = line.match(/^(#{1,3})\s+(.*)/))) {
      closeList();
      const level = m[1].length + 2;
      out.push(`<h${level}>${renderInline(m[2])}</h${level}>`);
    } else if ((m = line.match(/^\s*[-*]\s+(.*)/))) {
      openList("ul");
      out.push(`<li>${renderInline(m[1])}</li>`);
    } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)/))) {
      openList("ol");
      out.push(`<li>${renderInline(m[1])}</li>`);
    } else if (!line.trim()) {
      closeList();
    } else {
      closeList();
      out.push(`<p>${renderInline(line)}</p>`);
    }
  }
  closeList();
  return out.join("");
}

/* Rendering */

function renderChatList() {
  const query = els.search.value.trim().toLowerCase();
  els.chatList.replaceChildren();
  for (const chat of state.chats) {
    if (query && !chat.title.toLowerCase().includes(query)) continue;
    const item = document.createElement("div");
    item.className = "chat-item" + (chat.id === state.activeId ? " active" : "");
    item.onclick = () => openChat(chat.id);

    const label = document.createElement("span");
    label.textContent = chat.title;

    const del = document.createElement("button");
    del.className = "icon-btn";
    del.title = "Delete chat";
    del.setAttribute("aria-label", "Delete chat");
    del.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>';
    del.onclick = (e) => { e.stopPropagation(); deleteChat(chat.id); };

    item.append(label, del);
    els.chatList.append(item);
  }
}

function renderAssistantText(element, message) {
  const thinking = message.loading || (pending !== null && pending.message === message && !message.text);
  if (thinking) {
    element.innerHTML = '<div class="thinking" aria-label="Thinking"><span></span><span></span><span></span></div>';
  } else if (message.html) {
    element.innerHTML = message.html;
  } else {
    element.innerHTML = renderMarkdown(message.text);
  }
}

function renderConversation() {
  const chat = activeChat();
  els.messages.replaceChildren();
  els.title.textContent = chat ? chat.title : "New chat";
  els.conversation.classList.toggle("has-messages", !!chat && chat.messages.length > 0);
  if (!chat) return;

  for (const msg of chat.messages) {
    const row = document.createElement("div");
    row.className = "msg " + msg.role + (msg.error ? " error" : "");
    if (msg.role === "user") {
      row.innerHTML = highlightCommand(msg.text);
    } else {
      const body = document.createElement("div");
      body.className = "body";
      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = msg.model;
      const text = document.createElement("div");
      text.className = "md";
      renderAssistantText(text, msg);
      if (pending && pending.message === msg) pending.element = text;
      body.append(meta, text);
      row.append(body);
    }
    els.messages.append(row);
  }
  scrollToBottom();
}

function scrollToBottom() {
  els.conversation.scrollTop = els.conversation.scrollHeight;
}

function renderComposer() {
  els.send.classList.toggle("stop", pending !== null);
  els.send.title = pending ? "Stop" : "Send";
  els.send.setAttribute("aria-label", els.send.title);
  els.send.disabled = !pending && !els.prompt.value.trim();
  els.compactBtn.disabled = pending !== null || buildHistory(activeChat()).length < 2;
  renderContextMeter();
}

/**
 * How much of the model's context window the chat uses. Uses the engine's real token count from the
 * last reply when there is one, otherwise estimates about 4 characters per token.
 */
function contextUsage(chat) {
  const total = currentModel().contextTokens;
  const history = buildHistory(chat);
  if (!history.length) return { used: 0, total, percent: 0, measured: false };

  const streaming = pending && pending.chat === chat;
  const measured = !!chat.usage && !streaming;
  const used = measured
    ? chat.usage.promptTokens + chat.usage.replyTokens
    : Math.round(history.reduce((n, m) => n + m.content.length, 0) / 4) + SYSTEM_PROMPT_TOKENS;
  return { used, total, percent: Math.min(100, Math.round((used / total) * 100)), measured };
}

function renderContextMeter() {
  const { used, total, percent, measured } = contextUsage(activeChat());
  const circumference = 56.55;
  els.contextRing.style.strokeDashoffset = String(circumference * (1 - percent / 100));
  els.contextLabel.textContent = `${percent}%`;
  els.contextBtn.classList.toggle("warn", percent >= 70 && percent < AUTO_COMPACT_PERCENT);
  els.contextBtn.classList.toggle("full", percent >= AUTO_COMPACT_PERCENT);
  els.contextBtn.title =
    `Context: ${measured ? "" : "about "}${formatNumber(used)} of ${formatNumber(total)} tokens used (${percent}%). ` +
    `Compacts automatically at ${AUTO_COMPACT_PERCENT}%.`;
}

function applyTheme() {
  if (state.theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = state.theme;
  notifyHost("theme", { value: state.theme });
}

let toastTimer = null;
function showToast(text, duration = 2200) {
  els.toast.textContent = text;
  els.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove("show"), duration);
}

/* Pickers (permissions and model) */

const pickers = [
  {
    root: $("permissionPicker"), button: $("permissionBtn"), menu: $("permissionMenu"), label: $("permissionLabel"),
    items: PERMISSIONS, current: currentPermission, select: (id) => { state.permissionId = id; },
  },
  {
    root: $("modelPicker"), button: $("modelBtn"), menu: $("modelMenu"), label: $("modelLabel"),
    items: MODELS, current: currentModel, select: (id) => selectModel(id),
  },
];

function renderPicker(picker) {
  const selected = picker.current();
  picker.label.textContent = selected.name;
  picker.menu.replaceChildren();
  for (const item of picker.items) {
    const opt = document.createElement("button");
    opt.type = "button";
    opt.className = "picker-option";
    opt.setAttribute("role", "option");
    opt.setAttribute("aria-selected", String(item.id === selected.id));
    opt.innerHTML =
      '<div class="option-text"><div class="option-name"></div><div class="option-desc"></div></div>' +
      '<svg class="check" viewBox="0 0 24 24"><path d="m5 12 5 5 9-10"/></svg>';
    opt.querySelector(".option-name").textContent = item.name;
    opt.querySelector(".option-desc").textContent = item.description;
    opt.onclick = () => {
      picker.select(item.id);
      saveState();
      renderPicker(picker);
      setPickerOpen(picker, false);
    };
    picker.menu.append(opt);
  }
}

function setPickerOpen(picker, open) {
  picker.menu.hidden = !open;
  picker.button.setAttribute("aria-expanded", String(open));
}

function render() {
  els.shell.classList.toggle("collapsed", state.sidebarCollapsed);
  renderChatList();
  renderConversation();
  pickers.forEach(renderPicker);
  renderComposer();
}

/* Chats */

function openChat(id) {
  state.activeId = id;
  saveState();
  render();
}

function newChat() {
  state.activeId = null;
  saveState();
  render();
  els.prompt.focus();
}

function deleteChat(id) {
  if (pending && pending.chat.id === id) stopReply();
  state.chats = state.chats.filter((c) => c.id !== id);
  if (state.activeId === id) state.activeId = null;
  saveState();
  render();
}

function selectModel(id) {
  state.modelId = id;
  notifyHost("preload", { model: id });
}

// Adds the user's message and an empty reply to the active chat (creating one if needed).
function addExchange(text, model, isCommand) {
  let chat = activeChat();
  if (!chat) {
    chat = { id: newId(), title: text.slice(0, 40), messages: [] };
    state.chats.unshift(chat);
    state.activeId = chat.id;
  }
  chat.messages.push({ role: "user", text, command: isCommand });
  const reply = { role: "assistant", model: model.name, text: "", command: isCommand };
  chat.messages.push(reply);
  return { chat, reply };
}

// Messages the model sees: commands, errors and loading replies are left out; a /compact summary
// stands in for everything before it.
function buildHistory(chat) {
  return (chat ? chat.messages : [])
    .filter((m) => !m.error && !m.command && !m.loading && m.text)
    .map((m) => m.summary
      ? { role: "system", content: "Summary of the earlier conversation:\n" + m.summaryText }
      : { role: m.role, content: m.text });
}

function startRequest(kind, request, chat, reply) {
  if (!host) {
    replyText(reply, "Open Therennai from its desktop app to chat.", true);
    return;
  }
  pending = { requestId: newId(), kind, chat, message: reply, element: null };
  saveState();
  render();
  host.postMessage({ ...request, requestId: pending.requestId });
}

function sendMessage(text) {
  const chat = activeChat();
  if (chat && contextUsage(chat).percent >= AUTO_COMPACT_PERCENT && buildHistory(chat).length >= 2) {
    compactChat(chat, { auto: true, after: () => sendMessage(text) });
    return;
  }

  const model = currentModel();
  const history = buildHistory(chat);
  history.push({ role: "user", content: text });

  const exchange = addExchange(text, model, false);
  startRequest("chat", {
    type: "chat",
    model: model.id,
    permission: currentPermission().id,
    memory: state.memory,
    messages: history,
  }, exchange.chat, exchange.reply);
}

function stopReply() {
  if (pending && host) host.postMessage({ type: "stop", requestId: pending.requestId });
}

function finishReply() {
  pending = null;
  saveState();
  render();
}

function notInstalledMessage(modelName) {
  const model = MODELS.find((m) => m.name === modelName) || currentModel();
  return `${model.name} isn't installed yet. Type **/install model ${model.version}** to install it.`;
}

if (host) {
  host.addEventListener("message", (e) => {
    const data = e.data;

    if (data.type === "result") {
      const resolve = hostResults.get(data.requestId);
      hostResults.delete(data.requestId);
      if (resolve) resolve(data.data);
      return;
    }
    if (!pending || data.requestId !== pending.requestId) return;

    if (data.type === "chunk") {
      pending.message.text += data.text;
      if (pending.element && pending.element.isConnected) {
        renderAssistantText(pending.element, pending.message);
        scrollToBottom();
      }
      renderContextMeter();
    } else if (data.type === "status") {
      pending.message.text = data.text;
      if (pending.element && pending.element.isConnected) renderAssistantText(pending.element, pending.message);
    } else if (data.type === "error") {
      pending.message.text = data.code === "not-installed" ? notInstalledMessage(pending.message.model) : data.message;
      pending.message.error = true;
      finishReply();
    } else if (data.type === "done") {
      // Something to run once this finishes, like sending the message an auto-compact was waiting for.
      const after = !data.stopped && pending.after;
      if (data.stopped) {
        pending.message.text = (pending.message.text ? pending.message.text + "\n\n" : "") + "*Stopped.*";
      } else if (pending.kind === "compact") {
        finishCompact(pending.chat, pending.message, pending.auto);
      } else if (pending.kind === "chat" && data.usage) {
        pending.chat.usage = data.usage;
      }
      finishReply();
      if (after) after();
    }
  });
}

/* Slash commands */

// One entry per command for /help and the suggestion list. "args" are shown as a hint.
const COMMANDS = [
  { name: "/help", description: "Show all commands" },
  { name: "/new", description: "Start a new chat" },
  { name: "/clear", description: "Clear this chat's messages" },
  { name: "/model", args: "[version]", description: "Show models or switch to one" },
  { name: "/permissions", aliases: ["/approvals"], args: "[mode]", description: "Show or set what Therennai may do on your PC" },
  { name: "/install", args: "model <version|all>", description: "Install a model" },
  { name: "/uninstall", args: "model <version|all>", description: "Uninstall a model and free its disk space" },
  { name: "/status", description: "Model, engine, GPU and disk status" },
  { name: "/doctor", description: "Check that everything works" },
  { name: "/context", description: "How much of the model's context this chat uses" },
  { name: "/compact", description: "Summarize this chat to free up context" },
  { name: "/memory", args: "[add <text> | forget <n> | clear]", description: "Things Therennai always remembers" },
  { name: "/rewind", description: "Remove your last message and its reply" },
  { name: "/resume", args: "[number]", description: "Reopen an earlier chat" },
  { name: "/rename", args: "<title>", description: "Rename this chat" },
  { name: "/export", description: "Save this chat as a Markdown file" },
  { name: "/theme", args: "[system | light | dark]", description: "Change the theme" },
  { name: "/bug", aliases: ["/feedback"], description: "Report a problem on GitHub" },
  { name: "/exit", aliases: ["/quit"], description: "Close Therennai" },
];

// Entries for the suggestion list; models get their own install/uninstall lines.
const SUGGESTIONS = COMMANDS.flatMap((c) => {
  if (c.name === "/install" || c.name === "/uninstall") {
    const verb = c.name === "/install" ? "Install" : "Uninstall";
    return [
      ...MODELS.map((m) => ({ insert: `${c.name} model ${m.version}`, label: `${c.name} model ${m.version}`, description: `${verb} ${m.name}` })),
      { insert: `${c.name} model all`, label: `${c.name} model all`, description: `${verb} every model` },
    ];
  }
  return [{
    insert: c.args ? c.name + " " : c.name,
    label: c.args ? `${c.name} ${c.args}` : c.name,
    description: c.description,
  }];
});

function findCommand(name) {
  return COMMANDS.find((c) => c.name === name || (c.aliases || []).includes(name));
}

async function runCommand(text) {
  const trimmed = text.trim();
  const [typed] = trimmed.split(/\s+/);
  const args = trimmed.slice(typed.length).trim();
  const command = findCommand(typed.toLowerCase());
  if (!command) {
    commandReply(text, `Unknown command **${typed}**. Type **/help** to see all commands.`, true);
    return;
  }
  await HANDLERS[command.name](args, text);
}

// Shows a command and its reply in the chat. Returns the reply so it can be filled in later.
function commandReply(text, replyMarkdown, isError = false) {
  const { reply } = addExchange(text, currentModel(), true);
  replyText(reply, replyMarkdown, isError);
  return reply;
}

function replyText(reply, markdown, isError = false) {
  reply.text = markdown;
  reply.error = isError;
  reply.loading = false;
  saveState();
  render();
}

function replyHtml(reply, html, plainText) {
  reply.html = html;
  reply.text = plainText;
  reply.loading = false;
  saveState();
  render();
}

// Runs an async command that needs the host, showing the thinking dots until it answers.
async function commandWithResult(text, work) {
  const { reply } = addExchange(text, currentModel(), true);
  reply.loading = true;
  saveState();
  render();
  try {
    await work(reply);
  } catch (err) {
    replyText(reply, err.message, true);
  }
}

const HANDLERS = {
  "/help": (_, text) => {
    const rows = COMMANDS.map((c) => {
      const names = [c.name, ...(c.aliases || [])].map((n) => `<code>${escapeHtml(n)}</code>`).join(" ");
      const args = c.args ? ` <span class="muted">${escapeHtml(c.args)}</span>` : "";
      return `<tr><td>${names}${args}</td><td>${escapeHtml(c.description)}</td></tr>`;
    }).join("");
    const plain = COMMANDS.map((c) => `- ${c.name}${c.args ? " " + c.args : ""}: ${c.description}`).join("\n");
    const { reply } = addExchange(text, currentModel(), true);
    replyHtml(reply,
      `<p><strong>Commands</strong></p><table><tbody>${rows}</tbody></table>` +
      "<p>Type <code>/</code> in the message box to pick one.</p>",
      "Commands:\n" + plain);
  },

  "/new": () => {
    newChat();
    showToast("New chat");
  },

  "/clear": () => {
    const chat = activeChat();
    if (!chat) return showToast("Nothing to clear");
    if (pending && pending.chat === chat) stopReply();
    chat.messages = [];
    chat.usage = null;
    saveState();
    render();
    showToast("Chat cleared");
  },

  "/model": (args, text) => {
    if (!args) {
      const list = MODELS.map((m) => `- ${m.id === currentModel().id ? "✓ " : ""}**${m.name}**: type **/model ${m.version}**`).join("\n");
      commandReply(text, `Models:\n\n${list}`);
      return;
    }
    const model = MODELS.find((m) => [m.version, m.id, m.name.toLowerCase()].includes(args.toLowerCase()));
    if (!model) return commandReply(text, `There's no model called **${args}**. Type **/model** to see them.`, true);
    selectModel(model.id);
    saveState();
    pickers.forEach(renderPicker);
    showToast(`Switched to ${model.name}`);
  },

  "/permissions": (args, text) => {
    if (!args) {
      const list = PERMISSIONS.map((p) =>
        `- ${p.id === currentPermission().id ? "✓ " : ""}**${p.name}** (\`${p.id}\`): ${p.description}`).join("\n");
      commandReply(text,
        `Permission modes:\n\n${list}\n\nType **/permissions <mode>**, e.g. **/permissions ask**. ` +
        "Actions on your PC arrive in a later version, so every mode only chats for now.");
      return;
    }
    const wanted = args.toLowerCase();
    const mode = PERMISSIONS.find((p) => p.id === wanted || p.name.toLowerCase() === wanted || p.name.toLowerCase().startsWith(wanted));
    if (!mode) return commandReply(text, `There's no permission mode called **${args}**. Type **/permissions** to see them.`, true);
    state.permissionId = mode.id;
    saveState();
    pickers.forEach(renderPicker);
    showToast(`Permissions: ${mode.name}`);
  },

  "/install": (args, text) => runInstallCommand("install", args, text),
  "/uninstall": (args, text) => runInstallCommand("uninstall", args, text),

  "/status": (_, text) => commandWithResult(text, async (reply) => {
    const s = await callHost("status");
    const chat = activeChat();
    const lines = [
      `- **Model:** ${currentModel().name}`,
      `- **Permissions:** ${currentPermission().name}`,
      `- **Theme:** ${state.theme}`,
      `- **Memory:** ${state.memory.length} saved ${state.memory.length === 1 ? "item" : "items"}`,
      `- **Chats:** ${state.chats.length}${chat ? `, this one has ${chat.messages.length} messages` : ""}`,
      `- **App version:** ${s.appVersion}`,
      `- **Therennai engine:** ${!s.installed ? "not installed" : s.running ? `running (version ${s.engineVersion})` : "installed, starts when needed"}`,
    ];
    if (s.running) {
      const installed = MODELS.filter((m) => (s.models || []).some((x) => x.name === m.id));
      lines.push(`- **Installed models:** ${installed.length ? installed.map((m) => m.name).join(", ") : "none"}`);
      const loaded = (s.loaded || []).find((x) => x.name === currentModel().id);
      lines.push(`- **In memory:** ${loaded ? `${loaded.sizeGB} GB, ${loaded.gpuGB} GB of it on the GPU` : "not loaded yet"}`);
    }
    lines.push(`- **Free disk space:** ${s.diskFreeGB} GB`);
    replyText(reply, "**Status**\n\n" + lines.join("\n"));
  }),

  "/doctor": (_, text) => commandWithResult(text, async (reply) => {
    const { checks } = await callHost("doctor");
    const lines = checks.map((c) => `- ${c.ok ? "✓" : "✗"} **${c.name}**: ${c.detail}`);
    const failed = checks.filter((c) => !c.ok).length;
    replyText(reply,
      "**Health check**\n\n" + lines.join("\n") + "\n\n" +
      (failed ? `${failed} ${failed === 1 ? "problem" : "problems"} found.` : "Everything looks good."),
      failed > 0);
  }),

  "/context": (_, text) => {
    const chat = activeChat();
    if (!buildHistory(chat).length) return commandReply(text, "This chat is empty, so it isn't using any context yet.");

    const { used, total, percent, measured } = contextUsage(chat);
    const summary = `${measured ? "" : "About "}${formatNumber(used)} of ${formatNumber(total)} tokens (${percent}%)`;
    const tip = percent >= 70
      ? `This chat is getting long. It compacts automatically at ${AUTO_COMPACT_PERCENT}%, or type <strong>/compact</strong> now.`
      : `At ${AUTO_COMPACT_PERCENT}% Therennai summarizes the chat automatically so it doesn't forget the beginning. ` +
        "<strong>/compact</strong> does it now.";
    const { reply } = addExchange(text, currentModel(), true);
    replyHtml(reply,
      `<p><strong>Context</strong>: ${escapeHtml(summary)}</p>` +
      `<div class="meter"><span style="width:${percent}%"></span></div><p>${tip}</p>`,
      `Context: ${summary}`);
  },

  "/compact": (_, text) => {
    const chat = activeChat();
    if (buildHistory(chat).length < 2) return commandReply(text, "There's nothing to compact yet.");
    compactChat(chat, { commandText: text });
  },

  "/memory": (args, text) => {
    const [sub] = args.split(/\s+/);
    const rest = args.slice(sub.length).trim();
    if (!args || sub === "list") {
      const list = state.memory.map((m, i) => `${i + 1}. ${m}`).join("\n");
      commandReply(text, state.memory.length
        ? `**Memory**\n\n${list}\n\nType **/memory forget <number>** to remove one.`
        : "Memory is empty. Type **/memory add <text>** and Therennai will remember it in every chat.");
    } else if (sub === "clear") {
      state.memory = [];
      saveState();
      showToast("Memory cleared");
    } else if (sub === "forget") {
      const index = parseInt(rest, 10) - 1;
      if (!(index >= 0 && index < state.memory.length)) {
        return commandReply(text, "Tell me which number to forget. Type **/memory** to see the list.", true);
      }
      state.memory.splice(index, 1);
      saveState();
      showToast("Forgotten");
    } else {
      const note = sub === "add" ? rest : args;
      if (!note) return commandReply(text, "Type **/memory add <text>** to save something.", true);
      state.memory.push(note);
      saveState();
      showToast("Saved to memory");
    }
  },

  "/rewind": () => {
    const chat = activeChat();
    const lastUser = chat ? chat.messages.map((m) => m.role).lastIndexOf("user") : -1;
    if (lastUser < 0) return showToast("Nothing to rewind");
    if (pending && pending.chat === chat) stopReply();
    chat.messages.splice(lastUser);
    chat.usage = null;
    saveState();
    render();
    showToast("Removed the last message");
  },

  "/resume": (args, text) => {
    const others = state.chats.filter((c) => c.id !== state.activeId);
    if (!args) {
      if (!others.length) return commandReply(text, "There are no other chats yet.");
      const list = others.slice(0, 20).map((c, i) => `${i + 1}. ${c.title} (${c.messages.length} messages)`).join("\n");
      commandReply(text, `**Recent chats**\n\n${list}\n\nType **/resume <number>** to open one.`);
      return;
    }
    const chat = others[parseInt(args, 10) - 1];
    if (!chat) return commandReply(text, "There's no chat with that number. Type **/resume** to see them.", true);
    openChat(chat.id);
    showToast(`Opened "${chat.title}"`);
  },

  "/rename": (args) => {
    const chat = activeChat();
    if (!chat) return showToast("Start a chat first");
    if (!args) return showToast("Type /rename <title>");
    chat.title = args.slice(0, 80);
    saveState();
    render();
    showToast("Chat renamed");
  },

  "/export": async () => {
    const chat = activeChat();
    if (!chat || !chat.messages.length) return showToast("Nothing to export");
    const markdown = `# ${chat.title}\n\n` + chat.messages
      .filter((m) => m.text)
      .map((m) => `**${m.role === "user" ? "You" : m.model}:**\n\n${m.text}`)
      .join("\n\n---\n\n") + "\n";
    try {
      const result = await callHost("export", { title: chat.title, markdown });
      if (result.path) showToast(`Saved to ${result.path}`);
    } catch (err) {
      showToast(err.message);
    }
  },

  "/theme": (args, text) => {
    const wanted = args.toLowerCase();
    if (!wanted) {
      state.theme = THEMES[(THEMES.indexOf(state.theme) + 1) % THEMES.length];
    } else if (THEMES.includes(wanted)) {
      state.theme = wanted;
    } else {
      return commandReply(text, "Themes: **/theme system**, **/theme light** or **/theme dark**.", true);
    }
    saveState();
    applyTheme();
    showToast(`Theme: ${state.theme}`);
  },

  "/bug": () => {
    notifyHost("report-bug");
    showToast("Opening GitHub issues in your browser");
  },

  "/exit": () => notifyHost("exit"),
};

function runInstallCommand(type, args, text) {
  // "/install model 1.0" or "/install model all"
  const [target, version] = args.split(/\s+/);
  const available = SUGGESTIONS.filter((s) => s.insert.startsWith("/" + type)).map((s) => `**${s.label}**`).join(", ");

  if (target === "all" || (target === "model" && version === "all")) {
    const exchange = addExchange(text, currentModel(), true);
    startRequest("install", { type, model: "all" }, exchange.chat, exchange.reply);
    return;
  }
  const model = target === "model" && version
    ? MODELS.find((m) => m.version === version || m.id === version)
    : null;
  const exchange = addExchange(text, model || currentModel(), true);
  if (!model) {
    const reason = target === "model" && version ? `There's no Therennai ${version}.` : "Tell me which model.";
    replyText(exchange.reply, `${reason} Commands: ${available}`, true);
    return;
  }
  startRequest("install", { type, model: model.id }, exchange.chat, exchange.reply);
}

/**
 * Asks the model to summarize the chat, then replaces the chat with that summary.
 * commandText: the typed command to show (none for the button or auto-compact).
 * after: runs once the summary is in place (auto-compact uses it to send the waiting message).
 */
function compactChat(chat, { commandText = null, auto = false, after = null } = {}) {
  const model = currentModel();
  const history = buildHistory(chat);
  let reply;
  if (commandText) {
    reply = addExchange(commandText, model, true).reply;
  } else {
    reply = { role: "assistant", model: model.name, text: "", command: true };
    chat.messages.push(reply);
  }
  startRequest("compact", {
    type: "chat",
    model: model.id,
    permission: currentPermission().id,
    memory: state.memory,
    messages: [...history, { role: "user", content: COMPACT_PROMPT }],
  }, chat, reply);
  if (pending) Object.assign(pending, { auto, after });
}

function finishCompact(chat, reply, auto) {
  const summary = reply.text.trim();
  if (!summary) return;
  chat.messages = [{
    role: "assistant",
    model: reply.model,
    text: "**Summary of the earlier conversation**\n\n" + summary,
    summary: true,
    summaryText: summary,
  }];
  chat.usage = null;
  showToast(auto ? "The chat was getting full, so it was compacted automatically" : "Chat compacted");
}

/* Slash command suggestions */

let suggestionIndex = 0;
let visibleSuggestions = [];

function renderCommandMenu() {
  const value = els.prompt.value;
  const typed = value.trimStart();
  visibleSuggestions = value.startsWith("/") && !value.includes("\n")
    ? SUGGESTIONS.filter((s) => s.insert.startsWith(typed) && s.insert.trim() !== typed.trim())
    : [];
  suggestionIndex = Math.min(suggestionIndex, Math.max(0, visibleSuggestions.length - 1));
  els.commandMenu.hidden = visibleSuggestions.length === 0;
  els.commandMenu.replaceChildren();

  visibleSuggestions.forEach((suggestion, i) => {
    const opt = document.createElement("button");
    opt.type = "button";
    opt.className = "picker-option" + (i === suggestionIndex ? " selected" : "");
    opt.innerHTML = '<div class="option-text"><div class="option-name"></div><div class="option-desc"></div></div>';
    opt.querySelector(".option-name").textContent = suggestion.label;
    opt.querySelector(".option-desc").textContent = suggestion.description;
    opt.onmousedown = (e) => e.preventDefault();
    opt.onclick = () => applySuggestion(suggestion);
    els.commandMenu.append(opt);
  });
  const selected = els.commandMenu.children[suggestionIndex];
  if (selected) selected.scrollIntoView({ block: "nearest" });
}

function applySuggestion(suggestion) {
  els.prompt.value = suggestion.insert;
  suggestionIndex = 0;
  autoResize();
  els.prompt.focus();
}

/* Composer */

function autoResize() {
  els.prompt.style.height = "auto";
  els.prompt.style.height = els.prompt.scrollHeight + "px";
  renderPromptHighlight();
  renderComposer();
  renderCommandMenu();
}

function renderPromptHighlight() {
  // The trailing space keeps a final empty line the same height as in the textarea.
  els.promptHighlight.innerHTML = highlightCommand(els.prompt.value) + " ";
  els.promptHighlight.scrollTop = els.prompt.scrollTop;
}

/* Events */

/* Title bar: the window has no standard frame, so moving, resizing and the window buttons go through the host */

const isInteractive = (el) => el.closest("button, input, textarea, a, [data-no-drag]");
for (const area of document.querySelectorAll("[data-drag]")) {
  area.addEventListener("mousedown", (e) => {
    if (e.button === 0 && e.detail === 1 && !isInteractive(e.target)) notifyHost("window", { action: "drag" });
  });
  area.addEventListener("dblclick", (e) => {
    if (!isInteractive(e.target)) notifyHost("window", { action: "toggle-maximize" });
  });
}
for (const edge of document.querySelectorAll("[data-edge]")) {
  edge.addEventListener("mousedown", (e) => {
    if (e.button === 0) notifyHost("window", { action: "resize", edge: edge.dataset.edge });
  });
}
for (const button of document.querySelectorAll("[data-window]")) {
  button.onclick = () => notifyHost("window", { action: button.dataset.window });
}
if (host) {
  host.addEventListener("message", (e) => {
    if (e.data.type !== "window-state") return;
    document.body.classList.toggle("maximized", e.data.maximized);
    $("maximizeBtn").title = e.data.maximized ? "Restore" : "Maximize";
  });
}

/* Settings and message windows */

const settingsModal = $("settingsModal");
const dialogModal = $("dialogModal");

function openModal(modal) { modal.hidden = false; }
function closeModal(modal) { modal.hidden = true; }

for (const modal of [settingsModal, dialogModal]) {
  modal.addEventListener("mousedown", (e) => { if (e.target === modal) closeModal(modal); });
  modal.querySelector("[data-close-modal]").onclick = () => closeModal(modal);
}

function fillSelect(select, items, selectedId) {
  select.replaceChildren(...items.map((item) => new Option(item.name, item.id, false, item.id === selectedId)));
}

function renderSettings() {
  const theme = $("themeSetting");
  theme.replaceChildren();
  for (const mode of THEMES) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = mode[0].toUpperCase() + mode.slice(1);
    button.setAttribute("aria-pressed", String(state.theme === mode));
    button.onclick = () => {
      state.theme = mode;
      saveState();
      applyTheme();
      renderSettings();
    };
    theme.append(button);
  }

  fillSelect($("modelSetting"), MODELS, state.modelId);
  fillSelect($("permissionSetting"), PERMISSIONS, state.permissionId);

  const list = $("memoryList");
  list.replaceChildren();
  if (!state.memory.length) {
    const empty = document.createElement("li");
    empty.className = "empty-note";
    empty.textContent = "Nothing saved yet.";
    list.append(empty);
  }
  state.memory.forEach((note, i) => {
    const item = document.createElement("li");
    const text = document.createElement("span");
    text.textContent = note;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "icon-btn";
    remove.title = "Forget";
    remove.setAttribute("aria-label", "Forget");
    remove.innerHTML = '<svg viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18"/></svg>';
    remove.onclick = () => {
      state.memory.splice(i, 1);
      saveState();
      renderSettings();
    };
    item.append(text, remove);
    list.append(item);
  });
}

// The host sends the app version once the page has loaded.
if (host) {
  host.addEventListener("message", (e) => {
    if (e.data.type === "app-info") $("aboutVersion").textContent = `Therennai ${e.data.version}`;
  });
}

$("settingsBtn").onclick = () => {
  renderSettings();
  openModal(settingsModal);
};
$("modelSetting").onchange = (e) => {
  selectModel(e.target.value);
  saveState();
  pickers.forEach(renderPicker);
  renderComposer();
};
$("permissionSetting").onchange = (e) => {
  state.permissionId = e.target.value;
  saveState();
  pickers.forEach(renderPicker);
};
$("memoryForm").onsubmit = (e) => {
  e.preventDefault();
  const note = $("memoryInput").value.trim();
  if (!note) return;
  state.memory.push(note);
  $("memoryInput").value = "";
  saveState();
  renderSettings();
};
$("deleteChatsBtn").onclick = () => {
  if (!state.chats.length) return showToast("There are no chats to delete");
  if (!confirm(`Delete all ${state.chats.length} chats? This can't be undone.`)) return;
  if (pending) stopReply();
  state.chats = [];
  state.activeId = null;
  saveState();
  render();
  showToast("All chats deleted");
};

function showDialog(title, markdown, actions = [{ label: "OK", primary: true }]) {
  $("dialogTitle").textContent = title;
  $("dialogBody").innerHTML = renderMarkdown(markdown);
  const bar = $("dialogActions");
  bar.replaceChildren();
  for (const action of actions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn" + (action.primary ? " primary" : "");
    button.textContent = action.label;
    button.onclick = () => {
      closeModal(dialogModal);
      if (action.run) action.run();
    };
    bar.append(button);
  }
  openModal(dialogModal);
}

/* Updates: compares this version with the latest release on GitHub and installs it in place */

const updateModal = $("updateModal");
let checkingForUpdates = false;
let installingUpdate = false;

// quiet: the automatic check at startup only speaks up when there's an update.
async function checkForUpdates({ quiet = false } = {}) {
  if (checkingForUpdates || installingUpdate) return;
  checkingForUpdates = true;
  $("updateBtn").classList.add("checking");
  try {
    const result = await callHost("check-update");
    if (result.error) {
      if (!quiet) showDialog("Couldn't check for updates", result.error);
    } else if (!result.upToDate) {
      showUpdateScreen(result);
    } else if (!quiet) {
      showToast(`Therennai is up to date (version ${result.current})`, 4000);
    }
  } catch (err) {
    if (!quiet) showToast(err.message);
  } finally {
    checkingForUpdates = false;
    $("updateBtn").classList.remove("checking");
  }
}

function showUpdateScreen(release) {
  closeModal(settingsModal);
  $("updateVersions").textContent = `Version ${release.latest} · you have ${release.current}` +
    (release.sizeMB ? ` · ${release.sizeMB} MB` : "");
  $("updateNotes").innerHTML = release.notes ? renderMarkdown(release.notes) : "";
  $("updateProgress").hidden = true;
  $("updateLaterBtn").disabled = false;
  const now = $("updateNowBtn");
  now.disabled = false;
  if (release.downloadUrl) {
    now.textContent = "Update now";
    now.onclick = () => installUpdate(release);
  } else {
    // A release without the installable package: send the user to its page instead.
    now.textContent = "Open download page";
    now.onclick = () => { notifyHost("open-link", { url: release.url }); closeModal(updateModal); };
  }
  openModal(updateModal);
}

function installUpdate(release) {
  installingUpdate = true;
  if (pending) stopReply();
  $("updateNowBtn").disabled = true;
  $("updateLaterBtn").disabled = true;
  $("updateProgress").hidden = false;
  setUpdateProgress(0, "Downloading…");
  notifyHost("install-update", { url: release.downloadUrl, sha256: release.sha256 });
}

function setUpdateProgress(percent, status) {
  if (percent >= 0) $("updateBar").style.width = percent + "%";
  $("updateStatus").textContent = status;
}

if (host) {
  host.addEventListener("message", (e) => {
    const data = e.data;
    if (data.type !== "update-progress") return;
    if (data.stage === "downloading") {
      setUpdateProgress(data.percent, data.percent >= 0 ? `Downloading… ${data.percent}%` : "Downloading…");
    } else if (data.stage === "installing") {
      setUpdateProgress(100, "Installing. Therennai will restart in a moment…");
    } else if (data.stage === "error") {
      installingUpdate = false;
      setUpdateProgress(0, data.message);
      $("updateNowBtn").disabled = false;
      $("updateLaterBtn").disabled = false;
      $("updateNowBtn").textContent = "Try again";
    }
  });
}

$("updateLaterBtn").onclick = () => closeModal(updateModal);
updateModal.addEventListener("mousedown", (e) => { if (e.target === updateModal && !installingUpdate) closeModal(updateModal); });
$("updateBtn").onclick = () => checkForUpdates();
$("aboutUpdateBtn").onclick = () => checkForUpdates();
// Check quietly a few seconds after opening, like other desktop apps.
setTimeout(() => checkForUpdates({ quiet: true }), 4000);

$("newChatBtn").onclick = newChat;
els.contextBtn.onclick = () => {
  if (buildHistory(activeChat()).length) runCommand("/context");
  else showToast(`Empty chat: 0 of ${formatNumber(currentModel().contextTokens)} tokens used`);
};
els.compactBtn.onclick = () => {
  const chat = activeChat();
  if (!pending && buildHistory(chat).length >= 2) compactChat(chat);
};
$("collapseBtn").onclick = () => { state.sidebarCollapsed = true; saveState(); render(); };
$("openSidebarBtn").onclick = () => { state.sidebarCollapsed = false; saveState(); render(); };
els.search.oninput = renderChatList;

els.prompt.addEventListener("input", () => { suggestionIndex = 0; autoResize(); });
els.prompt.addEventListener("scroll", () => { els.promptHighlight.scrollTop = els.prompt.scrollTop; });
els.prompt.addEventListener("keydown", (e) => {
  const menuOpen = !els.commandMenu.hidden && visibleSuggestions.length > 0;
  if (menuOpen && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
    e.preventDefault();
    const step = e.key === "ArrowDown" ? 1 : -1;
    suggestionIndex = (suggestionIndex + step + visibleSuggestions.length) % visibleSuggestions.length;
    renderCommandMenu();
    return;
  }
  if (menuOpen && e.key === "Tab") {
    e.preventDefault();
    applySuggestion(visibleSuggestions[suggestionIndex]);
    return;
  }
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    // Enter picks the highlighted suggestion when it still needs more text (like "/model ").
    const suggestion = menuOpen ? visibleSuggestions[suggestionIndex] : null;
    if (suggestion && suggestion.insert.endsWith(" ")) {
      applySuggestion(suggestion);
      return;
    }
    if (suggestion) els.prompt.value = suggestion.insert;
    if (!pending) els.composer.requestSubmit();
  }
});

els.composer.addEventListener("submit", (e) => {
  e.preventDefault();
  if (pending) {
    stopReply();
    return;
  }
  const text = els.prompt.value.trim();
  if (!text) return;
  els.prompt.value = "";
  autoResize();
  if (text.startsWith("/")) runCommand(text);
  else sendMessage(text);
});

for (const picker of pickers) {
  picker.button.onclick = (e) => {
    e.stopPropagation();
    const open = picker.menu.hidden;
    pickers.forEach((p) => setPickerOpen(p, false));
    setPickerOpen(picker, open);
  };
}
document.addEventListener("click", (e) => {
  for (const picker of pickers) {
    if (!picker.menu.hidden && !picker.root.contains(e.target)) setPickerOpen(picker, false);
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    pickers.forEach((p) => setPickerOpen(p, false));
    els.commandMenu.hidden = true;
    if (!updateModal.hidden && !installingUpdate) closeModal(updateModal);
    else closeModal(dialogModal.hidden ? settingsModal : dialogModal);
  }
});

// Replies interrupted by closing the app can't resume; mark them so they don't spin forever.
// Also relabel replies from models that have since been renamed.
for (const chat of state.chats) {
  for (const msg of chat.messages) {
    if (msg.loading) { msg.loading = false; msg.text = msg.text || "*Stopped.*"; }
    if (RENAMED_MODELS[msg.model]) msg.model = RENAMED_MODELS[msg.model];
  }
}

applyTheme();
render();
els.prompt.focus();
// Load the selected model in the background so the first reply is quick.
notifyHost("preload", { model: currentModel().id });
