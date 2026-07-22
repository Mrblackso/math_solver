/* ====== 状态 ====== */
const STATE = {
  sessionId: localStorage.getItem("math_solver_session") || null,
  imageFiles: [],            // 求解图片列表（最多5张）
  imageDataUrls: [],         // 对应 data URL 用于预览
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

/* ====== 节流渲染器：避免 MathJax 频繁重排导致卡顿/崩溃 ====== */
function createStreamRenderer(targetEl, renderFn) {
  let rafId = null;
  let latestText = "";
  let lastRenderTime = 0;
  const MIN_INTERVAL = 120; // ms，两次渲染最小间隔

  return function render(text, isFinal = false) {
    latestText = text;
    if (isFinal) {
      // 最终渲染：立即执行，强制等待 MathJax 完成
      if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
      flush();
      return;
    }
    // 节流：用 requestAnimationFrame 批处理
    if (rafId) return; // 已有待渲染帧
    const elapsed = performance.now() - lastRenderTime;
    if (elapsed >= MIN_INTERVAL) {
      flush();
    } else {
      rafId = requestAnimationFrame(() => {
        rafId = null;
        flush();
      });
    }
  };

  function flush() {
    lastRenderTime = performance.now();
    targetEl.innerHTML = renderFn(latestText);
    typesetElement(targetEl);
  }
}

/* ====== 输入模式切换 ====== */
const tabImage = $("#tabImage");
const tabText = $("#tabText");
const uploadZone = $("#uploadZone");
const fileInput = $("#fileInput");
const textInputArea = $("#textInputArea");
const previewGrid = $("#previewGrid");
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
    if (STATE.imageFiles.length > 0) {
      previewGrid.classList.remove("hidden");
      uploadZone.classList.add("has-file");
    }
  } else {
    tabText.classList.add("active");
    tabImage.classList.remove("active");
    uploadZone.style.display = "none";
    textInputArea.style.display = "";
    textInputArea.classList.remove("hidden");
    previewGrid.classList.add("hidden");
    $("#solveQuestion").classList.add("hidden");
  }
  updateSolveButton();
  hideError();
}

function updateSolveButton() {
  if (STATE.inputMode === "image") {
    btnSolve.disabled = STATE.imageFiles.length === 0 || STATE.isSolving;
  } else {
    btnSolve.disabled = !textInputArea.value.trim() || STATE.isSolving;
  }
}

/* ====== 图片上传逻辑（多图，最多5张） ====== */
const MAX_IMAGES = 5;
const VALID_IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp", "image/bmp"];
const VALID_IMAGE_EXTS = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"];
const MAX_FILE_SIZE = 20 * 1024 * 1024;

function isValidImage(file) {
  // 先检查 MIME，再检查扩展名（Windows 上某些图片 MIME 可能为空）
  if (VALID_IMAGE_TYPES.includes(file.type)) return true;
  const ext = "." + file.name.split(".").pop().toLowerCase();
  return VALID_IMAGE_EXTS.includes(ext);
}

uploadZone.addEventListener("click", () => fileInput.click());
uploadZone.addEventListener("dragover", (e) => { e.preventDefault(); uploadZone.classList.add("drag-over"); });
uploadZone.addEventListener("dragleave", () => uploadZone.classList.remove("drag-over"));
uploadZone.addEventListener("drop", (e) => {
  e.preventDefault();
  uploadZone.classList.remove("drag-over");
  const files = e.dataTransfer?.files;
  if (files?.length) addFiles(files);
});
fileInput.addEventListener("change", () => {
  if (fileInput.files?.length) addFiles(fileInput.files);
  fileInput.value = "";  // 清空以便重复选择同一文件
});

function addFiles(fileList) {
  const remaining = MAX_IMAGES - STATE.imageFiles.length;
  if (remaining <= 0) {
    showError(`最多只能上传 ${MAX_IMAGES} 张图片`);
    return;
  }

  let added = 0;
  let skipped = 0;
  for (const file of fileList) {
    if (added >= remaining) break;
    if (!isValidImage(file)) { skipped++; continue; }
    if (file.size > MAX_FILE_SIZE) {
      showError(`"${file.name}" 超过 20MB 限制，已跳过`);
      continue;
    }
    STATE.imageFiles.push(file);
    STATE.imageDataUrls.push(URL.createObjectURL(file));
    added++;
  }

  if (added === 0 && skipped > 0) {
    showError("请上传 JPG、PNG、GIF、WebP 格式的图片文件");
    return;
  }

  if (STATE.imageFiles.length > 0) {
    previewGrid.classList.remove("hidden");
    uploadZone.classList.add("has-file");
    hideError();
  }
  renderPreviews();
  updateSolveButton();
}

