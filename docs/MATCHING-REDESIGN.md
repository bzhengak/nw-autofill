# 匹配方法重构（2026-10-02）

这份文件是**方法与决策的记录**，不是待办清单。它存在的原因：用户 2026-10-02 的原话
——"你现在不要纠结于具体哪个怎么改，而是应该审视你的匹配方法"。前几轮我一栏一栏打补丁
（删裸词别名、`slot_empty`、`block_ambiguous`、`optionRules`），每一块都有用例，但
"name 填成 last name / phone number 填成 id number"仍然成批出现。下面七条是**结构性**原因，
补丁治不了它们。

## 一、七个方法论错误（都对着代码，不是猜测）

1. **打分把英语短语的中心词当识别依据。**
   `core/matching.js` `scorePair` 里有 `labelCore.endsWith(ac)` 免覆盖率下限的分支，
   另有"不带中心词的别名 ×0.8"的罚分。实测：`School Name` 靠中心词 `name` 得 **0.695**，
   靠定语 `school` 命中的 学校名称 只得 **0.553**；`Referrer Name` 同理 0.673 > 0.637。
   网申栏位的身份由**定语 + 板块**决定，这条规则系统性地反着来。

2. **"槽位"与"取值"搅在同一层。**
   候选只从"资料里有值的槽位"里生成（空槽仅参与 `emptyBest` 补丁）。
   于是"对的槽位还没填"时，页面会被"次优但有值"的槽位抢走。`slot_empty` / `block_ambiguous`
   都是给这条规则擦屁股，不是修法。

3. **校验只验字节，不验语义。**
   写入后的回读问的是"框里的文字等不等于我要写的"。等 → 绿字。
   **栏位配错在现系统里永远显示成功**，所以错值看起来"填上了"，直到用户自己发现。

4. **AI 在结构上够不到"映射错了"。**
   `core/ai.js` 的 `AI_ELIGIBLE_REASONS = {no_candidate, required_no_candidate, conflict_unresolved}`
   只覆盖**缺口**。映射错误不产生缺口，产生 `assignments` → AI 永远不会被问到这一栏，
   也就永远没有机会推翻它。这就是"AI 填写不能修改已填过的错误的"的真实机制。

5. **我们写的值与不能动的值在页面上不可区分。**
   `dom/content.js` 的 `mark()` 只画 CSS 描边，`dom/scanner.js` 明确不读任何 `data-nw-*`。
   下一轮扫描见 `currentValue` 非空 → `already_filled` 跳过（`core/matcher.js`）。
   错值因此**永久化**，连「导出没填的字段与选项」里都不出现——它没在缺口里。

6. **同一栏位五种机制各自主张，没有终裁与可解释记录。**
   `pins`（直接给 1.0 短路打分）、`languageSlotPins`、`optionRules`、别名表、匈牙利分配。
   谁先命中谁说了算，最后不留"凭什么认定它是这个槽位"的记录 → 出错了谁都不可疑。

7. **发给 AI 的栏位档案仍不完整。**
   用户 2026-10-02 导出的 index 18 / 26：`label / labelRaw / placeholder / nearbyLabels /
   sectionTitle / options` **六项全空**（`id="value"` 的 `ant-input`）。
   模型答 `{"path":null,"reason":"无法识别字段含义"}` 是正确行为，缺的是我们的采集。

## 二、已定的三条口径（用户 2026-10-02 选）

- **映射范围：整页全量。** AI 对页面**所有**栏位给出槽位映射（含已经填过的），错映射才有机会被推翻。
  AI 从"兜底"变成"主力识别者"，本地规则退为候选生成器与离线退化方案。
- **覆盖策略：只覆盖我们自己写过的。** 每个写入都要留下可查的标记与账本；
  站点预填与用户手填默认不动。
- **写入前一律先出映射表。** AI 的映射结果先进"页面栏位 ↔ 槽位 ↔ 依据"表，用户在表上确认/改判后才写。
  确认后写入仍按敏感与证据分档显示状态（非敏感且证据充分=绿，敏感=黄+请核对）。

不变的硬边界：取值不出本机（`assertNoProfileValues`）、AI 不能造值、永不代提交/代传附件/代点未授权控件、
两道确认闸（AI 地址 + 每站点）、拿不准就留空并说清。

