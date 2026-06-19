/* ====== 状态 ====== */
const STATE = {
  sessionId: localStorage.getItem("math_solver_session") || null,
  imageFile: null,
  inputMode: "image",
  isSolving: false,
  isSending: false,
  abortController: null,
  chatImageFile: null,       // 追问时附加的图片
  chatImageDataUrl: null,    // 追问图片的 data URL（用于在聊天中回显）
};

/* ====== DOM 引用 ====== */
const $ = (sel) => document.querySelector(sel);

/* ====== API 调用（支持取消） ====== */
async function api(path, options = {}) {
  STATE.abortController = new AbortController();
  options.signal = STATE.abortController.signal;
  try {
    const resp = await fetch(path, options);
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
    STATE.abortController = null;
    return data;
  } catch (err) {
    STATE.abortController = null;
    if (err.name === "AbortError") throw new Error("CANCELLED");
    throw err;
  }
}

function cancelRequest() {
  if (STATE.abortController) {
    STATE.abortController.abort();
    STATE.abortController = null;
  }
}

/* ====== SSE 流式读取 ====== */
async function* readSSE(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("data: ")) {
          try {
            yield JSON.parse(trimmed.slice(6));
          } catch {}
        }
      }
    }
    // flush
    if (buffer.trim().startsWith("data: ")) {
      try {
        yield JSON.parse(buffer.trim().slice(6));
      } catch {}
    }
  } finally {
    reader.releaseLock();
  }
}

/* ====== LaTeX 安全 Markdown 渲染 ====== */
function renderMarkdownWithLatex(rawText) {
  if (!rawText) return "";
  const blocks = [];
  let protected_ = rawText
    .replace(/\$\$([\s\S]*?)\$\$/g, (_, math) => {
      blocks.push({ type: "display", math: math.trim() });
      return `\x00L${blocks.length - 1}\x00`;
    })
    .replace(/(?<!\$)\$(?!\$)([^\s$](?:[^$\n]*?[^\s$])?)\$(?!\$)/g, (_, math) => {
      blocks.push({ type: "inline", math });
      return `\x00L${blocks.length - 1}\x00`;
    })
    .replace(/\\\[([\s\S]*?)\\\]/g, (_, math) => {
      blocks.push({ type: "display", math: math.trim() });
      return `\x00L${blocks.length - 1}\x00`;
    })
    .replace(/\\\(([\s\S]*?)\\\)/g, (_, math) => {
      blocks.push({ type: "inline", math: math.trim() });
      return `\x00L${blocks.length - 1}\x00`;
    });
  let html = marked.parse(protected_);
  blocks.forEach((block, i) => {
    const marker = `\x00L${i}\x00`;
    html = html.replace(marker, block.type === "display" ? `$$${block.math}$$` : `$${block.math}$`);
  });
  return html;
}

async function typesetElement(el) {
  if (window.MathJax && MathJax.typesetPromise) {
    try { await MathJax.typesetPromise([el]); } catch {}
  }
}

/* ====== 输入模式切换 ====== */
const tabImage = $("#tabImage");
const tabText = $("#tabText");
const uploadZone = $("#uploadZone");
const fileInput = $("#fileInput");
const textInputArea = $("#textInputArea");
const preview = $("#preview");
const previewImg = $("#previewImg");
const btnRemove = $("#btnRemove");
const btnSolve = $("#btnSolve");
const uploadError = $("#uploadError");

tabImage.addEventListener("click", () => switchMode("image"));
tabText.addEventListener("click", () => switchMode("text"));

function switchMode(mode) {
  STATE.inputMode = mode;
  if (mode === "image") {
    tabImage.classList.add("active");
    tabText.classList.remove("active");
    uploadZone.style.display = "";
    textInputArea.style.display = "none";
    textInputArea.classList.add("hidden");
    $("#solveQuestion").classList.remove("hidden");
    if (STATE.imageFile) {
      preview.classList.remove("hidden");
      uploadZone.classList.add("has-file");
    }
  } else {
    tabText.classList.add("active");
    tabImage.classList.remove("active");
    uploadZone.style.display = "none";
    textInputArea.style.display = "";
    textInputArea.classList.remove("hidden");
    preview.classList.add("hidden");
    $("#solveQuestion").classList.add("hidden");
  }
  updateSolveButton();
  hideError();
}