function removeImage(index) {
  URL.revokeObjectURL(STATE.imageDataUrls[index]);
  STATE.imageFiles.splice(index, 1);
  STATE.imageDataUrls.splice(index, 1);
  if (STATE.imageFiles.length === 0) {
    previewGrid.classList.add("hidden");
    uploadZone.classList.remove("has-file");
  }
  renderPreviews();
  updateSolveButton();
}

function renderPreviews() {
  previewGrid.innerHTML = "";
  STATE.imageDataUrls.forEach((url, i) => {
    const item = document.createElement("div");
    item.className = "preview-item";
    item.innerHTML = `
      <img src="${url}" alt="预览 ${i + 1}">
      <button class="preview-remove" data-index="${i}" title="移除图片">&times;</button>
      <span class="preview-index">${i + 1}/${STATE.imageFiles.length}</span>
    `;
    item.querySelector(".preview-remove").addEventListener("click", (e) => {
      e.stopPropagation();
      removeImage(i);
    });
    previewGrid.appendChild(item);
  });
}

function clearImages() {
  STATE.imageDataUrls.forEach(url => URL.revokeObjectURL(url));
  STATE.imageFiles = [];
  STATE.imageDataUrls = [];
}

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
  if (STATE.inputMode === "image" && STATE.imageFiles.length === 0) return;
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

  // 准备请求体
  let body;
  let headers;
  if (STATE.inputMode === "image") {
    const validFiles = STATE.imageFiles.filter(f => f instanceof File && f.size > 0);
    if (validFiles.length === 0) {
      showError("图片文件已失效，请重新选择");
      STATE.isSolving = false;
      setSolveLoading(false);
      showCancelButton(false);
      return;
    }
    // 将文件转为 base64 data URL，以 JSON 方式发送
    const imagePromises = validFiles.map(f => new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(f);
    }));
    const imageDataUrls = (await Promise.all(imagePromises)).filter(Boolean);
    if (imageDataUrls.length === 0) {
      showError("图片读取失败，请重试");
      STATE.isSolving = false;
      setSolveLoading(false);
      showCancelButton(false);
      return;
    }
    const questionText = ($("#solveQuestion").value || "").trim();
    body = JSON.stringify({ images: imageDataUrls, text: questionText || "" });
    headers = { "Content-Type": "application/json" };
  } else {
    body = JSON.stringify({ text: textInputArea.value.trim() });
    headers = { "Content-Type": "application/json" };
  }

  STATE.abortController = new AbortController();
  const url = STATE.inputMode === "image" ? "/api/solve" : "/api/solve-text";

  try {
    // 显示 loading
    $("#solutionEmpty").classList.add("hidden");
    $("#solutionContent").classList.add("hidden");
    $("#solutionLoading").classList.remove("hidden");
    $("#solutionLoading p").textContent = "识别题目中...";

    const fetchOpts = {
      method: "POST",
      headers,
      body,
      signal: STATE.abortController.signal,
    };

    const resp = await fetch(url, fetchOpts);

    if (!resp.ok) {
      const errData = await resp.json().catch(() => ({}));
      throw new Error(errData.error || `HTTP ${resp.status}`);
    }

    let recognizedText = "";
    let solutionText = "";
    let solutionStarted = false;
    const renderSolution = createStreamRenderer($("#solutionBody"), renderMarkdownWithLatex);

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
          renderSolution(solutionText);
          break;

        case "done":
          renderSolution(solutionText, true);  // 最终渲染（含 MathJax）
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
    const renderChat = createStreamRenderer(replyDiv, renderMarkdownWithLatex);
    for await (const event of readSSE(resp)) {
      switch (event.type) {
        case "chunk":
          replyText += event.content;
          renderChat(replyText);
          scrollChatToBottom();
          break;
        case "error":
          replyDiv.textContent = `❌ ${event.message}`;
          break;
      }
    }
    renderChat(replyText, true);  // 最终渲染
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
  clearImages();
  localStorage.removeItem("math_solver_session");
  previewGrid.classList.add("hidden");
  uploadZone.classList.remove("has-file");
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

/* ====== 浏览记录面板 ====== */
let historyPage = 1;
let historyTotal = 0;

function initHistoryPanel() {
  $("#btnHistory").addEventListener("click", () => openHistoryPanel());
  $("#btnHistoryClose").addEventListener("click", () => closeHistoryPanel());
  $("#historyOverlay").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeHistoryPanel();
  });
}

