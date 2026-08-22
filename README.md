# 猎头简历搜寻系统（sourcer）

本地运行的简历匹配工具。**HTML 前端 + Node.js + SQLite + Markdown 简历池**，不使用 Python。

把简历丢进 `简历/` 文件夹，系统会自动解析、分类、生成 Markdown 索引；你在网页里输入岗位需求，AI 会挑出匹配度 ≥ 70% 的简历，并直接打开原文件。

---

## ✨ 核心优势：无需 API 也能入库

同类工具大多**必须配置大模型 API，才能把简历解析、分类、建库**——没有 Key 就寸步难行。

本项目从第一步起就由**纯本地规则引擎**跑通整条入库链路：

> 丢简历进 `简历/` → 自动解析 PDF / Word / TXT → 正则抽取姓名 / 年龄 / 学历 / 职务 / 公司 → 关键词规则分类 → 生成 `简历池/` Markdown

**整个过程零 API、零网络、零密钥。** 没配模型也能把简历库建起来。

| 能力 | 本项目 sourcer | 常见方案 |
| --- | --- | --- |
| 入库（解析 / 分类 / 建库） | ✅ 纯本地规则，**无需 API** | ❌ 通常必须 API |
| 精准匹配（匹配度打分排序） | ✅ 配 API 后更准 | ✅ 必须 API |
| 离线 / 隐私 | ✅ 完全本地，简历不出本机 | ⚠️ 多依赖云端 |

**有 API 锦上添花，没 API 也能正常工作。** 你先零成本把简历库建起来；等配了模型，再获得 AI 级的精准匹配度与智能比对。

---

## 一、新环境要装什么？

**必须先安装 Node.js（≥ 22 版本），然后再执行 `npm install`。**

> ⚠️ 重点：
> - `npm` 是 Node.js 自带的一个命令，**不装 Node.js 就没有 npm**。
> - 直接执行 `npm install` 会报错：`'npm' 不是内部或外部命令` / `command not found`。
> - **`npm install` 不会帮你安装 Node.js**，它只是安装项目依赖。
> - 所以新环境的顺序是：**先装 Node.js → 再 `npm install` → 再 `npm start`**。

不需要 Python，不需要数据库软件（SQLite 是 Node 内置的），不需要额外下载 WPS（系统装了 WPS 就会自动用它打开文件）。

### 安装 Node.js

- 官网下载 LTS 版本（推荐 22.x 或更高）：https://nodejs.org/
- Windows 也可以：
  ```powershell
  winget install OpenJS.NodeJS.LTS
  ```
- macOS 可以用 Homebrew：
  ```bash
  brew install node@22
  ```
- 安装完成后，打开终端 / PowerShell 确认：
  ```bash
  node -v
  npm -v
  ```
  能看到版本号（如 `v22.x.x`、`10.x.x`）就说明装好了。

---

## 二、拿到项目（两种方式）

### 方式 A：克隆 GitHub 仓库（新环境推荐）

```bash
git clone git@github.com:Hexvork/sourcer.git
cd sourcer
```

如果没配 SSH，可以用 HTTPS：

```bash
git clone https://github.com/Hexvork/sourcer.git
cd sourcer
```

### 方式 B：直接拿到项目文件夹

把整个 `sourcer` 文件夹拷贝到新电脑上即可（如果拷贝时不带 `node_modules`，就按下一步安装依赖）。

---

## 三、安装依赖并启动

> 前提：已经装好 Node.js（上一节）。先确认一下：
> ```bash
> node -v
> npm -v
> ```
> 两条命令都能输出版本号，才继续往下。

进入项目目录后，安装依赖：

```bash
npm install
```

### Windows

- 方式 1：双击 **`start.bat`**（会自动检查 Node、安装依赖、启动服务并打开浏览器）。
- 方式 2：命令行：
  ```powershell
  npm start
  ```

### macOS / Linux

```bash
npm start
```

启动成功后，终端会显示：

```
前端地址: http://127.0.0.1:3000
```

浏览器打开 **http://127.0.0.1:3000** 即可使用。

> 如果 3000 端口被占用，先设置环境变量再启动：
> - Windows PowerShell：`$env:PORT = 3001; npm start`
> - macOS/Linux：`PORT=3001 npm start`
> 然后访问 `http://127.0.0.1:3001`

