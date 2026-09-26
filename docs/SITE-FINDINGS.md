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
→ 方案：adapter 增加 `degreeSlotPins`（`{match, degree, subfield}`），按 profile 里 `education.N.degree` 的实际学历值定位槽位；定位不到就标橙交人工，绝不猜。

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

## 待办：SuccessFactors 两页导出失败

假设原因（未确认）：SF 页面极重（HKJC 那份 201KB HTML / 44 个 CSS / 159 个 JS），我的探针会把**所有样式表规则拼成一个大字符串**来数组件库，可能超时或把 service worker 拖到被回收。
已做：样式表数量与字符上限、部分结果标记（`partial`）。
如果仍失败，请把侧边栏那行错误原文发我（"本页无响应：…"），我按报错定位而不是猜。
