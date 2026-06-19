"""千问 API 封装 — vision 识别 + 文本解题 + 聊天追问"""

import base64
import json
import requests
from config import DASHSCOPE_API_KEY, DASHSCOPE_BASE_URL, MODEL, API_TIMEOUT_SECONDS

LATEX_HINT = (
    "数学公式必须用LaTeX格式：行内公式用 $...$ 包裹，独立公式用 $$...$$ 包裹。"
    "例如：行内 $f(x)$，独立 $$\lim_{x \to 0} f(x)$$"
)


def _image_to_data_url(image_path: str) -> str:
    import os
    ext = os.path.splitext(image_path)[1].lower().lstrip(".")
    mime_map = {"jpg": "jpeg", "jpeg": "jpeg", "png": "png", "gif": "gif", "webp": "webp", "bmp": "bmp"}
    mime = mime_map.get(ext, "jpeg")
    with open(image_path, "rb") as f:
        data = base64.b64encode(f.read()).decode("utf-8")
    return f"data:image/{mime};base64,{data}"


def _call_api(messages: list[dict], temperature: float = 0.3) -> str:
    """同步调用千问 API，返回完整回复"""
    url = DASHSCOPE_BASE_URL.rstrip("/") + "/chat/completions"
    headers = {
        "Authorization": f"Bearer {DASHSCOPE_API_KEY}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": MODEL,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": 8192,
    }
    resp = requests.post(url, json=payload, headers=headers, timeout=API_TIMEOUT_SECONDS)
    resp.raise_for_status()
    return resp.json()["choices"][0]["message"]["content"]


def _call_api_stream(messages: list[dict], temperature: float = 0.3):
    """流式调用千问 API，逐 chunk yield 文本"""
    url = DASHSCOPE_BASE_URL.rstrip("/") + "/chat/completions"
    headers = {
        "Authorization": f"Bearer {DASHSCOPE_API_KEY}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": MODEL,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": 8192,
        "stream": True,
    }
    resp = requests.post(url, json=payload, headers=headers, timeout=API_TIMEOUT_SECONDS, stream=True)
    resp.raise_for_status()

    for line in resp.iter_lines():
        if not line:
            continue
        text = line.decode("utf-8").strip()
        if not text.startswith("data:"):
            continue
        data_str = text[5:].strip()
        if data_str == "[DONE]":
            break
        try:
            chunk = json.loads(data_str)
            delta = chunk.get("choices", [{}])[0].get("delta", {})
            content = delta.get("content", "")
            if content:
                yield content
        except (json.JSONDecodeError, KeyError, IndexError):
            continue


def recognize_image(image_path: str) -> str:
    """发送图片到 VL 模型，识别数学题目（同步，较快不做流式）"""
    data_url = _image_to_data_url(image_path)
    messages = [{
        "role": "user",
        "content": [
            {"type": "image_url", "image_url": {"url": data_url}},
            {"type": "text", "text": (
                "请仔细识别图片中的所有数学内容，包括题目文字、数学公式、符号等。\n"
                + LATEX_HINT + "\n"
                "只做识别和转写，不要解答。用中文输出。"
            )},
        ],
    }]
    return _call_api(messages, temperature=0.1)


def solve_problem_stream(recognized_text: str):
    """流式生成解答，逐 chunk yield"""
    messages = [{
        "role": "user",
        "content": (
            "你是一位经验丰富的大学数学教授。请逐步解答以下数学题目。\n\n"
            "要求：\n"
            "1. 每一步推理都要有清晰的文字解释\n"
            + LATEX_HINT + "\n"
            "3. 最终答案用 $\\boxed{...}$ 标出\n"
            "4. 如果题目包含多个小问，请用（1）、（2）等分别标注\n"
            "5. 用中文回答\n\n"
            f"题目：\n---\n{recognized_text}\n---"
        ),
    }]
    yield from _call_api_stream(messages, temperature=0.3)


def chat_reply_stream(recognized_text: str, solution: str, history: list[dict], new_message: str):
    """流式聊天回复，逐 chunk yield"""
    system_msg = (
        "你是一位耐心细致的数学辅导老师。你正在帮助一位学生深入理解一道数学题。\n\n"
        f"原始题目：\n{recognized_text}\n\n"
        f"之前的完整解答：\n{solution}\n\n"
        "学生正在针对这道题提问。请用中文回答。" + LATEX_HINT + "\n"
        "如果学生问的是不相关的问题，请礼貌地将话题引导回题目本身。"
    )
    messages = [{"role": "system", "content": system_msg}]
    for msg in history[-20:]:
        messages.append(msg)
    messages.append({"role": "user", "content": new_message})
    yield from _call_api_stream(messages, temperature=0.5)


# 保留同步版本作为 fallback
def solve_problem(recognized_text: str) -> str:
    return _call_api([{"role": "user", "content": (
        "你是一位经验丰富的大学数学教授。请逐步解答以下数学题目。\n\n"
        "要求：\n"
        "1. 每一步推理都要有清晰的文字解释\n"
        + LATEX_HINT + "\n"
        "3. 最终答案用 $\\boxed{...}$ 标出\n"
        "4. 如果题目包含多个小问，请用（1）、（2）等分别标注\n"
        "5. 用中文回答\n\n"
        f"题目：\n---\n{recognized_text}\n---"
    )}], temperature=0.3)


def chat_reply(recognized_text: str, solution: str, history: list[dict], new_message: str) -> str:
    system_msg = (
        "你是一位耐心细致的数学辅导老师。你正在帮助一位学生深入理解一道数学题。\n\n"
        f"原始题目：\n{recognized_text}\n\n"
        f"之前的完整解答：\n{solution}\n\n"
        "学生正在针对这道题提问。请用中文回答。" + LATEX_HINT + "\n"
        "如果学生问的是不相关的问题，请礼貌地将话题引导回题目本身。"
    )
    messages = [{"role": "system", "content": system_msg}]
    for msg in history[-20:]:
        messages.append(msg)
    messages.append({"role": "user", "content": new_message})
    return _call_api(messages, temperature=0.5)