function openHistoryPanel() {
  $("#historyOverlay").classList.remove("hidden");
  historyPage = 1;
  loadHistory();
}

function closeHistoryPanel() {
  $("#historyOverlay").classList.add("hidden");
}

async function loadHistory() {
  const listEl = $("#historyList");
  const pagEl = $("#historyPagination");
  listEl.innerHTML = '<div class="overlay-empty">加载中...</div>';

  try {
    const data = await api(`/api/history?page=${historyPage}&page_size=20`);
    historyTotal = data.total;

    if (!data.items.length) {
      listEl.innerHTML = '<div class="overlay-empty">暂无浏览记录</div>';
      pagEl.innerHTML = "";
      return;
    }

    listEl.innerHTML = "";
    data.items.forEach(r => {
      const card = document.createElement("div");
      card.className = "history-card";
      const time = new Date(r.created_at * 1000).toLocaleString("zh-CN");
      const modeLabel = r.input_mode === "image" ? "📷 图片" : "📝 文本";
      const text = (r.question_text || r.recognized_text || "(空)").slice(0, 200);

      let thumbsHTML = "";
      if (r.images?.length) {
        thumbsHTML = `<div class="history-card-thumbs">${r.images.map(n =>
          `<img src="/data/images/${n}" alt="缩略图" loading="lazy">`
        ).join("")}</div>`;
      }

      let previewHTML = "";
      if (r.chat_preview) {
        previewHTML = `<div class="history-card-preview">💬 ${r.chat_preview}</div>`;
      }

      card.innerHTML = `
        <div class="history-card-header">
          <span class="history-card-mode">${modeLabel}</span>
          <span class="history-card-time">${time}</span>
        </div>
        <div class="history-card-text">${text}</div>
        ${previewHTML}
        ${thumbsHTML}
        <div class="history-card-actions">
          <button class="btn-sm" data-action="view" data-id="${r.id}">查看</button>
          <button class="btn-sm primary" data-action="addEB" data-id="${r.id}">＋错题本</button>
          <button class="btn-sm danger" data-action="delete" data-id="${r.id}">删除</button>
        </div>
      `;
      listEl.appendChild(card);
    });

    // 绑定事件
    listEl.querySelectorAll("[data-action='view']").forEach(btn =>
      btn.addEventListener("click", () => viewHistoryDetail(btn.dataset.id)));
    listEl.querySelectorAll("[data-action='addEB']").forEach(btn =>
      btn.addEventListener("click", (e) => { e.stopPropagation(); openTagModal(btn.dataset.id); }));
    listEl.querySelectorAll("[data-action='delete']").forEach(btn =>
      btn.addEventListener("click", (e) => { e.stopPropagation(); deleteHistory(btn.dataset.id); }));

    // 分页
    const totalPages = Math.ceil(historyTotal / 20);
    if (totalPages > 1) {
      pagEl.innerHTML = `
        <div class="pagination">
          <button ${historyPage <= 1 ? "disabled" : ""} id="histPrev">上一页</button>
          <span>${historyPage} / ${totalPages}</span>
          <button ${historyPage >= totalPages ? "disabled" : ""} id="histNext">下一页</button>
        </div>
      `;
      $("#histPrev")?.addEventListener("click", () => { historyPage--; loadHistory(); });
      $("#histNext")?.addEventListener("click", () => { historyPage++; loadHistory(); });
    } else {
      pagEl.innerHTML = "";
    }
  } catch (err) {
    listEl.innerHTML = `<div class="overlay-empty">加载失败: ${err.message}</div>`;
  }
}

