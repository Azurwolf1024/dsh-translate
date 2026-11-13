# Changelog

本项目从「个人可用的翻译插件」演进到「可分享安装」的过程记录。版本号与 `package.json` 同步。

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
