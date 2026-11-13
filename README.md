# dsh-translate

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 用的**本地翻译插件**：
文本、页面内划译、系统级划译（任意应用）、整份文件翻译——内核是你自己 Ollama 里的小模型，
请求不出本机，每次翻译互不携带上下文，空闲后自动卸载模型。

![系统级划译浮窗（暗色）](docs/overlay-dark.png)

![系统级划译浮窗（亮色）](docs/overlay-light.png)

---

## 能力一览

| 入口 | 说明 |
|---|---|
| **文本翻译** | 整页工作台里粘贴/输入，可选中英↔多语、语气、术语表 |
| **页内划译** | 在 DSH 页面里选中文字，停顿 500ms（可调）自动弹译文；Esc / 点空白 / 滚动即取消 |
| **系统级划译** | 在 Word / 浏览器 / PDF 阅读器等**任意应用**里选中文字即译，浮窗贴选区弹出（Windows） |
| **文件翻译** | 拖入 docx / xlsx / pptx / epub / txt / md / srt 等，按段推进度、双语对照导出 |
| **模型管理** | 工作台里看服务状态、切换模型、加载/钉住/卸载模型；自动跟随 DSH 主题 |

取词（系统级）按 **UI Automation → 剪贴板 → OCR** 三档回退，所以图片型 PDF、扫描件也能翻。

## 平台支持

| 能力 | Windows 10/11 | macOS / Linux |
|---|---|---|
| 页内划译、文本、文件翻译 | ✅ | ✅ |
| 系统级划译（任意应用） | ✅（UI Automation + 剪贴板 + 原生浮窗） | —（插件会明确提示，不影响页内划译） |
| OCR 兜底 | ✅（系统自带 WinRT OCR） | —（跟随系统级划译） |

系统级划译不安装任何额外运行时：脚本用系统自带的 Windows PowerShell 5.1，
OCR 用系统自带的 `Windows.Media.Ocr`，浮窗是自绘的原生窗口。

## 前置条件

1. **Ollama**（≥ 0.3）在本机运行：默认地址 `http://127.0.0.1:11434`。
2. **一个翻译模型**。推荐：
   ```bash
   ollama pull kaelri/hy-mt2:1.8b     # Hunyuan-MT2 1.8B，约 1.5 GB，加载快
   ```
   不想装这个也行——装好后在插件「设置 → 模型」里换成本机已有的任意模型。
3. （仅系统级划译）Windows 10/11；PowerShell 5.1 与 OCR 语言包都是系统自带。

## 安装

装完**刷新一次页面**即可生效（Host 行与客户端模块会热更新）。

### 方式 A：DSH 桌面端 · 插件管理界面

1. `git clone https://github.com/Azurwolf1024/dsh-translate`
2. 打开 **设置 → 插件 → 添加 / 安装**，选择克隆下来的目录
3. 刷新页面，左栏出现「翻译」图标

### 方式 B：命令行

```bash
# 从 GitHub 直接装（推荐）
dsh plugin --profile web add "github:Azurwolf1024/dsh-translate"

# 或从本地目录
git clone https://github.com/Azurwolf1024/dsh-translate
dsh plugin --profile web add ./dsh-translate

# 装完按提示重启 / 刷新
```

### 方式 C：npm（若已发布）

```bash
dsh plugin --profile web add dsh-translate
```

> 本包**没有构建步骤**：`index.js` / `client.js` 就是最终产物，`helper/` 是伴生进程脚本，
> 所以从 git 源安装不需要 `pnpm build`。

## 首次使用（3 步）

1. 打开左栏 **「翻译」**（或右下角悬浮小图标）→ 整页工作台。
2. 若顶部出现橙色提示「本地还没有翻译模型」：点 **复制命令**，在终端执行 `ollama pull …`，再点 **重新检测**。
   也可以直接去「设置 → 模型」选一个本机已装的模型。
3. 随便翻译一句；第一次会多等 2~3 秒（模型冷加载），之后约 0.5~1 秒。

## 使用

- **页内划译**：在 DSH 对话里选中文字，停一下即弹浮层；右下角小图标右键可开关划译。
- **系统级划译（Windows）**：在任意应用里拖选/双击选词 → 浮窗贴在选区正下方（放不下翻到上方）。
  可在小图标右键菜单或「设置 → 划译」里单独开关。
- **文件翻译**：拖入文件 → 自动按段落切分 → 开始翻译（可暂停/取消）→ 导出 `.md`（双语对照或仅译文）。
- **设置**：模型、生成后驻留时长、目标语言、语气、术语表、划译开关与停顿、诊断信息。

### 支持的文件格式

- **文档**：`.docx` / `.docm` / `.xlsx` / `.xlsm` / `.pptx` / `.pptm` / `.epub`
- **文本**：`.txt` `.md` `.mdx` `.rst` `.adoc` `.tex` `.csv` `.tsv` `.json` `.jsonl`
  `.yaml` `.yml` `.ini` `.toml` `.env` `.html` `.htm` `.xhtml` `.xml`
- **字幕**：`.srt` / `.vtt` —— 按行处理，序号与时间轴原样保留，只翻文本行；导出仍是合法字幕
- **不支持**：`.pdf`、旧版二进制 `.doc` / `.xls` / `.ppt`、`.ass` / `.lrc`（会明确报错而不是静默失败）

## 配置

默认值在 `cordis.patch.yml` 的 `config` 里。要覆盖，把你的字段写进 profile 的 patch（按 `id` 覆盖整块 config）：

```yaml
- id: dsh-translate
  config:
    model: 'qwen3.5:4b-chat'      # 换了模型就填这里
    keepAlive: '0'                # 每次翻完立即卸载（最省内存，代价是每次冷加载）
    idleUnloadMs: 60000           # 空闲 60 秒主动卸载
    defaultTarget: 'zh-Hans'      # 不填 auto = 中↔英自动
```

