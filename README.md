https://github.com/Mrblackso/math_solver/blob/main/演示视频.mp4

# 战胜高数！！！— 数学题解算器 🧮

上传数学题图片（或输入文字），AI 自动识别题目并流式生成详细解答。支持追问，LaTeX 公式渲染。

## 环境要求

- **Python** 3.10+
- **Node.js** (可选，仅独立识图脚本 `vision.js` 需要)
- **千问 API Key** → [阿里云百炼控制台](https://bailian.console.aliyun.com/) 免费注册获取

## 快速开始（从零部署）

```bash
# 1. 克隆项目
git clone git@github.com:Mrblackso/math_solver.git
cd math_solver/math-solver

# 2. 安装 Python 依赖
pip install -r requirements.txt
```

### 安装命令一览

| 依赖 | 用途 |
|------|------|
| `flask>=3.0.0` | Web 框架 |
| `requests>=2.31.0` | 调用千问 API |
| `Pillow>=10.0.0` | 上传图片压缩/转码 |

```bash
# 一条命令安装全部
pip install flask>=3.0.0 requests>=2.31.0 Pillow>=10.0.0
```

### 可选依赖

如果你需要使用独立的 `vision.js` 识图脚本（而非通过 Web 页面）：

```bash
# 在项目根目录（math_solver/）
npm install dotenv
```

## 配置 API 密钥

### 方式一：通过设置页面（推荐）

启动应用后，浏览器会自动跳转到 `/settings` 设置页面，填写 API Key 保存即可。

### 方式二：手动创建 .env 文件

在 `math-solver/` 目录下创建 `.env` 文件：

```env
DASHSCOPE_API_KEY=你的千问API密钥
DASHSCOPE_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
VISION_MODEL=qwen3.5-omni-plus
```

> 参考 `.env.example` 模板填写。

## 运行

```bash
cd math-solver
python app.py
```

浏览器打开 **http://localhost:5000**，上传数学题图片或输入文字即可解答。

## 功能

- 📷 **图片识别** — 上传数学题截图，AI 自动识别题目内容
- ✍️ **文字输入** — 手动输入数学题文字
- 🔄 **流式解答** — 实时逐字输出解答过程
- 💬 **多轮追问** — 解答后可继续提问，支持带图片追问
- 📐 **LaTeX 公式** — 使用 MathJax 渲染数学公式
- ⚙️ **可视化设置** — 网页配置 API Key，无需编辑文件

## 独立识图脚本

项目根目录下的 `vision.js` 可单独使用（不启动 Flask 服务）：

```bash
node vision.js <图片路径> "用中文描述这张图片"
node vision.js --url <图片链接> "这张图里有什么数学公式？"
```

需要配置 `DASHSCOPE_API_KEY` 环境变量或同目录 `.env` 文件。

## 项目结构

```
math_solver/
├── math-solver/
│   ├── app.py                 # Flask 主程序
│   ├── config.py              # 配置文件
│   ├── requirements.txt       # Python 依赖
│   ├── .env.example           # 环境变量模板
│   ├── services/
│   │   ├── qwen_client.py     # 千问 API 封装
│   │   └── session_manager.py # 会话管理
│   ├── templates/
│   │   ├── index.html         # 主页
│   │   └── settings.html      # 设置页
│   └── static/
│       ├── css/style.css
│       └── js/app.js
├── vision.js                  # 独立识图脚本
└── CLAUDE.md
```