async function viewHistoryDetail(recordId) {
  try {
    const r = await api(`/api/history/${recordId}`);
    const listEl = $("#historyList");
    const pagEl = $("#historyPagination");
    const time = new Date(r.created_at * 1000).toLocaleString("zh-CN");

    let imagesHTML = "";
    if (r.images?.length) {
      imagesHTML = `<div class="detail-images">${r.images.map(n =>
        `<img src="/data/images/${n}" alt="题目图片">`
      ).join("")}</div>`;
    }

    let chatHTML = "";
    if (r.chat_history?.length) {
      chatHTML = '<div class="detail-section"><h4>💬 追问记录</h4>';
      r.chat_history.forEach(msg => {
        const role = msg.role === "user" ? "🙋 你" : "🤖 AI";
        const content = typeof msg.content === "string" ? msg.content : (
          Array.isArray(msg.content)
            ? msg.content.map(c => c.type === "text" ? c.text : "[图片]").join(" ")
            : "[消息]"
        );
        chatHTML += `<div class="detail-chat-msg ${msg.role}">
          <div class="role-label">${role}</div>
          <div>${content}</div>
        </div>`;
      });
      chatHTML += "</div>";
    }

    listEl.innerHTML = `
      <div class="detail-section">
        <h4>📝 题目</h4>
        <div class="detail-text">${r.recognized_text || r.question_text || "(空)"}</div>
      </div>
      ${imagesHTML}
      <div class="detail-section">
        <h4>✅ 解答</h4>
        <div class="markdown-body">${renderMarkdownWithLatex(r.solution || "(空)")}</div>
      </div>
      ${chatHTML}
      <button class="btn btn-outline btn-block" id="btnBackToList">← 返回列表</button>
    `;
    pagEl.innerHTML = "";
    typesetElement(listEl);
    $("#btnBackToList").addEventListener("click", () => { loadHistory(); });
  } catch (err) {
    alert(`加载详情失败: ${err.message}`);
  }
}

async function deleteHistory(recordId) {
  if (!confirm("确定删除这条浏览记录吗？")) return;
  try {
    await api(`/api/history/${recordId}`, { method: "DELETE" });
    loadHistory();
  } catch (err) {
    alert(`删除失败: ${err.message}`);
  }
}

/* ====== 错题本面板（多本分类） ====== */
let ebCurrentBookId = null;
let ebCurrentBookName = null;
let ebPage = 1;
let ebCurrentTag = "";

function initErrorBookPanel() {
  $("#btnErrorBook").addEventListener("click", () => openErrorBookPanel());
  $("#btnErrorBookClose").addEventListener("click", () => closeErrorBookPanel());
  $("#errorBookOverlay").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeErrorBookPanel();
  });
  $("#btnEBDetailClose").addEventListener("click", () => {
    $("#errorBookDetailOverlay").classList.add("hidden");
  });
  $("#errorBookDetailOverlay").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) $("#errorBookDetailOverlay").classList.add("hidden");
  });
  // 新建错题本
  $("#btnCreateBook").addEventListener("click", createBook);
  $("#newBookName").addEventListener("keydown", (e) => {
    if (e.key === "Enter") createBook();
  });
}

function openErrorBookPanel() {
  $("#errorBookOverlay").classList.remove("hidden");
  ebCurrentBookId = null;
  ebCurrentBookName = null;
  ebCurrentTag = "";
  $("#ebPanelTitle").textContent = "📕 错题本";
  loadBookList();
}

function closeErrorBookPanel() {
  $("#errorBookOverlay").classList.add("hidden");
}

async function createBook() {
  const input = $("#newBookName");
  const name = input.value.trim();
  if (!name) return;
  try {
    await api("/api/error-books", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    input.value = "";
    loadBookList();
  } catch (err) {
    alert(`创建失败: ${err.message}`);
  }
}

async function loadBookList() {
  const listEl = $("#errorBookList");
  const footerEl = $("#ebFooter");
  listEl.innerHTML = '<div class="overlay-empty">加载中...</div>';
  footerEl.style.display = "";

  try {
    const data = await api("/api/error-books");
    if (!data.books.length) {
      listEl.innerHTML = '<div class="overlay-empty">还没有错题本，在下方新建一个吧</div>';
      return;
    }

    listEl.innerHTML = "";
    data.books.forEach(book => {
      const card = document.createElement("div");
      card.className = "book-card";
      card.innerHTML = `
        <div class="book-card-icon">📘</div>
        <div class="book-card-info">
          <div class="book-card-name">${book.name}</div>
          <div class="book-card-count">${book.item_count} 道题目</div>
        </div>
        <div class="book-card-actions">
          <button class="btn-sm" data-action="rename" data-id="${book.id}" data-name="${book.name}">✏️</button>
          <button class="btn-sm danger" data-action="deleteBook" data-id="${book.id}">🗑</button>
        </div>
      `;
      card.style.cursor = "pointer";
      card.addEventListener("click", (e) => {
        if (e.target.closest("button")) return;
        openBookItems(book.id, book.name);
      });
      listEl.appendChild(card);
    });

    // 重命名 / 删除书本
    listEl.querySelectorAll("[data-action='rename']").forEach(btn =>
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        renameBook(btn.dataset.id, btn.dataset.name);
      }));
    listEl.querySelectorAll("[data-action='deleteBook']").forEach(btn =>
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        deleteBook(btn.dataset.id);
      }));
  } catch (err) {
    listEl.innerHTML = `<div class="overlay-empty">加载失败: ${err.message}</div>`;
  }
}