## 三、里程碑与验收

> 进度（2026-10-03，构建号 2026-10-03-2）：**S1 台账 / S2 概念层 / M1 证据与形状 / 整页目的闸 / S5 整页概念映射 /
> S4 栏位档案补全（标题边界、国省码值）/ S6 映射表（写入前确认 + 计划校验 + 改判记住本站）已落地**；
> 剩下 S7 扩行代理（已获授权、默认关）。


| 里程碑 | 内容 | 验收 |
| --- | --- | --- |
| M1 证据与语义（已完成） | 实际做法与计划略有偏差并更好：没拆 `scorePairDetailed`，而是新增**独立分类** `labelEvidence()`（exact / full-cover / qualifier / head-only / head-noun / broader / struct-* / options-hit / section-agree / item-agree），每个 assignment 带 `evidence` 与 `weakEvidence`；只有弱证据的栏位不许 auto；`shapeOfControl × valueShape → shape_mismatch` 写入前体检。**两道闸最终下沉到 `filler.applyPlan` 入口**（独立审查 2026-10-02 的意见：挂在出口上就有后门） | 单栏页面 `School Name→学校`、`Referrer Name→内推人`、`Name→姓名`；形状不相容不再出现绿字；判分 191/191、越界 0 |
| M2 谁写的（已完成，S1） | 账本 `chrome.storage.local.nwFillLedger` 按站点 origin 分桶，**只存栏位指纹 + 槽位 + 取值哈希 + 构建号**；刻意**不打 DOM `data-*` 属性**（值进属性就能被页面脚本读走）；扫描前取账本→排计划，写完记账，撤销擦账；归属判定 `us / edited / other / empty` 统一由 `writtenByMap` 提供，所有出口引用同一答案 | 任何模式（full / incremental / AI 落地）都不盖站点预填与用户手填；我们上轮写错的值被重新计划并覆盖；值没变则 `already_ours` 不重写；台账不进任何导出物 |
| M3 整页映射 | `core/ai.js` 新增 `buildPageMapRequest / parsePageMapResponse`：全量栏位档案（标签/描述/板块/选项文案=码值/邻近/必填/当前值是否我们写的）+ 槽位目录，四档压缩；SW 新消息 `nw:aiMapPage`，白名单与自检沿用 | 一屏 28 栏的页面能一次拿到全量映射；请求体仍零取值；AI 拒绝的栏位带原话理由 |
| M4 映射表（已完成，S6） | 三层各自可测：`core/site-rules.js`（按 origin + 栏位指纹存改判，槽位路径必须在 `buildFields()` 的封闭集合里，被拒的每条带中文理由）、`core/mapping-table.js`（一栏一行：页面自述 / 判定与来历 / 依据 / 现状 / 已有规则 / 撞车；导出走剥掉回读值的 plain 视图）、`core/plan-check.js`（段数双向对齐、同一槽位被两栏认领、必填没安排、整页一栏都不写带原因分布、指纹撞车）。侧边栏 `mappingFirst` 开关默认开：「扫描并填写」改名「扫描并出映射表」，写入只从「按此映射填写」走 | 未确认的栏位一个都不写（面板测试：点扫描钮发的是 preview）；改判压过适配器钉位却压不过"永不代做"（验证码/声明/附件照旧拦）；勾「记住到本站」才落盘，同站重扫直接命中；没勾时**本轮确认不落存储**；导出的表里没有取值 |
| M5 收口 | 无 AI 时的退化路径（纯本地快填）明确成开关；README/SITE-FINDINGS 与 memory 同步；判分集补真实形状用例 | 关掉 AI 仍保持当前可核对行为；文档说的是代码真做的 |

## 四、要如实说的代价

整页映射的请求体比分缺口大得多（一屏 28 栏 × 完整档案），需要新的分级压缩与更清楚的"这次削了什么"；
每页一发会增加调用花费，且映射质量取决于模型本身——所以 M4 把确认权留在用户手上，
而不是让 AI 的结论直接落页面。M1/M2 不联网、不改花费，先做。

## 五、借鉴与采纳（先说清依据的成色）

