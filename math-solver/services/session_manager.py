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


class SessionManager:
    def __init__(self):
        self._sessions: dict[str, Session] = {}
        self._lock = threading.Lock()

    def create(self, recognized_text: str = "", solution: str = "") -> Session:
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
        return session

    def delete(self, session_id: str):
        with self._lock:
            self._sessions.pop(session_id, None)

    def cleanup_expired(self):
        """清除过期会话"""
        now = time.time()
        with self._lock:
            expired = [
                sid for sid, s in self._sessions.items()
                if now - s.last_access > SESSION_TTL_SECONDS
            ]
            for sid in expired:
                del self._sessions[sid]