async function renameBook(bookId, oldName) {
  const name = prompt("重命名错题本：", oldName);
  if (!name || name === oldName) return;
  try {
    await api(`/api/error-books/${bookId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    loadBookList();
  } catch (err) {
    alert(`重命名失败: ${err.message}`);
  }
}

async function deleteBook(bookId) {
  if (!confirm("确定删除这个错题本及其所有题目吗？此操作不可撤销。")) return;
  try {
    await api(`/api/error-books/${bookId}`, { method: "DELETE" });
    loadBookList();
  } catch (err) {
    alert(`删除失败: ${err.message}`);
  }
}

/* ====== 错题本内题目列表 ====== */
function openBookItems(bookId, bookName) {
  ebCurrentBookId = bookId;
  ebCurrentBookName = bookName;
  ebPage = 1;
  ebCurrentTag = "";
  $("#ebPanelTitle").textContent = `📕 ${bookName}`;
  $("#ebFooter").style.display = "none";
  loadBookItems();
}

function backToBookList() {
  ebCurrentBookId = null;
  ebCurrentBookName = null;
  $("#ebPanelTitle").textContent = "📕 错题本";
  $("#ebFooter").style.display = "";
  loadBookList();
}

async function loadBookItems() {
  const listEl = $("#errorBookList");
  listEl.innerHTML = '<div class="overlay-empty">加载中...</div>';

  try {
    // 加载标签
    const tagsData = await api(`/api/error-books/${ebCurrentBookId}/tags`);
    let tagBarHTML = '<div class="tag-bar">';
    tagBarHTML += `<span class="tag-chip${ebCurrentTag === "" ? " active" : ""}" data-tag="">全部</span>`;
    tagsData.tags.forEach(t => {
      tagBarHTML += `<span class="tag-chip${ebCurrentTag === t.name ? " active" : ""}" data-tag="${t.name}">${t.name} <span class="tag-count">${t.count}</span></span>`;
    });
    tagBarHTML += "</div>";

    let url = `/api/error-books/${ebCurrentBookId}/items?page=${ebPage}&page_size=20`;
    if (ebCurrentTag) url += `&tag=${encodeURIComponent(ebCurrentTag)}`;

    const data = await api(url);

    listEl.innerHTML = tagBarHTML;

    // 面包屑
    const bc = document.createElement("div");
    bc.className = "eb-breadcrumb";
    bc.innerHTML = `<a id="ebBreadcrumbBack">📕 错题本</a> <span>/</span> <strong>${ebCurrentBookName}</strong>`;
    listEl.appendChild(bc);
    $("#ebBreadcrumbBack").addEventListener("click", backToBookList);

    if (!data.items.length) {
      const empty = document.createElement("div");
      empty.className = "overlay-empty";
      empty.textContent = "这本错题本还是空的，去浏览记录中添加题目吧";
      listEl.appendChild(empty);
    } else {
      data.items.forEach(item => {
        const card = document.createElement("div");
        card.className = "eb-card";
        const time = new Date(item.created_at * 1000).toLocaleString("zh-CN");
        const text = (item.recognized_text || item.question_text || "(空)").slice(0, 200);
        const tagsHTML = (item.tags || []).map(t =>
          `<span class="tag-item" style="font-size:0.7rem;padding:2px 8px;">${t}</span>`
        ).join(" ");

        let thumbsHTML = "";
        if (item.images?.length) {
          thumbsHTML = `<div class="history-card-thumbs">${item.images.map(n =>
            `<img src="/data/images/${n}" alt="缩略图" loading="lazy">`
          ).join("")}</div>`;
        }

        card.innerHTML = `
          <div class="history-card-header">
            <span class="history-card-time">${time}</span>
          </div>
          <div class="history-card-text">${text}</div>
          ${tagsHTML ? `<div style="margin-top:6px">${tagsHTML}</div>` : ""}
          ${item.note ? `<div class="history-card-preview">📝 ${item.note.slice(0, 80)}</div>` : ""}
          ${thumbsHTML}
          <div class="eb-card-actions">
            <button class="btn-sm" data-action="viewEB" data-id="${item.id}">查看</button>
            <button class="btn-sm" data-action="editEB" data-id="${item.id}">✏️</button>
            <button class="btn-sm danger" data-action="deleteEB" data-id="${item.id}">删除</button>
          </div>
        `;
        listEl.appendChild(card);
      });

      // 分页
      const totalPages = Math.ceil(data.total / 20) || 1;
      if (totalPages > 1) {
        const pagDiv = document.createElement("div");
        pagDiv.className = "pagination";
        pagDiv.style.marginTop = "12px";
        pagDiv.innerHTML = `
          <button ${ebPage <= 1 ? "disabled" : ""} id="ebPrev">上一页</button>
          <span>${ebPage} / ${totalPages}</span>
          <button ${ebPage >= totalPages ? "disabled" : ""} id="ebNext">下一页</button>
        `;
        listEl.appendChild(pagDiv);
        pagDiv.querySelector("#ebPrev")?.addEventListener("click", () => { ebPage--; loadBookItems(); });
        pagDiv.querySelector("#ebNext")?.addEventListener("click", () => { ebPage++; loadBookItems(); });
      }
    }

    // 绑定标签点击
    listEl.querySelectorAll(".tag-chip").forEach(chip => {
      chip.addEventListener("click", () => {
        ebCurrentTag = chip.dataset.tag;
        ebPage = 1;
        loadBookItems();
      });
    });

    // 绑定题目操作
    listEl.querySelectorAll("[data-action='viewEB']").forEach(btn =>
      btn.addEventListener("click", () => viewErrorBookDetail(btn.dataset.id)));
    listEl.querySelectorAll("[data-action='editEB']").forEach(btn =>
      btn.addEventListener("click", (e) => { e.stopPropagation(); editErrorBookItem(btn.dataset.id); }));
    listEl.querySelectorAll("[data-action='deleteEB']").forEach(btn =>
      btn.addEventListener("click", (e) => { e.stopPropagation(); deleteErrorBookItem(btn.dataset.id); }));
  } catch (err) {
    listEl.innerHTML = `<div class="overlay-empty">加载失败: ${err.message}</div>`;
  }
}

async function viewErrorBookDetail(itemId) {
  try {
    const item = await api(`/api/error-books/${ebCurrentBookId}/items/${itemId}`);
    const body = $("#ebDetailBody");

    let imagesHTML = "";
    if (item.images?.length) {
      imagesHTML = `<div class="detail-images">${item.images.map(n =>
        `<img src="/data/images/${n}" alt="题目图片">`
      ).join("")}</div>`;
    }

    const tagsHTML = (item.tags || []).map(t =>
      `<span class="tag-item">${t}</span>`
    ).join(" ") || "无标签";

    body.innerHTML = `
      <div class="detail-section">
        <h4>🏷️ 标签</h4>
        <div>${tagsHTML}</div>
      </div>
      ${item.note ? `<div class="detail-section"><h4>📝 笔记</h4><div class="detail-text">${item.note}</div></div>` : ""}
      <div class="detail-section">
        <h4>📝 题目</h4>
        <div class="detail-text">${item.recognized_text || item.question_text || "(空)"}</div>
      </div>
      ${imagesHTML}
      <div class="detail-section">
        <h4>✅ 解答</h4>
        <div class="markdown-body">${renderMarkdownWithLatex(item.solution || "(空)")}</div>
      </div>
    `;
    typesetElement(body);
    $("#errorBookDetailOverlay").classList.remove("hidden");
  } catch (err) {
    alert(`加载详情失败: ${err.message}`);
  }
}

async function editErrorBookItem(itemId) {
  try {
    const item = await api(`/api/error-books/${ebCurrentBookId}/items/${itemId}`);
    const newTags = prompt("标签（逗号分隔）：", (item.tags || []).join(", "));
    if (newTags === null) return;
    const newNote = prompt("笔记：", item.note || "");
    if (newNote === null) return;

    const tags = newTags.split(/[；;，,]+/).map(t => t.trim()).filter(Boolean);
    await api(`/api/error-books/${ebCurrentBookId}/items/${itemId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tags, note: newNote }),
    });
    loadBookItems();
  } catch (err) {
    alert(`更新失败: ${err.message}`);
  }
}

