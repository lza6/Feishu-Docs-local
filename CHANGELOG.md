# Changelog

本文件记录对外可见的变化。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [1.2.0] - 2026-10-24

本地 Web 工作台（GUI）。导出引擎不变，新增一层可视化界面。

### Added

- `ui/`：Vite + React 18 + Tailwind 3.4 + Radix 的本地工作台，三段式布局（投入 / 队列 / 产物）。
  - 队列用 SSE 实时推进，四格阶段点阵（取块 / 资源 / 渲染 / 落盘），`waiting_login` 时出现「登录好了，继续」按钮（替代 CLI 的回车）。
  - **导出回执**：字段全部来自 `manifest.json`，直接标出「无缺口 / 存在缺口」，并逐条列出 `⚠` 原因。
  - 内嵌产物预览 iframe + 新标签打开 + 下载。
  - `#tokens` 路由是设计系统的自查页（色板 / 字阶 / 状态 / 三处动效）。
- `ui/src/features/receipt-model.js`：回执与完整性判定的纯函数，可在纯 Node 下测试。

### Changed

- `README` 顶部表述改为两段式：**导出引擎零依赖**，**工作台需构建一次**（构建依赖全在 `devDependencies`，运行时仍零依赖）。
- CI 仍不跑 `npm install`：`node --test` 只测引擎，`ui/` 不参与 CI。

### 设计取舍（有实测数据支撑）

- **iframe sandbox 用 `allow-scripts allow-same-origin`**：只给 `allow-scripts` 时，opaque origin 下 lazy 图片只加载 2/11，预览等于残废；加上后 8/11（其余在视口外，属正常懒加载）。理由是 iframe 不是本项目的安全边界——产物来自用户自己的文档、内容已 `esc()` 转义，真正的边界在服务端（URL 白名单 / Host-Origin 校验 / realpath / CSP / body 上限）。若将来支持"导出别人的文档给第三方预览"，必须重新评估。
- **动效只保留三处**（入槽 / 阶段点阵 / 产物揭示），`prefers-reduced-motion` 下全部归零。

### Known limitations

- 内嵌预览的图片按视口懒加载；iframe 焦点环在 Chrome 下无法用 CSS 显示。
- 工作台任务串行执行。

## [1.1.1] - 2026-10-24

收敛 `下一步改进指南` 里剩余的 P2 组，其中一条实为数据丢失。

### Fixed

- **同名不同文档互相覆盖（原 P2-9，实际是数据丢失）**：输出目录名取文档标题，批量导出两篇同名文档时后一个会静默覆盖前一个。现在会区分 `manifest.docId`——同一文档重导复用原目录并覆盖，不同文档落到 `<标题> (<docId前8位>)`；重导时一并清理旧 `assets/`，避免陈旧残留文件造成"看起来是全的"。
- **`--wait-login` 在非 TTY 环境永久挂起（原 P2-7）**：CI / 管道 / 重定向 stdin 下 `readline` 不会返回。现在检测 `stdin.isTTY`，立即报错退出（码 1），并提示改用 `--profile`。同时修正了此处会重复打印"建议加 --wait-login"的误导文案。
- **Markdown 表格丢失合并语义（原 P2-2）**：被合并覆盖的格子原来输出为空，读者无法区分"空"与"被合并"。现在输出 `↔` 占位并在表后附说明；HTML 侧 `colspan`/`rowspan` 不变。
- **Markdown 丢失斜体/下划线/高亮（原 P2-12）**：这三种行内样式此前只在 HTML 中还原。现在 Markdown 分别输出 `*x*`、`<u>x</u>`、`<mark>x</mark>`，与 HTML 能力对齐。

### Added

- `test/driver.test.mjs`：8 条用例覆盖 `safeName` / `assertInsideOut` / `resolveOutDir`（含"manifest 损坏时宁可多目录也不覆盖"）。
- `test/render.test.mjs` 增补 P2-2 / P2-12 用例。测试总数 41 → 51。

### 已知不修

- **P2-1 嵌套列表缩进**：实测确认 text 块作为列表项子节点时输出的 2 空格缩进是 CommonMark 合法的列表续行，不构成语义丢失，故不改（改动反而可能破坏既有结构）。

## [1.1.0] - 2026-10-24

**诚实性与健壮性**。核心变化：不再有任何"少导了内容却不告诉你"的路径。

### Added

- `manifest.json` 新增 `renderedBlocks`、`unsupportedTypes`、`degradedCount`、`renderErrors`、`danglingRefs`、`truncated`、`pagesFetched`、`warnings`；`assets` 增加 `skipped`。`blockCount`（输入总数）与 `renderedBlocks`（实际渲染数）并列，杜绝用单一块数暗示完整。
- CLI 参数 `--max-asset-bytes <n>`：单资源体积上限（默认 128MB），超限跳过并告警。
- CLI 完成前打印 `⚠` 告警：未支持块、渲染失败块、降级块、超大跳过资源、缺失资源、分页截断。
- `lib/driver.mjs`：导出编排层，CLI 与本地服务共用，产出结构化进度事件。
- `lib/jobs.mjs`、`server.mjs`：本地 Web 工作台服务（零依赖 HTTP + SSE，仅绑 `127.0.0.1`；前端 `ui/` 尚未实现，`GET /` 返回 503 与构建提示）。
- `test/render.test.mjs`、`test/capture.test.mjs`、`test/server.test.mjs`：39 条回归用例，全部无需浏览器与网络。
- 视频/音频块（`media`）纳入资源下载。

