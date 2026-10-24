# 飞书一键导出 · 本地 Web 工作台（GUI）实施计划 v1.0

| 项 | 值 |
|---|---|
| 文档版本 | v1.0（首版，无历史版本可继承——`计划书/` 为本次新建） |
| 编写时间 | 2026-10-24 19:14 |
| 代码基线 | `git HEAD = 20fda93`（工作区干净） |
| 运行时基线 | Node `v25.8.1`（`engines: >=20`） |
| 自检基线 | `node selftest.mjs` → `tests 11 / pass 11 / fail 0`（已实跑） |
| 本期主攻 | 本地 Web 可视化工作台（GUI） |
| 粒度 | 里程碑 + 验收口径 |
| D1 裁决 | **B —— Vite + React + Tailwind + Radix**（2026-10-24 用户拍板；连锁影响与对策见 §11） |
| 状态 | D1 已裁决 B；M0–M1 已完成（§12）；**M2 + M3 已完成并通过真实浏览器验证**（§13）；M4/M5 待做 |

---

## 0. 现状基线（全部为实测/读码事实，非推测）

### 0.1 代码构成

| 文件 | 行数 | 职责 |
|---|---|---|
| `feishu-export.mjs` | 231 | CLI 入口：参数解析、浏览器拉起、单文档导出编排、manifest 落盘 |
| `lib/cdp.mjs` | 117 | 零依赖 CDP 客户端（Node 内置 `WebSocket`）：目标管理、会话附加、`Runtime.evaluate` |
| `lib/capture.mjs` | 132 | **页面内**抓取逻辑：`client_vars` 分页取全量 block、按 token 拉资源转 base64 |
| `lib/render.mjs` | 419 | `attribs` 富文本解码、`block_map` → 自包含 HTML / Markdown、资源落盘 |
| `selftest.mjs` | 218 | `node:test` 覆盖纯逻辑（解码/嗅探/渲染/落盘），11 用例 |
| `probe-page.mjs` | 31 | 单页探测脚本 |

### 0.2 已验证可用的链路

`out/` 下有两份**真实导出产物**（含 `assets/` + `manifest.json`），证明端到端跑通过。
真实 `manifest.json` 字段（读 `out/Pytest脚本开发流程说明/manifest.json` 确认）：

```
sourceUrl / docId / title / exportedAt / isoTime / browser
blockCount / rootChildren / tocEntries
assets: { total, saved, missing[] }
outputs: { html, md }
stats: { blocks, tocEntries }
```

> 这份结构就是 GUI「导出回执」的数据源，不需要新增任何采集逻辑。

### 0.3 当前架构对 GUI 的三个硬约束（读码确认）

1. **编排逻辑不可复用**：`ensureBrowser` / `docIdOf` / `safeName` / `exportOne` 全部是 `feishu-export.mjs` 内的私有函数，`main()` 里直接 `console.log`。`server.mjs` 无法 import。
2. **进度是字符串不是结构**：`exportOne(cdp, sessionId, url, opts, log)` 只收一个 `log(msg)`，GUI 拿不到 `phase / 进度分子分母 / 缺失资源`，只能正则扒日志——不可接受。
3. **`--wait-login` 阻塞 stdin**：批量导出时每个 URL 都要人工按回车（`feishu-export.mjs:126-130`），GUI 里必须换成可被事件驱动的「等待登录」态。

### 0.4 现存缺陷清单（本期顺带收口的真实问题）

| # | 位置 | 问题 | 级别 |
|---|---|---|---|
| 1 | `render.mjs:83` | `style="background:${esc(hl)}33"` 对后端颜色值不做白名单，`;`/`(`/`)` 未转义 → CSS 声明注入面（可被塞 `position:fixed;inset:0`） | P1（数据源是自有文档，风险受限） |
| 2 | `capture.mjs` | 资源串行 `fetch`，无并发、无 429/5xx 重试、无失败原因记录 | P2 |
| 3 | `feishu-export.mjs` | 无增量：重导出重下全部资源 | P2 |
| 4 | `render.mjs:341` | Markdown 表格固定把首行当表头，且合并单元格信息在 MD 中丢失 | P2（HTML 侧正常） |
| 5 | `render.mjs:228` | TOC 只收 `heading1..3`，h4/h5 不进目录 | P3 |
| 6 | 全局 | 无 lint / 无 CI / `package.json` 缺 `files`、`scripts.start` | P2 |

> 缺陷 1 在本期 M4 修（属于安全收口，不占用 GUI 主线工期）。

---

## 1. 设计方向（Design Before Code）

先定美学观点，再写一行 CSS。以下四问是本期唯一的视觉裁决依据。

### 1.1 PURPOSE

- **解决什么问题**：把「敲一条命令、盯一屏滚动日志、去文件夹里翻产物」变成「粘贴链接 → 看见每一阶段 → 当场预览 → 拿到证据」。
- **目标用户**：要归档内部飞书文档的工程师 / 文档负责人。他们不追求花哨，追求**进度可见、结果可信、失败有因**。
- **情感需求**：安心。像把材料递进一台工业设备，出来一张带编号的回执。

### 1.2 TONE — 「图纸档案终端 / Archival Terminal」

在瑞士国际主义（严格栅格、字号阶梯）与轻粗野主义（1px 裸规则线、无圆角卡片、等宽数据）之间：

- **不做**暗黑赛博朋克（AI 最爱的默认解）、不做玻璃拟态卡片墙、不做英雄区 + 功能区。
- **做**暖纸基底 + 技术蓝图栅格 + 单一氧化橙信号色 + 衬线标题与等宽数据的强对比。
- 气质锚点：档案馆的检索台、老式绘图仪、体检报告单。

### 1.3 CONSTRAINTS

| 约束 | 要求 |
|---|---|
| 引擎零依赖 | `lib/`、`server.mjs` 只用 Node 内置能力，**运行时依赖必须为 0**（CDP 抓取链不受前端选型影响） |
| GUI 构建链（D1=B 已裁决） | `ui/` 用 Vite + React 18 + Tailwind 3.4 + Radix；`npm run build` 产出 `ui/dist` 由 `server.mjs` 托管；`react`/`react-dom` 也放 devDependencies，保证运行时零依赖口径成立。代价与对策见 §11 |
| 离线可用 | 禁任何 CDN 字体/图标/脚本；全部本地文件 |
| 无障碍 | 键盘全可达、焦点可见、正文对比度 ≥ 4.5:1、`prefers-reduced-motion` 全量降级 |
| 性能 | 首屏 CSS+JS 合计 < 60KB（未压缩），无阻塞第三方资源；长列表用事件委托 |
| 浏览器 | 本机 Chrome/Edge 最新版即目标环境（工具本身就依赖它们） |

### 1.4 DIFFERENTIATION —— 记忆点只有一个，做透

**「导出回执 / Receipt」**：每次导出完成，生成一张等宽票据，字段 100% 来自 `manifest.json`（源链接、docId、块数、资源 `saved/total`、缺失 token 列表、浏览器 UA、耗时、输出路径）。可 `@media print` 直接 A4 打印归入档案。

为什么这个点值得做：它不是装饰，而是把这个工具**已有的证据链能力**翻译成视觉语言；同类导出工具没人给「可打印回执」。用户离开后会记得「那个会给我开发票的导出工具」。

