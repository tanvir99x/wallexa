// WALLEXA AI — overlay.js (Full ChatGPT‑style functionality + animations)

// DOM Refs
const overlay = document.getElementById("wallexa-chat-overlay");
const chatContent = document.getElementById("wxa-chat-content");
const input = document.getElementById("wxa-input");
const sendBtn = document.getElementById("wxa-send-btn");
const newChatBtn = document.getElementById("wxa-new-chat-btn");

// Auto-resize textarea
input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = input.scrollHeight + "px";
});

// Scroll helper
function scrollToBottom() {
  chatContent.scrollTo({
    top: chatContent.scrollHeight,
    behavior: "smooth"
  });
}

// Add message helper
function addMessage(role, text, animate = true) {
  const group = document.createElement("div");
  group.className = "wxa-message-group";

  const msg = document.createElement("div");
  msg.className = "wxa-message " + (role === "user" ? "user" : "bot");

  const avatar = document.createElement("div");
  avatar.className = "wxa-message-avatar";
  avatar.textContent = role === "user" ? "🧑" : "✦";

  const bubble = document.createElement("div");
  bubble.className = "wxa-message-bubble";
  bubble.innerText = text;

  if (animate) bubble.classList.add("wxa-slide-up");

  msg.appendChild(avatar);
  msg.appendChild(bubble);
  group.appendChild(msg);
  chatContent.appendChild(group);

  scrollToBottom();
}

// Typing indicator
function showTyping() {
  const wrap = document.createElement("div");
  wrap.className = "wxa-typing";
  wrap.id = "wxa-typing";

  for (let i = 0; i < 3; i++) {
    const dot = document.createElement("div");
    dot.className = "wxa-typing-dot";
    wrap.appendChild(dot);
  }

  chatContent.appendChild(wrap);
  scrollToBottom();
}

function hideTyping() {
  const t = document.getElementById("wxa-typing");
  if (t) t.remove();
}

// Send user message
function handleSend() {
  const text = input.value.trim();
  if (!text) return;

  addMessage("user", text);
  input.value = "";
  input.style.height = "48px";

  showTyping();

  // fake AI delay
  setTimeout(() => {
    hideTyping();
    addMessage("bot", "This is a placeholder AI reply. Integrate real API next.");
  }, 1100);
}

// New chat
newChatBtn.addEventListener("click", () => {
  chatContent.innerHTML = "";
  addMessage("bot", "New chat ready. How can I help?");
});

// Events
sendBtn.addEventListener("click", handleSend);
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    handleSend();
  }
});

// Initial ready log
console.log("WALLEXA AI overlay.js loaded with full ChatGPT-style behavior.");