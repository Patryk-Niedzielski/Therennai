// Therennai interface. Replies come from the desktop host (src/Therennai), which runs
// the selected model on this PC and streams the text back over window.chrome.webview.

// Each model is installed separately with "/install model <version>".
const MODELS = [
  { id: "therennai:1.0", name: "Therennai 1.0", version: "1.0", description: "Runs on this PC" },
];

const COMMANDS = [
  ...MODELS.map((m) => ({ text: `/install model ${m.version}`, description: `Install ${m.name}` })),
  { text: "/install model all", description: "Install every model" },
  ...MODELS.map((m) => ({ text: `/uninstall model ${m.version}`, description: `Uninstall ${m.name} and free its disk space` })),
  { text: "/uninstall model all", description: "Uninstall every model" },
];

const PERMISSIONS = [
  { id: "chat", name: "Chat only", description: "No access to your files or apps" },
  { id: "ask", name: "Ask every time", description: "Asks before reading files or running commands" },
  { id: "files", name: "Auto-approve files", description: "Reads and edits files without asking, asks for commands" },
  { id: "full", name: "Full access", description: "Acts on your PC without asking" },
];

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
};

let state = loadState();

// The reply being streamed: { requestId, chat, message, element }.
let pending = null;

function loadState() {
  const defaults = { chats: [], activeId: null, modelId: MODELS[0].id, permissionId: "chat", sidebarCollapsed: false };
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

/* Markdown (small subset: paragraphs, headings, lists, code, bold, italics) */

function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
  const thinking = pending !== null && pending.message === message && !message.text;
  element.innerHTML = thinking
    ? '<div class="thinking" aria-label="Thinking"><span></span><span></span><span></span></div>'
    : renderMarkdown(message.text);
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
}

/* Pickers (permissions and model) */

const pickers = [
  {
    root: $("permissionPicker"), button: $("permissionBtn"), menu: $("permissionMenu"), label: $("permissionLabel"),
    items: PERMISSIONS, current: currentPermission, select: (id) => { state.permissionId = id; },
  },
  {
    root: $("modelPicker"), button: $("modelBtn"), menu: $("modelMenu"), label: $("modelLabel"),
    items: MODELS, current: currentModel, select: (id) => { state.modelId = id; },
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
      if (host && picker.items === MODELS) host.postMessage({ type: "preload", model: item.id });
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

/* Actions */

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

function replyLocally(reply, text) {
  reply.text = text;
  reply.error = true;
  saveState();
  render();
}

function startRequest(request, chat, reply) {
  if (!host) {
    replyLocally(reply, "Open Therennai from its desktop app to chat.");
    return;
  }
  pending = { requestId: newId(), chat, message: reply, element: null };
  saveState();
  render();
  host.postMessage({ ...request, requestId: pending.requestId });
}

function sendMessage(text) {
  const model = currentModel();
  const chat = activeChat();
  // Commands and their replies aren't part of the conversation the model sees.
  const history = (chat ? chat.messages : [])
    .filter((m) => !m.error && !m.command && m.text)
    .map((m) => ({ role: m.role, content: m.text }));
  history.push({ role: "user", content: text });

  const exchange = addExchange(text, model, false);
  startRequest(
    { type: "chat", model: model.id, permission: currentPermission().id, messages: history },
    exchange.chat, exchange.reply);
}

function runCommand(text) {
  // "/install model 1.0", "/install model all" (and the same for /uninstall)
  const [name, target, version] = text.trim().split(/\s+/);
  const available = COMMANDS.map((c) => `**${c.text}**`).join(", ");

  if (name === "/install" || name === "/uninstall") {
    const type = name.slice(1);
    if (target === "all" || (target === "model" && version === "all")) {
      const exchange = addExchange(text, currentModel(), true);
      startRequest({ type, model: "all" }, exchange.chat, exchange.reply);
      return;
    }
    const model = target === "model" && version
      ? MODELS.find((m) => m.version === version || m.id === version)
      : null;
    const exchange = addExchange(text, model || currentModel(), true);
    if (!model) {
      const reason = target === "model" && version ? `There's no Therennai ${version}.` : "Tell me which model.";
      replyLocally(exchange.reply, `${reason} Commands: ${available}`);
      return;
    }
    startRequest({ type, model: model.id }, exchange.chat, exchange.reply);
    return;
  }

  const exchange = addExchange(text, currentModel(), true);
  replyLocally(exchange.reply, `Unknown command ${name}. Commands: ${available}`);
}

function notInstalledMessage(modelName) {
  const model = MODELS.find((m) => m.name === modelName) || currentModel();
  return `${model.name} isn't installed yet. Type **/install model ${model.version}** to install it.`;
}

/* Slash command suggestions */

function renderCommandMenu() {
  const value = els.prompt.value;
  const matches = value.startsWith("/") && !value.includes("\n")
    ? COMMANDS.filter((c) => c.text.startsWith(value.trim()) && c.text !== value.trim())
    : [];
  els.commandMenu.hidden = matches.length === 0;
  els.commandMenu.replaceChildren();
  for (const command of matches) {
    const opt = document.createElement("button");
    opt.type = "button";
    opt.className = "picker-option";
    opt.innerHTML = '<div class="option-text"><div class="option-name"></div><div class="option-desc"></div></div>';
    opt.querySelector(".option-name").textContent = command.text;
    opt.querySelector(".option-desc").textContent = command.description;
    opt.onclick = () => {
      els.prompt.value = command.text;
      autoResize();
      els.prompt.focus();
    };
    els.commandMenu.append(opt);
  }
}

function stopReply() {
  if (pending && host) host.postMessage({ type: "stop", requestId: pending.requestId });
}

function finishReply() {
  pending = null;
  saveState();
  render();
}

if (host) {
  host.addEventListener("message", (e) => {
    const data = e.data;
    if (!pending || data.requestId !== pending.requestId) return;

    if (data.type === "chunk") {
      pending.message.text += data.text;
      if (pending.element && pending.element.isConnected) {
        renderAssistantText(pending.element, pending.message);
        scrollToBottom();
      }
    } else if (data.type === "status") {
      pending.message.text = data.text;
      if (pending.element && pending.element.isConnected) renderAssistantText(pending.element, pending.message);
    } else if (data.type === "error") {
      pending.message.text = data.code === "not-installed" ? notInstalledMessage(pending.message.model) : data.message;
      pending.message.error = true;
      finishReply();
    } else if (data.type === "done") {
      if (data.stopped) {
        pending.message.text = pending.message.command
          ? (pending.message.text ? pending.message.text + "\n\n" : "") + "*Stopped.*"
          : (pending.message.text ? pending.message.text + "\n\n" : "") + "*Stopped.*";
      }
      finishReply();
    }
  });
}

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

$("newChatBtn").onclick = newChat;
$("collapseBtn").onclick = () => { state.sidebarCollapsed = true; saveState(); render(); };
$("openSidebarBtn").onclick = () => { state.sidebarCollapsed = false; saveState(); render(); };
els.search.oninput = renderChatList;

els.prompt.addEventListener("input", autoResize);
els.prompt.addEventListener("scroll", () => { els.promptHighlight.scrollTop = els.prompt.scrollTop; });
els.prompt.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
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
  }
});

render();
els.prompt.focus();
// Load the selected model in the background so the first reply is quick.
if (host) host.postMessage({ type: "preload", model: currentModel().id });