### 1.5 视觉规格（可直接落 CSS，不留"看起来不错"）

**色彩（唯一一套，不做彩虹）**

```css
--paper:#F2EFE6;      /* 暖纸基底 */
--paper-2:#E9E4D6;    /* 次级面 */
--ink:#16150F;        /* 墨黑正文 */
--ink-soft:#5A564A;   /* 次级文字 */
--rule:#C9C3B2;       /* 1px 规则线 / 栅格 */
--signal:#D64518;     /* 氧化橙：活跃态、警示 */
--go:#1F6F4A;         /* 深铬绿：完成态 */
```
深色变体（`prefers-color-scheme: dark`，「煤纸」）：`--paper:#14140F` / `--paper-2:#1D1C16` / `--ink:#EDE8DA` / `--rule:#3A382C`。

**字体（双字体策略，禁 Inter/Roboto/Arial）**

```css
--font-display:"Newsreader","Spectral","Source Serif 4",Georgia,serif; /* 标题、编号 */
--font-mono:"JetBrains Mono","Cascadia Mono",Consolas,ui-monospace;    /* 全部数据、标签、路径 */
```
落位规则：所有数字、路径、token、时间、按钮文案用 mono；仅页面大标题与段落区标题用 display 衬线。中间不夹第三种字体。

**栅格与构图（有意不对称）**

- 主布局：`grid-template-columns: minmax(320px,1fr) minmax(0,1.618fr)`（黄金比，非 12 栏对称）。
- 左栏（输入 + 队列）粘性；右栏（运行面板 + 预览）随动，允许内容破格（预览 iframe 宽 `calc(100% + 48px)`）。
- 段落编号 `01 / 02 / 03` 用 mono、`--ink-soft`、`0.75rem`、`letter-spacing:.18em`——档案目录感。
- 垂直呼吸：段落间距 `clamp(3rem, 2rem + 4vw, 7rem)`，不用统一 `padding: 2rem`。
- 背景：32px 蓝图栅格（`linear-gradient` 双层），透明度 `0.28`，仅在页头与右栏出现，正文区留白干净。
- 圆角统一 `2px`；阴影只在「运行中」面板用一次（`0 0 0 1px var(--signal)`），不做多层柔光。

**动效（只允许三处，其余零过渡）**

| 位置 | 内容 | 参数 |
|---|---|---|
| 1. 提交入槽 | 新任务条目 `clip-path: inset(0 100% 0 0)` → `inset(0)` | `180ms cubic-bezier(.16,1,.3,1)` |
| 2. 阶段推进 | 四个阶段点阵（probe / assets / render / write）逐格点亮 + 等宽数字滚动 | 每格 `120ms`，阶梯 `40ms` |
| 3. 产物揭示 | 回执与产物行错开淡入上移 `translateY(6px)` → `0` | `240ms`，阶梯 `60ms` |

显式禁止：`transition: all .3s`、所有 hover 淡入淡出、loading 旋转圈（改用点阵）、彩虹渐变文字。

**状态语义（用颜色即语义，不做装饰色）**

`queued` 灰点 / `running` 氧化橙呼吸 / `waiting_login` 氧化橙 + 明确文案「已在浏览器打开，登录后点我继续」/ `done` 深铬绿 / `error` 氧化橙实心 + 首行错误原因 / `cancelled` 灰斜线。

---

## 2. 架构方案

### 2.1 目标结构

```
飞书一键导出/
├── feishu-export.mjs      (改) 薄 CLI 壳：解析参数 → 调 lib/driver.mjs
├── server.mjs             (新) 零依赖 HTTP 服务 + SSE，仅绑 127.0.0.1
├── lib/
│   ├── driver.mjs         (新) 从 CLI 抽出的可复用编排：ensureBrowser/docIdOf/safeName/exportOne(带 onEvent)
│   ├── jobs.mjs           (新) 内存任务队列 + 状态机 + 取消
│   ├── cdp.mjs            (不变)
│   ├── capture.mjs        (小改) 补失败原因采集、并发限流(可选)、429 重试
│   └── render.mjs         (小改) 颜色白名单收口(缺陷 1)、TOC 层级可配
├── ui/                                (新) Vite 前端工程（D1=B）
│   ├── index.html                     Vite 入口模板
│   ├── vite.config.js                 base:'/'，dev 代理 /api → 127.0.0.1:7801
│   ├── tailwind.config.js             §1.5 token 映射进 theme（不散落魔法值）
│   ├── postcss.config.js
│   ├── src/main.jsx                   React 挂载
│   ├── src/App.jsx                    三段式布局骨架（01/02/03）
│   ├── src/features/Submit.jsx        投入区：链接输入 + 选项
│   ├── src/features/JobList.jsx       队列：状态点阵 + 「继续」按钮
│   ├── src/features/Preview.jsx       产物预览 iframe + 下载
│   ├── src/features/Receipt.jsx       导出回执（M3）
│   ├── src/hooks/useJobs.js           EventSource 订阅 + 断线重连 + 全量兜底
│   ├── src/styles/tokens.css          §1.5 设计变量（CSS 自定义属性）
│   ├── src/styles/app.css             Tailwind 指令 + 三处动效 + reduced-motion 归零
│   └── dist/                          (构建产物，git 忽略) 由 server.mjs 托管
└── test/server.test.mjs               (新) node:test 起真服务打真 HTTP
```

### 2.2 数据流

```
[浏览器 UI]
   │ POST /api/jobs {urls[]}
   ▼
[server.mjs] ──► [lib/jobs.mjs] 排队（串行，见 D3）
                      │
                      ▼
                 [lib/driver.mjs] exportOne(..., onEvent)
                      │  ① ensureBrowser → CDP.connect
                      │  ② 页面内 captureDoc：client_vars 全量 blocks
                      │  ③ 按 chunk 拉资源（base64 回传）
                      │  ④ render() → 写 HTML/MD/assets/manifest.json
                      ▼
                 onEvent({phase, ...}) ──► jobs 状态机更新 ──► SSE /api/events
                                                              │
[浏览器 UI] ◄─────────────────────────────────────────────────┘
   │ 完成后 GET /preview/<title>/<title>.html  → <iframe sandbox>
   └ 回执渲染自 manifest.json
```

### 2.3 进度事件契约（已与实现对齐，M0 冻结）

分两层，职责不同：

**A. driver 层（`lib/driver.mjs` 的 `onEvent`）—— 只描述"导出这一件事"**

```js
{ phase:'navigate',      at, url }
{ phase:'slow_page',     at }                        // 页面 45s 内未就绪：不中断，仅告知（由 probe 兜底报错）
{ phase:'waiting_login', at, url }                   // 仅 opts.waitLogin 时；随后 await opts.promptLogin()
{ phase:'probe',         at, blockCount, assetTotal, title, totalChunks }
{ phase:'assets',        at, chunk, totalChunks, done, assetTotal }   // done = 已成功累计数
{ phase:'blocks',        at, blocks }
{ phase:'render',        at, tocEntries }
{ phase:'write',         at, outDir, manifestPath }
{ phase:'done',          at, outDir, htmlPath, mdPath, manifest,
                             htmlKB, tocEntries, savedAssets, assetTotal }  // 后四项供 CLI 还原日志行
```

