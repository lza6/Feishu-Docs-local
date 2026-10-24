# Changelog

本文件记录对外可见的变化。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

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