function updateSolveButton() {
  if (STATE.inputMode === "image") {
    btnSolve.disabled = !STATE.imageFile || STATE.isSolving;
  } else {
    btnSolve.disabled = !textInputArea.value.trim() || STATE.isSolving;
  }
}

/* ====== 图片上传逻辑 ====== */
uploadZone.addEventListener("click", () => fileInput.click());
uploadZone.addEventListener("dragover", (e) => { e.preventDefault(); uploadZone.classList.add("drag-over"); });
uploadZone.addEventListener("dragleave", () => uploadZone.classList.remove("drag-over"));
uploadZone.addEventListener("drop", (e) => {
  e.preventDefault();
  uploadZone.classList.remove("drag-over");
  const files = e.dataTransfer?.files;
  if (files?.length) selectFile(files[0]);
});
fileInput.addEventListener("change", () => {
  if (fileInput.files?.length) selectFile(fileInput.files[0]);
});

function selectFile(file) {
  const validTypes = ["image/jpeg", "image/png", "image/gif", "image/webp", "image/bmp"];
  if (!validTypes.includes(file.type)) {
    showError("请上传图片文件（JPG、PNG、GIF、WebP）");
    return;
  }
  if (file.size > 20 * 1024 * 1024) {
    showError("图片文件不能超过 20MB");
    return;
  }
  STATE.imageFile = file;
  previewImg.src = URL.createObjectURL(file);
  preview.classList.remove("hidden");
  uploadZone.classList.add("has-file");
  hideError();
  updateSolveButton();
}

btnRemove.addEventListener("click", () => {
  STATE.imageFile = null;
  preview.classList.add("hidden");
  uploadZone.classList.remove("has-file");
  if (previewImg.src) { URL.revokeObjectURL(previewImg.src); previewImg.src = ""; }
  fileInput.value = "";
  updateSolveButton();
});

textInputArea.addEventListener("input", updateSolveButton);

function showError(msg) {
  uploadError.textContent = msg;
  uploadError.classList.remove("hidden");
}
function hideError() { uploadError.classList.add("hidden"); }

/* ====== 解题流程（SSE 流式） ====== */
btnSolve.addEventListener("click", handleSolve);

