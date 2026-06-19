"""数学题解算器 — Flask 后端（SSE 流式响应）"""

import os
import json
import tempfile
from flask import Flask, request, jsonify, send_from_directory, Response, stream_with_context

from config import MAX_IMAGE_SIZE_MB, MAX_IMAGE_DIMENSION
from services.qwen_client import (
    recognize_image,
    solve_problem_stream,
    chat_reply_stream,
    solve_problem,
    chat_reply,
    _build_user_content,
)
from services.session_manager import SessionManager

app = Flask(__name__, static_folder="static", template_folder="templates")
app.config["MAX_CONTENT_LENGTH"] = MAX_IMAGE_SIZE_MB * 1024 * 1024

session_manager = SessionManager()


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
    return send_from_directory("templates", "index.html")


# ==================== SSE 流式 API ====================

@app.route("/api/solve", methods=["POST"])
def api_solve():
    """上传图片 → 识别 → 流式解答（SSE）"""
    if "image" not in request.files:
        return jsonify({"error": "请上传图片文件"}), 400

    file = request.files["image"]
    if file.filename == "":
        return jsonify({"error": "请选择图片文件"}), 400

    user_text = (request.form.get("text") or "").strip()

    ext = os.path.splitext(file.filename or "image.png")[1] or ".png"
    with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as tmp:
        file.save(tmp.name)
        tmp_path = tmp.name

    def generate():
        nonlocal tmp_path
        try:
            _resize_image(tmp_path)

            # Phase 1: 识别题目
            yield _sse_event({"type": "phase", "message": "识别题目中..."})
            recognized_text = recognize_image(tmp_path, user_text=user_text)

            if not recognized_text or len(recognized_text.strip()) < 5:
                yield _sse_event({"type": "error", "message": "未检测到数学题目"})
                return

            yield _sse_event({"type": "recognized", "text": recognized_text})

            # Phase 2: 流式解答
            yield _sse_event({"type": "phase", "message": "生成解答中..."})

            full_solution = ""
            for chunk in solve_problem_stream(recognized_text):
                full_solution += chunk
                yield _sse_event({"type": "chunk", "content": chunk})

            # 创建会话
            session = session_manager.create(
                recognized_text=recognized_text,
                solution=full_solution,
            )
            yield _sse_event({"type": "done", "session_id": session.session_id})

        except GeneratorExit:
            pass
        except Exception as e:
            yield from _error_handler(e)
        finally:
            try:
                os.unlink(tmp_path)
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

            session = session_manager.create(
                recognized_text=recognized_text,
                solution=full_solution,
            )
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
        if "image" in request.files:
            file = request.files["image"]
            if file.filename:
                ext = os.path.splitext(file.filename or "image.png")[1] or ".png"
                tmp_img = tempfile.NamedTemporaryFile(suffix=ext, delete=False)
                file.save(tmp_img.name)
                image_path = tmp_img.name
    else:
        # 纯文本 JSON 模式（向后兼容）
        data = request.get_json(silent=True) or {}
        session_id = data.get("session_id", "")
        message = (data.get("message", "") or "").strip()

    if not session_id:
        return jsonify({"error": "缺少会话 ID"}), 400
    if not message:
        return jsonify({"error": "请输入消息"}), 400
    if len(message) > 4000:
        return jsonify({"error": "消息过长"}), 400

    session = session_manager.get(session_id)
    if not session:
        return jsonify({"error": "会话已过期，请重新上传"}), 404

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
    print("   打开浏览器访问: http://localhost:5000\n")
    app.run(host="127.0.0.1", port=5000, debug=True, threaded=True)
