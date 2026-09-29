# 真实站点结构结论（2026-09-26，11 份导出）

来源：用户在自己浏览器里用扩展「导出本页字段结构」采集，共 11 份 JSON（同一 HKEX 页面重复 2 份）。
所有判定都注明证据；我推翻了自己两条早先的推断。

## 站点 → 系统家族（实测）

| 站点 | 入口特征 | 组件库计数 | 判定 |
|---|---|---|---|
| 港交所 HKEX（校招） | `hkex.wd3.myworkdayjobs.com/zh-CN/HKEXCareerPage` | ant 0 / el 0 | **Workday，中文 UI** |
| 招商银行 | `career.cmbchina.com/center/resume` | **ant 13,625 · rc 162** | **Ant Design + rc 组件** |
| 中国五矿 | `wecruit.hotjob.cn/SU6419…/pb/resumeOperation.html` | **ant 7,498** | hotjob 新壳 = AntD |
| 未署名 hotjob 租户 | `wecruit.hotjob.cn/SU62f3…/pb/resumeOperation.html` | **ant 7,489** | 同上，跨租户一致 |
| 中国移动 | `www.hotjob.cn/wt/zyhl/web/index/showNewResume` | ant 0 / el 0，但**32 个原生 `<select>` + 14 radio** | **hotjob 老壳 = 服务端渲染原生表单**（与 `/pb/` 完全不同代） |
| Shopee（Sea MAP） | `app.mokahr.com/campus-recruitment/shopee/170435` | 全 0，`input[placeholder=请选择]` | **Moka 自研组件，中文**（2 份：投递页 + 简历页） |
| 宁德时代 CATL | `app.mokahr.com/campus-recruitment/catlhr/148948/…/apply` | 全 0 | **Moka 自研组件，中文** |
| KPMG（已有） | `app.mokahr.com/campus-recruitment/kpmg/74217` | 全 0 | Moka，英文 |
| 携程 | `careers.ctrip.com/index.html#/campus/personal-homepage/addCV` | 全 0，自研 | **携程自建**（推翻我上一条"携程=Moka"：那个页面链到 Moka 是**招聘广告位**，简历页自建） |
| 拼多多 | `careers.pddglobalhr.com/campus/personal-center/resume-detail` | ant 654（弱） | 自建 |
| 太古 / 汇丰 | `career10.successfactors.com/portalcareer?_s.crb=…` / `career2.successfactors.eu/careers?company=hsbcholdin` | — | **两家都是 SAP SuccessFactors**（推翻我"太古自研""汇丰 Avature"两条推断）；这两页**导出失败**，见文末 |

## 三个结构性发现（影响的不是一家站点）

### 1. Moka 把每段学历**平铺成具名字段**，而不是重复区块
Shopee 同一页里同时出现：`硕士毕业学校（本科无需填写）`、`本科毕业学校`、`高中毕业学校`、`本科GPA（实绩/总分）`、`本科专业排名`。
我的 profile 是 `education.N.*` 列表 → 必须有"标签里的学历层次 → 列表槽位"的映射规则，否则三段会互相抢同一个 `education.0.school`，而且抢错了**不会报错**。
→ 已落地（2026-09-26）：adapter 新增 `degreeSlotPins`（`{match, degree, subfield}`），按 profile 里 `education.N.degree` 的实际学历值定位槽位；资料里没有那一级学历 → 缺口 `degree_slot_unresolved`（橙色交人工），绝不拿"最像的那段"顶替。判定只用标签/name/id，不用 placeholder（"请输入本科学校"这类示例会把硕士栏串到本科槽）。同一标签同时提到两个学位时（`硕士毕业学校（本科无需填写）`），取学位名出现更早的那个。回归见 `test-forms/moka-flat-degree.html`。
>
> 顺带挖出一个更普遍的 bug：`itemIndex` 原来按"全页面第几个重复区块"编号，老式 `<fieldset>` 布局里 Personal/Education/Work 结构相似会被归成一组，教育经历于是带着 `itemIndex=1` 去对齐 profile，把硕士槽漂到本科槽（`sf-plain-en` 命中率当场从 100% 掉到 72%）。现在改为按"同一章节内第几块"编号。

