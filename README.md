# dsh-translate —— 本地 Ollama 翻译插件

给 DeepSeek Harness Web UI 用的翻译插件：**输入文本翻译、划词翻译（可独立开关）、整份文件翻译**，
翻译内核是你本机 Ollama 里部署的翻译小模型（默认 `kaelri/hy-mt2:1.8b`，Hunyuan-MT2）。

## 功能

| 入口 | 说明 |
|---|---|
| **整页工作台** | 左侧栏面板图标「翻译」→ 整页视图，三个页签：文本 / 文件 / 设置 |
| **划译** | 选中一段文字后**停顿 500ms**（可调）自动弹出译文浮层；Esc / 点空白 / 滚动即取消 |
| **小图标** | 右下角悬浮按钮：左键打开工作台，**右键菜单**里有「开启/关闭划译」「加载/关闭模型」「刷新状态」「设置」 |
| **文件翻译** | 拖入或选择文件 → 自动按段落切分 → 逐段翻译 → 双语对照导出 `.md` |

## 翻译内核与「清理」

- **无状态**：每次翻译都是 `system + user` 两条消息，一次 HTTP 请求；不复用 `/api/generate` 的
  `context`，不缓存译文，不经过 DSH 的 LLM 通道（因此**不会写进会话日志、不会污染上下文**）。
- **请求级清理**：`AbortSignal` 从浏览器一路贯穿到 Ollama 调用；取消/关闭浮层/切页都会 abort，
  在飞请求不会留在后台。
- **模型级清理**：
  - `keepAlive`（默认 `5m`）控制生成后驻留时长，`0` = 生成结束立刻卸载；
  - 空闲卸载器：无翻译活动超过 `idleUnloadMs`（默认 90s）且模型没有被手动钉住时，主动
    `POST /api/generate {keep_alive:0}` 把模型从显存/共享内存里释放；
  - 手动加载（右键菜单「加载模型」）会**钉住**模型，空闲卸载器不碰它，直到你点「关闭模型」
    或插件被卸载；
  - 插件卸载时（禁用/删包/DSH 退出）abort 在飞请求并 best-effort 卸载。
- 这台机器是 Intel Arc 核显 + 共享内存，模型驻留代价很高（见工作区里的
  `ollama-arc130t-diagnosis.md`），所以默认策略是「用完就放掉」，代价是每次冷启动多 2~3 秒。

## 安装

```bash
# 在任意工作区里，用 DSH 的插件管理器安装本目录（绝对路径）
plugin_manager  action=install_bundle  target=<本目录绝对路径>
```

安装后无需重启：Host 行和 Client 模块图通过 HMR 生效。若页面没变化，刷新一次
`http://127.0.0.1:<port>/` 即可。

## 配置（`cordis.patch.yml` 的 `config`）

| 键 | 默认值 | 含义 |
|---|---|---|
| `baseURL` | `http://127.0.0.1:11434` | Ollama 端点（只应在回环地址上） |
| `model` | `kaelri/hy-mt2:1.8b` | 翻译模型 |
| `keepAlive` | `5m` | 生成后驻留时长；`0` = 立即卸载 |
| `idleUnloadMs` | `90000` | 空闲多久主动卸载；`0` = 关闭 |
| `timeoutMs` | `120000` | 单次 Ollama 请求超时 |
| `maxTextChars` | `20000` | 单次翻译文本上限 |
| `chunkChars` | `1200` | 分段长度（超长文本按段落/句子切分） |
| `maxUploadBytes` | `12582912` | 上传文件大小上限（12 MB） |
| `defaultTarget` | `auto` | 默认目标语言；`auto` = 中↔英 |
| `tone` | `natural` | 默认语气 |

界面里的「设置」页只覆盖**本次浏览器**的偏好（存 `localStorage`），不会写回 `cordis.patch.yml`；
模型与 `keepAlive` 随请求下发，改完立即生效。

## 支持的文件格式

- **文档**：`.docx` / `.docm` / `.xlsx` / `.xlsm` / `.pptx` / `.pptm` / `.epub`
- **文本**：`.txt` `.md` `.mdx` `.rst` `.adoc` `.tex` `.csv` `.tsv` `.json` `.jsonl`
  `.yaml` `.yml` `.ini` `.toml` `.env` `.html` `.htm` `.xhtml` `.xml`
- **字幕**：`.srt` / `.vtt` —— 按行处理，序号与时间轴原样保留，只翻文本行；导出仍是合法字幕
- **不支持**：`.pdf`、旧版二进制 `.doc` / `.xls` / `.ppt`、`.ass` / `.lrc`（时间轴与文本同行，逐行翻译会破坏时间戳）；会明确报错而不是静默失败

解析只在本机 Host 进程里做（ZIP + XML 抽取，无第三方依赖）；代码围栏（```）会被识别为
`code` 段**原样保留不翻译**。

## 自检

```bash
# Host 半边：纯函数 + docx/xlsx/pptx/epub 解析 + 路由（含真机 Ollama）
node tests/selftest.mjs          # 离线部分
node tests/selftest.mjs --live   # 额外跑一次真实翻译并卸载模型

# Client 半边：加载器契约 + 槽位注册 + 组件渲染冒烟
node tests/client_selftest.mjs
```

## 已知限制

- 一次只翻一段（串行），保证小模型显存与延迟稳定；取消会立刻停止后续段。
- `繁體中文` 用中文语言名 + 中文提示驱动（1.8B 模型对英文语言名会输出简体），实测短句/段落/简→繁都稳定。
- 划译只作用于页面内可选中的文本；输入框/可编辑区域/DOM 之外的选区会被忽略。
- 路由只在回环地址上服务，没有额外的令牌鉴权（与宿主自身「只绑回环」的部署假设一致）；
  请求侧校验 `Origin` / `Sec-Fetch-Site`，跨站请求一律 403。
- 宿主配置（`idleUnloadMs` 等）只能改 `cordis.patch.yml`，设置页里是只读展示。

## 卸载

```bash
plugin_manager  action=remove_bundle  target=dsh-translate
```

卸载时会把插件加载过的模型卸载掉，并清掉本页注册的槽位与监听。