async function deleteErrorBookItem(itemId) {
  if (!confirm("确定从错题本中删除这道题吗？")) return;
  try {
    await api(`/api/error-books/${ebCurrentBookId}/items/${itemId}`, { method: "DELETE" });
    loadBookItems();
  } catch (err) {
    alert(`删除失败: ${err.message}`);
  }
}

/* ====== 添加到错题本弹窗（含书本选择） ====== */
let pendingHistoryId = null;
let selectedTags = [];

async function openTagModal(historyId) {
  pendingHistoryId = historyId;
  selectedTags = [];
  $("#tagModal").classList.remove("hidden");
  renderSelectedTags();
  $("#tagInput").value = "";

  // 加载错题本列表到下拉框
  try {
    const data = await api("/api/error-books");
    const select = $("#bookSelector");
    select.innerHTML = data.books.length
      ? data.books.map(b => `<option value="${b.id}">${b.name}（${b.item_count}题）</option>`).join("")
      : '<option value="">请先新建错题本</option>';
  } catch {
    $("#bookSelector").innerHTML = '<option value="">加载失败</option>';
  }

  loadTagSuggestions();
  $("#tagInput").focus();
}

function closeTagModal() {
  $("#tagModal").classList.add("hidden");
  pendingHistoryId = null;
  selectedTags = [];
}

