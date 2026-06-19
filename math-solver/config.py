import os

# 加载 .env 文件（简易实现，不依赖 python-dotenv）
def _load_dotenv(path: str = None):
    if path is None:
        path = os.path.join(os.path.dirname(__file__), ".env")
    if not os.path.exists(path):
        return
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" in line:
                key, _, value = line.partition("=")
                key = key.strip()
                value = value.strip().strip('"').strip("'")
                if key and key not in os.environ:
                    os.environ[key] = value

_load_dotenv()

DASHSCOPE_API_KEY = os.getenv("DASHSCOPE_API_KEY")  # 请在 .env 或设置页面配置
DASHSCOPE_BASE_URL = os.getenv(
    "DASHSCOPE_BASE_URL",
    "https://dashscope.aliyuncs.com/compatible-mode/v1"
)
MODEL = os.getenv("VISION_MODEL", "qwen3.5-omni-plus")

MAX_IMAGE_SIZE_MB = 20
MAX_IMAGE_DIMENSION = 2048
API_TIMEOUT_SECONDS = 120
SESSION_TTL_SECONDS = 7200
MAX_CHAT_HISTORY = 20


def is_configured() -> bool:
    """检查是否已配置 API Key"""
    return bool(DASHSCOPE_API_KEY and DASHSCOPE_API_KEY.strip())
