# 同类插件各环节对比（2026-10-02）

看的是**别人在每个环节怎么做**，不是比功能多少。来源都是一手：
[Bitwarden 浏览器端 autofill 常量文件](https://github.com/bitwarden/clients/blob/main/apps/browser/src/autofill/services/autofill-constants.ts)、
[TshyGO/resume-form-assistant-plugin 的 form-agent.js](https://github.com/TshyGO/resume-form-assistant-plugin/blob/main/form-agent.js)、
[MDN autocomplete 令牌表](https://developer.mozilla.org/en-US/docs/Web/HTML/Attributes/autocomplete)、
[WHATWG Autofill 规范](https://html.spec.whatwg.org/multipage/forms.html#autofill)；
另外两个是同赛道：我们的上游底座 1lck/AI-Resume-Form-Filling-Assistant（本仓库 NOTICE 记着 fork 关系）
与 OpenJobAutofill（隐私边界那条我们早就搬了）。

## 逐环节对比

| 环节 | 别人怎么做（可查证的） | 我们现在 | 差距 / 采纳 |
| --- | --- | --- | --- |
| 字段词汇 | 标准令牌表约 40 项，带 section-/shipping/home 修饰符；Bitwarden 为每个概念备两份名单（扫属性文本的 FieldNames + 只比属性值的 FieldNameValues）和一条**属性优先级序列** | 519 个槽位路径 + 一张别名大表，所有线索混成一个分数 | 建概念层（M3），沿用标准命名；每概念两份名单 + 优先级 |
| 含糊词 | Bitwarden 有显式 AmbiguousTotpFieldNames（code/pin/otp…），单独命中不定性 | 已补 AMBIGUOUS_WORDS（本轮），只命中弱词不许绿字 | 已采纳，继续扩到概念×控件 |
| 排除表 | 挂在概念上（PasswordFieldExcludeList、ExcludedAutofillTypes 含 radio/checkbox） | 全局一份 BLOCK_PATTERNS + M1 的 shapeOfControl 雏形 | 概念×控件相容表（M3），例如"电话概念不接受 radio" |
| 页面目的 | 先分类表单目的（FormPurposeCategories、RegistrationKeywords、StrongNonLoginKeywords、登录类标题短路） | 只有零散 site_search | 整页目的判定放最前（M3），判成非网申整页不动 |
| 重复记录组 | TshyGO 的 form-agent 专门管"要几行"：targetCounts 算资料里该域已有几条、collect 找**父级标题对得上的加号按钮**、execute 点加号生成空行并返回行作用域 | 我们只读已存在的行（occurrence 推断序号），从不加行 | **需要你单独授权**才可能采纳：点"添加一段经历"是对页面的新种类操作，你的边界一直是"不代点未授权控件"。默认不做，只把它列为开放选项 |
| 计划校验 | TshyGO 在 execute 前有 validatePlan 做**结构与算术检查**（数量对不对、步骤合不合法） | 我们有分档与缺口归因，但没有"资料 3 段实习 vs 页面 2 行"这种整页算术核对 | 采纳到 M4：映射表确认前先跑一次计划校验，行数不够要说在第几段 |
| 写入 | 各家都靠事件序列 + 框架兼容；Bitwarden 明确排除 hidden/file/button/search 等类型 | 我们有 setNativeValue + 事件序列 + 皮肤控件识别 + 回读 | 已是我们的强项；补"概念×控件"相容表即可 |
| 可解释与校验 | 浏览器实现不面向用户解释；密码管理器靠"哪个字段被填了"提示 | 回读只验字节；本轮加了证据集与形状体检 | 继续：每栏显示证据；改判可记住（M4） |
| 人工确认 UI | TshyGO 的 sidepanel-queue（任务队列 + 诊断面板）是我们排除的底座里最值得抄的界面形态；集成平台的映射表是"建议+置信+依据+改判+记住" | 只有一张结果表，改不了映射 | M4 按这个形态做 |
| 隐私边界 | OpenJobAutofill：AI 只见字段名不见取值 | 同条边界，另有两道确认闸（AI 地址 + 每站点）与逐值自检 | 保持；整页映射让请求体变大，M3 要重做压缩 |
| 站点规则 | Bitwarden 用 domain-specific 规则（数据不是代码） | adapters/*.json 已是同形状，且校验严格 | M4 把"用户改判"也写成这一层，可导出可撤销 |

## 综合后的下一步方案（顺序即优先级）

1. **M2 收尾（接线，1 步）**：`core/ledger.js` 已就位，接进扫描（字段指纹）、写入（记账）、存储（按 origin）
   与撤销（擦账）。它决定"能不能纠正我们自己写错的值"，且完全不碰新页面操作，风险最低。
2. **M3 概念层**：新 `core/canonical.js` —— 标准令牌 + 简历扩展概念；每概念带 FieldNames / FieldNameValues /
   属性优先级 / 概念×控件相容 / 排除表；槽位标注主概念与限定（name.person / name.educationalInstitution /
   name.organization / name.certificate）。`autocomplete` 命中升为确定性证据。识别从 519 选一降到约 60 选一，
   AI 与本地规则共用同一张表；**取值仍不出本机，最终槽位由本地白名单定**。
3. **M3.5 整页目的判定**：先判"这是不是网申表格"（登录/搜索/问卷/支付一律整页不动），把 Bitwarden 的
   FormPurposeCategories 思路搬过来；顺带解决"页面把简历字段和搜索框混在一起"那类误填。
4. **M3.6 档案补全**：跨块扫描收进标题边界内（学 TshyGO/Bitwarden 的"关键词扫描不跨 heading"）；
   国别/省份加值→码值规范化（学 IsoCountries/IsoStates）。这一步治你导出里 index 18/26 那种空档案。
5. **M4 映射表 + 计划校验**：一行一栏位（页面栏位 / 概念 / 槽位 / 依据 / 现状 / 改判），
   确认前跑一次算术校验（资料有 N 段、页面能容 M 行 → 差多少说清）；改判写入站点规则，下次同站直接命中。
6. **开放选项（要你点头才做）**：点"添加一段经历/教育"这类加号按钮，把资料里多出来的记录行铺出来。
   这是新的页面操作类别，按你定的边界我不擅自做；不做的话，超出行数的经历就一律留空并在映射表点名。

硬边界一条不改：不代提交、不代传附件、不碰验证码；取值不出本机；AI 不能造值；拿不准就留空并说清。
