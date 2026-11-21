# Changelog

本项目从「个人可用的翻译插件」演进到「可分享安装」的过程记录。版本号与 `package.json` 同步。

## 1.7.4 — 发布到 npm（scoped 包名）

- 包名改为 **`@azurwolf1024/dsh-translate`**（无 scope 的 `dsh-translate` 已被 PerryLink 的插件占用）。
- 新增 `publishConfig.access = public`，**已发布到 npmjs.com**：
  `dsh plugin add @azurwolf1024/dsh-translate`
  - https://www.npmjs.com/package/@azurwolf1024/dsh-translate
  - 首次发布时 npm 会短暂只显示 `0.0.0-stage` 占位版本（处理约 5 分钟），之后正常；
    该占位版本已 `npm deprecate`，避免被误装。
- 插件市场索引 `market/index.json` 增加该版本的 npm 源条目（1.7.3 的 git 源保留，可回退）。
- 运行时代码与 1.7.3 相同（helper 版本号同步为 1.7.4）。

## 1.7.3 — 修「划译时闪过几个 cmd 窗口」

- **根因一（我们引入的）**：曾有多个 Ollama 监督进程抢同一端口——headless `ollama serve` 占着 11434，
  又拉起 `ollama app.exe`；托盘应用绑不上端口就**每秒重试** `ollama.exe`，每次重试都会创建一个控制台
  → 肉眼看到 cmd 窗口不停闪。
  - 修：`startOllama` 先做 **TCP 端口探测**，端口已被占用时**绝不**再拉起任何实例；
    `startOllama` 动作若已在运行立即返回；拉起后 120 秒内不重复尝试；托盘应用不再与 `serve` 并发拉起（避免双监督）。
- **根因二（Ollama 自身行为）**：模型每次**重新加载**时，Ollama 会启动 `gpu-discover` / runner 等子进程，
  这些都是控制台程序，会短暂闪窗口。我们原来默认 90 秒空闲就卸载模型，所以几乎每次划译都在重新加载。
  - 修：默认改为**模型常驻**（`idleUnloadMs: 0`、`keepAlive: '2h'`），不再反复加载 → 不再闪。
    想省内存可自行把 `idleUnloadMs` 调回（如 300000）。
- 实测：清理掉 4 个重复托盘实例后，5 秒内新增 conhost/ollama 从「8 个」降到 **0**；
  模型常驻状态下连续翻译不再产生任何 ollama 子进程。

## 1.7.2 — 自动启动 Ollama 时优先拉起托盘应用（带图标）

- 之前自动启动的是 `ollama.exe serve`（纯后台服务），**没有托盘图标**，看起来像「Ollama 没启动」。
- 现在优先拉起 `ollama app.exe`（托盘应用，同时带起服务），并以 `explorer.exe` 启动——即使 DSH 以管理员运行，
  Ollama 也保持用户身份，托盘图标正常出现在用户区。
- 托盘应用 12 秒内没把服务带起来时，自动兜底 `ollama serve`。
- 新增配置 `ollamaLaunch`：`auto`（默认，优先托盘应用）/ `app` / `serve`。
- status 新增 `ollamaLaunch` 与解析到的 `ollamaApp` 路径。

## 1.7.1 — 修「以管理员运行 DSH 后仍划不了 WorkBuddy」

- 根因：`Test-ElevatedTarget` 只判断「目标是否提权」，没判断「我们自己是否也是管理员」。
  DSH 以管理员运行后，helper 同样是管理员，WorkBuddy（同为管理员）其实**可以**读 UIA、也可以注入 Ctrl+C，
  但代码一律当成「被系统拦截」，于是跳过 UIA 和剪贴板、只剩 OCR，OCR 取不到时就弹「划译受限」。
- 修法：记录自身权限（`$script:SelfElevated`）；只有目标完整性级别**高于我们**才算被拦截。
  同级管理员应用恢复正常：UIA 不行就走剪贴板。