用户让我"搜索相关优秀实践学习并改进"。**本轮联网检索被安全策略拦下**（两次 WebSearch 均被拒），
所以下面这份不是 freshly verified 的外部结论，来源只有两处：① 本仓库 `docs/REQUIREMENTS.md`
2026-09-25 那次底座调研（已核实过的部分写在那儿）；② 我既有知识里的通行做法（**标注为未联网核实**）。
要按外部原文核对的话，把链接或文件给我，或在允许联网时我再跑一轮。

| 通行做法（未联网核实） | 谁在用 | 治我们哪个病 | 落到哪 |
| --- | --- | --- | --- |
| **两层映射：页面 → 规范概念 → 本地槽位** | 浏览器自动填充普遍把字段先归进一个**封闭的类型枚举**（Chrome/Edge 的 field type、WHATWG 表单字段名注册表里那几十个 `given-name / family-name / tel / address-level2` 之类），而不是直接映射到用户数据字段 | 我们现在让 AI 在 **519 个槽位路径**里挑，白名单巨大、请求体 10KB+、模型选错也没法解释。改成"AI 只从 ~60 个规范概念里选一个（含定语：`name.person` / `name.school` / `name.certificate`…），概念→槽位由本地确定性展开" | M3 重构请求与解析 |
| **页面自己声明的 `autocomplete` 优先于任何文本启发** | 同上，自动填充实现都把它当最强信号 | 我们 `scorePair` 里它只是加分项之一，`School Name` 仍会盖过它 | M1 已把 `struct-autocomplete` 记成强证据；M3 里升为确定性规则 |
| **站点专属规则压过通用启发，且规则是数据不是代码** | 密码管理器的 per-site / domain-specific 字段定义（同一套思路我们的 `adapters/*.json` 已经是了） | 途普/网申页的组件皮肤与题目措辞只有站点自己知道 | 已有；M4 把"用户改判"也落成这一层（按 origin + 栏位指纹，可导出可撤销） |
| **导入映射 UI：自动建议 + 置信 + 依据 + 人工改判 + 记住改判** | 集成平台（Zapier/Tray 一类）做字段映射时的通用形态 | 用户现在只能在结果表里看出来错了，改不了映射 | M4 |
| **选择性预测 / 弃权（reject option）** | 分类器实践通则：低于阈值不输出 top-1 | "填错比不填好"是我们所有分档的依据 | M1 的证据闸就是它 |
| **DOM 剪枝后序列化，按节点预测标签** | 表单字段分类的开源模型（DeepForm 一系）用"精简 DOM + 每节点标签"而不是整页文本 | 我们发给模型的档案还是太薄（index 18/26 六项全空就是采集不足） | M3 的档案形状：祖先链 + 同排兄弟控件 + 邻近文本，而不是只有一句话标签 |
| **写入可逆：每笔写入留账，撤销按账本回滚** | 编辑器/自动化库的 change journal | 我们的撤销只在本次会话内存里，重载就不知道"这值是我们写的" | M2（进行中） |

**由此定的一个方法级改动**（比原计划更进一步，也直接回应"字段对应方法可能完全不对"）：
识别不再是一步"页面栏位 → 资料槽位"，而是两步 ——
`页面栏位 →（封闭概念集，AI 或本地规则都能答）→（本地确定性展开）→ 资料槽位`。
好处是三件具体的事：AI 的选择空间从 519 降到约 60，错得少了也能解释；
请求体不再需要整份槽位目录，体积小、也不必将槽位中文名都发出去；
概念层给了本地一条确定性通道 —— 定语归属（`name.school` vs `name.person`）在那里一次定死，
不再靠每页调打分。硬边界不变：取值仍一个字节不出本机，最终写哪个槽位仍由本地白名单定。

## 六、联网核实到的做法（2026-10-02 第二轮，来源可查）

这一轮真的搜到了东西，来源只有两个但都是**一手**：浏览器的 `autocomplete` 令牌表（MDN 抄 WHATWG 注册表）
与 Bitwarden 浏览器端自动填充的常量文件 `apps/browser/src/autofill/services/autofill-constants.ts`
（连同它的采集服务 `collect-autofill-content.service.ts`）。下面每条都注明它治我们哪个病、落到哪个里程碑。

