# AI 取值对齐：让下拉选项按含义选中（2026-10-04 方案 → 同日实施）

触发：用户 2026-10-04 的两句 ——
①「Work permit 不是 yes/no，往往是选择在香港签证种类」；
②「我想按照我的想法进行 AI 放宽……性别、工作许可（选择签证类别）、最高学历等项的下拉选项，
可以看到我的个人信息内容，通过实际含义对齐实现下拉选择准确」，并要求先搜索实践参考、不确定的问、
最后他说做才开始。这份文件就是那"方案"，第 5 节是需要他拍板的四件事。

## 0. 先把现状说清楚（对着代码，不是回忆）

**AI 现在能看到：** 页面自己的全部文字。`core/ai.js` 的 `buildPageMapRequest()` 每一栏发
`label`（原始标签）、`kind`、`required`、`desc`（说明文字）、`section`（板块标题）、
`valueState`（empty/ours/site/user 四态词）、`options`（选项，形如 `文案=码值`）、`nearby`。
外加一份约 60 项的封闭概念清单。所以"页面信息和表格各项的文字和说明 AI 能不能看到"——**已经能看到**。

**AI 现在看不到：** 资料里的任何一个取值。两道机制保证：
构造上根本不拼值（只发槽位路径与中文显示名，见 `slotCatalog`），
运行时 `assertNoProfileValues()` 再把待发送文本与整份 profile 比一遍，命中即**拒发**；
`AI_FORBIDDEN_SECTION`（records / declaration）与 `AI_FORBIDDEN_KEY`
（`idNumber|passport|visa|credential|signature|consent|agree|salary|expect|criminal|background`）
把最不该进目录的槽位整个剔除。

**下拉选项今天是谁在挑：** 本地，不是 AI。`core/matcher.js` 的 `resolveOption(pageField, value)`
拿"我的值 + `VALUE_EQUIVALENTS` 中英对照表"去和页面选项文字比（相等 → 主干相等 → 包含 → 共享词元），
对不上就交人工。唯一能跨语言/跨形状硬对上的是 `adapter.optionRules`，
它是**逐条写死的** yes/no 两侧对照表（`core/adapters.js` 的 `NESTED_ALLOWED.optionRules`）。

**实测成绩（今天，判分语料 11 份表单）**：带选项的栏位 28 个，其中 26 个拿到了槽位、
**24 个本地就选对了选项**，只有 2 个对不上：

| 页面这一栏 | 我们的值 | 页面选项 | 为什么对不上 |
| --- | --- | --- | --- |
| 是否全日制 | `education.0.trainingMode = 全日制` | 请选择 / 是 / 否 | 题面问"是不是"，资料存的是"哪一种" —— 概念错位，字面永不相交 |
| how did you hear about this position | `intent.channel = 官网` | company website / careers fair / referral / others | 中英不等价，词典里少这一组 |

这两例正是放宽要解决的类：**页面用另一种问法说同一件事**。第二例其实补一组 `VALUE_EQUIVALENTS`
就够了，不需要 AI —— 这条判据后面还要用（能靠本地词典解决的，别开外发的口子）。

## 1. 先修被你说错的那层：work permit 不是 Yes/No

现在代码按 Yes/No 建模的痕迹有三处：`hkGlobal.needSponsorship` 是 `bool`；
`optionRules` 的形状被 `core/adapters.js` 卡死成 `{yes:[],no:[]}`；
`hkGlobal.visaType` 是自由文本 `text`，而且因为 `AI_FORBIDDEN_KEY` 里有 `visa`，
这一槽位**连进 AI 目录的资格都没有**。

