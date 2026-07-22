"""数学题解算器 — Flask 后端（SSE 流式响应）"""

import os
import json
import base64
import tempfile
from flask import Flask, request, jsonify, send_from_directory, Response, stream_with_context, redirect

from config import MAX_IMAGE_SIZE_MB, MAX_IMAGE_DIMENSION, is_configured
from services.qwen_client import (
    recognize_image,
    solve_problem_stream,
    chat_reply_stream,
    _build_user_content,
)
from services.session_manager import SessionManager
from services.history_manager import HistoryManager
from services.error_book_manager import ErrorBookManager

app = Flask(__name__, static_folder="static", template_folder="templates")
app.config["MAX_CONTENT_LENGTH"] = MAX_IMAGE_SIZE_MB * 1024 * 1024

session_manager = SessionManager()
history_manager = HistoryManager()
error_book_manager = ErrorBookManager()


# ==================== 工具函数 ====================

def _resize_image(filepath: str) -> str:
    try:
        from PIL import Image
        img = Image.open(filepath)
        w, h = img.size
        if max(w, h) > MAX_IMAGE_DIMENSION:
            ratio = MAX_IMAGE_DIMENSION / max(w, h)
            img = img.resize((int(w * ratio), int(h * ratio)), Image.LANCZOS)
        if img.mode in ("RGBA", "P"):
            img = img.convert("RGB")
        img.save(filepath, "JPEG", quality=85)
    except Exception:
        pass
    return filepath


def _sse_event(data: dict) -> str:
    """格式化为 SSE 事件"""
    return f"data: {json.dumps(data, ensure_ascii=False)}\n\n"


def _error_handler(e: Exception):
    """统一错误转 SSE error 事件"""
    msg = str(e)
    if "401" in msg:
        yield _sse_event({"type": "error", "message": "API 密钥无效"})
    elif "429" in msg:
        yield _sse_event({"type": "error", "message": "请求过于频繁，请稍后重试"})
    elif "timeout" in msg.lower():
        yield _sse_event({"type": "error", "message": "AI 服务响应超时，请重试"})
    else:
        yield _sse_event({"type": "error", "message": f"处理失败: {msg}"})


# ==================== 页面路由 ====================

@app.route("/")
def index():
    if not is_configured():
        return redirect("/settings")
    return send_from_directory("templates", "index.html")


@app.route("/data/images/<path:filename>")
def serve_data_image(filename):
    """提供 data/images 目录下的缩略图"""
    import os as _os
    data_dir = _os.path.join(_os.path.dirname(__file__), "data", "images")
    return send_from_directory(data_dir, filename)


# ==================== SSE 流式 API ====================