async function loadTagSuggestions() {
  const select = $("#bookSelector");
  const bookId = select.value;
  if (!bookId) { $("#tagSuggestions").innerHTML = ""; return; }
  try {
    const data = await api(`/api/error-books/${bookId}/tags`);
    const container = $("#tagSuggestions");
    container.innerHTML = data.tags
      .filter(t => !selectedTags.includes(t.name))
      .map(t => `<span class="tag-suggestion" data-tag="${t.name}">${t.name} (${t.count})</span>`)
      .join("");
    container.querySelectorAll(".tag-suggestion").forEach(el => {
      el.addEventListener("click", () => {
        const tag = el.dataset.tag;
        if (!selectedTags.includes(tag)) {
          selectedTags.push(tag);
          renderSelectedTags();
          el.remove();
        }
      });
    });
  } catch {
    $("#tagSuggestions").innerHTML = "";
  }
}

// 切换错题本时重新加载标签建议
$("#bookSelector").addEventListener("change", () => {
  selectedTags = [];
  renderSelectedTags();
  loadTagSuggestions();
});

function renderSelectedTags() {
  $("#tagSelected").innerHTML = selectedTags.map(t =>
    `<span class="tag-item">${t} <span class="tag-remove" data-tag="${t}">&times;</span></span>`
  ).join("");
  $("#tagSelected").querySelectorAll(".tag-remove").forEach(el => {
    el.addEventListener("click", () => {
      selectedTags = selectedTags.filter(t => t !== el.dataset.tag);
      renderSelectedTags();
      loadTagSuggestions();
    });
  });
}

$("#tagInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    const raw = $("#tagInput").value.trim();
    // 支持中文/英文分号、逗号作为分隔符
    const parts = raw.split(/[；;，,]+/).map(s => s.trim()).filter(Boolean);
    parts.forEach(val => {
      if (!selectedTags.includes(val)) {
        selectedTags.push(val);
      }
    });
    renderSelectedTags();
    loadTagSuggestions();
    $("#tagInput").value = "";
  }
});

$("#btnTagModalClose").addEventListener("click", closeTagModal);
$("#tagModal").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) closeTagModal();
});

$("#btnSaveToErrorBook").addEventListener("click", async () => {
  if (!pendingHistoryId) return;
  const bookId = $("#bookSelector").value;
  if (!bookId) { alert("请先选择一个错题本"); return; }
  try {
    await api(`/api/error-books/${bookId}/items`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        history_id: pendingHistoryId,
        tags: selectedTags,
        note: "",
      }),
    });
    closeTagModal();
    alert("已保存到错题本！");
  } catch (err) {
    alert(`保存失败: ${err.message}`);
  }
});

/* ====== 页面初始化 ====== */
document.addEventListener("DOMContentLoaded", () => {
  switchMode("image");
  restoreSession();
  initHistoryPanel();
  initErrorBookPanel();
});