**B. 队列层（`lib/jobs.mjs` + `server.mjs` 的 `driverRunner`）—— 描述"这个任务的编排"**

```js
{ phase:'queued' } { phase:'starting' }
{ phase:'launch',    at, browser, profile, reused }   // reused=true 表示复用已在跑的调试端口
{ phase:'cdp',       at, version }
{ phase:'job_url',   at, url }                        // 多链接任务里"当前正在导第几个"
{ phase:'waiting_login' } / { phase:'resuming' }
{ phase:'error',     at, message, code }              // 由队列层 catch 统一生成，driver 用 throw 表达错误
{ phase:'cancelled' }
```

`code` 取值：`NO_BROWSER` / `CDP_TIMEOUT` / `BAD_URL` / `BAD_OPTIONS` / `NO_CONTENT` / `CANCELLED` / `UNKNOWN`。

**不变量**
- 任务进入终态（done/error/cancelled）后，**任何 phase 事件都不得再改写其状态**（否则取消的任务会被后续事件"复活"，队列死锁）。
- `waiting_login` 若在已终态时被调用，必须立即返回，不得挂起。

CLI 侧用一个 formatter 把它还原成**与现在逐字一致**的中文日志行 → 这是 M0「CLI 行为零变化」的验收手段。

### 2.4 HTTP 契约

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` | 返回 `ui/dist/index.html`（未构建时返回 503 并提示 `npm run build`） |
| GET | `/assets/*` | 只服务 `ui/dist/assets/` 下文件；禁目录列表 |
| POST | `/api/jobs` | body `{ urls:string[], opts?:{md:boolean, waitLogin:boolean} }` → `201 {id,status}`。**`out`/`browser`/`port`/`profile` 由服务启动参数决定，不接受客户端覆盖**（否则等于让调用方指定任意写入路径） |
| GET | `/api/jobs` | 全量任务列表（脱敏后的 opts） |
| GET | `/api/jobs/:id` | 单任务详情 + 最近 200 条事件 |
| POST | `/api/jobs/:id/cancel` | 置取消标志，driver 在 chunk 边界退出 → `202` |
| POST | `/api/jobs/:id/resume-login` | 唤醒 `waiting_login` 态（替代 CLI 的回车） |
| GET | `/api/events` | `text/event-stream`；事件名 `job:update`、`log`、`job:done` |
| GET | `/preview/:title/*` | 服务 `out/<title>/` 下文件（含 assets），**URL 解码后必须 realpath 校验** |
| GET | `/api/health` | `{ ok, port, cdp:boolean, browser:(string 或 null), ui:{built,builtAt,stale}, allowAnyHost }` |

### 2.5 任务状态机

```
queued ──► running ──► done
              │ ├──► error
              │ ├──► cancelled
              │ └──► waiting_login ──(resume-login)──► running
```

不变量：任一时刻至多 1 个 `running`（D3 定）；`cancelled`/`error` 后必须 `Target.closeTarget`，不残留页面。

---

## 3. 里程碑

每个里程碑都是「可独立交付、可独立验收、可独立回滚」的单元。风险等级按项目规则：**L1** 局部可逆 / **L2** 多文件有下游影响 / **L3** 公共接口或不可逆。

---

### M0 · 抽出可复用编排层（L2）

**目标**：让 `server.mjs` 能 import 到编排逻辑，且 **CLI 外部行为零变化**。

**交付物**
- `lib/driver.mjs`：迁移 `ensureBrowser`、`findBrowser`、`isPortOpen`、`docIdOf`、`safeName`、`exportOne`；`exportOne` 第五参由 `log` 改为 `onEvent`。
- `feishu-export.mjs` 降为 ~70 行薄壳：`parseArgs` + `eventToLogLine()` + `main()`。
- `exportOne` 增加取消检查点：每个资源 chunk 之后检查 `signal.aborted`。

**验证命令**
```bash
node --check lib/driver.mjs
node selftest.mjs                                  # 期望仍为 pass 11 / fail 0
node feishu-export.mjs --help > /tmp/help-new.txt  # 与改动前捕获的 help 逐字 diff
node feishu-export.mjs                             # 期望打印帮助并 exit 1（行为不变）
```
真实导出回归（**需你本机已登录的 profile**）：
```bash
node feishu-export.mjs "<真实链接>" --out /tmp/m0-after
diff <(grep -v 导出时间 /tmp/m0-before/*.html) <(grep -v 导出时间 /tmp/m0-after/*.html)
```
期望：HTML 除时间戳外无差异；`assets/` 文件名集合完全一致；`manifest.json` 除 `exportedAt/isoTime` 外逐字段一致。

**完成标准**
1. `node selftest.mjs` 全绿（11/11）。
2. `--help` 输出与改动前逐字相同。
3. 真实导出产物 diff 通过（或明确记录差异原因）。
4. `feishu-export.mjs` 中不再残留 `exportOne`/`ensureBrowser` 实现，只有调用。
5. 依赖数仍为 0（`package.json.dependencies` 不存在）。

**回滚**：单 commit 反向 revert 即可（纯函数搬迁，无数据面）。

---

### M1 · 本地服务骨架 + SSE 进度（L2）

**目标**：不经 UI 也能用 curl 驱动完整导出并看到结构化进度。

**交付物**
- `server.mjs`：`node:http`，`127.0.0.1:7801`（`--port` 可换）；路由表按 §2.4；SSE 心跳 15s。
- `lib/jobs.mjs`：内存 Map 任务表、状态机、事件环形缓冲（每任务 200 条）。
- `test/server.test.mjs`：`node:test` 内 `spawn` 真服务 → 真 HTTP 请求（**非 mock**）。

**验证命令**
```bash
node server.mjs &
curl -s http://127.0.0.1:7801/api/health
curl -s -X POST http://127.0.0.1:7801/api/jobs -H 'Content-Type: application/json' \
     -d '{"urls":["<真实链接>"]}'
curl -sN http://127.0.0.1:7801/api/events | head -40      # 期望看到 >= 4 种 phase 事件
node --test test/server.test.mjs
```
测试断言要点：`/api/health` 200 且 `ok:true`；`POST /api/jobs` 201 且回 `id`；非法 body 400；非白名单 URL 400；SSE 收到 `probe` 与 `done` 事件各 ≥1。

**完成标准**
1. `node --test test/server.test.mjs` 全绿。
2. curl 走通一次真实导出，`out/` 下产物与纯 CLI 导出**同名同结构**。
3. 任务结束后 `Target.closeTarget` 已调用（断言 CDP target 列表无残留）。
4. 服务仅监听 `127.0.0.1`（`netstat` 确认）。

**回滚**：`server.mjs`/`jobs.mjs`/`test/` 为纯新增文件，删除即回滚；M0 前的 CLI 路径未受影响。

---

### M2 · 视觉层与交互状态机（L2）

**目标**：按 §1.5 落地三个区块——**投入区（01）/ 运行队列（02）/ 产物与预览（03）**，并把状态机接到真实事件。

**交付物**
**交付物 —— 分两个阶段，S1 未过不启 S2**

S1 基座与设计系统：
- `ui/` 工程：`vite.config.js`（`base:'/'`、dev 代理 `/api` → `127.0.0.1:7801`）、`tailwind.config.js`（§1.5 token → theme，禁散落魔法值）、`postcss.config.js`。
- `ui/src/styles/tokens.css`：§1.5 全部变量（含深色变体）。
- `ui/src/styles/app.css`：Tailwind 指令、蓝图栅格背景、1px 规则线、三处动效、`prefers-reduced-motion` 归零块。
- 设计系统验收页：`ui/src/dev/tokens-preview.jsx`（仅 dev 可达），把 §1.5 的色板/字阶/状态点阵一屏列全，用于自查而非交付物。

S2 界面与状态机：
- `ui/src/App.jsx`：三段式骨架 `01 投入 / 02 队列 / 03 产物`，语义化标签，无内联样式。
- `ui/src/features/Submit.jsx`：链接多行输入（逐行拆 URL）、选项（`--no-md` 等价开关）、提交。
- `ui/src/features/JobList.jsx`：状态点阵（probe/assets/render/write 四格）、等宽数字滚动、`waiting_login` 行的「已在浏览器打开，登录后点我继续」按钮。
- `ui/src/features/Preview.jsx`：`<iframe sandbox="allow-same-origin" loading="lazy">` + 下载入口。
- `ui/src/hooks/useJobs.js`：`EventSource` 订阅 + 断线自动重连 + `GET /api/jobs` 全量兜底。
- Radix 只按需引入（`@radix-ui/react-dialog` 用于取消确认、`@radix-ui/react-tooltip` 用于 token 解释），不整包铺开。

**验证命令与真实浏览器操作（Playwright MCP）**

```bash
npm --prefix ui ci                                   # 首装用 install，有锁文件后一律 ci
npm --prefix ui run build                            # 产出 ui/dist
node server.mjs &
curl -s http://127.0.0.1:7801/api/health             # 期望 {ok:true}
node -e "const g=require('zlib'),fs=require('fs');let j=0,c=0;for(const f of fs.readdirSync('ui/dist/assets')){const b=fs.readFileSync('ui/dist/assets/'+f);if(f.endsWith('.js'))j+=g.gzipSync(b).length;else if(f.endsWith('.css'))c+=g.gzipSync(b).length;}console.log('gzip JS',j,'CSS',c)"
```
以下 7 项在真实浏览器中逐条执行并截图存档（`docs/gui-*.png`）：

1. 成功路径：粘贴真实链接 → 观察四阶段点阵推进 → 完成态深铬绿 → 回执出现 → 点预览 iframe 渲染出正文 → 点下载得到文件。
2. 失败路径：贴一条无权限/不存在的 docx → `error` 态显示 `LOGIN_REQUIRED` 或 `NO_CONTENT` 中文原因，不显示 `undefined`。
3. 取消路径：大文档导出中点取消 → 状态 `cancelled`，无 CDP 残留。
4. 响应式截图：320 / 768 / 1440 三档，均无横向滚动。
5. 键盘：Tab 顺序 输入框 → 提交 → 队列 → 预览；焦点环可见（不 `outline:none`）。
6. `prefers-reduced-motion: reduce` 下三处动效全部归零。
7. 控制台零 error。

**完成标准**
1. 上述 7 项全部有**截图或断言证据**（截图存 `docs/gui-*.png`）。
2. 构建产物 gzip 后 JS+CSS 合计 < 180KB（本地服务无网络分发，仍按 app page 标准收紧；React 基线约 45KB gzip）。
3. 视觉自检通过：无 Inter/Roboto/Arial、无 `#4F46E5`、无彩虹渐变、无 `transition: all`、圆角统一 2px、仅一处阴影。
4. 断网（DevTools offline）后 UI 仍完整可用（字体/图标零 CDN）。

**回滚**：删除 `ui/` 与 `ui/dist` 即回到纯 CLI 形态（`server.mjs` 对 `GET /` 返回 503，`/api/*` 不受影响）。`devDependencies` 与锁文件同 commit 回退。

---

### M3 · 导出回执（差异化）（L1）

**目标**：把 `manifest.json` 变成可读、可打印的票据。

**交付物**
- `ui/src/features/receipt-model.js`：**纯 JS 函数**（无 JSX），`buildReceipt(manifest)` → 纯数据结构，**字段一一映射 §0.2**，缺失字段成 `null` 由视图层显示 `—`。这样 `node:test` 能直接测，不需要 vitest。
- `ui/src/features/Receipt.jsx`：只做 model → DOM 的映射，不含任何业务判断。
- `ui/src/styles/receipt.css`：等宽票据版式 + `@media print`（A4、去背景栅格、去按钮）。
- `selftest.mjs` 新增 2 个用例：用 `out/` 里两份**真实 manifest** 作 fixture（一份 `missing:[]`、构造一份 `missing:[token]`），断言字段渲染与缺失列表。

**验证命令**
```bash
node selftest.mjs            # 期望 pass 13 / fail 0
```
浏览器：导出完成后截回执图 + `Ctrl+P` 打印预览截图各一张。

**完成标准**
1. 回执中每个数字都能在 `manifest.json` 里找到同名字段（逐字段核对，不自造）。
2. `missing` 非空时打印**全部**缺失 token，不折叠、不吞。
3. 打印预览为单页 A4，无背景栅格、无交互元素。

**回滚**：删除 `receipt.*` 与新增测试用例。

---

### M4 · 安全与鲁棒性收口（L2）

**目标**：本地服务不能变成文件读取器或 SSRF 跳板；导出失败必须给可行动原因。

**交付物**
1. **绑定**：仅 `127.0.0.1`；`Host` 白名单（`127.0.0.1:<port>` / `localhost:<port>`）+ `Origin` 校验（缺失或不匹配 → 403）。
2. **路径穿越防护**：`/preview/*` 与静态路由统一 `decodeURIComponent` → `path.resolve` → `fs.realpathSync` → 断言 `startsWith(outRoot + path.sep)`。
3. **URL 白名单**：`^https://[\w.-]+\.(feishu\.cn|larksuite\.com)/`；逃生门 `--allow-any-host`（启动时明确提示风险）。
4. **body 限制**：≤ 256KB，超限 413；`JSON.parse` 包 try → 400。
5. **响应头**：`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`Content-Security-Policy: default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-src 'self'`。
6. **缺陷 1 修复**：`render.mjs` 对 `textHighlight`/`textColor` 做 `^#[0-9a-fA-F]{3,8}$` 白名单，不合法则丢弃样式（不降级为任意 CSS）。
7. **错误分级**：driver 抛错统一带 `code`；`capture.mjs` 资源失败记录 `{token, kind, status, reason}` 进 manifest 的 `assets.failures[]`（新增字段，向后兼容）。
8. **重试**：资源 `429/5xx` → 指数退避 3 次（`600ms / 1.8s / 5.4s`），用 mock `fetch` 注入验证。

**验证命令**
```bash
curl -s -o /dev/null -w '%{http_code}\n' 'http://127.0.0.1:7801/preview/../../etc/passwd'   # 期望 400/403/404，绝不含 root:x
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:7801/api/jobs \
     -H 'Content-Type: application/json' -d '{"urls":["https://evil.example.com/docx/abc"]}'  # 期望 400
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:7801/api/jobs \
     -H 'Origin: http://evil.example.com' -d '{}'                                            # 期望 403
node --test test/server.test.mjs     # 含 429/5xx mock 重试用例
node selftest.mjs                    # 含颜色白名单用例
```

**完成标准**
1. 三个负向用例返回期望码，且穿越用例**不含文件内容**。
2. `textHighlight: "red;position:fixed"` 渲染结果不含该值（selftest 断言）。
3. 429 mock 场景：3 次重试后成功；持续 429 后记为失败并进 `assets.failures[]`。
4. 无 CRITICAL 遗留。

**回滚**：安全校验集中在 `server.mjs` 的 `guard()` 与 `render.mjs` 的 `safeColor()`，单点回滚。

---

### M5 · 收尾与发布闭环（L2）

**交付物**
- `README.md`：新增「可视化工作台」章节 + 截图 + 与 CLI 的关系说明；修正已知限制。
- `package.json`：`scripts.start = "node server.mjs"`、`scripts.test = "node --test test/ && node selftest.mjs"`、`files` 白名单、`repository`。
- `graft build` 重建图谱（`AGENTS.md` 要求，代码大改后必须刷）。
- `workflow_status.md`：M0 起即创建，记录验收表与验证日志（项目规则要求复杂任务维护）。

**验证命令**
```bash
npm run test          # 全部测试
npm pack --dry-run    # 确认打包含 ui/dist lib/ server.mjs，不含 out/ .browser-profile/ graft/
node feishu-export.mjs --help
graft build
```

**完成标准**：README 描述与真实行为逐条对得上；打包清单无泄漏（无 profile、无 out）；图谱重建成功。

**回滚**：本里程碑只动文档与 `package.json` 元数据，单 commit `git revert` 即可；`graft/` 为可再生派生物，删除后 `graft build` 可原样重建，无数据面风险。

---

## 4. 验收口径总表

| # | 验收项 | 证据形式 | 归属 |
|---|---|---|---|
| A1 | CLI 外部行为零变化 | `--help` diff + 真实导出产物 diff | M0 |
| A2 | 引擎可被服务复用 | `server.mjs` 成功 import 并跑通 | M0/M1 |
| A3 | 结构化进度可观测 | SSE 抓到 ≥4 种 phase | M1 |
| A4 | 三条真实路径可用 | Playwright 截图（成功/失败/取消） | M2 |
| A5 | 三档响应式无溢出 | 320/768/1440 截图 | M2 |
| A6 | 无障碍基线 | 键盘 Tab 截图 + 对比度检查记录 | M2 |
| A7 | 回执零自造数据 | 逐字段核对表（manifest ↔ 回执） | M3 |
| A8 | 安全负向用例 | 3 条 curl 真实返回码 | M4 |
| A9 | 运行时零依赖成立 | `package.json` 的 `dependencies` 为空；全部前端包进 `devDependencies` 且不超 §11.2 白名单 | M5 |
| A10 | 离线性 | DevTools offline 后 UI 完整 | M2 |

**证据标签约定**（按项目规则）：`已验证`（实际跑过）/ `静态确认`（读码）/ `合理推断` / `待验证`。文档与汇报里必须带标签，禁止把静态检查说成真实路径验证。

---

## 5. 安全清单（P0，缺一项不得交付）

- [ ] 服务仅绑 `127.0.0.1`
- [ ] `Host` + `Origin` 双校验（防 DNS rebinding / CSRF）
- [ ] 预览与静态路由 realpath 越界防护
- [ ] URL 域名白名单（默认仅 feishu.cn / larksuite.com）
- [ ] body 体积上限 + JSON 解析异常兜底
- [ ] CSP / nosniff / no-referrer 响应头
- [ ] 预览 iframe `sandbox` 隔离
- [ ] 不落任何凭据、不打印 profile 内敏感路径
- [ ] 错误消息不回显本机绝对路径与堆栈（仅服务端日志）

---

## 6. 不做清单（本期 Out of Scope，避免范围失控）

- 不做 wiki 空间递归、sheet / 多维表格 / 评论 / @提醒导出（抓取侧扩展属下一期）
- 不做增量重导出与资源缓存（缺陷 3 记录在案，不在本期）
- 不做多用户 / 远程部署 / Docker（这是**本机单用户工具**，暴露到网络即破坏安全模型）
- 不做暗色/亮色切换开关（跟随系统 `prefers-color-scheme` 即可）
- 不引入 React / 状态库 / CSS-in-JS
- 不重写 `capture.mjs` 的抓取策略（已实测有效，风险大于收益）

---

## 7. 需你拍板的决策点

> 这四条会实质影响工期与代码形态，请一并定。每条已给推荐。

### D1 前端是否引入构建链？（已裁决：B）

> **用户 2026-10-24 拍板选 B。** 下表保留原始权衡记录，A 为未采纳的备选。

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| **A. 原生 ESM + 手写 token CSS** | 保住「下载即用、零 npm install」核心卖点；无 CI 构建步骤；`web/` 直接可读可改 | 无 Tailwind 原子类便利；组件一致性靠人守 | 未采纳 |
| **B. Vite + React + Tailwind + Radix** | 组件生态成熟、后续复杂 UI 扩展快 | 破坏原有零依赖宣传：新增大量 devDependencies、需构建产物、`node server.mjs` 前必须 `npm run build` | **已采纳**（对策见 §11） |

> 说明：你给的通用前端准则要求 Shadcn/Radix + Tailwind。但本项目**核心卖点就是零依赖**（README 明写、M0 验收含"依赖数为 0"）。二者冲突，我按"项目级规则覆盖通用默认"处理，推荐 A。若你要 B，M2 工期从 1 个里程碑变 2 个，且 M5 需加构建产物校验。

### D2 字体如何保证离线不退化？

| 方案 | 说明 |
|---|---|
| **A. 先只写本地字体栈（推荐）** | `Newsreader/JetBrains Mono` 若本机没装则回退 `Georgia`/`Consolas`——回退后仍有"衬线 + 等宽"的骨架，设计不塌 |
| B. 内嵌 WOFF2 子集（中文子集 ~200-400KB） | 视觉 100% 确定，但体积突破 60KB 首屏预算，且中文字体子集化需要额外工具链 |

### D3 任务并发策略？

| 方案 | 说明 |
|---|---|
| **A. 串行单队列（推荐）** | 复用同一 CDP 会话与浏览器 profile，避免飞书侧风控与资源争抢；进度语义简单 |
| B. 多页面并发（2） | 大文档批量快一些，但同一 profile 下多页同时打 `client_vars` 更容易触发限流，且取消语义复杂 |

### D4 `waiting_login` 的交互形态？

| 方案 | 说明 |
|---|---|
| **A. UI 里出现「已在浏览器打开，登录后点我继续」（推荐）** | 把 CLI 的 stdin 阻塞转成可被事件驱动的显式状态，批量导出可逐个推进 |
| B. 轮询页面正文出现自动继续 | 更省手，但判断"正文已出现"的启发式不可靠，容易抢跑抓到空内容 |

---

## 8. 风险与待验证项

| # | 项 | 标签 | 说明 |
|---|---|---|---|
| R1 | M0 的"真实导出 diff 通过" | **待验证** | 需要你本机 `.browser-profile` 里有效的飞书登录态。我做得到的是 `--help` diff、`node --check`、selftest 与代码静态确认；真实链路 diff 需你在本机跑一次或授权我跑 |
| R2 | 本机 Chrome/Edge 探测 | 合理推断 | `feishu-export.mjs` 的候选路径只覆盖 Chrome/Edge 标准安装位；manifest 显示真实跑过 `Chrome/151.0.7922.172`，说明可用 |
| R3 | Playwright 真机验证可达性 | 待验证 | 需要 `plugin:playwright` MCP 可用 + 本机 `127.0.0.1:7801` 端口空闲。若不可用，M2 验收降级为"手动截图 + 明确披露阻塞"，不假装通过 |
| R4 | SSE 在本地长连接下的稳定性 | 合理推断 | `node:http` + 15s 心跳足够；但浏览器标签页休眠可能断流，`app.js` 必须实现 `EventSource` 自动重连 + 全量 `GET /api/jobs` 兜底 |
| R5 | 大文档体积 | 已验证（历史实测） | 983 块 / 57 图 / 5 白板 / 2 附件曾跑通；GUI 预览大 HTML 可能卡顿 → 已知限制，写入 README，不在本期优化 |
| R6 | 视觉方向的主观接受度 | 待你确认 | §1.5 是明确取舍（暖纸 + 氧化橙 + 衬线/等宽）。若你想要别的调性（如冷金属、纯黑白），请在过目时直接说，改动集中在一个 `tokens.css` |
| R7 | 构建链引入带来的三类新风险 | 合理推断 | D1=B 后新增：供应链面、`ui/dist` 与源码不同步、Radix 默认样式冲击视觉。逐条对策见 §11.3 |

---

## 9. 已知偏差与环境事实（诚实披露）

1. **项目根的 `CLAUDE.md` 要求会话开始先读 `.wolf/OPENWOLF.md`、`.wolf/cerebrum.md`、`.wolf/anatomy.md`，但本项目不存在 `.wolf/` 目录**（已 `ls` 确认）。本期按事实处理：不假装读过该协议，也不擅自创建 `.wolf/` 体系。如需启用 OpenWolf，请明示，我另做初始化计划。
2. **`gitStatus` 快照与真实 HEAD 不一致**：快照显示 `e2c0e83`，实测 `git rev-parse HEAD = 20fda93`（历史含 `chore: 补 .gitattributes 与 CHANGELOG`）。本文档以实测为准。
3. **`计划书/` 为本项目新建目录**，此前不存在任何计划文档，因此本次是"新建"，不涉及"判断旧文件是否过时"。
4. `package.json` 声明 `engines: node >= 20`，实际运行环境 `v25.8.1`。代码只用到 `fetch` / `WebSocket` / `node:test` / `readline/promises`，20+ 均可用。
5. **D1 裁决为 B 后，README 现有的「零第三方依赖、不需要 npm install」宣传将不再字面成立**。这不是可以模糊过去的措辞问题：M5 必须把它改写成「CLI 引擎零依赖 / 可视化工作台需构建」两段式表述，否则文档与真实行为不一致。详见 §11.1。

---

## 10. 下一步

1. ~~过目并裁决~~ —— **D1 已定为 B**；D2–D4 按推荐执行（本地字体栈 / 串行单队列 / 登录改按钮化）。
2. **M0、M1 已完成并通过真实验证**，逐项证据见 §12（含真实飞书导出 45 块 / 13 资源 / 产物逐字节一致）。
3. 下一步：**M2 的 S1**（Vite 工程 + Tailwind token 映射 + Radix 原语 + `tokens-preview` 自查页）。S1 过验收后才动 S2 界面，避免在错误的基座上雕花。

---

## 11. 附：D1 裁决为 B 的连锁影响与对策

### 11.1 因 D1=B 而失效的前提（必须同步改写，不得含糊）

| 原前提 | 裁决后状态 |
|---|---|
| 「零第三方依赖、不需要 npm install」（README 现有宣传） | **字面不再成立**。M5 改写为两段式：① CLI 引擎仍零依赖，下载即可跑；② 可视化工作台需 `npm install && npm run build` |
| §1.3 原「GUI 不得引入构建链」 | 改为「引擎零依赖 + GUI 构建链」双轨，见 §1.3 |
| 验收项 A9「`dependencies` 不存在」 | 改为「`dependencies` 为空 + `devDependencies` 不超白名单」——运行时仍真正零依赖，只是构建期有依赖 |
| M2 单里程碑 | 拆为 S1 基座与设计系统 / S2 界面与状态机，S1 未过不启 S2 |

### 11.2 新增工程要求

| 项 | 要求 |
|---|---|
| 锁文件 | 提交 `ui/package-lock.json`；任何复现一律 `npm ci`，禁止 `npm install` 改锁 |
| 服务启动 | `server.mjs` 检测 `ui/dist/index.html` 缺失 → `GET /` 返回 503 并提示 `npm --prefix ui run build`；**不自动触发 build**（不在启动时静默装依赖/联网） |
| 开发模式 | 两进程：`npm --prefix ui run dev`（Vite 5173，`/api` 代理到 7801）+ `node server.mjs` |
| 打包分发 | `npm pack` 的 `files` 必须收录 `ui/dist`（使用者不需要构建环境）；`ui/dist` 仍进 `.gitignore`（可再生产） |
| 依赖白名单（封顶） | `vite`、`@vitejs/plugin-react`、`react`、`react-dom`、`tailwindcss`、`postcss`、`autoprefixer`、`@radix-ui/react-dialog`、`@radix-ui/react-tooltip`。超出需你确认 |
| 零 CDN | 字体/图标/脚本一律本地，禁用任何外链（含 Google Fonts） |

### 11.3 新增风险与对策

| # | 风险 | 对策 |
|---|---|---|
| R7 | 供应链面：传递依赖大量进入 `devDependencies` | 锁文件 + `npm ci`；M5 跑 `npm audit --omit=dev`（运行时为空，预期无运行时漏洞面） |
| R8 | `ui/dist` 与 `ui/src` 不同步：改了源码忘 build，服务静默跑旧产物 | `GET /api/health` 返回 `ui:{ builtAt, stale:boolean }`（对比 `ui/src` 最新 mtime），`stale:true` 时 UI 顶部显示氧化橙警示条 |
| R9 | Radix 默认样式/a11y 行为与 §1.5 视觉打架，做出「默认库长相」 | Radix 只买行为（focus trap、portal、aria），所有视觉由 Tailwind + token 覆盖；S1 阶段用 `tokens-preview` 页先确认没有库自带长相 |

### 11.4 工期影响

M2 从 1 个里程碑变 2 个阶段，实际工期预计翻倍；M5 增加构建产物与 `npm ci` 校验。**M0/M1 不受影响**（纯 Node 层，与前端选型解耦——这正是先做 M0 抽离的价值）。

---

## 12. M0–M1 实施记录（全部为实跑证据）

### 12.1 M0 验收

| 验收项 | 实际命令 | 实际结果 | 标签 |
|---|---|---|---|
| 语法 | `node --check lib/driver.mjs` / `feishu-export.mjs` / `lib/jobs.mjs` / `server.mjs` / `test/server.test.mjs` | 全部 OK | 已验证 |
| 自检 | `node selftest.mjs` | `tests 11 / pass 11 / fail 0` | 已验证 |
| `--help` 契约 | `diff <(改动前) <(改动后)` | **逐字一致**，exit 0 | 已验证 |
| 无参契约 | 同上 | **逐字一致**，exit 1 | 已验证 |
| 真实导出产物 | 同链接重导 + `diff` + 字节比对 | HTML/Markdown 除导出时间外**完全一致**；manifest 10 字段逐字段一致；**assets 13/13 字节级一致** | 已验证 |
| 依赖数 | `package.json.dependencies` | 不存在（零运行时依赖） | 已验证 |

### 12.2 M1 验收

| 验收项 | 实际命令 | 实际结果 | 标签 |
|---|---|---|---|
| HTTP 契约 | `node --test test/server.test.mjs` | `tests 22 / pass 22 / fail 0`（真 HTTP 非 mock；含 6 条独立审查回归用例） | 已验证 |
| SSE 事件链 | 同测试内含 `probe → assets → done → job:done` 断言 | 通过 | 已验证 |
| 真实链路（服务侧） | `node server.mjs --port 7812` + `curl` 创建任务并轮询 | `queued→starting→launch→cdp→job_url→navigate→probe→assets×2→blocks→render→write→done`；45 块 / 13 资源全命中；产物 HTML 10214B + MD + assets + manifest 落盘 | 已验证 |
| 预览接口 | `curl /preview/<标题>/<标题>.html` | `status=200 size=10214`（与磁盘字节数吻合） | 已验证 |
| 监听边界 | 契约测试断言 `server.address().address` | `127.0.0.1` | 已验证 |
| 串行不变量 | 契约测试「第二个任务在第一个结束前不会进入 running」 | 通过 | 已验证 |

### 12.3 实施中暴露并修复的 3 个真实缺陷（不是计划内条目，是实测撞出来的）

| # | 现象 | 根因 | 修复 | 证据 |
|---|---|---|---|---|
| 1 | 真实链路报 `TypeError: Failed to fetch`（原 CLI 复跑同样失败） | `waitForReady + sleep(2500)` 是**时序赌博**：导航刚完成时页面内 `fetch` 会被中断。诊断确认页面本身正常（title/cookie/fetch 手动测均 200），是死等窗口撞上导航尾流 | 新增 `waitForDocReady()` 就绪轮询（readyState + https + 正文非空 + 稳定期），并在 `captureDoc` 内加指数退避重试（700/1400/2800ms）。重试器必须写在函数体内，因为 `captureDoc` 是 `toString()` 注入页面独立执行的 | 修复前：CLI 与 server 两条链路均失败；修复后：两条链路均成功，且产物与修复前**逐字节一致** |
| 2 | 取消 `running` 任务不落终态，一直吊在 running | `cancel()` 只 `abort()`，依赖 runner 主动抛错；runner 不响应就永远 running | 取消时**立即**置 `cancelled` 终态，abort 只作为加速信号 | 契约测试「取消运行中的任务落到 cancelled」由 FAIL 转 PASS |
| 3 | 测试收尾每例额外 ~3s，总耗时 6744ms | keep-alive 连接使 `server.close()` 等待超时 | 测试收尾加 `closeAllConnections()` | 总耗时 6744ms → 878ms |

> 说明：缺陷 1 是**产品级 P1**（会让真实用户在页面加载慢时随机失败），不修则 M1 的"真实链路可用"验收无法成立。它不在原计划的 M4 清单里，我按"主动补位"规则在 M1 一并修了。

### 12.4 本轮新增/改动文件

| 文件 | 类型 | 说明 |
|---|---|---|
| `lib/driver.mjs` | 新增 | 编排层：`PROJECT_ROOT` / `findBrowser` / `isPortOpen` / `ensureBrowser` / `docIdOf` / `safeName` / `waitForDocReady` / `exportOne(onEvent)` / `CancelledError` / `ExportError` |
| `lib/jobs.mjs` | 新增 | 队列 + 状态机（queued/running/waiting_login/done/error/cancelled）+ `resumeLogin` + `toPublic` 脱敏 |
| `server.mjs` | 新增 | 零依赖 HTTP + SSE；仅绑 127.0.0.1；Host/Origin 校验；realpath 越界防护；256KB body 上限；URL 域名白名单；CSP/nosniff/no-referrer；`/api/health` 报告 `ui.{built,builtAt,stale}` |
| `test/server.test.mjs` | 新增 | 16 条契约测试（真 HTTP） |
| `feishu-export.mjs` | 重写 | 231 行 → 175 行薄壳：只做参数解析 + `eventToLogLines` + 打印；日志文本与改动前逐字一致 |
| `lib/capture.mjs` | 小改 | `client_vars` 请求加指数退避重试（4 次） |
| `package.json` | 小改 | 新增 `start` / `test` / `test:server` 脚本 |

### 12.5 本轮明确未做（按计划留给后续里程碑）

- `ui/` 前端工程与视觉层（M2，S1 基座 + S2 界面）
- 导出回执（M3）
- `render.mjs` 颜色白名单、`assets.failures[]`、资源下载 429 重试、负向用例固化（M4）
- README 两段式改写、`files` 白名单、`graft build`（M5）

### 12.6 遗留观察

- 真实导出耗时分布：`navigate` 约 5s（含页面加载）、资源批次约 20s（13 个资源 base64 回传）。这是 M2 UI 上传进度点阵的必要性依据，不是缺陷。
- 本次验证复用了 `.browser-profile` 中的有效登录态（`launched:false`），说明"登录态可复用"这条 README 承诺仍然成立。

### 12.7 独立代码审查（第 1 轮）

审查者：独立子代理（不继承我的结论、不看我写的过程）。结论是 **"不建议直接进 M2"**，共报 2 HIGH / 5 MEDIUM / 6 LOW。它的判断是对的：其中两条会在 M2 真实交互中必然触发。

**已修复（本轮，全部带回归用例）**

| # | 级别 | 问题 | 修复 | 回归用例 |
|---|---|---|---|---|
| 1 | **HIGH** | 取消后 driver 才走到 `waiting_login`，把已取消任务的状态改写成 `waiting_login` 并挂起 → `#current` 永不释放 → **整条队列永久死锁**。M2 决裁 D4 正好是"登录后点我继续"，触发面会扩大 | `jobs.mjs` 三处写状态处加终态守卫；`waitForResume` 在终态时立即 resolve 不挂起；`driver.mjs` 在 `waitLogin` 前补 `assertNotAborted` | 「取消后不再触发 waitForResume 复活任务，队列不死锁」 |
| 2 | **HIGH** | `serveFile` 的 `createReadStream` 无 `error` 监听：`statSync` 与 `open` 之间是 TOCTOU 窗口，一次竞态即 `uncaughtException` **打崩整个服务进程** | 改用 `stream.pipeline`（任一端出错双向销毁）；catch 块加 `res.headersSent` 判断 | 预览正常/越界用例 + pipeline 结构保证 |
| 3 | MEDIUM | 取消不打断 `waitForDocReady`，队列被白占最长 45s | 轮询每轮检查 `signal` | 由 #1 的用例覆盖该路径 |
| 4 | MEDIUM | 取消时 SSE 重复推 2 次 `job:done`（`.finally` 再 emit 一次）→ UI 会重复刷新 | `server.mjs` 用 `_donePushed` 去重（`toPublic` 不暴露该字段） | 「取消时 SSE 只推一次 job:done」 |
| 5 | MEDIUM | **实现与 §2.3/§2.4 契约不一致**：`launch` 缺 browser/profile/reused、`assets` 用 accumulated、`job_url`/`slow_page` 未登记、health 缺 browser、`opts.out/browser` 被静默丢弃 | 代码对齐；契约文档补齐并明确"error 由队列层生成"、"out/browser 由启动参数决定" | 「health 含 browser 字段」「assets 使用 done」 |
| 6 | MEDIUM | 全局 `script-src 'self'` 屏蔽了导出 HTML 的内联脚本 → **经服务预览时目录滚动高亮与外链 target 全部失效**（双击本地文件打开正常） | `/preview/*` 单独放行内联脚本，其它路由不放行 | 「预览路由 CSP 放行内联脚本，其它不放行」 |
| 7 | MEDIUM | `.pipe(res)` 在客户端中断时不销毁源流 → 文件句柄泄漏（M2 的 iframe 预览会高频触发） | 同 #2 改 `pipeline` | 结构保证 |
| 8 | MEDIUM | 同步抛错的 runner 直接 `uncaughtException` + `#current` 永不释放 | `Promise.resolve().then(() => this.runner(...))` 包一层 | 「runner 同步抛错不会打崩进程，队列继续」 |
| 10 | LOW | `readBody` 未处理 `'close'`，客户端中途断开会让 Promise 永不落地 | 加 settled 标记 + `close` 监听 | 结构保证 |

**未修（已登记，进 M4 待办）**

| # | 级别 | 问题 | 处理 |
|---|---|---|---|
| 9 | LOW | POST 不校验 `Content-Type`（CSRF 目前靠 Origin 单点兜底） | M4 追加 `application/json` 校验 |
| 11 | LOW | 任务表与 SSE 负载无上界（单任务 N 事件 → 传输 O(N²)） | M2 动 UI 前定任务保留策略 |
| 12 | LOW | 取消窗口落在 `render`/`write` 时产物已落盘但 `result` 被丢弃 | M4 明确为已知语义并写入 README |
| 13 | LOW | `/api/health` 硬编码探测 9222 | 随 M4 统一到可配端口 |

**审查者实测的安全结论**（证据来源：独立审查代理实跑攻击用例，非我本人复现）

- URL 白名单对 `evil-feishu.cn`、`feishu.cn.evil.com`、`a.feishu.cn.evil.com`、`feishu.cn@evil.com`、全角字符、`\u0000` 注入、反斜杠变体 —— **全部拒绝**。
- `resolveInside` 对 junction 指向 `C:\Windows`、三重 URL 编码、`..%5C` 反斜杠穿越、盘符绝对路径、UNC、NTFS ADS（`:: $DATA`）—— **越界全部落到 404**，realpath 二次校验有效。
- `hostAllowed` 要求端口与实际监听端口**精确相等**，`Origin: null` 被拒 —— DNS rebinding 与跨站 fetch 均挡住。

> 这一轮审查的价值：我自己的 16 条测试全绿、产物逐字节一致，但**仍然漏了 2 个 HIGH**。测试全绿不等于没有问题，这也是我在 M2 之前坚持走独立审查的原因。

---

## 13. M2 + M3 实施记录（真实浏览器验证）

### 13.1 交付物

```
ui/
├── index.html / vite.config.js / tailwind.config.js / postcss.config.js
├── src/main.jsx
├── src/App.jsx                    三段式布局（01 投入 / 02 队列 / 03 产物）
├── src/features/Submit.jsx        链接输入 + 选项 + 校验
├── src/features/JobList.jsx       状态点 + 四格阶段点阵 + 取消/继续
├── src/features/Receipt.jsx       回执 + 预览 iframe
├── src/features/receipt-model.js  纯函数（可 node:test 直测）
├── src/hooks/useJobs.js           SSE 订阅 + 断线兜底刷新
├── src/dev/TokensPreview.jsx      #tokens 自查页
└── src/styles/tokens.css + app.css
```

构建产物 gzip：CSS `3.65KB` + JS `52.6KB` = **约 56KB**（预算 180KB）。

### 13.2 真实浏览器验证（Playwright，实跑）

| 检查项 | 结果 | 标签 |
|---|---|---|
| 空状态 | 三段区块 + 两处空文案，导出按钮 disabled | 已验证 |
| 错误态 | 非法域名提交 → 服务端 400 → 界面显示中文原因 | 已验证 |
| 真实导出 | 45 块 / 12/13 资源，队列四格依次点亮，`done` | 已验证 |
| 回执 | 判定「**存在缺口**」（因 190MB 被跳过），字段与 manifest 逐项对齐 | 已验证 |
| 预览 iframe | 目录高亮脚本执行（`active=1`）、图片按视口懒加载 | 已验证 |
| console | **0 error**（仅 1 条已知 sandbox 提示 warning） | 已验证 |
| 响应式 | 320 / 375 / 768 / 1024 / 1440 **全部无横向溢出** | 已验证 |
| 键盘 | textarea → 2 个 checkbox → 按钮 → 2 个链接，**焦点环均 2px solid** | 已验证 |
| 设计 token | 计算样式实测 `--paper #f2efe6` / `--signal #d64518` / 蓝图栅格 / Newsreader | 已验证 |

### 13.3 实施中发现并修复的 3 个真实缺陷

| # | 现象 | 根因 | 修复 |
|---|---|---|---|
| 1 | 预览 iframe 里目录高亮失效，控制台报 `Blocked script execution … 'allow-scripts' permission is not set` | 上一轮只修了服务端 CSP，**iframe 的 sandbox 属性未给 allow-scripts** | 对照实验后定 `allow-scripts allow-same-origin`（只给 allow-scripts 时图片仅 2/11），理由与安全边界写入代码注释与 CHANGELOG |
| 2 | 320px 视口横向溢出 230px | grid 隐性单列的列宽被子元素 `min-content` 撑到 530px | 显式 `grid-cols-1` + 子项 `min-w-0` |
| 3 | 回执标签与数值横向跨度过大 | 回执撑满右栏（约 740px） | 收窄到 `max-w-[620px]`，更像票据 |

### 13.4 已知限制（不修，已披露）

- iframe 焦点环在 Chrome 下 CSS 无法生效（`:focus` / `:focus-visible` 对 iframe 都不触发）→ 键盘用户用「新标签打开」。
- 内嵌预览图片按视口懒加载，长文档需滚动。
- 任务串行。

---

*本文档所有代码事实均来自 2026-10-24 对 `HEAD=20fda93` 的实际读取与实跑；未运行的内容已逐条标注 `待验证`。*
