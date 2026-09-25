# NOTICE

本仓库的 `core/profile-schema.js`、`core/matching.js`、`core/matcher.js`、`dom/scanner.js`、
`dom/filler.js`、`dom/safety.js` 为本项目原创实现。

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

`libs/pdfjs/`（若后续启用）同样来自上游仓库内打包的 pdf.js，受其原始 Apache-2.0 许可约束。

## 许可义务

本仓库整体以 GNU GPL-3.0 发布。对外分发（含发布压缩包、公开仓库、分享给他人使用）时，
必须保留 `LICENSE`、本 `NOTICE`，并公开对应源码。仅在本地自行修改使用不构成分发。
