"""千问 API 封装 — vision 识别 + 文本解题 + 聊天追问"""

import os
import base64
import json
import requests
from config import API_TIMEOUT_SECONDS

# 动态读取（支持设置页面修改后即时生效）
def _get_api_key():
    return os.getenv("DASHSCOPE_API_KEY", "")

def _get_base_url():
    return os.getenv("DASHSCOPE_BASE_URL", "https://dashscope.aliyuncs.com/compatible-mode/v1")

def _get_model():
    return os.getenv("VISION_MODEL", "qwen3.5-omni-plus")

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


def _build_user_content(text: str, image_path: str = None):
    """构建用户消息 content：纯文本或 图片+文本 多模态数组"""
    if image_path:
        data_url = _image_to_data_url(image_path)
        content_text = text.strip() if text else "请分析这张图片，并结合之前的题目和解答进行回答。"
        return [
            {"type": "image_url", "image_url": {"url": data_url}},
            {"type": "text", "text": content_text},
        ]
    return text


def _call_api(messages: list[dict], temperature: float = 0.3) -> str:
    """同步调用千问 API，返回完整回复"""
    url = _get_base_url().rstrip("/") + "/chat/completions"
    headers = {
        "Authorization": f"Bearer {_get_api_key()}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": _get_model(),
        "messages": messages,
        "temperature": temperature,
        "max_tokens": 8192,
    }
    resp = requests.post(url, json=payload, headers=headers, timeout=API_TIMEOUT_SECONDS)
    resp.raise_for_status()
    return resp.json()["choices"][0]["message"]["content"]


def _call_api_stream(messages: list[dict], temperature: float = 0.3):
    """流式调用千问 API，逐 chunk yield 文本"""
    url = _get_base_url().rstrip("/") + "/chat/completions"
    headers = {
        "Authorization": f"Bearer {_get_api_key()}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": _get_model(),
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


def recognize_image(image_path: str, user_text: str = "") -> str:
    """发送图片到 VL 模型，识别数学题目（同步，较快不做流式）

    user_text: 用户对图片的额外说明或提问，如"只做第2小问"
    """
    data_url = _image_to_data_url(image_path)
    base_prompt = (
        "请仔细识别图片中的所有数学内容，包括题目文字、数学公式、符号等。\n"
        + LATEX_HINT + "\n"
        "只做识别和转写，不要解答。用中文输出。"
    )
    if user_text:
        base_prompt += f"\n\n【用户附加说明】\n{user_text}\n\n请结合以上说明进行识别和转写。"
    messages = [{
        "role": "user",
        "content": [
            {"type": "image_url", "image_url": {"url": data_url}},
            {"type": "text", "text": base_prompt},
        ],
    }]
    return _call_api(messages, temperature=0.1)


def solve_problem_stream(recognized_text: str):
    """流式生成解答，逐 chunk yield"""
    messages = [{
        "role": "user",
        "content": (
            "请逐步解答以下数学题目。\n\n"
            "要求：\n"
            "1. 直接开始解答，不要寒暄，不要说你是什么角色，不要评价题目难易\n"
            "2. 每一步推理都要有清晰的文字解释\n"
            "3. " + LATEX_HINT + "\n"
            "4. 最终答案用 $\\boxed{...}$ 标出\n"
            "5. 如果题目包含多个小问，请用（1）、（2）等分别标注\n"
            "6. 用中文回答\n\n"
            f"题目：\n---\n{recognized_text}\n---"
        ),
    }]
    yield from _call_api_stream(messages, temperature=0.3)


def chat_reply_stream(recognized_text: str, solution: str, history: list[dict], new_message: str, image_path: str = None):
    """流式聊天回复，逐 chunk yield

    image_path: 追问时附带的图片路径（可选），会与文字一起发送给模型
    """
    system_msg = (
        f"原始题目：\n{recognized_text}\n\n"
        f"之前的完整解答：\n{solution}\n\n"
        "学生正在针对这道题追问。如果学生发送了图片，请结合图片内容回答。\n"
        "注意：直接回答，不要寒暄，不要说你是什么角色，不要评价问题好坏。"
        + LATEX_HINT + "\n"
        "如果学生问的是不相关的问题，请简短引导回题目本身。"
    )
    messages = [{"role": "system", "content": system_msg}]
    for msg in history[-20:]:
        messages.append(msg)
    messages.append({"role": "user", "content": _build_user_content(new_message, image_path)})
    yield from _call_api_stream(messages, temperature=0.5)


# 保留同步版本作为 fallback
def solve_problem(recognized_text: str) -> str:
    return _call_api([{"role": "user", "content": (
        "请逐步解答以下数学题目。\n\n"
        "要求：\n"
        "1. 直接开始解答，不要寒暄，不要说你是什么角色，不要评价题目难易\n"
        "2. 每一步推理都要有清晰的文字解释\n"
        "3. " + LATEX_HINT + "\n"
        "4. 最终答案用 $\\boxed{...}$ 标出\n"
        "5. 如果题目包含多个小问，请用（1）、（2）等分别标注\n"
        "6. 用中文回答\n\n"
        f"题目：\n---\n{recognized_text}\n---"
    )}], temperature=0.3)


def chat_reply(recognized_text: str, solution: str, history: list[dict], new_message: str, image_path: str = None) -> str:
    system_msg = (
        f"原始题目：\n{recognized_text}\n\n"
        f"之前的完整解答：\n{solution}\n\n"
        "学生正在针对这道题追问。如果学生发送了图片，请结合图片内容回答。\n"
        "注意：直接回答，不要寒暄，不要说你是什么角色，不要评价问题好坏。"
        + LATEX_HINT + "\n"
        "如果学生问的是不相关的问题，请简短引导回题目本身。"
    )
    messages = [{"role": "system", "content": system_msg}]
    for msg in history[-20:]:
        messages.append(msg)
    messages.append({"role": "user", "content": _build_user_content(new_message, image_path)})
    return _call_api(messages, temperature=0.5)
