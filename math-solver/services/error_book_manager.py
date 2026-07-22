"""错题本管理 — 支持多本错题本分类"""

import os
import json
import uuid
import time
import threading

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data")
ERROR_BOOK_FILE = os.path.join(DATA_DIR, "error_book.json")


def _ensure_dirs():
    os.makedirs(DATA_DIR, exist_ok=True)


def _migrate_old_format(data: list[dict]) -> list[dict]:
    """将旧版扁平 item 数组迁移为新版 books 数组"""
    if not data:
        return []
    # 如果第一个元素有 "name" 和 "items" 字段，说明已经是新格式
    if "name" in data[0] and "items" in data[0]:
        return data
    # 旧格式：扁平 item 数组 → 迁移到默认错题本
    default_book = {
        "id": uuid.uuid4().hex[:12],
        "name": "默认错题本",
        "created_at": time.time(),
        "items": data,
    }
    return [default_book]


class ErrorBookManager:
    def __init__(self):
        self._lock = threading.Lock()
        _ensure_dirs()

    def _read_books(self) -> list[dict]:
        if not os.path.exists(ERROR_BOOK_FILE):
            return []
        try:
            with open(ERROR_BOOK_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
            if not isinstance(data, list):
                return []
            # 自动迁移旧格式
            if data and not ("name" in data[0] and "items" in data[0]):
                data = _migrate_old_format(data)
                self._write_books(data)
            return data
        except (json.JSONDecodeError, OSError):
            return []

    def _write_books(self, books: list[dict]):
        with open(ERROR_BOOK_FILE, "w", encoding="utf-8") as f:
            json.dump(books, f, ensure_ascii=False, indent=2)

    def _find_book(self, books: list[dict], book_id: str) -> dict | None:
        for b in books:
            if b["id"] == book_id:
                return b
        return None

    # ==================== 错题本 CRUD ====================

    def list_books(self) -> list[dict]:
        """列出所有错题本（含题目数量）"""
        with self._lock:
            books = self._read_books()
            return [
                {
                    "id": b["id"],
                    "name": b["name"],
                    "created_at": b["created_at"],
                    "item_count": len(b.get("items", [])),
                }
                for b in books
            ]

    def create_book(self, name: str) -> dict:
        """新建错题本"""
        _ensure_dirs()
        book = {
            "id": uuid.uuid4().hex[:12],
            "name": name.strip(),
            "created_at": time.time(),
            "items": [],
        }
        with self._lock:
            books = self._read_books()
            books.append(book)
            self._write_books(books)
        return {"id": book["id"], "name": book["name"], "created_at": book["created_at"], "item_count": 0}

    def rename_book(self, book_id: str, name: str) -> dict | None:
        """重命名错题本"""
        with self._lock:
            books = self._read_books()
            book = self._find_book(books, book_id)
            if not book:
                return None
            book["name"] = name.strip()
            self._write_books(books)
            return {"id": book["id"], "name": book["name"], "created_at": book["created_at"], "item_count": len(book.get("items", []))}

    def delete_book(self, book_id: str) -> bool:
        """删除错题本及其所有题目"""
        with self._lock:
            books = self._read_books()
            for i, b in enumerate(books):
                if b["id"] == book_id:
                    books.pop(i)
                    self._write_books(books)
                    return True
        return False

    # ==================== 题目 CRUD ====================

    def add_item(self, book_id: str, history_record: dict, tags: list[str] | None = None, note: str = "") -> dict | None:
        """从浏览记录添加题目到指定错题本"""
        with self._lock:
            books = self._read_books()
            book = self._find_book(books, book_id)
            if not book:
                return None

            item = {
                "id": uuid.uuid4().hex[:12],
                "created_at": time.time(),
                "source_history_id": history_record["id"],
                "question_text": history_record.get("question_text", ""),
                "recognized_text": history_record.get("recognized_text", ""),
                "solution": history_record.get("solution", ""),
                "images": list(history_record.get("images", [])),
                "chat_history": list(history_record.get("chat_history", [])),
                "tags": tags or [],
                "note": note,
            }
            book.setdefault("items", []).insert(0, item)
            self._write_books(books)
            return item

    def list_items(self, book_id: str, tag: str = "", page: int = 1, page_size: int = 20) -> dict | None:
        """列出错题本中的题目"""
        with self._lock:
            books = self._read_books()
            book = self._find_book(books, book_id)
            if not book:
                return None

            items = book.get("items", [])
            if tag:
                items = [i for i in items if tag in i.get("tags", [])]

            total = len(items)
            start = (page - 1) * page_size
            end = start + page_size
            page_items = items[start:end]

            result = []
            for i in page_items:
                result.append({
                    "id": i["id"],
                    "created_at": i["created_at"],
                    "source_history_id": i.get("source_history_id", ""),
                    "question_text": i.get("question_text", ""),
                    "recognized_text": i.get("recognized_text", "")[:200],
                    "images": i.get("images", []),
                    "tags": i.get("tags", []),
                    "note": i.get("note", ""),
                })
            return {"items": result, "total": total, "page": page, "page_size": page_size, "book_name": book["name"]}

    def get_item(self, book_id: str, item_id: str) -> dict | None:
        """获取单条题目详情"""
        with self._lock:
            books = self._read_books()
            book = self._find_book(books, book_id)
            if not book:
                return None
            for item in book.get("items", []):
                if item["id"] == item_id:
                    return item
        return None

    def update_item(self, book_id: str, item_id: str, tags: list[str] | None = None, note: str | None = None) -> dict | None:
        """更新题目标签/笔记"""
        with self._lock:
            books = self._read_books()
            book = self._find_book(books, book_id)
            if not book:
                return None
            for item in book.get("items", []):
                if item["id"] == item_id:
                    if tags is not None:
                        item["tags"] = tags
                    if note is not None:
                        item["note"] = note
                    self._write_books(books)
                    return item
        return None

    def delete_item(self, book_id: str, item_id: str) -> bool:
        """删除题目"""
        with self._lock:
            books = self._read_books()
            book = self._find_book(books, book_id)
            if not book:
                return False
            items = book.get("items", [])
            for i, item in enumerate(items):
                if item["id"] == item_id:
                    items.pop(i)
                    self._write_books(books)
                    return True
        return False

    def get_tags(self, book_id: str) -> list[dict] | None:
        """获取错题本中所有标签及计数"""
        with self._lock:
            books = self._read_books()
            book = self._find_book(books, book_id)
            if not book:
                return None
            tag_counts: dict[str, int] = {}
            for item in book.get("items", []):
                for t in item.get("tags", []):
                    tag_counts[t] = tag_counts.get(t, 0) + 1
            result = [{"name": k, "count": v} for k, v in sorted(tag_counts.items())]
            return result