async function handleSolve() {
  if (STATE.isSolving) return;
  if (STATE.inputMode === "image" && !STATE.imageFile) return;
  if (STATE.inputMode === "text" && !textInputArea.value.trim()) return;

  STATE.isSolving = true;
  setSolveLoading(true);
  showCancelButton(true);
  hideError();

  if (STATE.sessionId) {
    await api("/api/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: STATE.sessionId }),
    }).catch(() => {});
    resetChat();
  }

  // 准备 SSE fetch
  let body;
  if (STATE.inputMode === "image") {
    body = new FormData();
    body.append("image", STATE.imageFile);
    const questionText = ($("#solveQuestion").value || "").trim();
    if (questionText) body.append("text", questionText);
  } else {
    body = JSON.stringify({ text: textInputArea.value.trim() });
  }

  STATE.abortController = new AbortController();
  const url = STATE.inputMode === "image" ? "/api/solve" : "/api/solve-text";
  const headers = STATE.inputMode === "text" ? { "Content-Type": "application/json" } : {};

  try {
    // 显示 loading
    $("#solutionEmpty").classList.add("hidden");
    $("#solutionContent").classList.add("hidden");
    $("#solutionLoading").classList.remove("hidden");
    $("#solutionLoading p").textContent = "识别题目中...";

    const resp = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: STATE.abortController.signal,
    });

    if (!resp.ok) {
      const errData = await resp.json().catch(() => ({}));
      throw new Error(errData.error || `HTTP ${resp.status}`);
    }

    let recognizedText = "";
    let solutionText = "";
    let solutionStarted = false;

    for await (const event of readSSE(resp)) {
      switch (event.type) {
        case "phase":
          $("#solutionLoading p").textContent = event.message;
          break;

        case "recognized":
          recognizedText = event.text;
          break;

        case "chunk":
          if (!solutionStarted) {
            solutionStarted = true;
            $("#solutionLoading").classList.add("hidden");
            $("#solutionContent").classList.remove("hidden");
            $("#recognizedText").textContent = recognizedText;
            if (!recognizedText) $("#recognizedBox").style.display = "none";
          }
          solutionText += event.content;
          // 实时渲染（不强制滚动，用户可自由翻阅上面内容）
          $("#solutionBody").innerHTML = renderMarkdownWithLatex(solutionText);
          typesetElement($("#solutionBody"));
          break;

        case "done":
          STATE.sessionId = event.session_id;
          if (STATE.sessionId) {
            localStorage.setItem("math_solver_session", STATE.sessionId);
          }
          showChatPanel();
          break;

        case "error":
          showError(event.message);
          $("#solutionLoading").classList.add("hidden");
          $("#solutionEmpty").classList.remove("hidden");
          break;
      }
    }
  } catch (err) {
    if (err.name === "AbortError" || err.message === "CANCELLED") {
      showError("已取消");
    } else if (!uploadError.classList.contains("hidden")) {
      // 已经显示过错误了
    } else {
      showError(err.message);
    }
    $("#solutionLoading").classList.add("hidden");
    if (!$("#solutionContent").classList.contains("hidden") && !solutionStarted) {
      $("#solutionContent").classList.add("hidden");
      $("#solutionEmpty").classList.remove("hidden");
    }
  } finally {
    STATE.isSolving = false;
    STATE.abortController = null;
    setSolveLoading(false);
    showCancelButton(false);
  }
}

function setSolveLoading(loading) {
  const textEl = btnSolve.querySelector(".btn-text");
  const spinnerEl = btnSolve.querySelector(".btn-spinner");
  btnSolve.disabled = loading;
  if (loading) {
    textEl.classList.add("hidden");
    spinnerEl.classList.remove("hidden");
  } else {
    textEl.classList.remove("hidden");
    spinnerEl.classList.add("hidden");
  }
}

/* ====== 取消按钮 ====== */
const btnCancel = $("#btnCancel");
function showCancelButton(show) { btnCancel.classList.toggle("hidden", !show); }
btnCancel.addEventListener("click", () => cancelRequest());

/* ====== 聊天逻辑（SSE 流式） ====== */
const chatPanel = $("#chatPanel");
const chatMessages = $("#chatMessages");
const chatEmpty = $("#chatEmpty");
const chatInput = $("#chatInput");
const btnSend = $("#btnSend");
const btnStopChat = $("#btnStopChat");
const charCount = $("#charCount");
const btnAttachImage = $("#btnAttachImage");
const chatImageInput = $("#chatImageInput");
const chatImagePreview = $("#chatImagePreview");
const chatPreviewImg = $("#chatPreviewImg");
const btnRemoveChatImage = $("#btnRemoveChatImage");

/** 智能滚动：仅当用户在底部附近（距底部 60px 内）才自动滚动 */
function scrollChatToBottom(force = false) {
  const el = chatMessages;
  const threshold = 60; // 距底部多少像素内视为"在底部"
  const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
  if (force || isNearBottom) {
    el.scrollTop = el.scrollHeight;
  }
}

function showChatPanel() {
  chatPanel.classList.remove("hidden");
  chatMessages.querySelectorAll(".chat-msg, .chat-typing").forEach(m => m.remove());
  chatEmpty.classList.remove("hidden");
  chatInput.value = "";
  removeChatImage();
  updateCharCount();
  btnSend.disabled = true;
}

function resetChat() {
  chatPanel.classList.add("hidden");
  chatMessages.querySelectorAll(".chat-msg, .chat-typing").forEach(m => m.remove());
  chatEmpty.classList.remove("hidden");
  chatInput.value = "";
  removeChatImage();
  updateCharCount();
}