---

## 四、首次使用步骤

1. **打开网页**：http://127.0.0.1:3000
2. **配置模型**（不配也能用关键词粗筛，但 AI 匹配更准）：
   - 点右上角「设置」
   - 「用户信息」填你的称呼，例如：王猎头
   - 「想让 AI 怎么回答」填你的偏好，例如：简洁、中文、只推荐真正合适的候选人
   - 「模型 API 配置」点「添加 API」，填写：
     - 名称：DeepSeek（随便起）
     - Base URL：`https://api.deepseek.com/v1`（OpenAI 兼容地址）
     - API Key：你的 key
     - 模型：如 `deepseek-chat`（一个 Key 可以加多个模型）
     - 多模态：如果你的模型支持图片（例如 GPT-4o、Qwen-VL），打勾
   - 可以加多个 API，拖动卡片调整优先级；某个 API 挂了会自动切换到下一个
   - 点「保存全部设置」
3. **放入简历**：把下载的简历（PDF / Word .docx / .doc / TXT）放进项目里的 **`简历`** 文件夹。
   - 系统后台会自动监测并处理：解析内容 → 提炼基础信息（姓名、年龄、学历、职务、主要任职公司等）→ 分类 → 在 `简历池/` 生成一个分类 Markdown（如 `人工智能.md`）
   - **原 PDF/Word 文件不会被搬走、不会放进简历池**，它们继续留在 `简历/` 里；`简历池/` 只放 Markdown，不放大文件
4. **搜索简历**：回到「简历搜寻」页，输入岗位需求（可多行，每行一个岗位），点「开始匹配」。
   - 只展示匹配度 ≥ 70% 的简历卡片
   - 卡片显示：姓名、性别、年龄、学历、职务、主要任职公司、大学
   - 颜色：70~80% 黄、80~90% 蓝、90~100% 绿
   - 外圈进度环 + 内圈实心圆随匹配度变化
   - 单击卡片会用默认程序（通常是 WPS）打开原简历
5. **对比两份简历**：点右上角「简历匹配度」，把两份简历拖进两个框，点「开始匹配」，会得到匹配度、共同点、差异点。

---

## 五、常用目录

```
sourcer/
├─ 简历/                  ← 你放原始简历的地方（实时监测）
├─ 简历池/                ← 自动生成的分类简历池（只放 Markdown）
│  ├─ 人工智能.md         ← 每个分类一个 Markdown 文件
│  ├─ 机器人.md
│  └─ ...
├─ data/resume.db         ← SQLite 数据库（自动生成）
├─ public/                ← 前端 HTML/CSS/JS
├─ lib/                   ← 后端逻辑（解析/LLM/分类/数据库）
├─ server.js              ← 后端入口（Express + chokidar + node:sqlite）
├─ start.bat              ← Windows 一键启动
└─ package.json
```

---

## 六、注意事项 / 常见问题

- **必须 Node.js 22+**：项目使用 Node 内置的 `node:sqlite`，不需要安装 SQLite，也不需要在 npm install 时编译原生模块。
- **模型没配也能用**：未配置 API 或 API 全部失败时，系统自动降级为关键词粗筛，不会崩溃。
- **扫描版 PDF（图片型）**：纯文本解析会失败，该文件会被标记为解析失败并留在 `简历/` 中；请使用可 OCR 的 PDF，或配置多模态模型后人工处理。
- **隐私安全**：`data/`、`简历/`、`简历池/` 已在 `.gitignore` 中忽略，不会把简历和个人数据推到 GitHub。
- **打开文件**：系统调用系统默认程序打开文件；只要 WPS 设置为 .doc/.docx/.pdf 的默认程序，就会用 WPS 打开。
- **停止服务**：在启动终端按 `Ctrl + C`。

---

## 七、技术栈

- 后端：Node.js + Express + `node:sqlite`
- 文件监听：chokidar（实时监测 `简历/`）
- 文件解析：pdf-parse（PDF）、mammoth（.docx）、word-extractor（.doc）
- 前端：原生 HTML/CSS/JS + Font Awesome（极简黑白风格，参考 shadcn/ui）
- 数据存储：SQLite（`data/resume.db`）+ Markdown（`简历池/`）
