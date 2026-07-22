"""浏览记录管理 — JSON 文件持久化"""

import os
import json
import uuid
import time
import threading
import base64
from io import BytesIO

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data")
HISTORY_FILE = os.path.join(DATA_DIR, "history.json")
IMAGES_DIR = os.path.join(DATA_DIR, "images")
THUMB_MAX_WIDTH = 200
THUMB_QUALITY = 70


def _ensure_dirs():
    os.makedirs(DATA_DIR, exist_ok=True)
    os.makedirs(IMAGES_DIR, exist_ok=True)


def _generate_thumbnail(image_b64: str, record_id: str, index: int) -> str | None:
    """将 base64 图片压缩为缩略图 WebP，返回文件名；失败返回 None"""
    try:
        from PIL import Image
        header, data = image_b64.split(",", 1)
        img = Image.open(BytesIO(base64.b64decode(data)))
        w, h = img.size
        if w > THUMB_MAX_WIDTH:
            ratio = THUMB_MAX_WIDTH / w
            img = img.resize((THUMB_MAX_WIDTH, int(h * ratio)), Image.LANCZOS)
        if img.mode in ("RGBA", "P"):
            img = img.convert("RGB")
        filename = f"{record_id}_{index}.webp"
        filepath = os.path.join(IMAGES_DIR, filename)
        img.save(filepath, "WEBP", quality=THUMB_QUALITY)
        return filename
    except Exception:
        return None


class HistoryManager:
    def __init__(self):
        self._lock = threading.Lock()
        _ensure_dirs()

    def _read_all(self) -> list[dict]:
        if not os.path.exists(HISTORY_FILE):
            return []
        try:
            with open(HISTORY_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
            return data if isinstance(data, list) else []
        except (json.JSONDecodeError, OSError):
            return []

    def _write_all(self, records: list[dict]):
        with open(HISTORY_FILE, "w", encoding="utf-8") as f:
            json.dump(records, f, ensure_ascii=False, indent=2)

    def add(
        self,
        input_mode: str = "text",
        question_text: str = "",
        recognized_text: str = "",
        solution: str = "",
        image_data_urls: list[str] | None = None,
        chat_history: list[dict] | None = None,
    ) -> dict:
        """添加一条浏览记录，返回创建好的记录"""
        _ensure_dirs()
        record_id = uuid.uuid4().hex[:12]
        now = time.time()

        # 生成缩略图
        thumb_names = []
        if image_data_urls:
            for i, data_url in enumerate(image_data_urls):
                name = _generate_thumbnail(data_url, record_id, i)
                if name:
                    thumb_names.append(name)

        record = {
            "id": record_id,
            "created_at": now,
            "input_mode": input_mode,
            "question_text": question_text,
            "recognized_text": recognized_text,
            "solution": solution,
            "images": thumb_names,
            "chat_history": chat_history or [],
        }

        with self._lock:
            records = self._read_all()
            records.insert(0, record)  # 最新在前
            # 最多保留 500 条
            if len(records) > 500:
                old = records[500:]
                records = records[:500]
                for r in old:
                    self._delete_images(r)
            self._write_all(records)

        return record

    def append_chat(self, record_id: str, chat_history: list[dict]):
        """追问结束后，更新历史记录中的 chat_history"""
        with self._lock:
            records = self._read_all()
            for r in records:
                if r["id"] == record_id:
                    r["chat_history"] = chat_history
                    self._write_all(records)
                    return

    def list_all(self, page: int = 1, page_size: int = 20) -> dict:
        """分页返回记录列表"""
        with self._lock:
            records = self._read_all()
            total = len(records)
            start = (page - 1) * page_size
            end = start + page_size
            items = records[start:end]
            # 列表不返回完整解答和对话（太大），只返回摘要
            result = []
            for r in items:
                item = {
                    "id": r["id"],
                    "created_at": r["created_at"],
                    "input_mode": r["input_mode"],
                    "question_text": r["question_text"],
                    "recognized_text": r["recognized_text"][:200],
                    "images": r.get("images", []),
                }
                # 最后一条 AI 回复作为摘要
                chat = r.get("chat_history", [])
                if chat:
                    last_ai = chat[-1]["content"] if chat[-1]["role"] == "assistant" else ""
                    item["chat_preview"] = last_ai[:100] if last_ai else ""
                else:
                    item["chat_preview"] = ""
                result.append(item)
            return {"items": result, "total": total, "page": page, "page_size": page_size}

    def get(self, record_id: str) -> dict | None:
        """获取单条记录完整内容"""
        with self._lock:
            records = self._read_all()
            for r in records:
                if r["id"] == record_id:
                    return r
        return None

    def delete(self, record_id: str) -> bool:
        """删除一条记录及其图片"""
        with self._lock:
            records = self._read_all()
            for i, r in enumerate(records):
                if r["id"] == record_id:
                    self._delete_images(r)
                    records.pop(i)
                    self._write_all(records)
                    return True
        return False

    def _delete_images(self, record: dict):
        """删除记录关联的缩略图文件"""
        for name in record.get("images", []):
            path = os.path.join(IMAGES_DIR, name)
            try:
                os.unlink(path)
            except OSError:
                pass
