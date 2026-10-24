// Therennai desktop shell. The agent has no model yet: replies are placeholders
// until a backend is connected in respond().

const MODELS = [
  { id: "therennai-1.0", name: "Therennai 1.0", description: "Not trained yet" },
];

const STORAGE_KEY = "therennai.state.v1";

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
  modelBtn: $("modelBtn"),
  modelMenu: $("modelMenu"),
  modelLabel: $("modelLabel"),
};

let state = loadState();

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (saved && Array.isArray(saved.chats)) return saved;
  } catch {}
  return { chats: [], activeId: null, modelId: MODELS[0].id, sidebarCollapsed: false };
}

function saveState() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch {}
}

function activeChat() {
  return state.chats.find((c) => c.id === state.activeId) || null;
}

function currentModel() {
  return MODELS.find((m) => m.id === state.modelId) || MODELS[0];
}

// Placeholder until Therennai is taught. Swap this for a real model call later.
function respond(text, model) {
  return `I'm ${model.name}, but I haven't been taught anything yet, so I can't answer "${text}". ` +
    "Once a model is connected, I'll reply here.";
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

function renderConversation() {
  const chat = activeChat();
  els.messages.replaceChildren();
  els.title.textContent = chat ? chat.title : "New chat";
  els.conversation.classList.toggle("has-messages", !!chat && chat.messages.length > 0);
  if (!chat) return;

  for (const msg of chat.messages) {
    const row = document.createElement("div");
    row.className = "msg " + msg.role;
    if (msg.role === "user") {
      row.textContent = msg.text;
    } else {
      const icon = document.createElement("img");
      icon.src = "icon.svg";
      icon.alt = "";
      const body = document.createElement("div");
      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = msg.model;
      const text = document.createElement("div");
      text.textContent = msg.text;
      body.append(meta, text);
      row.append(icon, body);
    }
    els.messages.append(row);
  }
  els.conversation.scrollTop = els.conversation.scrollHeight;
}

function renderModelMenu() {
  els.modelLabel.textContent = currentModel().name;
  els.modelMenu.replaceChildren();
  for (const model of MODELS) {
    const opt = document.createElement("button");
    opt.type = "button";
    opt.className = "model-option";
    opt.setAttribute("role", "option");
    opt.setAttribute("aria-selected", String(model.id === state.modelId));
    opt.innerHTML =
      '<div class="model-text"><div class="model-name"></div><div class="model-desc"></div></div>' +
      '<svg class="check" viewBox="0 0 24 24"><path d="m5 12 5 5 9-10"/></svg>';
    opt.querySelector(".model-name").textContent = model.name;
    opt.querySelector(".model-desc").textContent = model.description;
    opt.onclick = () => {
      state.modelId = model.id;
      saveState();
      renderModelMenu();
      toggleModelMenu(false);
    };
    els.modelMenu.append(opt);
  }
}

function render() {
  els.shell.classList.toggle("collapsed", state.sidebarCollapsed);
  renderChatList();
  renderConversation();
  renderModelMenu();
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
  state.chats = state.chats.filter((c) => c.id !== id);
  if (state.activeId === id) state.activeId = null;
  saveState();
  render();
}

function sendMessage(text) {
  let chat = activeChat();
  if (!chat) {
    chat = { id: Date.now().toString(36) + Math.random().toString(36).slice(2), title: text.slice(0, 40), messages: [] };
    state.chats.unshift(chat);
    state.activeId = chat.id;
  }
  const model = currentModel();
  chat.messages.push({ role: "user", text });
  chat.messages.push({ role: "assistant", model: model.name, text: respond(text, model) });
  saveState();
  render();
}

function toggleModelMenu(open) {
  els.modelMenu.hidden = !open;
  els.modelBtn.setAttribute("aria-expanded", String(open));
}

function autoResize() {
  els.prompt.style.height = "auto";
  els.prompt.style.height = els.prompt.scrollHeight + "px";
  els.send.disabled = !els.prompt.value.trim();
}

/* Events */

$("newChatBtn").onclick = newChat;
$("collapseBtn").onclick = () => { state.sidebarCollapsed = true; saveState(); render(); };
$("openSidebarBtn").onclick = () => { state.sidebarCollapsed = false; saveState(); render(); };
els.search.oninput = renderChatList;

els.prompt.addEventListener("input", autoResize);
els.prompt.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    els.composer.requestSubmit();
  }
});

els.composer.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = els.prompt.value.trim();
  if (!text) return;
  els.prompt.value = "";
  autoResize();
  sendMessage(text);
});

els.modelBtn.onclick = (e) => {
  e.stopPropagation();
  toggleModelMenu(els.modelMenu.hidden);
};
document.addEventListener("click", (e) => {
  if (!els.modelMenu.hidden && !$("modelPicker").contains(e.target)) toggleModelMenu(false);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") toggleModelMenu(false);
});

render();
els.prompt.focus();