- 日志：拦截日志带上 `selfElevated=`；自检结果带 `selfElevated` 字段。
- 实测（DSH 管理员 + helper 1.6.3）：
  · 对 WorkBuddy 模拟 Ctrl+A/Ctrl+C → 剪贴板序号 910→918、读到 3912 字符（以前被 UIPI 丢弃）；
  · 模拟拖选 → 日志 `uia: no selection (elevated=normal)` + `gesture app=WorkBuddy source=clipboard chars=3900`。
## 1.7.0 — 自动启动本地 Ollama

- 翻译前检测不到 Ollama 时，**自动拉起 `ollama serve`** 并等它就绪（默认开，最多等 25s），
  不再只是报「连不上本地 Ollama」。
- 新增 action `startOllama`：连不上时页面顶部提示条会出现「启动 Ollama」按钮，点一下即可拉起并重连。
- 自动找 ollama.exe：`OLLAMA_EXE` 环境变量 → 配置 `ollamaExe` → PATH → `%LOCALAPPDATA%\Programs\Ollama`
  → `Program Files\Ollama` → `Program Files (x86)\Ollama`。
- 新增配置：`autoStartOllama`（默认 true）、`ollamaExe`（留空自动找）、`ollamaStartTimeoutMs`（默认 25000）。
- status 返回 `autoStartOllama` 与解析到的 `ollamaExe`，方便排查。
- 并发保护：多个请求同时检测到服务未起时，只拉起一次，其余等同一个 Promise。
- 测试：新增 `findOllamaExe`/配置默认值断言；实测杀掉 ollama 后直接调 translate，自动拉起并成功返回译文。


## 1.6.2 — 修「管理员应用里划译不生效」（含 WorkBuddy 这类应用）

- **根因一（代码 bug）**：UIA 拿不到选区矩形时，`Set-AnchorFromRects $point $null` 把锚点设成 **0×0 点框**，
  OCR 层又优先用它 → 截到 0×0 区域，OCR 必然失败（拖拽框也被忽略）。现在：拖拽用拖拽框、双击/点选用词框。
- **根因二（系统限制）**：目标应用以管理员（高完整性级别）运行时，Windows UIPI 会拦截跨完整性的
  UI Automation 查询和模拟按键（Ctrl+C）。实测 WorkBuddy 主进程 token 查询被拒（err=5），而 msedge/explorer
  正常；截屏没有被禁（display affinity=0），所以 OCR 仍可用。
- 手势开始时重置锚点，避免沿用上一个应用的选区框截错区域。
- 检测前台进程 token：高完整性目标**跳过**必然失败的 UIA 与模拟按键，直接走 OCR；
  仍然取不到时弹一次「划译受限」提示（同应用只弹一次），不再静默失败。
- 日志分因：`uia: no selection (elevated=…)` / `clipboard inject skipped: elevated target` /
  `gesture blocked: elevated target`，方便以后排查。
- 自检新增 `dragBoxOk` / `clickBoxOk` 逻辑断言；实测（WinForms 文本窗 + 模拟拖选）日志出现
  `source=ocr chars=32`，证明 OCR 兜底链路可用。

## 1.6.1 — 修“开始翻译”按钮白底白字看不见

- 三个主按钮（文本翻译 / 文件翻译 / PDF 翻译）原来用 `var(--dsw-alias-brand-primary)` 当背景，
  该 token 在浅色主题下未定义 → 背景退回白色，而字号颜色是白色，于是只剩一个白块。
- 改为**显式实底蓝 + 白字**（#3b82f6 / hover #2563eb），两种主题下都能看见；
  其它按钮（普通/幽灵）保持原样。
- 客户端自检加一条“主按钮是实底白字”，防止再退化。

## 1.6.0 — PDF 排版质量：修「部分未翻译 / 文字重叠」

- **分块上限**：块 ≤ 560 字符（句子边界可放宽到 ~900）、块高 ≤ 页高 32%。以前整页正文会被并成一个块
  （5255 字符），模型只回 ~27% 的内容 → 大段未翻译；现在按块切分，短输入翻译更稳。
- **分栏在聚行之前**：双栏页先用文本片段找竖向空白沟分栏，再各自聚行。以前左右两栏同基线的字会被并进
  同一行，栏检测必然失败、两栏文本交错 → 译文错行/重叠。现在块不跨栏，顺序正确。