chatInput.addEventListener("input", () => {
  updateCharCount();
  btnSend.disabled = (!chatInput.value.trim() && !STATE.chatImageFile) || STATE.isSending;
});

function updateCharCount() {
  const len = chatInput.value.length;
  charCount.textContent = len;
  charCount.style.color = len > 3800 ? "var(--error)" : "var(--text-secondary)";
}

chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    handleSend();
  }
});

/* 追问图片附件 */
btnAttachImage.addEventListener("click", () => chatImageInput.click());
chatImageInput.addEventListener("change", () => {
  if (chatImageInput.files?.length) selectChatImage(chatImageInput.files[0]);
});
btnRemoveChatImage.addEventListener("click", removeChatImage);

function selectChatImage(file) {
  const validTypes = ["image/jpeg", "image/png", "image/gif", "image/webp", "image/bmp"];
  if (!validTypes.includes(file.type)) {
    alert("请上传图片文件（JPG、PNG、GIF、WebP）");
    return;
  }
  if (file.size > 20 * 1024 * 1024) {
    alert("图片文件不能超过 20MB");
    return;
  }
  STATE.chatImageFile = file;
  STATE.chatImageDataUrl = URL.createObjectURL(file);
  chatPreviewImg.src = STATE.chatImageDataUrl;
  chatImagePreview.classList.remove("hidden");
  btnSend.disabled = false; // 有图片时允许发送
}

function removeChatImage() {
  STATE.chatImageFile = null;
  if (STATE.chatImageDataUrl) {
    URL.revokeObjectURL(STATE.chatImageDataUrl);
    STATE.chatImageDataUrl = null;
  }
  chatImagePreview.classList.add("hidden");
  chatPreviewImg.src = "";
  chatImageInput.value = "";
  btnSend.disabled = !chatInput.value.trim() || STATE.isSending;
}

btnSend.addEventListener("click", handleSend);

async function handleSend() {
  const message = chatInput.value.trim();
  if ((!message && !STATE.chatImageFile) || STATE.isSending || !STATE.sessionId) return;

  STATE.isSending = true;
  STATE.pendingMessage = message;  // 保存以便打断后恢复
  btnSend.classList.add("hidden");
  btnStopChat.classList.remove("hidden");
  chatInput.disabled = true;
  btnAttachImage.disabled = true;  // 发送中不允许改图片

  const chatImageFile = STATE.chatImageFile;        // 先保存引用
  const chatImageDataUrl = STATE.chatImageDataUrl;  // 再清除状态
  appendMessage("user", message, chatImageDataUrl);
  chatInput.value = "";
  removeChatImage();
  updateCharCount();

  // 创建空消息占位
  const replyDiv = document.createElement("div");
  replyDiv.className = "chat-msg assistant";
  chatEmpty.classList.add("hidden");
  chatMessages.appendChild(replyDiv);
  scrollChatToBottom(true);

  STATE.abortController = new AbortController();

  // 根据是否有图片选择请求格式
  let fetchOptions;
  if (chatImageFile) {
    const formData = new FormData();
    formData.append("session_id", STATE.sessionId);
    formData.append("message", message);
    formData.append("image", chatImageFile);
    fetchOptions = { method: "POST", body: formData };
  } else {
    fetchOptions = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: STATE.sessionId, message }),
    };
  }

  try {
    const resp = await fetch("/api/chat", {
      ...fetchOptions,
      signal: STATE.abortController.signal,
    });

    if (!resp.ok) {
      const errData = await resp.json().catch(() => ({}));
      throw new Error(errData.error || `HTTP ${resp.status}`);
    }

    let replyText = "";
    for await (const event of readSSE(resp)) {
      switch (event.type) {
        case "chunk":
          replyText += event.content;
          replyDiv.innerHTML = renderMarkdownWithLatex(replyText);
          typesetElement(replyDiv);
          scrollChatToBottom();
          break;
        case "error":
          replyDiv.textContent = `❌ ${event.message}`;
          break;
      }
    }
  } catch (err) {
    if (err.name !== "AbortError" && err.message !== "CANCELLED") {
      replyDiv.textContent = `❌ 发送失败: ${err.message}`;
    } else {
      // 被用户打断：标记已取消，保留部分内容
      if (replyDiv.textContent && replyDiv.textContent.trim()) {
        replyDiv.innerHTML = renderMarkdownWithLatex(
          (replyDiv.textContent || "") + "\n\n---\n*⏹ 已停止生成*"
        );
      } else {
        replyDiv.textContent = "⏹ 已停止生成";
      }
    }
  } finally {
    STATE.isSending = false;
    STATE.abortController = null;
    btnSend.classList.remove("hidden");
    btnStopChat.classList.add("hidden");
    chatInput.disabled = false;
    btnAttachImage.disabled = false;
    chatInput.focus();
  }
}

