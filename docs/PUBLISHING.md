# 发布与分发指南（dsh-translate）

本插件是 **DSH bundle**：一个 npm 风格的包目录（`package.json` 里的 `dsh.bundle.patch` + `dsh.client`），
安装到某个 profile 后就成为该 profile 的一行。DSH 没有面向第三方的「官方应用商店」提交入口，
但支持 **自建插件市场（plugin market index）**，这也是让其他人「在市场里搜到并一键安装」的正规方式。

下面按「从易到难 / 从零依赖到需要账号」列出所有可行路径。

---

## 0. 一张表看清各条路

| 方式 | 别人怎么装 | 需要什么 | 版本锁定 | 适合 |
|---|---|---|---|---|
| A. GitHub clone + 链接安装 | clone 仓库 → Settings→插件→选择目录 | 只要 git | 跟 main | 开发者/熟人 |
| B. 直接从 Git commit 安装 | `dsh plugin add "git+https://…#<commit>"` | git | commit | 想稳定复现 |
| C. **插件市场 index（推荐）** | 添加索引 URL → Discover 里安装 | 一个可访问的 JSON 地址 | commit（index 里锁） | 面向普通用户 |
| D. npm 发布 | `dsh plugin add <包名>` | npm 账号/token | 版本号 | 有 npm 账号时最顺 |
| E. 进官方 catalog | Settings→插件 直接出现 | 需 DeepSeek 官方收录 | — | 目前无公开入口 |

> 注意：npm 上的 **`dsh-translate` 已被别人占用**（PerryLink 的「整页网页翻译」插件，0.3.6）。
> 本插件因此使用 scoped 名 **`@azurwolf1024/dsh-translate`** 发布（`publishConfig.access = public`）；
> 市场索引同时保留 npm 源（1.7.4+）与 Git 源（1.7.3，commit 锁定）两条可安装路径。

---

## 1. 插件市场 index（本仓库已内置）

索引文件：[`market/index.json`](../market/index.json)（格式 1，已用官方校验器验证通过）。

公网地址（推送后在浏览器可直接打开）：

```
https://raw.githubusercontent.com/Azurwolf1024/dsh-translate/main/market/index.json
```

### 用户侧安装步骤

1. 安装「插件市场」浏览界面（官方实验性 bundle，装完重启/刷新 DSH）：

   ```bash
   dsh plugin add @deepseek-ai/dsh-experimental-plugin-market-bundle
   ```

   或：**设置 → 插件 → 添加/安装**，填 `@deepseek-ai/dsh-experimental-plugin-market-bundle`。

2. 打开 **设置 → 插件 → Discover**，在「索引 / Market indexes」里添加上面的索引 URL。

3. 搜索 `Local Ollama Translator`（或 `本地 Ollama 翻译`）→ 安装 → 重启/刷新 DSH。

4. 首次使用前确认本机 Ollama 已装模型：`ollama pull kaelri/hy-mt2:1.8b`（插件也能自动拉起 Ollama）。

### 索引格式 1 的硬性要求（校验器会逐条检查）

- 顶层：`format: 1`、`title`（必须含 `en`）、可选 `description`、`metadata`、`plugins`。
- 语言 key 必须是**小写语言 id**（`en`、`zh`、`zh-hans` 可以，`zh-Hans` 会被拒）。
- 每个 plugin：`name`（合法 npm 包名）、`versions`（非空、版本号唯一）、
  可选 `title`/`description`/`icon`/`author`/`homepage`/`repository`/`metadata`。
- 每个 version：`version`（严格 SemVer）、`publishTimestamp`（Unix 秒整数）、
  `source`（`{type:"npm"}` 或 `{type:"git", url, commit}`，commit 必须是 40 位小写 hex）、
  可选 `engines.dsh`（SemVer range）。
- `icon`：https 绝对地址、内联 data URI（≤32 KiB），或与索引**同源**的相对路径。
- 安装目标由 `name@version` / git commit 推导：
  - npm：`<name>@<version>`
  - git：`git+<url>.git#<commit>`（有 `path` 时追加 `&path:/<dir>`）

### 本地校验（发布前必做）