- **译文有效性校验 + 严格重试**：目标中文但译文几乎没汉字（模型把英文原样返回）→ 用更严格的提示重试；
  长段失败再二分重译；两次仍失败则保留原文并在界面标出「N 块译文校验未通过」。
- **溢出与遮盖**：按「同栏下一块顶部」算可用高度，放不下截断并计入 overflow；覆盖底色扩到
  「原文块 + 实际译文」并上下多盖一点（修掉原文字母的“鬼影”）。
- **旋转文字跳过**：arXiv 侧栏之类的旋转文本不再被当正文翻译/覆盖。
- **排版统计**：`pdfBuild` 返回 `stats`（translated / skipped / empty / overflow / overlaps），
  工作台显示「已翻译 N 块 · 校验未通过 X · 溢出 Y · 重叠 Z」。
- 测试新增：块上限、双栏切分、译文校验（英文原样判失败/中文放行/中文原文不判/非中文目标不启用）。

## 1.5.2 — 恢复三层取词，并把剪贴板做成「不打扰复制」

- 取词顺序回到 **UIA → 剪贴板 → OCR**（1.5.1 曾把剪贴板关掉，现按用户要求恢复）
- 剪贴板层改为**被动优先**：手势期间用户自己按过 Ctrl+C（剪贴板序号变化）就直接读，**不注入**；
  需要注入时也只还原「自己写的那一次」，期间用户自己的复制不会被覆盖；按住 Ctrl 不注入、终端跳过
- OCR 作为第三层：剪贴板拿到的仍是无空格连写文本时，OCR 重读选区补空格/补首字母
- 复制优先：松手后 120ms 再取词，期间按 Ctrl 视为复制意图并跳过
- 配置 `clipboardFallback` 语义调整：`true`（默认）= 允许注入一次；`false` = 只被动读、绝不注入

## 1.5.1 — 划译不再干扰复制 + 取词更准

- **修「划译影响正常 Ctrl+C」**：以前拉丁文本没空格时会注入 Ctrl+C 读剪贴板，干扰用户自己的复制。
  现在改为 **OCR 重读选区**补空格/补首字母；**剪贴板兜底默认关闭**（`clipboardFallback: true` 可开回）。
  即使开启：只在自己写的那次剪贴板上还原，期间用户自己复制的不会被覆盖。
- **复制优先**：松手后延迟 120ms 再取词，这段时间按了 Ctrl（复制意图）就跳过翻译。
- 取词顺序：UIA →（拉丁无空格/缺字）OCR → 大小写补空格；日志标 `uia+ocr` / `uia-respaced` / `ocr`。

## 1.5.0 — PDF 翻译（覆盖 / 对照 + OCR）

- 新增 PDF 翻译：`pdf.js` 取文字层与坐标 → 聚段落（轻量 IR）→ 逐块翻译 → `pdf-lib` 写回
  - **覆盖模式（默认）**：原位盖掉原文写译文，版式/分页不变
  - **对照模式**：每页原文后插入同版式译文页
  - 公式/矩阵/代码块启发式识别后**保留原文不译**
  - 扫描页（无文本层）先 OCR（Windows 自带引擎），返回带坐标的行再排版
- 依赖：`pdfjs-dist` / `pdf-lib` / `@pdf-lib/fontkit`（纯 JS，由插件安装时拉取）；
  浏览器端 pdf.js 产物由 Host 新增的 `/dsh-translate/assets/*` 路由提供（前缀路由不带结尾斜杠）
- 中文字体：自动探测系统单文件 TTF（Windows 等线 `Deng.ttf`），可用配置 `pdfFont` 覆盖；TTC 不支持
- 新增配置 `maxPdfBytes`（60 MB）与 `pdfFont`；请求体上限随 PDF 上限放大
- 测试：Host 自检新增 PDF 段（解析、公式标记、字体、覆盖写入译文、对照页数、路由 pdfExtract/pdfBuild）；
  客户端自检新增 PdfPane 渲染冒烟

## 1.4.0 — 可分享 / 可安装