### 2. AntD 系的"下拉"是一个 `div[role=combobox]` 配一个**匿名 input**
五矿 27 个、招行/拼多多 8 个 `div/combobox`，同时导出里出现大量 `(无)` 标签的 input 与"请选择×"标签成对出现。
危险在于：带 `id`/`name` 的那个匿名 input 会被当成独立字段并**被打字**，而下拉的真身是那个 div。
→ 方案：scanner 把 combobox 与其内部/紧邻 input 合并成一个字段（kind=combobox），命中我们既有的 `custom_control` 拒填规则，不再生成可写字段。

### 3. 招行的日期字段标签全是 `请选择时间`
真实标签（开始时间/结束时间/获奖时间…）在 DOM 里没被我们的标签策略抓到，退到了 placeholder。
这类"泛提示语当标签"会让我们把时间字段全部混在一起。
→ 方案：标签策略增加**候选文本打分回退**（社区同类项目 `shared/field-text.js` 的思路）：当首选标签是泛提示语时，在最近容器内收集短文本候选并按关键词/长度/标点打分重选。
同时"必填星号位置不固定"（`姓名*`、`*姓名*`、`毕业时间*?`、`最高学历*?`）要在归一化里剥干净，包括 SVG 噪声标签 `Created with Sketch.`。

## 字段词典缺口（真实页面上问了、我现在没地方存的）

`高考生源地` / `生源地`、`曾用名`、`健康状况`、`面试地点`、`是否接受岗位调剂`（与"工作地点调剂"是两题）、
`紧急人联系电话`（移动/宁德用词，我只有"紧急联系人电话"）、`成绩排名`、`受教育类型`、`毕业学院`（拼多多笔误式叫法）、
`社交平台 + 用户ID/URL`、`选择本公司理由`（主观，已有槽位但要确保被拒填规则覆盖）、
`父母/配偶/其他家庭成员` 的具名四套（中国移动）→ family 列表需要 relation 级 pin。

## Moka 家族级 vs 租户级（三租户 diff）

- **三家共现（升为家族级）**：姓名 / 手机号码 / 邮箱 / 性别 / 出生日期 (年龄) / 身份证 + 证件号码 / 最高学历 / 学校名称 / 专业名称 / 公司名称 / 职位名称 / 工作职责 / 项目名称 / 年 + 月 成对 / `-` 分隔 / 请选择·Please select 自定义下拉 / 自我描述·About me（主观拒填）/ 奖项名称 / 期望城市 / 期望薪资。
- **仅单一租户（留租户级）**：KPMG 的 `Work experience`、`Organizational role`、`Current salary`；Shopee 的 `硕士/本科/高中` 平铺、`是否校园大使推荐`、`籍贯`、`国籍（例：中国）`；CATL 的 `是否有亲友受雇于本公司`、`是否接受岗位调剂`、`您是否同意本公司在入职前对您进行背景调查?`、`紧急人联系电话`、`健康状况`。
- 规则：**只在一家出现过的措辞不得写进家族层**；每条 alias 记 `source` 与 `lastVerified`，下次有第二家同租户类型验证后才升级。

## SuccessFactors / 汇丰两页"导出失败"的真实原因（已确认并修复）

用户第二次导出后拿到了两个 JSON，`controls: 0` 但结构合法：
- 一个 `url` 是 `match.adsrvr.org/track/cei?...`（广告交换的 cookie-sync 框）
- 一个 `url` 是 `apply.careers.hsbc.com/widgets/cookiemanageriframe/`（cookie 同意框）

**根因不是页面太重**，而是消息选路：`chrome.tabs.sendMessage(tabId, msg)` 不带 `frameId` 时会广播给该标签页全部 frame，
而 Promise 只取**第一个应答**。第三方框是几 KB 的空壳、`document_idle` 早就跑完，秒回；
真表单框要动态 `import()` 探针模块 + 扫全量 DOM，慢半拍 → 于是"导出"导出了广告框。
之前给它加的样式表上限是治错了方向（那个优化本身有价值，保留）。

**修法（两条，方向不同）**：
- 只读探针：遍历 `chrome.webNavigation.getAllFrames()` 的全部 frame，按 `控件数 + 是否第三方 junk URL + 是否顶层框`
  打分挑一个"最像真表单"的框返回，并把 `frameReport`（选了哪个框、每个框多少控件）一起带出去显示在侧边栏。
- 写入路径：反而**收紧成只发顶层框**（`{ frameId: 0 }`）。广播式写入意味着可能把资料打进第三方 iframe，
  这是不可接受的行为；表单确实在首方 iframe 里的站点，宁可明确不支持也不能误写。

