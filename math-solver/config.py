import os

DASHSCOPE_API_KEY = os.getenv(
    "DASHSCOPE_API_KEY",
    "sk-ws-H.REHHRRY.GPxY.MEQCIEQYWNQoar-gRy9m4qm-r3vrpUkX_YrnDd5V-q91qZ0wAiB2BfG_HIWkyiSiGRhoPWrJD1YC-6Cvs3XibACe2yr1lw"
)
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