### Changed

- **未支持块不再静默丢弃**：正文输出 `［未支持块：type］` 占位（HTML + Markdown），并记录 token。
- **悬空子块引用不再静默过滤**：`children` 指向不存在的块时记入 `danglingRefs` 并告警（原实现直接 `filter` 掉，正文与日志都无痕迹）。
- **单块渲染异常不再炸掉整篇**：输出 `［渲染失败块：type / id］` 占位，其它块正常导出。
- `todo` 块渲染为 `☐/☑`；`heading6`–`heading9` 渲染为 `<h6>`，不再降级成普通段落。
- 资源分批回传只带本批新增项（原为全量重复回传，O(n²)）；单资源超限主动跳过。
- 分页达到 200 页上限时标记 `truncated`，不再静默截断。
- `--out`/`--port`/`--browser`/`--max-asset-bytes` 增加取值校验，错误以中文提示并退出码 `2`。
- `safeName` 拒绝纯点号标题并回退 `untitled-<docId前8位>`，输出目录额外做越界校验。
- 资源文件名处理 Windows 保留名（`CON`/`PRN`/`AUX`/`NUL`/`COM1-9`/`LPT1-9`）与超长名；ZIP 容器按字节嗅探补 `.zip`。
- `--help` 增加完整选项说明段。

### Fixed

- **`engines.node` 改为 `>= 22`**：原 `>= 20` 与全局 `WebSocket` 的实际要求不符；Node 20 下会抛 `ReferenceError`。现在启动时先探测并给出可执行提示（含 `--experimental-websocket` 方案）。
- **CDP `send` 的 180s 超时定时器泄漏**：原来只注册不清理，导出跑完后进程仍要等定时器到期才退出（表现为"日志已完成但终端不返回"）。现在 `unref` + settle/close 时 `clearTimeout`。
- **`manifest.assets.missing` 恒为 `[]`**：探查调用传 `[]` 导致资源清单从未返回。现在 `null` = 探查（返回清单不下载）、`[]` = 不做事、数组 = 下载指定批次，清单始终返回。

### Known limitations

- 超过 128MB 的单个附件默认跳过（可由 `--max-asset-bytes` 放开，建议同时提高堆上限）。
- `sheet` / `bitable` / `mindnote` / `diagram` 等块类型仍不导出内容，仅占位。
- 本地 Web 工作台前端（`ui/`）尚未实现。

## [1.0.1] - 2026-10-24

文档与工程化补充，无功能变更、无破坏性改动。

### Added

- `.github/workflows/selftest.yml`：每次 push / PR 在 Node 20 / 22 / 24 上跑 `node selftest.mjs` 与 `node feishu-export.mjs --help` 冒烟，零 `npm install`。
- `CHANGELOG.md`（本文件）、`.gitattributes`（文本规范化 + 二进制扩展名声明）。
- 计划书与台账：`计划书/本地Web工作台-GUI实施计划-v1.0.md`、`docs/计划书/下一步改进指南.md`、`project_specs.md`、`tasks/`。

### Changed

- `README.md`：补 CI 徽章、目录结构、`probe-page.mjs` 调试用法、「许可证」段落；验证记录改为泛指，不披露具体单位。
- `AGENTS.md`：说明 `graft/` 不随仓库提交，需本地 `graft build` 生成。

## [1.0.0] - 2026-10-24

首个公开版本。

### Added

- CLI `feishu-export.mjs`：一条命令把飞书 `/docx/` 文档导出为本地离线 HTML + Markdown；支持批量、`--wait-login`、`--browser` / `--profile` / `--port`。
- 走飞书文档自身的数据接口（`client_vars` 分页）取全量 block，绕开“虚拟滚动只渲染视口附近块”的限制。
- 图片 / 飞书画板 / 附件全部本地化，按文件头嗅探真实格式（飞书白板接口会标 png 实为 jpeg）。
- 富文本 `attribs` 解码（36 进制游程 + apool 属性表），还原加粗 / 斜体 / 删除线 / 下划线 / 行内代码 / 高亮 / 文字色。
- HTML 快照：侧边目录 + 滚动高亮 + 打印样式 + 表格合并单元格。
- `manifest.json` 记录来源链接、导出时间、块数与资源数，可作导出证据链。
- `selftest.mjs`：Node 内置 `node:test` 自检 11 项纯逻辑用例，不需要浏览器与网络。
- 文件内说明：`README.md` 含原理、参数、已知限制与验证记录；`AGENTS.md` 记录仓库上下文图谱用法。

### Known limitations

- 白板导出为静态图，不可交互；评论、@提醒、内嵌第三方 iframe（如多维表格视图）不在导出范围。
- 不提供 PDF 导出（仅会把附件中的 PDF 原样下载）。
- 导出后与云端无同步关系，原文档更新需重新导出。