真实情况（你说对了）：港企门户这一题通常是单选下拉，选项是**入境处那一套类别**。
按 [IMMD 的 visas/entry permit 一览](https://www.immd.gov.hk/eng/forms/hk-visas.html) 归出封闭词表：

- 雇佣/投资类：Top Talent Pass Scheme (TTPS)、General Employment Policy (GEP)、
  Admission Scheme for Mainland Talents and Professionals (ASMTP)、
  **Immigration Arrangements for Non-local Graduates (IANG)**、Technology Talent Admission Scheme (TechTAS)、
  New Capital Investment Entrant Scheme (New CIES)
- 居留类：Quality Migrant Admission Scheme (QMAS)、Dependants（受养人）
- 学习类：Students（学生标签，兼职受限）
- 再加三种不是"签证"的身份：香港永久性居民 / 香港居民 / 需雇主担保（needs sponsorship）

要动的（**全部本地，零新增外发**）：
1. `hkGlobal.visaType` 从 `text` 改成 `enum` + 新选项集 `O:visaCategory`，词表就是上面这套（中英都收，
   但**不写"我是 IANG"这种结论**，它只是候选项容器）。
2. `AI_FORBIDDEN_KEY` 里那条 `visa` 要拆细：它该拦的是证件号（`visa number`、`visaNumber`），
   不该把"签证类别"这种**页面选项的分类**整个隔在外面。改成 `visa.*number|idNumber|passport|…`。
3. `optionRules` 的 yes/no 形状**保留但不再够用**：新增"值 → 页面选项"的一侧多值形状之前，
   先看第 2 节的档 A 是不是更合适 —— 很可能不需要动这个形状。
4. 这一栏的写入档位保持"敏感 + 请核对"：选错签证类别等于在合规声明上说错话，
   按你的口径（敏感字段仍走黄字核对），**不因放宽而改成绿字**。

顺带一条边界：`basics.idType` 的枚举里没有"HKID / 护照"之外的港签证类别，不要把 `visaCategory`
塞进 `idType` —— 那两栏在港页上经常同屏出现（"Identification Type" / "Right to Work"）。

## 2. 「什么是自定义下拉」，以及要不要为这个方案新开授权

原生 `<select>` 的选项**在 HTML 里就写着**，扫描器直接读得到，不需要碰页面。
自定义下拉是**框架用 div 装的**：Element UI 的 `.el-select`、AntD 的 `.ant-select`、
以及 `role=combobox` 的那个 `<input readonly>` 或 `<a role=combobox>` ——
选项在点击之后才被框架渲染到 `<body>` 末端的弹层里（`dom/select-opener.js` 的 `LIBRARY_SIGNATURES` 就是干这个的）。
往这种框打字不会选中任何值，所以计划阶段就归 `custom_control` 拒填，而不是写了再报红。

它**早就有开关了**：`ui/sidepanel.html` 第 91 行「允许点开自定义下拉并选中（会真的点击页面控件）」
= `allowCustomSelect`，默认关。四条硬边界不因授权而放宽：只点 `dom/safety.js` 允许的元素、
选中后必须回读校验显示文本、否定词一律不认（`全日制` 绝不落进 `非全日制`）、
找不到"这次点击新出现的弹层"就收起并记 `panel_ambiguous`，一个选项都不点。

**所以：这个方案不需要你为"点开下拉"新授权。** 点开与不点开只决定"我们能不能读到选项"；
而你真正在问的是另一件事 —— **读到选项之后，让不让 AI 看见我的值**。两者正交，分开签。

一个必须记住的技术细节：整页映射请求在体积吃紧时会把选项削到 8 条甚至全删
（`buildPageMapRequest` 的 `caps` 三级降级 24 条 → 8 条 → 0 条，`AI_MAX_BYTES = 24000`）。
所以"认选项"这件事**必须按栏单独发请求**，一页几栏发几栏，不能塞进整页请求里顺手办。

## 3. 三档放宽（按隐私代价从小到大）

### 档 A —— 反向标注：AI 只给页面选项归类，我的值一个字节不出去（**推荐先做**）

发出去的是：这一栏的页面选项文字 + 一份**封闭代号集**（不是我的资料）。
AI 的活是把每个选项翻译成代号，例如 workAuth 一栏页面上写着
`Right of Abode Holder` / `Holder of IANG visa` / `Require visa sponsorship`，
它回 `PR` / `IANG` / `NEEDS_SPONSORSHIP`；回 `Other` 或不敢认就回 `null`。
落选项由我们本地做：新增 `core/value-tokens.js`（纯函数、可离线测），
一份写死的"资料取值 → 代号"表，把 profile 里的 `IANG（内地应届毕业生留港计划）` 折算成 `IANG`，
两边代号相同才写。**资料值落不进任何代号 → 交人工，不许"最接近的那个"。**

- 为什么它是这一类问题的正解：`是否全日制` vs `是/否`、`company website` vs `官网` 这种题，
  缺的是"页面这句英文/这个问法到底指哪个含义"的知识，而这个知识**页面上就有**，不需要我的隐私去换。
- AI 结构上不可能替我说错身份：它不知道我的身份，只在做文案归类。
  它能犯的错退化成"归类错"，而归类结果会逐条印在映射表上（"页面选项 → 代号 → 我们要写的值"），可改判、可存站点规则。
- 代价：要新增并维护 8 个概念左右的代号集与值→代号表；每加一个枚举槽位要记得登记，否则这一栏永远走人工。
  建议照现有做法加一条长期测试：**代号表里出现的值必须是 profile 里真存在的枚举项**（撞名/漏项直接红）。

### 档 B —— 代号外发：把"我是 IANG"这一句告诉它（一次往返，准确率更高）

请求里带上 `ourToken: "IANG"`，AI 直接在页面选项里挑那一项。
好处：能处理"同一栏两个选项都能对上 IANG，但一个指身份、一个指雇主安排"这种档 A 分不开的情形；
省一半往返。隐私代价：**"我持 IANG"这一条事实出本机**（但值不是原文、是封闭代号，
不构成可拼合的身份画像）。实现上 A 是 B 的子集，两者共用 `core/value-tokens.js`。

推荐形态：**A 先行、落选才对那一栏升 B**（升级动作在界面上明说：
"这一栏页面上有两项都像，需要把你的『IANG』这一项代号发给 AI 比对，是否继续"）。

### 档 C —— 白名单原文外发：真正意义的"AI 看到我的信息内容"

只有逐条白名单槽位允许原文值进请求（性别 / 工作许可身份 / 最高学历 / 培养方式 / 专业名称 /
学校名称 / 公司名称 / 职位名称 / 语言 / 证书名称…）；
身份证号、护照号、手机号、邮箱、住址、薪资期望、犯罪记录、任何声明勾选**永久排除**，
且这条例外要写进 `AI_FORBIDDEN_KEY` 而不是靠界面自觉。
`assertNoProfileValues` 要改成"对白名单槽位豁免、其余一律拦"——
**这一步把硬闸改成了带孔的闸，是三档里唯一改变安全模型的一条**，所以：
逐栏预览"这条要发出去的原文是 X"、发送清单进时间线日志、每站点一次授权 + 每次值清单确认。

我的判断：**C 先不做。** 它的收益只在"页面文案与我的说法毫无共同词、且档 A 也归不出代号"时才出现；
而判分语料里那一类只有 2/28。等真实站点跑出一批"档 A 救不回"的栏位，再拿那份清单来决定 C 白名单，
比现在凭想象给闸开门要好。（外部实践也都是这个顺序：egress 之前先 tokenize/redact，见第 6 节。）

## 4. 如果放行，实施顺序（不含档 C）

0. **度量**：先在真实导出（`unfilled-map`）里把"带选项且没选中"的栏位数出来，按原因分堆。
   判分集只有 28 栏太少，不能拿它当"这类问题不大"的证据。
1. 修签证类别建模（第 1 节 4 条）—— 纯本地。
2. 新增 `core/value-tokens.js`：封闭代号集 + 值→代号表 + `valueToToken` / `optionTokenByAiAnswer`，
   两个函数都"认不出返回 null"，不返回最接近项。
3. `core/ai.js`：新增 `buildOptionClassifyRequest()`（单栏、选项全量、代号清单封闭）与
   `parseOptionClassifyResponse()`（代号必须在封闭集内、只认本次发过的选项指纹，越界整条丢）。
   两道闸照旧跑 `assertNoProfileValues`（档 A 里没有值，闸门一行都不用改松）。
4. `core/matcher.js`：`resolveOption` 失败时，如果这一栏有 AI 代号且我们的值能折算成同代号 → 落该选项；
   来源标〔AI 认项〕、写入档位仍是 review（敏感栏）或 auto（非敏感栏），沿用 2026-10-02 的档位口径。
5. `core/mapping-table.js` / 侧边栏：多一列"页面选项 → 代号 → 我们要写的值"，
   每一处代词都要能被人看见并改判（改判仍走 `core/site-rules.js` 存成站点规则，下次不用重问）。
6. 可选档 B：只在"这一栏两个选项都落进同一代号"时逐栏问一次。
7. **验证**（沿用本仓库的测试分层规矩：装配层必须真跑）：装配层真跑一遍
   （假 chrome + 假 fetch 走 `nw:aiMapPage` → content.js → 映射表），
   新增断言逐条做"摘掉实现会红"检查，判分集补 3 例：港签证类别下拉、`是否全日制` vs `是/否`、
   `Master of Science` vs `研究型硕士`。`npm test` 与 `node tools/hit-rate.mjs` 必须全绿、越界 0。

预估：1–5 是一个里程碑（约 250–350 行实现 + 同量测试）；6 单独一步；7 每次都要走。

## 5. 四问与用户的答复（2026-10-04，已照此实施）

1. **取哪几档？** →「A和C都做，默认A，C勾选框选了就能用。」
   实施：档 A 是默认通路（零取值外发）；档 C 是「填写授权」里新增的
   **允许 AI 看取值认选项** 勾选框，勾了就可用，不做逐次确认（他原话："不用询问过多，点了勾选框就可以"）。
   档 B 被 C 吸收：既然允许发原文，就不需要再发代号，实现里只留 label / pick 两种任务。
2. **C 的白名单到哪一层？** →「除了身份证号和电话号、家人姓名和家人电话、还有姓名、单独的姓和名以外的，
   其他都可以白名单。」所以实现是**默认放开 + 硬排除清单**（`core/ai-security.js` 的 `VALUE_SHARE_NEVER`），
   加新字段不用改这段代码；被拦下的栏位一律**报出原因**，不静默丢（他的另一条口径）。
   清单之外还留着两条既有名单（`records`/`declaration` 整段、`AI_FORBIDDEN_KEY` 那批路径）：
   它们比他说的更少发，属"沿用"，但同样会逐条列在回包 `blocked` / `skipped` 里。
   邮箱、住址、微信号这三类**他没列**：微信号我自己加进了硬排除（它是可反查到人的把手，
   性质与电话同类）；邮箱本来按他的清单放开，但实施时加了"资料里标 sensitive 的一律不发"这条兜底，
   于是邮箱（与生日那类）也被拦下 —— 方向是少发，且逐条报原因（见 5c 的 C3）；要放开就改标记或改这一条。
3. **授权粒度** → 勾选框即授权，站点确认沿用既有那道（`aiSiteConsent`）；每次回答都回一份
   `valuesSent`（栏名列表，不含取值本身）显示在状态行里，"这次发了哪几栏"看得见。
4. **学历代号细到哪一层** →「学历不区分全日制等，那是另外的栏位。」
   实施：`degreeLevel` 空间只到 高中/大专/本科/硕士/博士/博士后/其他；
   全日制与否另成 `trainingMode` 空间（判分语料里那例「是否全日制 vs 是/否」正是它）。

## 5b. 实施记录与两处"每个函数都对、链是死的"（2026-10-04）

新代码：`core/value-tokens.js`（封闭代号集 + 值→代号，折不出/有歧义一律 null）、
`core/option-align.js`（请求构造 / 回答解析 / 本地折代号 / 落进 plan）、
`nw:aiAlignOptions`（后台唯一出网点，四闸一道不少）、映射表新增 `decision.aiOption` 与"需要选一项"的
`needsChoice` 列、侧边栏「认选项（下拉里该选哪一项）」一个按钮一次问。
签证类别按第 1 节改成枚举（`O:visaCategory`），`AI_FORBIDDEN_KEY` 的 `visa` 拆成 `visa.*number`。

装配层测试（`tests/option-align-bridge.test.js`）抓到两处纯函数测照不到的缺陷：

1. **后台在把 target 交出去之前就把 `ourValue` 抹成空串**（"档 C 没开就不该带着值"），
   于是档 A 本地折代号时永远拿不到值 → 每一栏都报 `no_token`，整条路是死的，
   而 `core/option-align.js` 的单元测试全绿（它自己造 target）。
   改法：`ourValue` 本地一直带着，**送不送出去由构造函数上的 `allowValues` 那道闸决定**，
   而回包里的 `valuesSent` 改从 `req.sharedPaths` 取 —— 否则它会把"本地有值"报成"已经外发"。
2. **大小写**：扫描器把 option 文案统一转小写，而 `expect` 从面板那一路过来可能是原文大小写，
   回找真选项整串相等判成 `option_gone`。这与 2026-10-02「Awarding Body vs awarding body」
   是同一类事故，同一族修法：比较一律归一化。

变异检查（把实现摘掉一条、看断言会不会红）跑了 7 条，全部会红：
档 C 的闸、后台的硬排除清单、清单外代号不接受、AI 不覆盖本地已认出的、合规声明类强制核对、
代号歧义时不猜、指纹撞车不写。其中第 5 条第一版**没红** —— 因为用例的起点已经是 `review`，
删掉强制核对那行结果不变；把起点改成 `auto` 之后才咬得住。这是"守卫被另一个条件替它过了"
那个老坑的第四次现身。



### 5c. 第三轮独立审查（同日）：3 Critical / 5 Important / 3 Minor，逐条判定

| # | 判定 | 内容 |
| --- | --- | --- |
| C1 | 改 | 模型在 label 任务里自己改口 `pick` 就能落笔 —— 协议由被问的一方决定，等于档 A 是假的。
     现在构造函数把 `askTask` 记在 target 上，任务不符一律 `task_mismatch` 丢弃。
| C2 | 改 | 体积削档后仍按**本地全量**校验下标：只发出 12 项时模型指第 15 项照样落成。
     现在把"这一栏实际发出去的那几条"记成 `sentOptions` 并按它校验；面板把削过档说出来。
| C3 | 改 | 硬排除清单漏了三类同性的东西：别人的名字（导师/汇报对象/推荐人整组）、各类编号（学号/证书号）、
     长正文（textarea 的工作内容/自述）。另加一条兜底：**资料里标了 sensitive 的栏位一律不发**，
     这比用户清单严（邮箱因此也不发），方向是少发且逐条报原因；要放开改标记即可。
| I4 | 改 | 取值自检的豁免集取自"本地带着 ourValue 的所有栏位"，等于把没勾档 C 的栏位也预先免掉。
     改成只免**真的进了请求体**的那几条（按 `sharedPaths`）。
| I5 | 改 | `expect` 来自映射表（文案裁到 40 字 + 省略号 + `=码值`），回找真选项时整串/前缀都比不中 →
     长文案的栏永远落不了笔，表现是"AI 认出来了、页面没动"。现在先按最后一个 `=` 切段再比。
| I6 | 改 | `visa` 拆细之后，概念映射与缺口兜底两条路可以**绿字**写签证类别 —— 与"合规声明保持核对"矛盾。
     新增 `aiTierFor()`，三处 AI 落地统一走它。
| I7 | 改 | 分屏之后四处提示还在说"去下面那一栏"，指的是另一屏：文案改为「资料与设置 → …」，
     AI 没配好那两句直接把第二屏切出来。
| I8 | 改 | 三段合成的诊断包里，另两段带 `currentValue`，用户原本能单独安全粘贴的那一段没有了。
     加一个「只出映射表（这一段保证无取值）」出口。
| M9 | 改 | `flags.includes('S')` 把 `O:paperStatus` / `O:gradStatus` 误判成敏感（标记位改成按段取）。
     这条不只是洁癖：C3 与 I6 的判据都建在这个位上。
| M10 | 改 | `<select multiple>` 的 `multi` 标记只在 checkbox 形状上为真，AI 挑一项会清空用户其他选择：
     加 `f.el.multiple` 一条 refusal。
| M11 | 不改 | `OPTION_SETS` 的整串豁免对所有 AI 路径生效。它只让自检**少报**，不产生任何外发；
     换成逐请求传参只会漏传。已在 core/ai.js 的注释里写明这条豁免的适用面。

教训两条：① **测试不许 `if (!x) continue`** —— 上一版的硬排除用例就是这么把"路径名写错"吞掉的，
摘掉规则后测试照样绿（本轮 R4 第一次跑就是 ALIVE，改成 `assert.ok(f)` 之后立刻 RED）。
② 变异检查要**看替换后的实际形状**：R4 第一次我替换的是一行的前半，对象里留下第二个 `re` 键，
规则其实没被摘掉 —— ALIVE 是 mutations 自己造假，不是实现没问题。


## 6. 外部实践参考（都对着上面某一档）

- [Schema Matching with Large Language Models](https://arxiv.org/html/2407.11852v1)、
  [GRAM: Generative Retrieval Augmented Matching of Data Schemas](https://arxiv.org/html/2406.01876v1)、
  [Structured Outputs Enable the Fast and Accurate…](http://arxiv.org/html/2409.10132v1)：
  一致结论是把候选集**封闭成有限枚举 + 结构化输出**，准确率与可校验性同时上升 —— 就是档 A 的形状。
- [Interactive Data Harmonization with LLM Agents](https://arxiv.org/html/2502.07132)：
  自动映射 + 人在环确认，对应我们的映射表改判 + 站点规则沉淀。
- [LLM 流水线中的 PII](https://tianpan.co/zh/blog/2026-04-12-pii-in-llm-pipelines)、
  [Trace Masking 自动脱敏](https://m.blog.csdn.net/weixin_4145546/article/details/156574257)、
  [阿里云 PAI 的 LLM 敏感信息打码](https://help.aliyun.com/zh/pai/user-guide/llm-sensitive-content-mask-dlc)：
  业界默认动作是"egress 前先 tokenize / redact"，也就是档 B 的代号化；没有人建议"整份 profile 丢给模型"。
- [PII Detection in LLM Outputs（2026-07）](https://www.openlayer.com/blog/post/llm-output-pii-detection)：
  出闸检测要独立于构造逻辑 —— 我们 `assertNoProfileValues` 就是这么设计的（构造不拼值 + 发送前再检一遍）。
- [Mirroring Privacy Risks with Digital Twins](https://link.springer.com/article/10.1007/s42979-024-03413-z)：
  碎片化标识信息组合起来即可再识别 —— 支持第 5 节问题 2 里"事实类文本另算"的判断。
- [Bitwarden Custom Fields](https://bitwarden.com/help/custom-fields/) 与
  [Chrome DevTools 的 autofill 调试](https://developer.chrome.google.cn/docs/devtools/autofill)：
  成熟密码管理器的字段映射同样全在本地完成，远端不参与"值 → 选项"的对齐。
- [IMMD Visas / Entry Permits](https://www.immd.gov.hk/eng/forms/hk-visas.html)：`visaCategory` 封闭词表来源。
  旁证（二手，仅供读法参考）：[HoiSum 香港工作签证指南 2026](https://hoisum.hk/zh-hans/knowledge/hong-kong-work-visa-guide/)。

## 7. 现在的状态

第 4 节的 1–5 与第 5 节的答复已全部落地（BUILD 号 2026-10-04-1）：签证类别建模、代号层、
认选项的请求 / 解析 / 落地、档 C 勾选框与硬排除清单、映射表标记与侧边栏按钮。
`npm test` 549 条全绿（新增 21 条）、判分集 191/191 越界 0、7 条变异检查全部会红。

还没做的两件：
 · **档 B 的逐栏升级提示**（同一栏两个选项落进同一代号时，现在只报 ambiguous 交人工，不再追问）；
 · **真实站点实测**：档 A/C 在真页面上的命中率只有用户那一侧能验（与任务「真实站点实测第二轮」同批）。
