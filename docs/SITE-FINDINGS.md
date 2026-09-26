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
