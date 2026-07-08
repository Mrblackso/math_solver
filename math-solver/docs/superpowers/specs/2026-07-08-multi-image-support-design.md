# 多图片上传支持 — 设计文档

**日期**: 2026-07-08
**状态**: 已批准

## 目标

初始提问和追问阶段均支持上传多张图片，AI 将所有图片合并理解为同一道题的内容。

## 当前状态

| 位置 | 现状 |
|------|------|
| `/api/solve` | `request.files["image"]` 单文件 |
| `/api/chat` | `request.files["image"]` 单文件 |
| `STATE.imageFile` | 单个 File 对象 |
| `STATE.chatImageFile` | 单个 File 对象 |
| `fileInput` | 无 `multiple` 属性 |
| `recognize_image()` | `image_path: str` |
| `_build_user_content()` | `image_path: str = None` |
| `chat_reply_stream()` | `image_path: str = None` |

## 设计决策

- **合并理解（方案 A）**：所有图片作为 content array 中多个 `image_url` block 一同发送给 Qwen VL 模型，prompt 告知"它们属于同一道题，请综合分析"。
- 用户无需选择模式 — 这是唯一默认行为。

## 后端改动

### `services/qwen_client.py`

三个函数签名变更：

```python
# 之前
def recognize_image(image_path: str, user_text: str = "") -> str:
def _build_user_content(text: str, image_path: str = None):
def chat_reply_stream(..., image_path: str = None):

# 之后
def recognize_image(image_paths: list[str], user_text: str = "") -> str:
def _build_user_content(text: str, image_paths: list[str] = None):
def chat_reply_stream(..., image_paths: list[str] = None):
```

内部逻辑：遍历 `image_paths`，每个生成一个 `{"type": "image_url", "image_url": {"url": data_url}}` block，最后追加 text block。prompt 措辞更新为"以上所有图片"。

### `app.py`

| 路由 | 变更 |
|------|------|
| `/api/solve` | `request.files["image"]` → `request.files.getlist("images")`；循环保存、resize 所有图片；传入 `recognize_image(image_paths=[...])`；finally 块清理所有临时文件 |
| `/api/chat` | 同上：`"image"` → `"images"`，多文件处理 |

向后兼容：`request.files.getlist("images")` 在只有 1 个文件时也能正常工作。

## 前端改动

### `templates/index.html`

- 初始区 `#fileInput` 加 `multiple` 属性
- 预览区改为 `<div class="preview-grid" id="previewGrid">` + "添加更多"按钮
- 追问区 `#chatImageInput` 加 `multiple`，预览区改为多图网格

### `static/js/app.js`

状态变更：
```javascript
// 之前
imageFile: null,
chatImageFile: null,
chatImageDataUrl: null,

// 之后
imageFiles: [],       // File[]
chatImageFiles: [],   // File[]
chatImageDataUrls: [], // string[]
```

关键逻辑：
- `selectFiles(newFiles)` — 过滤验证后 concat 到数组，刷新预览网格
- `removeFile(index)` — splice 删除，刷新预览
- `removeChatImage(index)` — 同上
- 构建 FormData：`imageFiles.forEach(f => formData.append("images", f))`
- `btnRemove` 改为清空整个数组
- `switchMode`、`updateSolveButton`、`resetChat` 等适配数组

### `static/css/style.css`

新增：
```css
.preview-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(100px, 1fr)); gap: 8px; }
.preview-item { position: relative; }
.preview-item img { width: 100%; aspect-ratio: 1; object-fit: cover; border-radius: 6px; border: 1px solid var(--border); }
.preview-item .preview-remove { /* 已有的删除按钮样式复用 */ }
.preview-add { /* 虚线边框、＋图标，点击触发 fileInput.click() */ }
```

移除：`.upload-zone.has-file { display: none; }` — 有多图时上传区不再隐藏，而是缩小为添加按钮。

## 测试要点

1. 单图上传 — 行为与改动前一致
2. 多图上传（2+ 张）— 均被识别和解答
3. 图片 + 文字（solveQuestion）— 多图 + 说明文字正确传递给 AI
4. 追问多图 — chat 区多图上传正常流式回复
5. 删除单张图片 — 其他图片保留
6. 清空所有图片 — 回到空状态
7. 会话恢复 — 历史消息中多图正确回显：`appendMessage` 需检测 content 是否为数组（多模态），从中提取 text 和 image URLs 分别渲染
