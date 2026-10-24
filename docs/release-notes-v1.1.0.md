# Release Notes · v1.1.0

> 本篇同时是 GitHub Release 的正文来源。Tag `v1.1.0` 已推送；Release 因本机无 `GITHUB_TOKEN` 未自动创建，
> 可用文末命令补发。

## 一句话

把「少导了内容」从静默失败改成必须被看见。

## 为什么

此前工具能跑、产物好看，但 `lib/render.mjs` 的 `default` 分支在块既无 `text` 又无 `children` 时直接返回空字符串——视频、电子表格、多维表格、思维导图静默消失；而 `manifest.blockCount` 统计的是**输入块总数**，反而给出了「很完整」的假象。

## 新增

- `manifest.json`：`renderedBlocks`、`unsupportedTypes`、`degradedCount`、`renderErrors`、`danglingRefs`、`truncated`、`pagesFetched`、`warnings`；`assets` 增加 `skipped`
- CLI `--max-asset-bytes <n>`：单资源体积上限（默认 128MB）
- CLI 完成前的 `⚠` 告警：未支持块 / 渲染失败块 / 降级块 / 超大跳过资源 / 缺失资源 / 悬空子块引用 / 分页截断
- 视频与音频块（`media`）纳入资源下载
- 41 条回归用例（`render` / `capture` / 本地服务契约），全部无需浏览器与网络

## 行为变更

- 未支持块输出显式占位 `［未支持块：type］`（HTML + Markdown），带 `data-token`
- 单块渲染异常被隔离为 `［渲染失败块：type / id］`，不再炸掉整篇
- 悬空子块引用与「块缺 data」不再静默过滤，记入 `danglingRefs` / `unsupported`
- `todo` 渲染为 `☐/☑`；`heading6`–`heading9` 渲染为 `<h6>`
- 资源分批只回传本批新增（原为全量重复回传，O(n²)）
- 分页达 200 页上限时标记 `truncated`
- 参数缺值/非法以中文提示退出，退出码 `2`
- `--help` 增加完整选项段

## 修复

- **CDP `send` 定时器泄漏**：原来只注册不清理，导出跑完后进程仍要等 180 秒定时器到期才退出（表现为「日志已完成但终端不返回」）。现在 `unref()` + settle/close 时 `clearTimeout()`。
- **`manifest.assets.missing` 恒为 `[]`**：探查调用传 `[]`，而代码只在 `chunkIndexes === null` 时返回资源清单。现在三态语义明确：`null` = 探查（返回清单不下载）、`[]` = 不做事、数组 = 下载指定批次。
- **`engines.node` 与全局 `WebSocket` 不符**：改为 `>= 22`，并在模块加载时探测，Node 20 会得到可执行提示而非 `ReferenceError`。
- **`safeName('..')` 可越出 `out/`**：纯点号标题回退 `untitled-<docId前8位>`，输出目录追加越界校验。
- 资源文件名处理 Windows 保留名与超长名；ZIP 容器按字节嗅探补 `.zip`。

## 破坏性变更

| 项 | 影响 | 应对 |
|---|---|---|
| `engines.node` `>=20` → `>=22` | Node 20 用户启动即报错 | 升级 Node，或 `node --experimental-websocket` 运行 |
| 单个附件 `>128MB` 默认跳过 | 大附件不再默认导出 | `--max-asset-bytes 209715200` + `--max-old-space-size=2048`（实测 190MB / 约 30 秒） |
| `--help` 输出变长 | 若有人比对 help 文本 | 信息增量，无功能破坏 |

## 验证

```bash
node selftest.mjs     # tests 11 / pass 11 / fail 0
node --test           # tests 41 / pass 41 / fail 0
```

真实导出 5 次（含 190MB 附件）：

| 场景 | 结果 |
|---|---|
| 默认上限 | 12/13，`⚠ 超大资源跳过 1 个（191MB…）`，`missing: []`、`skipped: [1]` |
| `--max-asset-bytes 209715200` + 2GB 堆 | 13/13，`real 0m29.7s`，`RG-WorkSpace_V2.2_R1.5_Setup.zip` 199754226 字节完整落盘 |
| 正常文档零噪声 | `unsupportedTypes: {}`、`danglingRefs: []`、`renderErrors: 0` |

## 仍未做

- 本地 Web 工作台前端（`ui/`）：`GET /` 返回 503 与构建提示，服务端骨架已在
- `sheet` / `bitable` / `mindnote` 等块类型：仅占位，不采集
- 同名文档批量导出会覆盖同一目录（已知限制，README 已披露）

## 补发 Release

```bash
GITHUB_TOKEN=<你的 token> curl -sS -X POST \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/lza6/Feishu-Docs-local/releases \
  -d "{\"tag_name\":\"v1.1.0\",\"name\":\"v1.1.0 诚实性与健壮性\",\"body\":$(node -e "process.stdout.write(JSON.stringify(require('fs').readFileSync('docs/release-notes-v1.1.0.md','utf8')))")}"
```
