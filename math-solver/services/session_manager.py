"""内存会话管理 — 存储题目、解答、聊天历史"""

import uuid
import time
import threading
from dataclasses import dataclass, field

from config import SESSION_TTL_SECONDS


@dataclass
class Session:
    session_id: str
    created_at: float
    last_access: float
    recognized_text: str = ""
    solution: str = ""
    chat_history: list = field(default_factory=list)  # [{"role":"user"|"assistant", "content":"..."}]
    history_id: str = ""  # 关联的浏览记录 ID，用于追问时更新


class SessionManager:
    def __init__(self):
        self._sessions: dict[str, Session] = {}
        self._lock = threading.Lock()

    def create(self, recognized_text: str = "", solution: str = "") -> Session:
        self.cleanup_expired()  # 创建新会话前清理过期会话，防止内存泄漏
        sid = uuid.uuid4().hex[:12]
        now = time.time()
        session = Session(
            session_id=sid,
            created_at=now,
            last_access=now,
            recognized_text=recognized_text,
            solution=solution,
        )
        with self._lock:
            self._sessions[sid] = session
        return session

    def get(self, session_id: str) -> Session | None:
        with self._lock:
            session = self._sessions.get(session_id)
            if session:
                session.last_access = time.time()
            else:
                # 未找到会话时顺便清理过期数据
                self._cleanup_expired_unlocked()
        return session

    def delete(self, session_id: str):
        with self._lock:
            self._sessions.pop(session_id, None)

    def _cleanup_expired_unlocked(self):
        """清除过期会话（调用者必须已持有 _lock）"""
        now = time.time()
        expired = [
            sid for sid, s in self._sessions.items()
            if now - s.last_access > SESSION_TTL_SECONDS
        ]
        for sid in expired:
            del self._sessions[sid]

    def cleanup_expired(self):
        """清除过期会话"""
        with self._lock:
            self._cleanup_expired_unlocked()