教训沉淀：**任何"多框广播 + 取第一个应答"的实现都是竞态**，与页面轻重无关。

## SuccessFactors Portal 真实结构（2026-09-27，frame 选路修好后拿到的两份）

`career10.successfactors.com/portalcareer?company=johnswireP2`：frame#0 · 97 控件 · 39 可见 · 6 个跨源 iframe · 3 个 shadow host。
`career2.successfactors.eu/careers?company=hsbcholdin`：frame#0 · 179 控件 · 63 可见（**落在登录/注册面板**，不是简历表单——导出必须在填简历那一步做）。

家族级事实（不是某一家租户的措辞）：
1. **它的"下拉"是 `<input type=text role=combobox placeholder="No Selection">`**，语言切换甚至是 `<a role=combobox>`。
   原来 `kindOf()` 按标签名判：`input` 分支先 return 'text'，role 永远看不到 → 会往下拉里打字。
   现在 role 先于标签名，且计划阶段就归 `custom_control`（不是等 filler 失败再报红）。
2. 日期占位符就是 `DD/MM/YYYY`（en-GB），模板推断已覆盖；`labelVia=for` 是主力，`aria-label` 次之。
3. **`If other University/College, please specify` 是条件框**：上面那个下拉选了 Other 才填。
   把它当普通学校字段填 = 同一个值写两遍。租户级 skip 掉（`conditional_other`）。
4. 职位搜索区的 `Search by Keyword` / `Search by Location` 与简历字段同页 → 误填等于把城市名打进取框。

这四条换来三条打分层的通用修正（都在 `tests/core.test.js` 里有断言）：
- **显式 `<label for>` 不该被长度上限杀掉**：那条 42 字符的 SF 标签被丢弃后，上一节的 `<h3>Personal Information</h3>` 冒充了它的标签。显式来源的上限放宽到 90。
- **英文右分支**：`Current Job Title` 问的是 title，`current job` 只是修饰词；别名不含标签中心词时降权，否则"是否在职"会赢过"职位名称"。
- **精确别名能扛住错的章节线索，扛不住列表槽位**：SF 把 Expected Salary 放在 Employment 小节里（章节线索是错的），字面命中该保住；但「政治面貌」在基本信息里时，`family.0.political` 同样是字面命中，却因为是可重复槽位必须让位。

## 判分器自己也要有回归（一次假警报换来的）

`mustNotTouch` 原来用 `el.value` 判"有没有被写过"，而 **checkbox 的 `value` 天生是 `"on"`** →
所有 cookie 开关都被误判成越界。假警报比漏报更危险：它会让整套门槛失去意义。
现在按控件类型分开判（checkbox/radio 看 `checked`，select 看 `selectedIndex`，button/submit 永不判）。

## Klook（Moka）实测跑通后暴露的未解问题（2026-09-27）

用户第一次在真实页面扫描，结构层没问题（`本页适配器：moka`、只读/下拉/成对日期都正确拒填），
但暴露一个我们**还没解决**的问题，写下来而不是掩盖：

Moka 的重复经历区块里，每个字段各自一个 `.mk-form-item`，页面**没有小节标题、也没有可识别的卡片包裹**。
于是 `公司名称 → internship.0.company` 与同块的 `职位名称 → work.0.title` 可能来自 profile 的不同条目：
两个路径各自都合法，匈牙利也就不会拦，但落到页面上就是"把 A 公司的职位写成 B 公司的职位"。

- 现在 `tools/expected/moka-kpmg-en.json` / `moka-klook-cn.json` 对这类字段只允许 `oneOf` 一组合理路径，
  **判分不承认配对正确**，避免把没解决的问题写成"通过"。
- 真正的修法要等 P4：一致性断言（同块内的字段必须来自同一个 profile 列表条目），
  实现点是把 `detectRepeatedBlocks` 的卡片边界判定从"结构签名"扩到"重复标签序列 + 缩进/包裹猜测"。

## 2026-09-28 · 年 + 月 成对框：从"整组拒填"改成"一个日期、两笔写入"

实测形态（四份判分表单、14 个框）：Moka 把 `年/月` 两个 `<input placeholder="年|月">` 塞在同一个
`.mk-control` 里，Workday 用「自:」「至:」两个 `wd-field`，海康自建用 `.se-field`。以前整组标
`composite_date` 交回人工，理由是"单个框装不下一个完整日期，两个框会各自去抢 profile 的日期列"。
这个理由成立，但结论过头了：抢列的问题在于**规划粒度**，不在于控件不可写。