@app.route("/api/solve", methods=["POST"])
def api_solve():
    """上传图片（最多5张，base64 JSON 或 multipart）→ 识别 → 流式解答（SSE）"""
    tmp_paths = []
    user_text = ""

    if not request.is_json:
        return jsonify({"error": "不支持的请求格式"}), 400

    data = request.get_json(silent=True) or {}
    data_urls = data.get("images", [])
    if not data_urls:
        return jsonify({"error": "请上传图片文件"}), 400
    data_urls = data_urls[:5]
    user_text = (data.get("text") or "").strip()

    # 将 base64 data URL 解码保存为临时文件
    for data_url in data_urls:
        try:
            header, b64 = data_url.split(",", 1)
            ext = ".png"
            if "image/" in header:
                mime = header.split("image/")[1].split(";")[0]
                ext = "." + mime if mime else ".png"
            img_data = base64.b64decode(b64)
            tmp = tempfile.NamedTemporaryFile(suffix=ext, delete=False)
            tmp.write(img_data)
            tmp.close()
            tmp_paths.append(tmp.name)
        except Exception:
            continue

    if not tmp_paths:
        return jsonify({"error": "请上传图片文件"}), 400

    def generate():
        nonlocal tmp_paths
        try:
            # 逐张压缩
            for p in tmp_paths:
                _resize_image(p)

            # Phase 1: 识别题目
            yield _sse_event({"type": "phase", "message": "识别题目中..."})
            recognized_text = recognize_image(tmp_paths, user_text=user_text)

            if not recognized_text or len(recognized_text.strip()) < 5:
                yield _sse_event({"type": "error", "message": "未检测到数学题目"})
                return

            yield _sse_event({"type": "recognized", "text": recognized_text})

            # Phase 2: 流式解答
            yield _sse_event({"type": "phase", "message": "生成解答中..."})

            full_solution = ""
            for chunk in solve_problem_stream(recognized_text, user_text=user_text):
                full_solution += chunk
                yield _sse_event({"type": "chunk", "content": chunk})

            # 保存浏览记录
            history_record = history_manager.add(
                input_mode="image",
                question_text=user_text,
                recognized_text=recognized_text,
                solution=full_solution,
                image_data_urls=data_urls,
            )
            # 创建会话
            session = session_manager.create(
                recognized_text=recognized_text,
                solution=full_solution,
            )
            session.history_id = history_record["id"]
            yield _sse_event({"type": "done", "session_id": session.session_id})

        except GeneratorExit:
            pass
        except Exception as e:
            yield from _error_handler(e)
        finally:
            for p in tmp_paths:
                try:
                    os.unlink(p)
                except OSError:
                    pass

    return Response(
        stream_with_context(generate()),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@app.route("/api/solve-text", methods=["POST"])
def api_solve_text():
    """文本输入 → 流式解答（SSE）"""
    data = request.get_json(silent=True) or {}
    text = (data.get("text", "") or "").strip()

    if not text:
        return jsonify({"error": "请输入题目文本"}), 400
    if len(text) > 10000:
        return jsonify({"error": "文本过长，请控制在 10000 字符以内"}), 400

    def generate():
        try:
            recognized_text = text
            yield _sse_event({"type": "recognized", "text": recognized_text})
            yield _sse_event({"type": "phase", "message": "生成解答中..."})

            full_solution = ""
            for chunk in solve_problem_stream(recognized_text):
                full_solution += chunk
                yield _sse_event({"type": "chunk", "content": chunk})

            # 保存浏览记录
            history_record = history_manager.add(
                input_mode="text",
                question_text=text,
                recognized_text=recognized_text,
                solution=full_solution,
            )
            session = session_manager.create(
                recognized_text=recognized_text,
                solution=full_solution,
            )
            session.history_id = history_record["id"]
            yield _sse_event({"type": "done", "session_id": session.session_id})

        except GeneratorExit:
            pass
        except Exception as e:
            yield from _error_handler(e)

    return Response(
        stream_with_context(generate()),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@app.route("/api/chat", methods=["POST"])
def api_chat():
    """追问 → 流式回复（SSE）。支持 JSON（纯文本）和 multipart/form-data（图片+文字）"""
    image_path = None

    if request.content_type and "multipart/form-data" in request.content_type:
        # 图片 + 文字模式
        session_id = (request.form.get("session_id") or "").strip()
        message = (request.form.get("message") or "").strip()
    else:
        # 纯文本 JSON 模式（向后兼容）
        data = request.get_json(silent=True) or {}
        session_id = data.get("session_id", "")
        message = (data.get("message", "") or "").strip()

    if not session_id:
        return jsonify({"error": "缺少会话 ID"}), 400
    if not message and not (
        request.content_type
        and "multipart/form-data" in request.content_type
        and "image" in request.files
        and request.files["image"].filename
    ):
        return jsonify({"error": "请输入消息或上传图片"}), 400
    if len(message) > 4000:
        return jsonify({"error": "消息过长"}), 400

    session = session_manager.get(session_id)
    if not session:
        return jsonify({"error": "会话已过期，请重新上传"}), 404

    # 先验证 session，再保存图片（避免 session 无效时泄漏临时文件）
    if request.content_type and "multipart/form-data" in request.content_type:
        if "image" in request.files:
            file = request.files["image"]
            if file.filename:
                ext = os.path.splitext(file.filename or "image.png")[1] or ".png"
                tmp_img = tempfile.NamedTemporaryFile(suffix=ext, delete=False)
                file.save(tmp_img.name)
                image_path = tmp_img.name

    def generate():
        try:
            full_reply = ""
            for chunk in chat_reply_stream(
                recognized_text=session.recognized_text,
                solution=session.solution,
                history=session.chat_history,
                new_message=message,
                image_path=image_path,
            ):
                full_reply += chunk
                yield _sse_event({"type": "chunk", "content": chunk})

            # 存入历史（图片消息以多模态数组存储）
            user_content = _build_user_content(message, image_path)
            session.chat_history.append({"role": "user", "content": user_content})
            session.chat_history.append({"role": "assistant", "content": full_reply})
            if len(session.chat_history) > 20:
                session.chat_history = session.chat_history[-20:]

            # 同步更新浏览记录中的 chat_history
            if session.history_id:
                history_manager.append_chat(session.history_id, session.chat_history)

            yield _sse_event({"type": "done"})

        except GeneratorExit:
            pass
        except Exception as e:
            yield from _error_handler(e)
        finally:
            if image_path:
                try:
                    os.unlink(image_path)
                except OSError:
                    pass

    return Response(
        stream_with_context(generate()),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


# ==================== 设置页面 ====================

@app.route("/settings")
def settings_page():
    return send_from_directory("templates", "settings.html")


@app.route("/api/settings", methods=["GET", "POST"])
def api_settings():
    """GET: 返回当前配置（Key 脱敏）；POST: 保存配置到 .env 文件"""
    env_path = os.path.join(os.path.dirname(__file__), ".env")

    if request.method == "GET":
        key = os.getenv("DASHSCOPE_API_KEY") or ""
        masked = key[:3] + "***" + key[-4:] if len(key) > 8 else (key[:2] + "***" if len(key) > 3 else "")
        return jsonify({
            "api_key_masked": masked,
            "model": os.getenv("VISION_MODEL", "qwen3.5-omni-plus"),
            "base_url": os.getenv("DASHSCOPE_BASE_URL", "https://dashscope.aliyuncs.com/compatible-mode/v1"),
        })

    # POST: 保存
    data = request.get_json(silent=True) or {}
    api_key = (data.get("api_key") or "").strip()
    model = (data.get("model") or "").strip()
    base_url = (data.get("base_url") or "").strip()

    if not api_key:
        return jsonify({"error": "请输入 API 密钥"}), 400

    lines = []
    if os.path.exists(env_path):
        with open(env_path, "r", encoding="utf-8") as f:
            lines = f.read().splitlines()

    updated = {"DASHSCOPE_API_KEY": False, "VISION_MODEL": False, "DASHSCOPE_BASE_URL": False}
    new_lines = []
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("DASHSCOPE_API_KEY=") or stripped.startswith("DASHSCOPE_API_KEY "):
            new_lines.append(f"DASHSCOPE_API_KEY={api_key}")
            updated["DASHSCOPE_API_KEY"] = True
        elif stripped.startswith("VISION_MODEL=") or stripped.startswith("VISION_MODEL "):
            new_lines.append(f"VISION_MODEL={model or 'qwen3.5-omni-plus'}")
            updated["VISION_MODEL"] = True
        elif stripped.startswith("DASHSCOPE_BASE_URL=") or stripped.startswith("DASHSCOPE_BASE_URL "):
            new_lines.append(f"DASHSCOPE_BASE_URL={base_url or 'https://dashscope.aliyuncs.com/compatible-mode/v1'}")
            updated["DASHSCOPE_BASE_URL"] = True
        else:
            new_lines.append(line)

    for key_name, env_key in [("DASHSCOPE_API_KEY", "DASHSCOPE_API_KEY"), ("VISION_MODEL", "VISION_MODEL"), ("DASHSCOPE_BASE_URL", "DASHSCOPE_BASE_URL")]:
        if not updated[env_key]:
            val = api_key if env_key == "DASHSCOPE_API_KEY" else (model if env_key == "VISION_MODEL" else (base_url or "https://dashscope.aliyuncs.com/compatible-mode/v1"))
            new_lines.append(f"{env_key}={val}")

    with open(env_path, "w", encoding="utf-8") as f:
        f.write("\n".join(new_lines) + "\n")

    # 更新当前进程环境变量
    os.environ["DASHSCOPE_API_KEY"] = api_key
    if model:
        os.environ["VISION_MODEL"] = model
    if base_url:
        os.environ["DASHSCOPE_BASE_URL"] = base_url

    return jsonify({"success": True})


# ==================== 浏览记录 API ====================

@app.route("/api/history", methods=["GET"])
def api_history_list():
    """浏览记录列表（分页）"""
    page = request.args.get("page", 1, type=int)
    page_size = request.args.get("page_size", 20, type=int)
    result = history_manager.list_all(page=page, page_size=min(page_size, 50))
    return jsonify(result)


@app.route("/api/history/<record_id>", methods=["GET"])
def api_history_detail(record_id):
    """浏览记录详情"""
    record = history_manager.get(record_id)
    if not record:
        return jsonify({"error": "记录不存在"}), 404
    return jsonify(record)


@app.route("/api/history/<record_id>", methods=["DELETE"])
def api_history_delete(record_id):
    """删除浏览记录"""
    ok = history_manager.delete(record_id)
    if not ok:
        return jsonify({"error": "记录不存在"}), 404
    return jsonify({"success": True})


# ==================== 错题本 API（多本分类） ====================

@app.route("/api/error-books", methods=["GET"])
def api_error_books_list():
    """列出所有错题本"""
    return jsonify({"books": error_book_manager.list_books()})


@app.route("/api/error-books", methods=["POST"])
def api_error_books_create():
    """新建错题本"""
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"error": "请输入错题本名称"}), 400
    if len(name) > 50:
        return jsonify({"error": "名称过长"}), 400
    book = error_book_manager.create_book(name)
    return jsonify(book)


@app.route("/api/error-books/<book_id>", methods=["PUT"])
def api_error_books_rename(book_id):
    """重命名错题本"""
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"error": "请输入错题本名称"}), 400
    book = error_book_manager.rename_book(book_id, name)
    if not book:
        return jsonify({"error": "错题本不存在"}), 404
    return jsonify(book)