| 键 | 默认值 | 含义 |
|---|---|---|
| `baseURL` | `http://127.0.0.1:11434` | Ollama 端点 |
| `model` | `kaelri/hy-mt2:1.8b` | 翻译模型（设置页可临时切换） |
| `keepAlive` | `5m` | 生成后驻留时长；`0` = 立即卸载 |
| `idleUnloadMs` | `90000` | 空闲多久主动卸载；`0` = 关闭 |
| `timeoutMs` | `120000` | 单次 Ollama 请求超时 |
| `maxTextChars` | `20000` | 单次翻译文本上限 |
| `chunkChars` | `1200` | 分段长度 |
| `maxUploadBytes` | `12582912` | 上传文件大小上限（12 MB） |
| `defaultTarget` | `auto` | 默认目标语言 |
| `tone` | `natural` | 默认语气 |

## 无状态与清理

- **每次翻译 = 一次独立请求**：`system + user` 两条消息，不复用 KV/context、不缓存译文、
  **不经过 DSH 的 LLM 通道**，所以不会写进会话日志、不污染上下文。
- **请求级**：`AbortSignal` 从浏览器一路到 Ollama；取消/关闭浮层/切页都会终止生成。
- **模型级**：`keepAlive` + 空闲卸载器（默认 90s）把模型从显存/共享内存释放；手动「加载模型」会钉住它。
- **进程级**：伴生进程随 DSH 走（父进程消失即退出；插件卸载时被杀）。

## 排障

先看日志：`%TEMP%\dsh-translate-capture.log`（系统级划译）与工作台「设置 → 服务状态」。

```bash
# 1) 伴生进程自检：装配 UIA/WinForms、GET 状态、真机翻一句，然后退出（不弹窗）
powershell -NoProfile -STA -ExecutionPolicy Bypass \
  -File helper/dsh-translate-capture.ps1 -Port 61213 -Target zh-Hans -SelfTest

# 2) OCR 自检：画英文/中文/选中高亮三张位图走一遍识别（不碰屏幕）
powershell -NoProfile -STA -ExecutionPolicy Bypass -File helper/dsh-translate-capture.ps1 -TestOcr

# 3) 浮窗冒烟：画一帧并截图
powershell -NoProfile -STA -ExecutionPolicy Bypass \
  -File helper/dsh-translate-capture.ps1 -TestOverlay -ShotPath C:\Temp\overlay.png

# 4) 探针：先在目标应用里选中文字，再跑它——看 UIA / 剪贴板各读到什么
powershell -NoProfile -STA -ExecutionPolicy Bypass -File helper/dsh-translate-capture.ps1 -Probe
```

| 现象 | 处理 |
|---|---|
| 工作台顶部提示「连不上本地 Ollama」 | 启动 Ollama（`ollama serve` / 打开应用），点重新检测 |
| 提示「本地还没有翻译模型」 | 复制命令 `ollama pull …`，或去设置换模型 |
| 系统级划译没反应 | 看日志最后几行：`gesture app=… source=…`；确认划译总开关与「外部」开关都开 |
| PDF 出来是 `TheInnerProduct` 这类连写 | 正常：会自动走剪贴板/OCR/补空格；若仍不行把日志发我 |
| 图片型 PDF / 扫描件 | 走 OCR（日志 `source=ocr`）；OCR 语言包缺失时会在日志写 `ocr engine unavailable` |
| 翻译很慢 | 冷加载 2~3 秒正常；把 `keepAlive` 调成 `5m` 可减少冷启动 |

## 开发

```
index.js                  Host 半边：Ollama 客户端、分段、卸载器、/dsh-translate/api
client.js                 浏览器半边：整页工作台 / 划译浮层 / 小图标（手写 bundle，无需构建）
helper/dsh-translate-capture.ps1   Windows 伴生进程：手势 → UIA/剪贴板/OCR → 原生浮窗
cordis.patch.yml         bundle 行与默认配置
locale/{en,zh}.json      插件元数据标题/描述
tests/                   Host 与 Client 的离线/真机自检
```

```bash
npm test              # 离线：纯函数 + 文件解析 + 路由 + 客户端渲染冒烟
npm run test:live     # 额外跑一次真实 Ollama 翻译（会加载并卸载模型）
npm run selftest:helper / selftest:ocr / selftest:overlay   # Windows 伴生进程三段自检
```

无构建步骤；改了 `index.js` / `helper/*.ps1` 后重装或重启 DSH 生效，改 `client.js` 刷新页面。

## 卸载

```bash
dsh plugin --profile web remove dsh-translate
```

或在「设置 → 插件」里停用/删除。卸载时会中止在飞请求、卸载插件加载过的模型、结束伴生进程。

## License

MIT © Azurwolf1024

---

## English Quickstart

A local-Ollama translation plugin for DeepSeek Harness: text, in-page selection popup,
system-wide selection (Windows: UI Automation → clipboard → OCR), and file translation.
Requests stay on your machine, every translation is stateless, and the model is unloaded when idle.

```bash
# 1. Ollama + a translation model
ollama pull kaelri/hy-mt2:1.8b

# 2. Install the plugin
dsh plugin --profile web add "github:Azurwolf1024/dsh-translate"

# 3. Open the sidebar "Translate" panel and translate something
```

Platform: in-page selection, text and file translation work everywhere; system-wide selection
requires Windows 10/11 (built-in PowerShell, UIA and WinRT OCR — no extra runtime).

Troubleshooting: see `%TEMP%\dsh-translate-capture.log` for the companion process, and run
`npm test` (offline) or the PowerShell self-tests listed above.