// 停止追问生成
function stopChatGeneration() {
  if (!STATE.isSending) return;
  cancelRequest();
  // 恢复原始消息到输入框，供用户修改
  if (STATE.pendingMessage) {
    chatInput.value = STATE.pendingMessage;
    STATE.pendingMessage = null;
    updateCharCount();
    btnSend.disabled = false;
  }
}

btnStopChat.addEventListener("click", stopChatGeneration);

function appendMessage(role, content, imageUrl = null) {
  chatEmpty.classList.add("hidden");
  const div = document.createElement("div");
  div.className = `chat-msg ${role}`;
  if (role === "user") {
    // 用户消息：可选图片 + 文字
    if (imageUrl) {
      const img = document.createElement("img");
      img.src = imageUrl;
      img.className = "chat-msg-image";
      img.alt = "追问图片";
      div.appendChild(img);
    }
    const textSpan = document.createElement("span");
    textSpan.textContent = content;
    div.appendChild(textSpan);
  } else {
    div.innerHTML = renderMarkdownWithLatex(content);
    typesetElement(div);
  }
  chatMessages.appendChild(div);
  scrollChatToBottom(true);
  return div;
}

/* ====== 重置按钮 ====== */
$("#btnReset").addEventListener("click", async () => {
  cancelRequest();
  if (STATE.sessionId) {
    await api("/api/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: STATE.sessionId }),
    }).catch(() => {});
  }
  STATE.sessionId = null;
  STATE.imageFile = null;
  localStorage.removeItem("math_solver_session");
  preview.classList.add("hidden");
  uploadZone.classList.remove("has-file");
  if (previewImg.src) { URL.revokeObjectURL(previewImg.src); previewImg.src = ""; }
  fileInput.value = "";
  textInputArea.value = "";
  $("#solveQuestion").value = "";
  btnSolve.disabled = true;
  hideError();
  showCancelButton(false);
  $("#solutionEmpty").classList.remove("hidden");
  $("#solutionContent").classList.add("hidden");
  $("#solutionLoading").classList.add("hidden");
  $("#recognizedBox").style.display = "";
  resetChat();
});

/* ====== 页面加载：恢复会话 ====== */
async function restoreSession() {
  const sid = STATE.sessionId;
  if (!sid) return;
  try {
    const data = await api(`/api/session/${sid}`);
    if (data.valid) {
      STATE.sessionId = data.session_id;
      $("#solutionEmpty").classList.add("hidden");
      $("#solutionLoading").classList.add("hidden");
      $("#solutionContent").classList.remove("hidden");
      $("#recognizedText").textContent = data.recognized_text;
      $("#solutionBody").innerHTML = renderMarkdownWithLatex(data.solution);
      typesetElement($("#solutionBody"));
      showChatPanel();
      if (data.chat_history?.length) {
        data.chat_history.forEach(msg => appendMessage(msg.role, msg.content));
      }
    }
  } catch {
    localStorage.removeItem("math_solver_session");
    STATE.sessionId = null;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  switchMode("image");  // 确保初始状态正确显示
  restoreSession();
});
