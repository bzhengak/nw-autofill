# 上游与派生关系

- 上游仓库：https://github.com/1lck/AI-Resume-Form-Filling-Assistant
- 锁定基线 commit：`76c052d254da0b668ea1af9a1a2eb247dd3e62f8`（2026-09-05，GPL-3.0）
- 上游基线状态：184 stars / 34 forks / 3 位贡献者 / 自带 `node --test` 与 GitHub Actions

## 为什么不直接 merge 上游源码

上游是扁平结构（`content.js` + `shared/*.js` + `popup.js`），且核心匹配走"AI 映射 + 缓存"路线。
本项目的目标是**本地词典优先、AI 只在卡住时兜底**，并且要让匹配逻辑可单测、可量化命中率，
因此重建了目录分层：

```
core/   纯函数（无 DOM、无 chrome API）→ node --test 直接覆盖
dom/    页面扫描、写入、安全闸门
ui/     侧边栏
background/  MV3 service worker
tools/  评测与后续 E2E
test-forms/ + tools/expected/  仿真表单与判分标准
```

上游源码保留在 `.reference/upstream/`（已 gitignore，不随分发），仅用于对照设计。
借鉴对应关系见 `NOTICE.md`。

## 明确从上游"没有"到"有"的能力

1. `core/matching.js` 的 Kuhn-Munkres 全局最优分配（上游为逐字段独立取最高分，会串位）
2. 简体中文 / 繁体 / 英文三语标签归一与别名词典
3. 章节归属识别（headingBefore），避免 work / internship / family 之间漂移
4. 写后回读校验 + 三态标注 + 一键回滚
5. `dom/safety.js` 提交闸门（`form.submit()` 劫持 + 点击白名单）
6. 仿真表单 + 判分标准 + 命中率量化（上游无此闭环）
7. 面向国企/银行（政审、档案、家庭成员）与港企（工作许可、担保、薪酬）的字段超集

## 尚未做（后续阶段）

- P1：Markdown / PDF 导入（上游有 pdf.js 打包可复用）
- P2：Element UI / Ant Design / Moka 真实控件适配，附件上传可行性结论
- P3：混合 AI 兜底与 Key 安全
- P4：Playwright E2E、report/dashboard、adapter 导入安全约束