1. **概念是封闭令牌表，不是自由文本。** 标准里有约 40 个字段名令牌：
   `name / honorific-prefix / given-name / additional-name / family-name / nickname / username /
   bday(-day|-month|-year) / sex / email / tel(-country-code|-national|-area-code|-local|-extension) /
   street-address / address-line1..3 / address-level1..4 / postal-code / country(-name) /
   organization / organization-title / url / photo / cc-* …`
   还带**修饰符**：`section-<名>`（同一页重复分组，正是我们的"第几条经历"）、
   `shipping|billing`（语境）、`home|work|mobile|fax|pager`（同类不同用途）。
   → 我们的概念层**直接沿用这套命名**，再补简历特有的（degree / major / gpa / graduationYear /
   certName / languageProficiency / workPermit / sponsorship…）。AI 与本地规则共用同一张表。
   顺带一条硬收益：`autocomplete` 令牌命中就是**确定性证据**，不用再和文本启发抢分数。

2. **Bitwarden 的每个概念有两份名单**：`XxxFieldNames`（拿去扫属性文本）与 `XxxFieldNameValues`
   （只比对 `autocomplete`/`data-stripe` 这类属性**值**），并且扫属性时有**固定优先级序列**
   （`autoCompleteType → data-stripe → htmlName → htmlID → label-tag → placeholder → label-left →
   label-top → type`）。→ 我们的 `scorePair` 现在把所有线索混成一个数；改成"按优先级找第一条能定性的证据"，
   证据本身就是结论的依据（M1 的 `labelEvidence` 是这个思路的第一步，M3 完整化）。

3. **有一份明确的"含糊词表"**：`AmbiguousTotpFieldNames = [code, pin, otp, 2fa, mfa …]` ——
   这些词单独出现**不足以定性**，必须旁证。→ 正是我们裸词 `name / number / date / type / level` 的病。
   已在 M1 之后补 `AMBIGUOUS_WORDS`，只命中含糊词时证据算弱（不许绿字）。

4. **排除表挂在概念上，不挂在全页**：`FieldIgnoreList(captcha, forgot…)`、
   `PasswordFieldExcludeList(hint + 忽略表 + TOTP 名单)`、`ExcludedAutofillTypes(hidden/file/button/image/
   reset/search，登录类还额外排除 radio/checkbox)`。→ 我们的 `BLOCK_PATTERNS` 是全局一份；
   下一步把"电话/邮箱这类概念不接受 radio/checkbox 之外的控件"这种**概念×控件**的相容表补进去
   （M1 的 `shapeOfControl` 只做了一半）。

5. **先判表单目的，再判字段**：`FormPurposeCategories` + `RegistrationKeywords` +
   `StrongNonLoginKeywords(newsletter)` + `StrongLoginHeadingKeywords(sign in / log in …)`——
   页面目的判错，字段判得再准也没用。→ 我们现在只有零散的 `site_search`；M3 加一次**页面级目的判定**
   （网申表格 / 登录 / 搜索 / 问卷），判成非网申就整页不动。

6. **关键词扫描不许跨标题边界**：它的采集服务专门把每个 heading 单列成一条，
   注释写着"这样关键词扫描不会跨边界匹配"。→ 我们的 `blockTitleOf` / `nearbyLabels` 会跨块取文本，
   这是"Certificate Name 抢走姓名"能发生的土壤之一。M1' 直接把扫描收进标题边界内。

7. **值也要规范化到代码**：`IsoCountries / IsoStates` 把 "United States"→`US`、"California"→`CA`。
   → 我们有中英等价表，但国省**没有值→码值**这一层；英文页面的 `Country/Territory of Residence`
   这类下拉常常要的是码值或另一种写法（M3 一起做，放在取值层，不影响识别）。

**由此确认没走偏的地方**：AI 只见字段名不见取值（OpenJobAutofill 那条边界我们本来就有）、
"拿不准就弃权"（Bitwarden 的 ambiguous 表就是同一个思想）、站点规则是数据不是代码（我们的
`adapters/*.json` 形状与它的 domain-specific 规则一致，缺的只是"把用户改判也写进这一层"，M4 做）。

## 七、S2 概念层落地实录（2026-10-02）