@app.route("/api/error-books/<book_id>", methods=["DELETE"])
def api_error_books_delete(book_id):
    """删除错题本"""
    ok = error_book_manager.delete_book(book_id)
    if not ok:
        return jsonify({"error": "错题本不存在"}), 404
    return jsonify({"success": True})


@app.route("/api/error-books/<book_id>/items", methods=["GET"])
def api_error_book_items(book_id):
    """错题本题目列表（支持 ?tag= 筛选）"""
    tag = request.args.get("tag", "").strip()
    page = request.args.get("page", 1, type=int)
    page_size = request.args.get("page_size", 20, type=int)
    result = error_book_manager.list_items(book_id, tag=tag, page=page, page_size=min(page_size, 50))
    if result is None:
        return jsonify({"error": "错题本不存在"}), 404
    return jsonify(result)


@app.route("/api/error-books/<book_id>/items", methods=["POST"])
def api_error_book_add_item(book_id):
    """从浏览记录添加题目到错题本"""
    data = request.get_json(silent=True) or {}
    history_id = (data.get("history_id") or "").strip()
    tags = data.get("tags", [])
    note = (data.get("note") or "").strip()

    if not history_id:
        return jsonify({"error": "缺少 history_id"}), 400

    record = history_manager.get(history_id)
    if not record:
        return jsonify({"error": "浏览记录不存在"}), 404

    item = error_book_manager.add_item(book_id, record, tags=tags, note=note)
    if item is None:
        return jsonify({"error": "错题本不存在"}), 404
    return jsonify(item)