```bash
pnpm add -D @deepseek-ai/dsh-plugin-market-index
pnpm run test:market
```

`tests/market_validate.mjs` 会用官方 `parseMarketIndex` 解析 `market/index.json`，
并打印每个版本的安装 spec；任何字段违规都会直接报 `MarketIndexError` + JSON 路径。

### 每次发版后更新索引

`source.commit` 必须指向**已推送**的发布提交，且索引自身不能引用自己的提交，所以顺序是：

1. 改代码 → 测试 → 提交并打 tag（例如 `v1.7.4`），推送；
2. 取该提交 SHA：`git rev-parse v1.7.4^{}`；
3. 把 `market/index.json` 里该版本的 `version`、`publishTimestamp`、`source.commit` 更新为新值
   （新版本号加在 `versions` 数组里，旧版本保留以便回退），提交并推送；
4. 用户侧刷新索引（Discover 的刷新/重新添加）即可看到新版本。

---

## 2. 直接从 Git 安装（不走市场）

```bash
# <commit> 见 market/index.json 或 `git rev-parse v1.7.3^{}`
dsh plugin add "git+https://github.com/Azurwolf1024/dsh-translate.git#747641472b300ce91594dd7663bfaf2bbf99acc0"
```

或在 **设置 → 插件 → 安装** 里把上面 `git+…` 整串填进去。
装的是 commit 快照（不是 main），所以可复现；升级就是换 commit 重装。

已验证：pnpm 能直接解析该 spec 并把包完整装进 `node_modules/dsh-translate`
（含 `index.js`、`client.js`、`helper/`、`locale/`、`cordis.patch.yml`）。

---

## 3. npm 发布（已执行：`@azurwolf1024/dsh-translate`）

当前没有 npm 凭据，且无 scope 的 `dsh-translate` 已被占用。要走 npm 的话：

1. 选一个唯一名字，建议 scope：`@<你的npm用户名>/dsh-translate`；
2. 同步修改：`package.json` 的 `name`、`README` 安装说明、`market/index.json` 的 `plugins[].name`；
3. 加 `publishConfig: { "access": "public" }`（scope 包默认私有，必须显式 public）；
4. 登录并发布：

   ```bash
   npm login
   npm publish --access public
   # 或：pnpm publish --access public
   ```

5. 在索引里把该版本的 `source` 换成：

   ```json
   { "type": "npm", "registry": "https://registry.npmjs.org" }
   ```

   用户安装即为 `dsh plugin add <name>@<version>`。

发布前自检清单：

- 没有 `"private": true`；
- `files` 白名单包含运行所需文件（本仓库包含 `index.js`、`client.js`、`pdf.js`、`helper/`、
  `locale/`、`cordis.patch.yml`、`icon.svg`、`tests/fixtures`、`docs/*.png` 等）；
- `engines.dsh` 与目标 DSH 版本兼容（本插件：`>=0.2.0-0 <0.3.0-0`）；
- 没有把 `node_modules/`、`.probe/`、日志打进包里（`.gitignore` + `files` 已处理）；
- 依赖（`pdfjs-dist`、`pdf-lib`、`@pdf-lib/fontkit`）必须留在 `dependencies`，
  不能放 devDependencies，否则用户装完 PDF 功能会缺依赖。

---

## 4. 进官方 catalog？

`plugin_manager` 的官方 catalog 里 `official: true` 的条目都是 DSH 自带/DeepSeek 自家包
（`@deepseek-ai/*`），列表由 DSH 安装目录决定，**没有第三方提交入口**。
想被收录只能走 DSH 仓库的 issue / 官方渠道沟通；在此之前，自建 market index 就是「市场里可见」的等价方案。

---

## 5. 安全与责任

- 插件市场索引**未签名**：索引里的 `name`/`version`/`commit` 只是发布者的声明，
  真正装什么由被安装的包 manifest 决定。建议在索引条目旁注明仓库地址，让用户能核对。
- `source.commit` 必须钉死 40 位 SHA，不要用分支名（格式不支持，也不可复现）。
- 插件会执行本机进程（外部划译的 PowerShell 伴生进程、PDF 字体读取、自动拉起 Ollama），
  在 README 里已经写明；市场描述里保持同样的透明度。