`core/canonical.js`：**页面栏位 → 封闭概念 → 本地展开槽位**的第一跳。
概念 id 直接沿用 autocomplete 标准令牌族（`name.person / name.family / phone / phone-dial-code /
address-line / postal-code / country …`）+ 简历扩展（`degree / major / gpa / cert-name / work-permit …`），
每个概念两份名单（keywords 扫属性文本、values 只比 autocomplete 值），属性扫描按优先级走。

两条**当场学到并立刻写死**的自律，都是判分掉分换来的：

1. **不认识的槽位不插手，只抬举命中的、不降级别人。**
   第一版把"概念明确是别的东西"的槽位一律压到 0.6，判分当场从 191 掉到 186：
   `紧急联系人电话` 被判成歧义、`mobile` 被 id-number 顶掉。
   现在只有**站点自己写了 autocomplete**（那是页面向我们自证）才允许压别人；
   概念来自属性文本时只抬不压。
2. **一个概念跨板块时必须页面先说块。** `work-summary` 同时是工作总结、实习职责、项目描述，
   「项目职责」被硬抬进 `work.0.summary`（判分又掉 2 条）。
   现在多板块同概念时，只有在页面给出板块证据（`sectionHint`）的情况下才抬举，
   且只抬那一块，别块出局；没块证据就整条不插手。
   另外多概念并列命中按**具体度**取胜（长词赢），而不是判死为歧义 ——
   「紧急联系人电话」里既含"紧急联系人"又含"电话"，按长度该定案到 emergency-contact-phone。

验证：`tests/canonical.test.js` 6 条（概念表自洽、autocomplete 确定性、具体度、概念×控件、
`family-name` 压过 "Your Name" 字面相似、跨板块需板块证据）。
摘掉 boost 那条用例立刻红；判分 191/191、越界 0；391 条测试全绿。构建号 2026-10-02-13。

## S6 实录（2026-10-03）：映射表落地时真正难的是三件"看起来很小"的事

计划里 M4 只有两行字。写起来发现难点全不在表格本身，而在三件容易糊过去的事：

**① 改判的"身份"用指纹，不用 index。** 网申页大多是 SPA，节点会重建；`index` 是扫描顺序，
下一页、下一次重载就可能换人。`core/site-rules.js` 因此直接复用 `core/ledger.js` 的 `fingerprint()`，
**一个指纹算法只存在一处** —— 两处各写一份的结局是"台账说这栏是我们写的、规则却找不着它"。
代价也要说出来：同页两栏自述完全相同时共用一个指纹（真站点上见过两个 `id="value"` 的 `ant-input`），
于是一条改判会同时落到它们身上。不假装能区分，但必须说：表里那一行标 `collision`，
校验里单列 `fingerprint_collision`，档位在这种时候强制黄字。

**② 「记住」与「本轮」是同一套机制的两种寿命。** 界面最容易做错的地方就在这：
勾了「记住到本站」→ 走 `nw:siteRulesPut` 落盘，扫描时由后台按 tabId 反查 origin 下发；
没勾 → 只把 `confirmed` 随这一次扫描带下去，**绝不落存储**。两条路在 `planFill` 里合成同一个
`siteRules`，所以匹配层只有一套判据（来历不同而已：`siteRule` / `confirmed`）。
被后台拒的每条都带中文理由回到表顶，且这句话不能在下一次渲染里被抹掉 ——
`panelNotice` 与表顶摘要一起组装，就是为了这条（第一版就是被 `run()` 无条件清空抹掉了）。

**③ 校验必须是整页的算术，不是逐栏的措辞。** `core/plan-check.js` 里最值钱的一条是
"页面这一节排了几组"要按**页面的事实**数（含只带章节线索、我们根本没分配的栏），
不能按已分配的行数 —— 第一版按已分配数算，恰好把最想报的那种失败漏掉了：
页面三行实习、资料只有一段，后两行根本没进计划，于是"对得上"。

顺带钉住的几条硬边界（都有用例）：改判**压过**适配器钉位（人来过就不必先验），
但压不过"永不代做"（验证码/声明/附件在 `blockReason` 那一层就先拦了）、
压不过敏感授权（点一下不等于允许写证件号）、压不过"资料里是空的"
（`pinned_field_empty` 照旧，改判只决定这一格是什么，不造值）。