改法（三段，缺一都会留下假绿）：

1. **扫描阶段配对**（`dom/scanner.js` `markCompositeDatePairs`）：同容器 + 同标签的年框与月框按
   文档顺序两两成组，给出 `datePair = { id, part, role, roleSource }`。落单的年框仍然带
   `compositeDate` 标记，否则它会被当成普通文本框，把整个日期写进年份框。
2. **一组 = 一个问题**（`core/matcher.js`）：组长（年框）单独成行进匈牙利矩阵，只占一个 profile 列；
   落笔前在 `assignments` 末尾统一展开成每成员一笔，`dateFormat` 分别给 `yyyy` / `MM`。
   展开必须放在最后而不是打分分支里：Moka 适配器一钉位，只钉年框就会把月框整个弄丢（实测踩过，
   `tests/core.test.js` 有一条专门盯它）。
3. **起止角色**：标签自己说了「自/至/开始/结束」→ `roleSource='label'`；只写了「起止时间」这种
   一句问两个框的范围词 → 按出现顺序推（第一组是起），`roleSource='order'` 一律黄字，
   并且**保留先前的黄字理由再追加**，不让两处说明互相覆盖。

顺带修掉一个真 bug：`detectRepeatedBlocks` 会把「自」「至」两个纯日期行当成第 0/1 段经历，于是
`自 → work.0.startDate`、`至 → work.1.endDate` —— 一个时间段被拆到两段经历上，而且"自"那侧还能拿绿字。
现在纯日期壳子不参与重复编号（`isDatePartShell`）。

仍未解决（判分标准里如实写着，不掩盖）：Moka 的起止行**没有小节标题**，落在哪一段经历说不清，
`y1..m2` 目前会拿到 `education.0.*` 这类同样合法但可能错位的路径，所以必须一直是黄字。
根因是 `sectionHint` 只来自容器标题；下一步是让日期行继承邻近字段的章节线索（见任务 #5 一致性断言）。

## 2026-09-28 · 第二轮：三个"看起来是我们的词不够"其实不是的归因错误

跑完拆日期后把剩余缺口按原因排了一遍（`custom_control=27`、`no_candidate=12`、`subjective=5`…），
逐条查下来发现 12 个 `no_candidate` 里有一多半是**我们自己的判读错误**，不是资料缺词：

1. **附件按标签拒 → 漏进来被报成"没词"**。`BLOCK_PATTERNS` 的 file 规则要求标签命中
   「上传/附件/upload/attachment」，于是 Sea 的 `Resume`/`Transcript`、Workday 的「简历履历」漏网，
   落到候选打分后变成 `no_candidate`。用户看到"没有这个词"会去补资料，而真相是"这栏得你自己传"。
   现在 `kind === 'file'` 直接归因 `file`，不再看标签。
2. **枚举选项比对一直拿到 `[object object]`**。`scorePair` 里
   `pageField.options.some(o => profileField.options.some(p => normalize(o) === normalize(p)))`
   的 `o` 是 `{text,value}` 对象，`normalize(o)` 恒等于 `"[object object]"` → 永远 0 命中 →
   **所有带选项的枚举字段都在吃 ×0.8 惩罚**。后果不是"少点分"而是排错序：SF 的
   `Current Work Authorization` 输给"工作城市"（0.529 vs 0.554），整栏红字。改成比 `text/value`
   并允许包含关系后，它自己回到了 `hkGlobal.workAuth` 并选中 Hong Kong Permanent Resident。
3. **裸 `work` 把合规块认成工作经历**。SF 的 `<legend>Work Authorization</legend>` 命中章节词 `work`
   → 该块字段拿到 `sectionHint=work` + 区块序号 0 →「Do you require sponsorship…」对
   `hkGlobal.needSponsorship`（别名精确包含）被章节惩罚 ×0.75、槽位惩罚 ×0.8，0.84 掉到 0.50 出局。
   `work` 现在带否定前后词（authorization/permit/visa/status/…），`Work Experience` 仍然照认。

修 2 时顺带暴露并修掉一个更普遍的结构缺陷：**标签证据能撞到 1.0，结尾的 `Math.min(1, best)`
就把后面的槽位惩罚一起抹平**。精确命中的 `education.0.school` 与 `education.1.school`
都变成 1.000，匈牙利只能按列顺序随便挑 —— legacy 表单的「最高学历」因此拿到 `education.1.degree`
（本科）而正确答案是 `education.0`（硕士），而且是**绿字**。现在标签证据封顶 0.95，
章节/槽位的奖惩才有可见的地方。