- 包元数据补全：`repository` / `homepage` / `bugs` / `keywords` / `engines.dsh` / `scripts`，
  去掉 `private`，`files` 纳入 `docs/`、`CHANGELOG.md`、`LICENSE`（npm 打包与 git 安装都能直接吃）
- 首次使用引导：工作台顶部会提示「连不上 Ollama」（含启动说明）与「本地还没有翻译模型」
  （给 `ollama pull …` 命令 + 一键复制 + 重新检测）；不再让人对着报错猜
- macOS / Linux 明确降级：外部（系统级）划译是 Windows 专属，插件会直接说明并停用该开关，
  页内划译/文本/文件翻译不受影响；不再反复尝试拉起伴生进程
- README 重写为可安装文档：能力表、平台矩阵、前置条件、三种安装方式、首次使用三步、
  配置覆盖示例、排障命令与常见错误表、English Quickstart
- 补 `LICENSE`、`CHANGELOG.md`，`npm test` / `npm run test:live` / 三段 PowerShell 自检脚本入口

## 1.3.0 — OCR 兜底

- 取词链路补第三档：UI Automation → 剪贴板 → OCR（Windows 自带 `Windows.Media.Ocr`，零依赖）
- 触发条件：完全取不到文字（图片型 PDF / 扫描件），或纯拉丁文本却没有词间空格（`TheInnerProduct`）；
  中文选区不触发（中文本来没有词间空格）
- OCR 区域优先用 UIA 选区矩形，其次用拖选/双击起止框；带选中高亮（浅蓝底黑字）也能识别
- 双引擎 `en-US` + 系统语言（本机 `zh-Hans-CN`），认出 CJK 的优先，否则取内容更长的
- 中文 OCR 的「内 积 是 …」逐字空格会先收拢再交给模型
- 新增 `-TestOcr` 自检（英文 / 中文 / 高亮三张位图，不碰屏幕）与 `-NoOcr` 开关

## 1.2.x — 系统级划译打磨

- 1.2.6：主循环异常兜底，单次异常不再打死伴生进程
- 1.2.5：修「划词没反应」——补丁里的注释被转义劈出可执行行，每次手势都抛异常被静默吞掉；
  `-SelfTest` 增加源码 lint（非注释行以中文开头即失败）与取词/锚点逻辑断言
- 1.2.4：PDF 取词空格问题真正的两个原因——先判空白后 Trim（末尾 CRLF 被当成词间空白）、
  剪贴板路径没有补空格逻辑
- 1.2.2：浮窗改贴选区（正下方，放不下翻上方）；剪贴板兜底不再把「内容和上次相同」当失败
- 1.2.1：修 DPI 缩放（字体写成设备像素，200% 屏上只有一半大）、修 `RectangleF.Contains(Point)`
  导致点「重译」弹 .NET 错误框
- 1.2.0：外部浮窗按 DSH 内页样式自绘（实测换行、12px 圆角、跟随 `--dsw-alias-*` 主题 token）

## 1.1.x — 系统级外部划译

- 1.1.0：新增 Windows 伴生进程（`helper/dsh-translate-capture.ps1`）：全局鼠标手势 →
  UI Automation 取词（不碰剪贴板）→ 读不到才注入 Ctrl+C 兜底 → 光标旁原生置顶浮窗
- 1.1.1：伴生进程单实例（Local 互斥体 + PID 文件 + 重启交接窗口）、Host 停止时 taskkill 收尸、
  `-TestOverlay` / `-Probe` 排障入口

## 1.0.0 — 首版

- Host：直连本地 Ollama（默认 `kaelri/hy-mt2:1.8b`），包私有路由 `POST /dsh-translate/api`
- 无状态：每次 `system + user` 两条消息，不复用 context、不写会话日志
- 清理三层：AbortSignal 贯通 / `keep_alive` 与空闲卸载器 / 插件卸载兜底
- 文件：docx / xlsx / pptx / epub + txt / md / csv / json / html + srt / vtt（按行保留时间轴）
- Client：整页工作台（文本/文件/设置）、页内划译浮层、小图标右键菜单
- 测试：`tests/selftest.mjs`（纯函数/解析/路由/真机）、`tests/client_selftest.mjs`（渲染冒烟）