@app.route("/api/error-books/<book_id>/items/<item_id>", methods=["GET"])
def api_error_book_item_detail(book_id, item_id):
    """错题本题目详情"""
    item = error_book_manager.get_item(book_id, item_id)
    if not item:
        return jsonify({"error": "条目不存在"}), 404
    return jsonify(item)


@app.route("/api/error-books/<book_id>/items/<item_id>", methods=["PUT"])
def api_error_book_item_update(book_id, item_id):
    """更新题目标签/笔记"""
    data = request.get_json(silent=True) or {}
    tags = data.get("tags", None)
    note = data.get("note", None)
    item = error_book_manager.update_item(book_id, item_id, tags=tags, note=note)
    if not item:
        return jsonify({"error": "条目不存在"}), 404
    return jsonify(item)


@app.route("/api/error-books/<book_id>/items/<item_id>", methods=["DELETE"])
def api_error_book_item_delete(book_id, item_id):
    """删除题目"""
    ok = error_book_manager.delete_item(book_id, item_id)
    if not ok:
        return jsonify({"error": "条目不存在"}), 404
    return jsonify({"success": True})


@app.route("/api/error-books/<book_id>/tags", methods=["GET"])
def api_error_book_tags(book_id):
    """错题本标签及计数"""
    tags = error_book_manager.get_tags(book_id)
    if tags is None:
        return jsonify({"error": "错题本不存在"}), 404
    return jsonify({"tags": tags})


# ==================== 非流式 API（保留兼容） ====================

@app.route("/api/session/<session_id>", methods=["GET"])
def api_check_session(session_id):
    session = session_manager.get(session_id)
    if not session:
        return jsonify({"valid": False}), 404
    return jsonify({
        "valid": True,
        "session_id": session.session_id,
        "recognized_text": session.recognized_text,
        "solution": session.solution,
        "chat_history": session.chat_history,
    })


@app.route("/api/reset", methods=["POST"])
def api_reset():
    data = request.get_json(silent=True) or {}
    session_id = data.get("session_id", "")
    if session_id:
        session_manager.delete(session_id)
    return jsonify({"success": True})


@app.route("/api/health")
def api_health():
    return jsonify({"status": "ok"})


# ==================== 启动 ====================

if __name__ == "__main__":
    import sys
    sys.stdout.reconfigure(encoding="utf-8")
    print("\n== 数学题解算器 启动中...")
    print("   打开浏览器访问: http://localhost:5001\n")
    from waitress import serve
    serve(app, host="127.0.0.1", port=5001, threads=8)