同轮修掉两处"假红"（写入层）：`<option value="2">共青团员</option>` 这种码值下拉，回读拿可见文本
比码值永远不等 → 明明选对却报红；单选按 `value="M"` 勾上、验收却比 `男` → 同样假红。
现在写入与回读共用同一个 `hitOf` 判定；站点真的把选择改回去时报 `selection_reverted` 红字（保留），
计划阶段就知道选项对不上的（`needsChoice`）报橙色"需人工"而不是红色"填错了"。

结果：9 份判分表单 186/186、越界 0、**红字 0**（本轮开始前是 7 条红字），
`no_candidate` 从 12 降到 2（Workday 的「区」「电话分机」——profile 里确实没有这两栏，属真缺口）。

## 2026-09-28 · 摊平表单的记录配对：出现次数是能用的证据，但不是"哪段经历"的证据

`moka-klook-cn.html` 把两条工作经历摊成 8 个"一行一个控件"的 `.mk-item`，没有小节标题、没有卡片包裹，
`detectRepeatedBlocks` 找不到任何边界（每个容器只有 1 个控件）。同块的 公司名称 / 职位名称 / 工作职责
因此各自去抢 profile 列，会出现"A 公司的职位写进 B 公司那一栏"，而每个字段单独回读都是绿的。

试过、被否掉的做法：把 `sectionHint` 从邻近字段继承过来 —— **Klook 整份表单一个章节线索都没有**，
继承无源可继；有线索的表单（kpmg / workday）本来就已经对齐了。所以这条不在本轮做。

实际做法（`markRecordOccurrences`）：把"同一个标签第 k 次出现"当作"第 k 条记录"的证据。
三个关键约束，每一条都是实测踩出来的：

1. **只给确实重复的标签编号**（出现次数 ≥2）。一次性字段（学校 / 专业 / 姓名）没有"第几条"可言，
   给它们编 0 反而是无中生有 —— 老式 fieldset 布局的三个不同章节会被一起编号，
   硕士槽位漂到本科槽位（`tests/scanner.test.js` 有一条专门钉这个）。
2. **同一容器里的年月对折成一个单位**。Klook 的「起止时间」四个框 = 一条记录的开始与结束，
   按框计数会把它当成两次出现。
3. **`role=combobox` / `listbox` / `file` 不参与计数**。Sea 的 `Contact Number *` 是一个
   `div[role=combobox]` 壳子和一个真空输入框共用同一条 `aria-labelledby`，壳子占掉"第 1 次出现"之后，
   真输入框就成了"第 2 次"，实测去抢了 `family.1.phone`。

序号一律带 `itemIndexSource='occurrence'`，匹配器据此**拒绝开绿字**：它说得出"第几条"，
说不出"是工作还是实习"。绿字只认两种证据 —— DOM 区块序号，或页面小标题的章节归属与 profile 分组一致。
另外加了一条错位点名：第 k 次出现的标签如果被派到序号 ≠ k 的条目上，黄字说明会写
"这一栏是页面上第 k+1 次出现的「工作职责」，却拿到了资料里第 1 条，配对可能错位"。

效果：Klook 第 2 条经历的 公司名称 / 职位名称 现在都落在 `work.1.*`（以前一个 work.0 一个 internship.0），
剩下 1 处错位（`工作职责 → work.0`）被点名而不是静默通过。
判分 186/186、越界 0、红字 0、需人工 2；112 单测全绿（本轮新增 4 条，其中 3 条验证过"去掉实现就失败"）。

## 2026-09-28 · P3 混合 AI 兜底：边界能自证，但本仓库判分集上的增益是 0

实现见 `core/ai.js` + `background/service-worker.js` 的 `nw:aiPreview / nw:aiAsk / nw:saveAiKey`。
三条边界的落点（都不是"文档承诺"，都有测试）：

