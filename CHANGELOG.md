# Changelog

本文件记录对外可见的变化。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

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
