# NOTICE

本仓库是上游项目的**派生作品（derivative work）**，整体按 GNU GPL-3.0 发布。
`core/profile-schema.js`、`core/matching.js`、`core/matcher.js`、`dom/scanner.js`、
`dom/filler.js`、`dom/safety.js` 由本项目独立编写实现，但其设计思路部分取自下表所列的上游模块
（见下方"具体借鉴关系"）——因此不声称这些文件与上游无关。

以下部分参考或取自上游开源项目，遵循 GNU GPL-3.0：

- 上游项目：AI Resume Form Filling Assistant（1lck/AI-Resume-Form-Filling-Assistant）
- 上游提交：`76c052d254da0b668ea1af9a1a2eb247dd3e62f8`（2026-09-05）
- 上游许可证：GNU GPL-3.0（见 `LICENSE`）

具体借鉴关系（均为思路借鉴 + 独立重写，未逐行复制源码）：

| 本项目位置 | 借鉴自上游 | 说明 |
|---|---|---|
| `core/matching.js` 的 `normalize/core/signals` | `shared/field-text.js` | 标签归一化与候选打分思路；此处新增简繁映射、全半角、CJK 二元组、缩写扩展 |
| `dom/filler.js` 的写后回读判定 | `shared/fill-runtime.js` | "填完读回比对"与只读日期控件的值归一；此处改为带容忍度的 `tolerant()` |
| `core/profile-schema.js` 的分段式简历 schema | `shared/resume-schema.js` | 分组 + 列表槽位的建模方式；字段集合为面向国内/国企/港企场景重写并扩充 |
| 三种填充模式（整页 / 增量 / 选区） | 上游 README 描述 | 目前实现整页与增量，选区模式待补 |

`libs/pdfjs/` 目前**尚不存在于本仓库**。若后续接入 PDF 简历解析，将复用上游打包的 pdf.js，
届时受其原始 Apache-2.0 许可约束，并在本文件补充其版本号、来源路径与许可正文位置。

## 许可义务（GPL-3.0 §5 对应说明）

- 本仓库自身就是完整源码（无构建步骤、无二进制依赖），获取地址见 `UPSTREAM.md` 与本仓库远端地址；
  分发任何安装包/压缩包时，必须同时给出对应 commit 的源码获取方式。
- 保留 `LICENSE`（GPL-3.0 正文）、本 `NOTICE`（修改说明与借鉴关系）、`UPSTREAM.md`（上游版权与基线 commit）。
- 对外分发（发布公开仓库、分享 .zip、上架商店）即触发分发义务；仅本地自行使用不构成分发。
