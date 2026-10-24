# 飞书文档一键导出（离线版）

把飞书云文档（`/docx/` 链接）一键转成本地可离线阅读的 HTML + Markdown，图片/白板/附件全部本地化。

**零第三方依赖**：只用 Node（**>= 22**）内置能力 + 本机已装的 Chrome/Edge，通过 CDP 驱动，不需要 `npm install`。

> **Node 版本**：`lib/cdp.mjs` 依赖全局 `WebSocket`（Node 22 起稳定）。Node 20 需以 `node --experimental-websocket` 运行，否则启动时会直接给出可执行提示，而不是抛 `ReferenceError`。

[![selftest](https://github.com/lza6/Feishu-Docs-local/actions/workflows/selftest.yml/badge.svg)](https://github.com/lza6/Feishu-Docs-local/actions/workflows/selftest.yml)

---

## 快速开始

```bash
# 1) 直接跑（会自动拉起一个专用浏览器实例）
node feishu-export.mjs "https://your-tenant.feishu.cn/docx/AbCdEf12345"

# 2) 需要登录才能看的文档
node feishu-export.mjs "https://your-tenant.feishu.cn/docx/AbCdEf12345" --wait-login

# 3) 批量导出
node feishu-export.mjs "链接1" "链接2" "链接3" --out ./out

# 4) 指定浏览器 / 复用你自己的登录态目录
node feishu-export.mjs "链接" --browser edge --profile "C:/my-chrome-profile"
```

输出结构：

```
out/<文档标题>/
├── <文档标题>.html     ← 双击即看：左侧目录 + 滚动高亮 + 图片已本地化
├── <文档标题>.md       ← Markdown，便于检索/喂给 AI
├── assets/             ← 图片、飞书画板（静态导出）、附件
└── manifest.json       ← 抓取元数据（来源链接、导出时间、块数、资源数），可作证据链
```

### 自检（不需要浏览器、不需要网络）

```bash
node selftest.mjs        # 等价 npm run selftest
```

用 Node 内置 `node:test` 覆盖纯逻辑：飞书富文本 `attribs` 解码、资源扩展名嗅探（白板接口标 png 实为 jpeg 的情况）、`block_map` → HTML/Markdown 渲染、资源落盘，以及**未支持块占位、单块容错、资源三分类、分页截断**。

```bash
npm test                 # = node --test（跑 test/ 全部用例） + node selftest.mjs
```

当前规模：`test/` 39 条（`render` / `capture` / 本地服务契约）+ `selftest.mjs` 11 条，全部不需要浏览器与网络。抓取层用例通过 mock `window` / `document` / `FileReader` / `fetch` 在纯 Node 下直接执行 `captureDoc`。

---

## 参数

| 参数 | 说明 | 默认 |
|---|---|---|
| `--out <目录>` | 输出根目录 | `./out` |
| `--port <端口>` | CDP 调试端口，端口已开则直接复用 | `9222` |
| `--browser <name>` | `chrome` / `edge` | 自动探测 |
| `--profile <目录>` | 浏览器用户目录（登录态可复用） | 工具目录下 `.browser-profile` |
| `--wait-login` | 打开页面后等你登录完再回车抓取 | 关 |
| `--no-md` | 不生成 Markdown | 关 |
| `--keep-open` | 结束后不提示关闭浏览器 | 关 |
| `--max-asset-bytes <n>` | 单个资源体积上限（字节）。超限不下载，记入 `manifest.assets.skipped` 并打印告警 | `134217728`（128MB） |

参数错误（缺值、端口非数字等）会以中文提示退出，退出码 `2`，不会再抛裸 `TypeError`。

---

## 目录结构

```
feishu-export.mjs   CLI 入口：解析参数、把进度事件翻译成日志、打印结果
lib/driver.mjs      导出编排层（CLI 与本地服务共用），产出结构化进度事件
lib/cdp.mjs         极简 CDP 客户端（连接/复用浏览器、发命令、监听）
lib/capture.mjs     走飞书数据接口分页取全量块、按 token 取资源
lib/render.mjs      富文本 attribs 解码 + HTML/Markdown 渲染 + 资源落盘
lib/jobs.mjs        任务队列与状态机（供本地服务使用）
server.mjs          本地 Web 工作台服务（零依赖 HTTP + SSE，仅监听 127.0.0.1）
selftest.mjs        纯逻辑自检（node:test，不需要浏览器/网络）
test/               缺陷回归用例（render / capture / 本地服务契约）
probe-page.mjs      调试工具：连上已在 9222 端口开着的浏览器，打印页面标题/正文摘要并截图
```

`probe-page.mjs` 用法（排查“取不到内容”时很有用）：

```bash
node feishu-export.mjs "链接" --keep-open      # 先让浏览器停在 9222 端口
node probe-page.mjs "https://your-tenant.feishu.cn/docx/xxx" shot.png
```

---

## 原理（为什么不用爬 DOM）

飞书文档页是**虚拟滚动**渲染：滚动时只保留视口附近几十个块，直接抓 DOM 只能拿到一小段，且表格合并、代码块、行内样式都会丢。

本工具改走文档自身的数据接口：

1. `GET /space/api/docx/pages/client_vars?id=<docId>&mode=7&limit=239[&cursor=...]` 分页取全量块（`block_map` + 结构树 `children`）；
2. 按 token 取资源：
   - 图片 `GET /space/api/box/stream/download/preview/<token>/?preview_type=16`
   - 飞书画板 `GET /space/api/file/f/cdp-whiteboard-<token>~noop/`
   - 附件 `GET /space/api/box/stream/download/all/<token>/`
3. 本地解码飞书富文本 `attribs`（36 进制游程 + apool 属性表），还原加粗/高亮/行内代码；
4. 渲染成独立 HTML + Markdown。

因为走的是浏览器自己的会话（Cookie 自动带上），所以**不需要任何 App ID / Secret / Token 配置**。

---

## 导出完整性（manifest 是证据，不是装饰）

`manifest.json` 同时记录三个不同口径的数字，避免用单一"块数"暗示内容完整：

| 字段 | 含义 |
|---|---|
| `blockCount` | 接口返回的输入块总数 |
| `renderedBlocks` | 真正渲染出内容的块数——小于 `blockCount` 就说明有块没导出 |
| `unsupportedTypes` | 未支持块类型分布，如 `{"media": 2, "sheet": 1}` |

同时保证：

- **未支持块不静默丢弃**：正文里输出显式占位 `［未支持块：media］`（HTML 与 Markdown 都有），并带 `data-token` 便于追查来源。
- **渲染失败块隔离**：单块异常只影响它自己，输出 `［渲染失败块：type / id］`，不会让整篇导出失败。
- **资源三分类且互斥**：`assets.saved`（成功落盘）、`assets.missing`（下载失败）、`assets.skipped`（超过体积上限主动跳过）。旧版本 `missing` 恒为 `[]` 的问题已修复。
- **悬空引用可见**：`danglingRefs` 记录「某块的 children 指向了 `block_map` 里不存在的块」的情况（接口少返回块 / 分页截断）。原实现会把这类引用直接过滤掉，正文里毫无痕迹；现在会记入 manifest 并触发 `⚠` 告警。
- **分页截断可见**：`truncated: true` 与 `pagesFetched` 说明文档超过单次分页上限。
- 一旦出现上述任一情况，CLI 会在结束前打印 `⚠` 告警行，例如：

  ```
  ⚠ 超大资源跳过 1 个（191MB，超过 128MB 上限；需要时用 --max-asset-bytes 放开）
  ```

---

## 已知限制

- **白板**导出为静态图，不可交互（原文档里可拖拽缩放）。
- 评论、@提醒、文档内嵌的第三方 iframe（如多维表格视图）不在导出范围内。
- **未支持的块类型**（`sheet`、`bitable`、`mindnote`、`diagram`、`synced_block`、`isv` 等）不导出内容，但会在正文留下 `［未支持块：type］` 占位并在 `manifest.unsupportedTypes` 中统计——不会静默消失。视频/音频（`media`）已支持下载。
- **超过 128MB 的单个资源默认跳过**（避免 base64 回传撑爆 Node 堆），记入 `assets.skipped`。需要时用 `--max-asset-bytes 209715200` 放开，并建议同时提高堆上限（`node --max-old-space-size=2048`）。实测 190MB 附件在 2GB 堆下约 30 秒可正常导出。
- 需要登录的文档必须加 `--wait-login`；首次登录后 profile 会记住会话。
- 导出后与云端**无同步关系**，原文档更新需重新导出。
- 仅用于导出**你有权限访问**的文档，请遵守所在组织的资料外发规定。
- **同名文档会落到同一目录并被覆盖**：输出目录名取文档标题，批量导出两篇同名文档时后一次会覆盖前一次（`assets/` 也不清理旧文件）。实测复现。需要保留多份时请分批用不同的 `--out`。

---

## 验证记录

在某企业内部一份 10 万字文档上实测（983 个内容块 / 57 张图 + 5 个白板 + 2 个附件）：

| 检查项 | 结果 |
|---|---|
| 内容块 | 983（与文档一致） |
| 图片/白板 | 57/57 渲染成功，0 损坏 |
| 表格（含合并单元格） | 4 个正常 |
| 代码块 | 29 个正常 |
| 侧边目录 | 70 条，滚动高亮正常 |
| 附件 | `cfg_data.py`、`testbed.yml` 可下载 |
| 离线性 | 断网后仍可完整阅读 |

---

## 常见问题

**Q：提示「未取到内容」**
A：多为未登录或文档无权限。加 `--wait-login`，在弹出的浏览器里登录、等正文出现后回车。

**Q：端口 9222 被占用**
A：说明你已有一个开调试端口的 Chrome，工具会直接复用；也可 `--port 9333` 换一个。

**Q：图片是 0 KB / 打不开**
A：检查是否有代理拦截 `feishu.cn` 的 `/space/api/` 请求；工具依赖浏览器会话直连租户域名。

---

## 许可证

[MIT](LICENSE)。