1. **取值不出本机**：请求体由页面文字（标签/控件类型/站点选项文案）+ 槽位路径与中文名构成；
   内容脚本回包 `aiFields` 时**刻意不带 `currentValue`**（站点预填的内容里就可能有用户姓名手机）。
   发送前 `assertNoProfileValues()` 把整份 profile 逐值扫一遍，命中即拒发。
   自检有个必须承认的坑：槽位目录自己的中文名（"掌握程度""与推荐人关系"）会和资料里的短值
   （`熟练`、`导师`）撞字，第一版每次都把自己拦下 → 拦成"永远拒绝"等于没有。
   现在只豁免**构造出来的目录文本**这一段，其余区域一律不豁免，植入取值仍能被抓住（有测试）。
2. **只能选路径**：响应里的 path 必须命中白名单，值一律由本地从 profile 取；
   证件号/护照/签证/薪酬/无犯罪/声明类路径根本不进白名单（`AI_FORBIDDEN_KEY`）。
3. **永远黄字**：`tier='review'` 写死，且 AI 选中的 sensitive 槽位仍要走「允许填写敏感字段」那道闸；
   候选带 `label` 落地时复核下标，页面在两次扫描之间改了控件顺序就整条丢弃（`stale`）。

Key 进 `chrome.storage.session`（重启即失效，不会被 settings/profile 导出带走），
Base URL 与模型名才进 `storage.local`。「预览将发送的内容」与实际请求共用同一次构造，
看到的就是发出去的。

**实测上限**：9 份仿真表单里 `no_candidate` 只剩 2 栏（Workday 的「区」「电话分机」），
而这两栏在 profile 里本来就是空的 → AI 最多只能说"你资料里那栏没填"。
所以本轮的量化结论是：**在仓库自带判分集上 AI 兜底增益为 0，真实增益未验证**，
只能在用户实际遇到的自建门户上量。剩下的覆盖损失集中在 `custom_control=27`（需要点开下拉，未批准），
那部分 AI 帮不上 —— 它答的是"这栏对应哪个槽位"，不是"这个控件怎么操作"。

## 2026-09-29 · 第一批用户真实导出（11 份，5 个平台）

| 平台 | 页面 | 控件 | 框架判定 | 结构特征 |
|---|---|---|---|---|
| 卓越/zhiye（北京银行） | `/form` | 85（导出 77） | none/自定义组件 | 全部字段**无 name/id**，标签全靠前置兄弟；0 个原生 select，下拉全是"readonly input + 点击渲染弹层" |
| 卓越/zhiye（aigtek） | `/form` | 24 | none/自定义组件 | 同上，同一族的第二个租户 |
| 智联校园 | `xiaoyuan.zhaopin.com/scrd/resume2` | 22 | none/自定义组件 | **分步向导**（选择志愿 → 填写简历 → 完成投递），每页要先点「填写」；标签质量意外地好，但两个「手机号码」、两个「请选择行政区」是同标签不同用途 |
| 飞书招聘 | `lightwheel.jobs.feishu.cn/referral/resume` | 41（导出 37） | formily | 结构最友好：23 个字段有 `label[for]`；6 个 div 自定义控件 |
| 国聘 iguopin | `c.iguopin.com/basic-info`、`/apply` | 19/15/6/5/5/4 | ant | 多步向导，**每步控件很少**（4-19），"一次扫描"只能拿到局部 |
| 途普 tupu360（埃森哲） | `/resume/applica…` | 52（导出 41） | ant | **25/41 无标签**、17 个 div 控件、标签里带 `*` 前缀（`*Name`） |

判读：

- 探针本身在这批页面上都能出结构（用户报"到处失败"的根因是 manifest 漏了 `dom/select-opener.js`，
  内容脚本 import 被拒 → 见 commit `778ffa1`；不是站点问题）。
- zhiye 有一类确定的标签错误：手机号那栏 label = 「中国大陆」，那是旁边**国际区号下拉的显示区**。
  修法是"兄弟里有没有控件"这条判据要扩成"兄弟是不是字段壳子"（`isFieldShell`），
  且 `prev-sibling` 与 `container-text` 两条路径共用同一判据 —— 先只修一条时测试仍然红，
  说明赢的是另一条。
- tupu / iguopin 的无标签问题**这批导出不足以定位**：缺祖先类名链和"被否掉的候选标签"。
  因此探针加了 `chain` / `labelAlts`（都是站点 DOM 元数据，不含填写值），版本 `2026-09-29-2`，
  等用户重新导出后再改，不靠猜。
- 分步向导改变了 P4 的需求形状：一次扫描只覆盖一步，报告必须能按"站点 + 步骤"累积，
  否则"投了 20 家还差哪几栏"根本统计不出来。
