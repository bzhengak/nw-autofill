// 标准简历 / profile 模板定义。
// 设计原则（对应需求 §3.1 与用户的"模板要全面"要求）：
//  1. 覆盖面优先于精简：宁可列出你简历里没写的条目（政审、家庭成员、港企签证合规、
//     银行要的婚育/身高体重），让你手动补，也不要到了网申页面上发现没地方存。
//  2. 每个字段带中英文别名，匹配阶段直接消费，不再另建词表。
//  3. sensitive=true 的字段（证件号、手机号等）在任何 AI 请求里默认排除。
//  4. 纯数据 + 纯函数，无 DOM、无 chrome API，可被 node --test 直接覆盖。

// 字段元组：[key, 中文名, '别名1|别名2|...', 类型, 标记]
// 类型：text textarea email tel date month year bool enum num url
// 标记：'S' = sensitive；'O:<set>' = 使用 OPTION_SETS 里的枚举候选；'L' = 该行可有多个值（逗号分隔语义）
export const SECTIONS = [
  {
    k: 'basics', zh: '基本信息', en: 'Personal Information', fields: [
      ['name', '姓名', 'name|full name|candidate name|您的姓名|名字|真实姓名|本人姓名|full name of candidate|candidate full name', 'text', 'S'],
      ['preferredName', '常用名', 'preferred name|nickname|常用名|英文名', 'text', ''],
      ['lastName', '姓', 'last name|surname|family name|姓（拼音）', 'text', 'S'],
      ['firstName', '名', 'first name|given name|forename|名（拼音）', 'text', 'S'],
      ['lastNameZh', '中文姓', 'chinese surname|姓 中文|姓（中文）|中文姓', 'text', 'S'],
      ['firstNameZh', '中文名', 'chinese given name|名 中文|名（中文）|中文名', 'text', 'S'],
      ['nameEn', '英文姓名', 'english name|name in english|拼音姓名', 'text', ''],
      ['gender', '性别', 'gender|sex|性别（男/女）', 'enum', 'O:gender'],
      ['birthDate', '出生日期', 'date of birth|dob|birth date|出生年月|生日', 'date', 'S'],
      ['birthYear', '出生年份', 'birth year|出生年份|本人出生年份|date of birth year', 'year', ''],
      ['age', '年龄', 'age|年龄（岁）', 'num', ''],
      ['nationality', '国籍', 'nationality|citizenship|country of nationality|國籍', 'text', ''],
      ['idType', '证件类型', 'id type|document type|证件类型', 'enum', 'O:idType'],
      ['idNumber', '证件号码', 'id number|id no|identity card number|nric|身份证号|证件号', 'text', 'S'],
      ['passportNumber', '护照号', 'passport number|passport no|护照号码', 'text', 'S'],
      ['passportExpiry', '护照有效期', 'passport expiry|passport expiration|护照到期日', 'date', ''],
      ['hukou', '户口所在地', 'hukou|household registration|户口所在地|户籍', 'text', ''],
      ['hukouType', '户口性质', 'hukou type|户口性质|农业/非农业', 'enum', 'O:hukouType'],
      ['hometown', '籍贯', 'hometown|place of origin|native place|籍贯（省市）', 'text', ''],
      ['politicalStatus', '政治面貌', 'political status|政治面貌|党派|本人政治面貌', 'enum', 'O:political'],
      ['partyDate', '入党时间', 'party membership date|入党日期|转正日期', 'date', ''],
      ['maritalStatus', '婚姻状况', 'marital status|婚姻状况|婚否', 'enum', 'O:marital'],
      ['children', '子女情况', 'number of children|子女数量|育有子女', 'text', 'S'],
      ['health', '健康状况', 'health status|健康状况|体检结果', 'text', ''],
      ['heightCm', '身高', 'height|身高（cm）', 'num', ''],
      ['weightKg', '体重', 'weight|体重（kg）', 'num', ''],
      ['photo', '证件照', 'photo|photograph|headshot|avatar|照片|证件照上传', 'url', ''],
      ['ethnicity', '民族', 'ethnicity|ethnic group|民族', 'text', 'S'],
      ['formerName', '曾用名', 'former name|used name|曾用名|原名', 'text', ''],
      ['birthPlace', '生源地', 'birth place|native place|生源地|生源所在地', 'text', ''],
      ['gaokaoOrigin', '高考生源地', 'gaokao origin|高考所在地|高考生源地', 'text', ''],
      ['religion', '宗教信仰', 'religion|religious belief|宗教', 'text', 'S'],
      ['languagePref', '沟通语言偏好', 'preferred language|language preference|沟通语言', 'text', ''],
    ],
  },
  {
    k: 'contact', zh: '联系方式', en: 'Contact', fields: [
      ['phone', '手机号', 'mobile|phone|cell|contact number|telephone|mobile number|手机号|联系电话|手机号码|移动电话|本人手机号|本人电话|my phone number|personal mobile', 'tel', 'S'],
      ['altPhone', '备用电话', 'alternative phone|backup contact|other contact number|other phone|其他联系方式|其他联系电话|紧急电话', 'tel', 'S'],
      ['dialCode', '电话国家/地区区号', 'dial code|country code|国家或地区电话区号|区号', 'text', ''],
      ['extension', '电话分机', 'extension|ext|phone extension|分机号', 'text', ''],
      ['email', '邮箱', 'email|e-mail|email address|邮箱地址|电子邮箱|电邮', 'email', 'S'],
      ['wechat', '微信号', 'wechat|weixin id|微信', 'text', ''],
      ['address', '现居住地址', 'current address|address|residential address|住址|现居住地|通讯地址', 'text', 'S'],
      ['addressEn', '英文地址', 'address in english|english address', 'textarea', ''],
      ['postalCode', '邮编', 'postal code|zip code|postcode|邮政编码', 'text', ''],
      ['city', '现居城市', 'current city|city|location|现居地|所在城市|所在地', 'text', ''],
      ['country', '国家/地区', 'country|region|country/region|国家', 'text', ''],
      ['emergencyName', '紧急联系人姓名', 'emergency contact name|紧急联系人', 'text', 'S'],
      ['emergencyRelation', '紧急联系人关系', 'emergency contact relation|与本人关系', 'text', ''],
      ['emergencyPhone', '紧急联系人电话', 'emergency contact number|紧急联系电话', 'tel', 'S'],
    ],
  },
  {
    k: 'education', zh: '教育经历', en: 'Education', maxItems: 4, fields: [
      ['school', '学校', 'school|university|college|institute|学校名称|毕业院校|就读学校', 'text', ''],
      ['schoolEn', '学校英文名', 'university english name|school (english)|学校英文', 'text', ''],
      ['degree', '学历', 'degree|qualification|education level|highest education|学历|最高学历', 'enum', 'O:degree'],
      ['degreeTitle', '学位', 'degree title|bachelor/master|学位|学士/硕士', 'enum', 'O:degreeTitle'],
      ['major', '专业', 'major|field of study|subject|specialization|专业|所学专业', 'text', ''],
      ['majorEn', '专业英文名', 'major (english)|field of study english', 'text', ''],
      ['minor', '辅修专业', 'minor|辅修|第二专业', 'text', ''],
      ['researchField', '研究方向', 'research area|research field|concentration|研究方向', 'text', ''],
      ['supervisor', '导师', 'supervisor|advisor|thesis advisor|导师|指导教师', 'text', ''],
      ['lab', '实验室/课题组', 'lab|laboratory|research group|课题组|实验室', 'text', ''],
      ['trainingMode', '培养方式', 'study mode|training mode|full time|学习形式|培养方式|全日制', 'enum', 'O:trainingMode'],
      ['enrollDate', '入学时间', 'start date|enrollment date|from|入学|开始时间', 'month', ''],
      ['gradDate', '毕业时间', 'graduation date|end date|to|毕业|毕业年月|结束时间', 'month', ''],
      ['graduateYear', '毕业年份', 'graduation year|expected graduation|毕业年份', 'year', ''],
      ['gpa', 'GPA', 'gpa|grade point average|绩点|平均绩点', 'text', ''],
      ['gpaScale', 'GPA 满分', 'gpa scale|out of 4|满分', 'text', ''],
      ['rank', '专业排名', 'class rank|ranking|percentile|专业排名|排名', 'text', ''],
      ['studentNumber', '学号', 'student id|student number|学号', 'text', 'S'],
      ['diplomaNumber', '毕业证/学位证编号', 'diploma number|certificate number|毕业证编号|学位证编号', 'text', 'S'],
      ['overseas', '是否海外学习', 'study abroad|overseas experience|海外学习经历', 'bool', ''],
      ['overseasYears', '海外停留年数', 'years overseas|overseas duration|境外连续停留时间', 'text', ''],
      ['verifiable', '学历是否可查（学信网）', 'verifiable|education verification|学信网可查', 'bool', ''],
      ['transcript', '成绩单说明', 'transcript|成绩单|主修课程', 'textarea', ''],
    ],
  },
  {
    k: 'work', zh: '工作经历', en: 'Work Experience', maxItems: 4, fields: [
      ['company', '公司', 'company|employer|organization|公司名称|工作单位|任职公司', 'text', ''],
      ['title', '职位', 'title|position|job title|role|designation|职位|职务|岗位', 'text', ''],
      ['department', '部门', 'department|team|division|部门|所属团队', 'text', ''],
      ['startDate', '开始时间', 'start date|from|joining date|入职时间|开始|开始时间|任职开始时间|work start date|employment start date', 'month', ''],
      ['endDate', '结束时间', 'end date|to|until|离开时间|结束|开始时间|结束时间|任职结束时间|work end date|employment end date', 'month', ''],
      ['current', '是否在职', 'current job|present|currently|是否在职', 'bool', ''],
      ['city', '工作城市', 'work location|job location|city|工作地点|工作城市', 'text', ''],
      ['summary', '工作内容', 'responsibilities|job description|duties|description|work content|工作内容|职责|工作描述|work duties', 'textarea', ''],
      ['achievements', '主要业绩', 'achievements|highlights|accomplishments|业绩|成果', 'textarea', ''],
      ['reason4leave', '离职原因', 'reason for leaving|why left|离职原因', 'text', ''],
      ['reportsTo', '汇报对象', 'reports to|supervisor|汇报对象', 'text', ''],
      ['teamSize', '团队规模', 'team size|subordinates|managed|下属人数', 'text', ''],
      ['salary', '薪资', 'salary|monthly salary|compensation|薪资|月薪', 'text', 'S'],
      ['industry', '行业', 'industry|sector|行业', 'text', ''],
    ],
  },
  {
    k: 'internship', zh: '实习经历', en: 'Internship Experience', maxItems: 4, fields: [
      ['company', '实习公司', 'company|internship company|实习单位|公司名称', 'text', ''],
      ['title', '实习岗位', 'position|intern title|role|实习岗位|职位', 'text', ''],
      ['department', '实习部门', 'department|team|部门', 'text', ''],
      ['startDate', '实习开始时间', 'start date|from|开始时间|实习开始时间|internship start date|intern start date', 'month', ''],
      ['endDate', '实习结束时间', 'end date|to|结束时间|实习结束时间|internship end date|intern end date', 'month', ''],
      ['city', '实习城市', 'location|city|实习地点', 'text', ''],
      ['summary', '实习内容', 'description|responsibilities|internship content|实习内容|工作描述|工作内容|工作职责|职责|duties', 'textarea', ''],
      ['offer', '是否获转正 offer', 'return offer|conversion|是否转正', 'bool', ''],
      ['durationMonths', '实习时长（月）', 'duration|internship duration|实习时长', 'num', ''],
    ],
  },
  {
    k: 'projects', zh: '项目经历', en: 'Projects', maxItems: 5, fields: [
      ['name', '项目名称', 'project name|project|title|项目名称|项目名', 'text', ''],
      ['role', '担任角色', 'role|responsibility|position|担任职责|角色', 'text', ''],
      ['org', '项目来源', 'organization|company|source|项目单位|所属组织', 'text', ''],
      ['startDate', '项目开始时间', 'start date|from|开始时间|项目开始时间|project start date', 'month', ''],
      ['endDate', '项目结束时间', 'end date|to|结束时间|项目结束时间|project end date', 'month', ''],
      ['description', '项目描述', 'description|details|background|project description|项目描述|项目背景|内容', 'textarea', ''],
      ['techStack', '技术栈', 'technologies|tech stack|tools|skills used|技术栈|使用技术', 'text', 'L'],
      ['outcome', '项目成果', 'outcome|result|achievement|impact|项目成果|业绩', 'textarea', ''],
      ['url', '项目链接', 'project link|portfolio|url|github|项目地址', 'url', ''],
      ['teamSize', '团队人数', 'team size|团队规模', 'num', ''],
      ['isPersonal', '是否个人项目', 'personal project|side project|个人项目', 'bool', ''],
    ],
  },
  {
    k: 'campus', zh: '校园经历', en: 'Campus Activities', maxItems: 3, fields: [
      ['org', '组织名称', 'organization|club|society|学生组织|社团名称', 'text', ''],
      ['role', '职务', 'position|role|title|职务|担任|校园担任职务|campus role', 'text', ''],
      ['startDate', '校园活动开始时间', 'start date|from|开始时间|校园活动开始时间|campus start date|activity start date', 'month', ''],
      ['endDate', '校园活动结束时间', 'end date|to|结束时间|校园活动结束时间|campus end date|activity end date', 'month', ''],
      ['summary', '校园活动内容', 'description|responsibilities|activity description|工作内容|活动描述|校园活动内容|campus activity content', 'textarea', ''],
      ['scale', '组织规模', 'scale|members|人数规模', 'text', ''],
    ],
  },
  {
    k: 'awards', zh: '奖项荣誉', en: 'Awards & Honors', maxItems: 6, fields: [
      ['title', '奖项名称', 'award|honor|prize|title|奖项名称|荣誉', 'text', ''],
      ['level', '获奖等级', 'level|award level|等级|一等奖/银奖', 'enum', 'O:awardLevel'],
      ['issuer', '颁发机构', 'issuer|grantor|awarded by|颁发单位', 'text', ''],
      ['date', '获奖时间', 'date|award date|year|获奖时间|年份', 'month', ''],
      ['rank', '名次/比例', 'rank|placement|top|比例|名次', 'text', ''],
    ],
  },
  {
    k: 'competitions', zh: '竞赛经历', en: 'Competitions', maxItems: 3, fields: [
      ['name', '竞赛名称', 'competition|contest|hackathon|competition name|竞赛名称', 'text', ''],
      ['level', '级别', 'level|national|international|竞赛级别|国家级/省级', 'enum', 'O:awardLevel'],
      ['award', '获奖情况', 'result|prize|award|获奖|成绩', 'text', ''],
      ['date', '时间', 'date|year|competition date|时间|竞赛时间|competition time|contest date', 'month', ''],
      ['team', '队伍信息', 'team|teammates|队伍|队员', 'text', ''],
      ['role', '分工', 'role|responsibility|负责内容', 'text', ''],
    ],
  },
  {
    k: 'publications', zh: '论文/专利/软著', en: 'Publications & IP', maxItems: 3, fields: [
      ['title', '标题', 'title|publication|paper title|patent title|论文标题|专利名称', 'text', ''],
      ['type', '类型', 'type|category|paper|patent|类型|论文/专利', 'enum', 'O:ipType'],
      ['venue', '发表刊物/会议', 'venue|journal|conference|publisher|刊物|会议', 'text', ''],
      ['status', '状态', 'status|accepted|published|under review|状态|已录用/在投', 'enum', 'O:paperStatus'],
      ['date', '发表时间', 'date|year|published|发表时间|publication date|publish date', 'month', ''],
      ['authorOrder', '作者排序', 'author order|first author|corresponding|作者顺序|第几作者', 'text', ''],
      ['number', '编号', 'patent number|doi|isbn|id|专利号|DOI', 'text', ''],
      ['url', '链接', 'link|url|paper url|链接', 'url', ''],
    ],
  },
  {
    k: 'skills', zh: '技能与工具', en: 'Skills', fields: [
      ['programming', '编程语言', 'programming languages|languages|coding skills|编程语言|开发语言', 'text', 'L'],
      ['frameworks', '框架/库', 'frameworks|libraries|tools|框架|技术栈', 'text', 'L'],
      ['tools', '工具', 'tools|software|ide|常用工具|软件', 'text', 'L'],
      ['domain', '专业领域', 'domain|expertise|skills|专业方向|技能领域', 'text', 'L'],
      ['office', '办公软件', 'ms office|excel|ppt|办公软件', 'text', 'L'],
      ['level', '熟练程度', 'proficiency|skill level|熟练度', 'enum', 'O:proficiency'],
      ['selfAssessment', '技能自评', 'self assessment|skills summary|技能自我评价', 'textarea', ''],
    ],
  },
  {
    k: 'languages', zh: '语言能力', en: 'Languages', maxItems: 4, fields: [
      ['language', '语言', 'language|语言能力|语种', 'text', ''],
      ['level', '水平', 'level|proficiency|horizontal|水平|熟练度', 'enum', 'O:langLevel'],
      ['listening', '听力', 'listening|听力', 'enum', 'O:langLevel'],
      ['speaking', '口语', 'speaking|oral|口语', 'enum', 'O:langLevel'],
      ['reading', '阅读', 'reading|阅读', 'enum', 'O:langLevel'],
      ['writing', '写作', 'writing|写作', 'enum', 'O:langLevel'],
      ['cert', '语言证书', 'certificate|test|cet|ielts|toefl|语言证书|四六级', 'text', ''],
      ['score', '语言成绩', 'score|band|成绩|分数', 'text', ''],
    ],
  },
  {
    k: 'certifications', zh: '证书与资格', en: 'Certifications', maxItems: 5, fields: [
      // 裸词 'name' 不属于这里：一页有 5 个「Name」时，"name" 就是"这一块的名字栏"这个**列名**，
      // 不是"姓名"。用户 2026-10-02 的诊断——"你把 name 识别成为 姓名，而不是 name"。
      // 想要证书名称的栏位必须自己说清楚（certificate/certification/…），否则宁可留空。
      ['name', '证书名称', 'certificate|certification|license|证书名称|资格证书|certificate name|certification name|qualification', 'text', ''],
      ['number', '证书编号', 'certificate number|license number|编号', 'text', 'S'],
      ['issuer', '发证机构', 'issuer|awarded by|颁发机构', 'text', ''],
      ['issueDate', '获证时间', 'issue date|date obtained|获证时间', 'month', ''],
      ['expiryDate', '有效期至', 'expiry date|valid until|有效期', 'date', ''],
      ['url', '证书链接', 'verification link|url|查询链接', 'url', ''],
    ],
  },
  {
    k: 'intent', zh: '求职意向', en: 'Job Preferences', fields: [
      ['position', '意向岗位', 'desired position|preferred job|objective|applied position|意向职位|求职意向', 'text', ''],
      ['position2', '备选岗位', 'secondary preference|alternative position|第二志愿|备选岗位', 'text', ''],
      ['cities', '意向城市', 'preferred city|desired location|work location|意向城市|期望工作地|工作地点', 'text', 'L'],
      ['acceptRelocation', '是否接受调剂/异地', 'relocation|accept transfer|是否接受调剂|服从分配|接受调剂|是否接受工作地点调剂|可接受调剂公司|期望工作性质', 'bool', ''],
      ['acceptPositionAdjust', '是否接受岗位调剂', 'position adjustment|accept role adjustment|是否接受岗位调剂|岗位调剂', 'bool', ''],
      ['interviewCity', '面试地点', 'interview location|interview city|面试地点|意向面试城市|期望面试地点|面试城市', 'text', ''],
      ['availableDate', '最早到岗时间', 'available date|available from|earliest available date|earliest start date|到岗时间|最早入职|可入职时间', 'date', ''],
      ['durationMonths', '可实习时长（月）', 'internship duration|available months|duration|实习时长|可实习几个月', 'num', ''],
      ['weeklyDays', '每周可出勤天数', 'days per week|weekly availability|每周天数|实习天数', 'num', ''],
      ['salary', '期望薪资', 'expected salary|salary expectation|desired compensation|ctc|expected ctc|薪资要求|期望薪水', 'text', 'S'],
      ['currency', '薪资币种', 'currency|salary currency|币种|人民币/港币', 'text', ''],
      ['contractType', '可签协议类型', 'agreement type|tripartite|三方协议|就业协议类型', 'enum', 'O:contractType'],
      ['acceptOvertime', '是否接受加班/排班', 'overtime|shift|是否接受加班|可倒班', 'bool', ''],
      ['acceptDispatch', '是否接受外派', 'dispatch|overseas assignment|relocation allowance|是否接受外派|常驻境外', 'bool', ''],
      ['remote', '办公形式偏好', 'remote|hybrid|onsite|work arrangement|办公方式', 'enum', 'O:workMode'],
      ['gradStatus', '应届身份', 'fresh graduate|graduating|student status|应届|在读状态', 'enum', 'O:gradStatus'],
      ['batch', '应聘批次', 'batch|campus batch|application round|批次|提前批/正式批', 'text', ''],
      ['channel', '信息来源', 'how did you hear|source|channel|information source|从哪里了解到|招聘渠道', 'enum', 'O:channel'],
      ['referralName', '内推人姓名', 'referral|referred by|referrer|内推人|推荐人', 'text', ''],
      ['referralCode', '内推码', 'referral code|invitation code|内推码|推荐码', 'text', ''],
      ['hasRelative', '是否有亲友在公司', 'relative in company|family member employed|是否有亲属在职', 'bool', ''],
      ['previousInterview', '是否参加过本公司面试', 'previously interviewed|reapply|previous application|是否曾面试', 'bool', ''],
      ['willingnessNote', '其他意向说明', 'additional preference|comments|其他意向说明', 'textarea', ''],
    ],
  },
  {
    k: 'hkGlobal', zh: '港企/海外合规', en: 'Work Authorization (HK & Overseas)', fields: [
      ['workAuth', '工作许可身份', 'work authorization|right to work|working status|visa status|工作许可|合法工作身份', 'enum', 'O:workAuth'],
      ['needSponsorship', '是否需要签证担保', 'do you require sponsorship|visa sponsorship required|need work visa|是否需要担保|签证赞助', 'bool', ''],
      ['visaType', '当前签证类型', 'visa type|current visa|identification type|签证类型|身份证类型', 'text', ''],
      ['idForWork', '工作证件号码', 'hkid|social security number|ssn|work permit number|身份证（工作）', 'text', 'S'],
      ['taxResidency', '税务居民身份', 'tax residency|tax resident country|where are you a tax resident|税务居民', 'text', ''],
      ['nationalIdCountry', '证件签发国家', 'country of issue|issuing country|签发国家', 'text', ''],
      ['expectedCtc', '期望总薪酬（港币）', 'expected remuneration|desired package|expected salary (hkd)|期望薪酬', 'text', 'S'],
      ['currentCtc', '当前总薪酬', 'current remuneration|current package|current salary|目前薪酬', 'text', 'S'],
      ['noticePeriod', '通知期', 'notice period|how much notice do you need to give|离职通知期', 'text', ''],
      ['references', '推荐人', 'reference|referee|recommendation provider|推荐人', 'text', ''],
      ['referenceName1', '推荐人1 姓名', 'reference 1 name|referee name|推荐人姓名', 'text', ''],
      ['referenceRelation1', '推荐人1 关系', 'reference 1 relation|relationship|与推荐人关系', 'text', ''],
      ['referenceContact1', '推荐人1 联系方式', 'reference 1 email|contact|推荐人邮箱', 'text', 'S'],
      ['drivingLicense', '驾照', 'driving license|driver license|驾照|准驾车型', 'text', ''],
      ['militaryService', '兵役情况', 'military service|national service|conscientious objector|兵役', 'text', ''],
      ['veteran', '是否退伍军人', 'veteran|protected veteran|disabled veteran|退役/军人', 'bool', ''],
      ['disability', '是否申报残障', 'disability|reasonable accommodation|disabled veteran status|残障申报', 'bool', 'S'],
      ['overseasStay', '境外连续停留天数', 'overseas stay days|consecutive days abroad|境外连续停留', 'text', ''],
      ['timeZoneOk', '是否接受跨时区协作', 'timezone flexibility|work across timezones|跨时区', 'bool', ''],
      ['startFlexibility', '入职灵活度', 'flexible start|earliest availability|入职灵活度', 'text', ''],
    ],
  },
  {
    k: 'records', zh: '档案与政审', en: 'Records & Background', fields: [
      ['dossierLocation', '档案所在地', 'dossier location|personnel file location|档案所在地|人才市场', 'text', ''],
      ['noCriminal', '有无犯罪记录', 'criminal record|no criminal record|有无犯罪记录|无违法犯罪', 'bool', ''],
      ['discipline', '违纪处分情况', 'disciplinary record|school discipline|违纪|处分记录', 'text', ''],
      ['dischargeStatus', '退出现役情况', 'discharge status|retired military|退役情况', 'text', ''],
      ['publicOfficial', '是否为公职人员亲属', 'public official relative|government official family|公职亲属', 'bool', ''],
      ['signedOthers', '是否已与其他单位签约', 'signed with other company|三方已签|是否已签其他单位', 'bool', ''],
      ['backgroundOk', '是否接受背景调查', 'background check|consent to screening|是否接受背调', 'bool', ''],
      ['bankAccount', '工资卡开户行', 'bank account|salary account|开户行|银行卡号', 'text', 'S'],
    ],
  },
  {
    k: 'family', zh: '家庭成员', en: 'Family Members', maxItems: 4, fields: [
      // 同上：家庭成员的「姓名」不能靠裸词 name 抢 —— 抢走一次，就把家属名字写进了页面某个
      // 叫 Name 的栏位（证书、项目、推荐人都会中招）。要它就得说"family member / member name"。
      ['name', '家属姓名', 'family member name|成员姓名|member name|relative name|家属姓名|姓名', 'text', 'S'],
      ['relation', '与本人关系', 'relation|relationship|family relation|称谓|关系', 'text', ''],
      ['birthYear', '家属出生年份', 'birth year|year of birth|出生年月|家属出生年份|family member birth year', 'year', ''],
      ['employer', '工作单位', 'employer|work unit|company|工作单位|职业', 'text', ''],
      ['position', '家属职务', 'position|title|occupation|职务|职业|家属职务|family member position|occupation', 'text', ''],
      ['political', '家属政治面貌', 'political status|政治面貌|家属政治面貌|family member political status', 'text', ''],
      ['phone', '联系电话', 'contact number|phone|联系电话|家属联系电话|family member phone', 'tel', 'S'],
    ],
  },
  {
    k: 'others', zh: '补充信息', en: 'Additional Information', fields: [
      ['selfIntro', '自我评价', 'self introduction|self assessment|about me|summary|profile|自我评价|个人总结', 'textarea', ''],
      ['whyCompany', '为什么选择我们', 'why us|motivation|why do you want to join|cover letter|选择原因|求职动机', 'textarea', ''],
      ['careerPlan', '职业规划', 'career plan|career objective|5 year plan|职业规划|发展目标', 'textarea', ''],
      ['strength', '个人优势', 'strengths|key strengths|core competencies|个人优势|特长', 'textarea', ''],
      ['weakness', '待改进项', 'weakness|areas of improvement|缺点|不足', 'textarea', ''],
      ['hobbies', '兴趣爱好', 'hobbies|interests|个人爱好|兴趣', 'text', ''],
      ['portfolio', '作品集链接', 'portfolio|personal site|作品集', 'url', ''],
      // personalSite / socialPlatform 以前只存在于 EXTRA_ALIASES 与示例资料里，
      // SECTIONS 里没这两个字段 —— 别名补丁对不存在的路径是静默失效的，导入时"个人网站"就无处可落
      ['personalSite', '个人网站', 'personal website|website url|website|webpage|个人主页|网站|博客', 'url', ''],
      ['socialPlatform', '社交平台账号', 'social media|social platform|weibo|xiaohongshu|社交平台|社交媒体', 'text', ''],
      ['github', 'GitHub', 'github|git hub|code profile|开源主页', 'url', ''],
      ['linkedin', 'LinkedIn', 'linkedin|领英', 'url', ''],
      ['otherInfo', '其他需要说明', 'additional information|anything else|notes|补充说明|备注', 'textarea', ''],
      ['sourceResume', '原始简历文本', 'resume|cv|upload resume|简历|上传简历', 'textarea', ''],
    ],
  },
];

// 枚举候选值：既用于 profile 编辑，也用于把站点 option 文本归一化后回填。
export const OPTION_SETS = {
  gender: ['男', '女', '保密', 'Male', 'Female', 'Prefer not to say'],
  idType: ['中国居民身份证', '护照', '港澳居民来往内地通行证', '台湾居民来往大陆通行证', 'HKID', 'Passport', 'Driver License', '其他'],
  hukouType: ['城镇', '农村', '居民户口', '无'],
  political: ['群众', '共青团员', '中共党员', '中共预备党员', '民主党派', '无党派人士'],
  marital: ['未婚', '已婚', '离异', '保密'],
  degree: ['高中/中专', '大专', '本科', '硕士', '博士', '博士后', 'Bachelor', 'Master', 'PhD', 'Other'],
  degreeTitle: ['学士', '硕士', '博士', '双学士', '无', 'Bachelor', 'Master', 'Doctorate'],
  trainingMode: ['全日制', '非全日制', '在职', '自考', '统招全日制', 'Full-time', 'Part-time'],
  awardLevel: ['国家级', '省级', '市级', '校级', '一等奖', '二等奖', '三等奖', '金奖', '银奖', '铜奖', '入围'],
  ipType: ['论文', '专利', '软件著作权', '技术标准', '开源项目', 'Journal Paper', 'Conference Paper', 'Patent'],
  paperStatus: ['已发表', '已录用', '在投', '审中', 'Published', 'Accepted', 'Under Review'],
  proficiency: ['了解', '熟悉', '熟练', '精通', 'Basic', 'Intermediate', 'Advanced', 'Expert'],
  langLevel: ['一般', '良好', '熟练', '母语', '工作语言', 'Basic', 'Conversational', 'Fluent', 'Native'],
  contractType: ['三方协议', '两方协议', '劳动合同', '劳务派遣', '实习协议', '暂不签约'],
  workMode: ['现场办公', '混合办公', '远程', 'Onsite', 'Hybrid', 'Remote'],
  gradStatus: ['应届毕业生', '毕业一年内', '已毕业', '在读', 'Fresh Graduate', 'Graduating', 'Alumni'],
  channel: ['官网', '牛客', '应届生求职网', '学校就业网', '学长学姐内推', 'LinkedIn', 'Company Website', 'Careers Fair', 'Referral', '其他'],
  workAuth: ['本地居民', '公民', '永久居民', 'IANG（内地应届毕业生留港计划）', '持工作签证', '学生签证（可兼职/OPT/CPT）', '需申请工作签证', 'Citizen', 'Permanent Resident', 'Holder of Employment Visa', 'Require Sponsorship'],
};

/**
 * 中英值等价表：profile 里存中文，站点下拉却是英文（反之亦然）。
 * 没有这一层，"硕士"永远匹配不上 option "Master"，英文表单的枚举字段会整片失败。
 */
export const VALUE_EQUIVALENTS = [
  ['硕士', '硕士研究生', 'Master', 'MPhil', 'MSc', 'M.S.', 'MBA'],
  ['本科', '学士', 'Bachelor', 'BSc', 'BEng', 'B.A.', 'Undergraduate'],
  ['博士', 'PhD', 'Doctorate', 'Doctor of Philosophy'],
  ['大专', '专科', 'Diploma', 'Associate Degree'],
  ['全日制', '统招全日制', 'Full-time', 'Full Time'],
  ['非全日制', '在职', 'Part-time', 'Part Time'],
  ['男', 'Male', 'M'],
  ['女', 'Female', 'F'],
  ['是', '有', '同意', '接受', 'Yes', 'Y', 'True'],
  ['否', '无', '不同意', '不接受', 'No', 'N', 'False'],
  ['中共党员', 'CPC Member', 'Party Member'],
  ['共青团员', 'CYL Member'],
  ['群众', 'Non-party Member', 'Ordinary Citizen'],
  ['应届毕业生', 'Fresh Graduate', 'Recent Graduate', 'Graduating Student'],
  ['精通', 'Expert', 'Proficient', 'Advanced'],
  ['熟练', 'Good', 'Well', 'Working Knowledge'],
  ['母语', 'Native', 'Native Speaker', '母语水平'],
  ['流利', 'Fluent', 'Professional', '工作语言'],
  ['本地居民', 'Permanent Resident', 'PR', 'HK Permanent Resident'],
  // IANG = 内地应届毕业生来港留港计划（Insertion Admission Scheme）。港企表单里它是独立一项，
  // 但对"有没有工作许可 / 需不需要担保"这两个问题，答案与永久居民同向：有权工作、无需担保。
  ['IANG', 'IANG签证', '内地应届毕业生留港计划', '内地高校毕业留港计划', 'Insertion Admission Scheme', 'Non-local Graduate'],
  ['公民', 'Citizen', 'Hong Kong Citizen'],
  ['需申请工作签证', 'Require Sponsorship', 'Need Visa', 'Would require sponsorship'],
  ['现场办公', 'Onsite', 'On-site'],
  ['混合办公', 'Hybrid'],
  ['远程', 'Remote', 'Work from home'],
  ['中国居民身份证', 'PRC Identity Card', 'Chinese ID Card'],
  ['护照', 'Passport'],
];

/**
 * 国别 / 省市的写法对照（S4）。以前只有一句话等价表，`equivalentsOf('中国')` 返回的仍是"中国"，
 * 于是英文门户的 `Country/Territory of Residence`、`Nationality` 这类下拉一个都选不上
 * （页面上写的是 China / CN，我们存的是"中国"）。
 * 学自动填充实现的做法：值的规范化单独一层，把"中文名 ↔ 英文名 ↔ 两位码"连起来。
 * 只收网申里真会出现的常见项；查不到就原样交给选项文本匹配，不硬猜。
 *
 * 组内顺序有讲究：**第一个拉丁写法就是英文页面上要显示的那一个**
 * （englishOption / geoEnglishFor 都取第一个拉丁项），所以
 * 常用写法排前面（'China' 而不是 'PRC'，'South Korea' 而不是 'Korea'）。
 * 比较一律走小写归一化，写成首字母大写不会影响匹配。
 */
export const GEO_EQUIVALENTS = [
  ['中国', '中华人民共和国', 'China', "People's Republic of China", 'PRC', 'CN', 'CHN'],
  ['中国香港', '香港', 'Hong Kong', 'Hong Kong SAR', 'HK', 'HKG'],
  ['中国澳门', '澳门', 'Macao', 'Macau', 'MO'],
  ['中国台湾', '台湾', 'Taiwan', 'TW'],
  ['美国', 'United States', 'USA', 'United States of America', 'US'],
  ['英国', 'United Kingdom', 'UK', 'Great Britain', 'England'],
  ['加拿大', 'Canada', 'CA'],
  ['澳大利亚', 'Australia', 'AU'],
  ['新加坡', 'Singapore', 'SG'],
  ['日本', 'Japan', 'JP'],
  ['韩国', '大韩民国', 'South Korea', 'Republic of Korea', 'Korea', 'KR'],
  ['德国', 'Germany', 'DE'], ['法国', 'France', 'FR'], ['荷兰', 'Netherlands', 'NL'],
  ['瑞士', 'Switzerland', 'CH'], ['爱尔兰', 'Ireland', 'IE'], ['印度', 'India', 'IN'],
  ['北京', 'Beijing', 'BJ'], ['上海', 'Shanghai', 'SH'], ['天津', 'Tianjin'],
  ['重庆', 'Chongqing'],
  ['广东', 'Guangdong', 'GD'], ['深圳', 'Shenzhen', 'SZ'], ['广州', 'Guangzhou', 'Canton'],
  ['浙江', 'Zhejiang', 'ZJ'], ['杭州', 'Hangzhou', 'HZ'], ['江苏', 'Jiangsu', 'JS'], ['南京', 'Nanjing'],
  ['四川', 'Sichuan', 'SC'], ['成都', 'Chengdu', 'CD'], ['湖北', 'Hubei'], ['武汉', 'Wuhan'],
  ['陕西', 'Shaanxi'], ['西安', 'Xian'], ['山东', 'Shandong'], ['济南', 'Jinan'], ['青岛', 'Qingdao'],
  ['哈尔滨', 'Harbin'], ['长沙', 'Changsha'], ['厦门', 'Xiamen'], ['福州', 'Fuzhou'],
];

export const VALUE_EQUIVALENTS_ALL = [...VALUE_EQUIVALENTS, ...GEO_EQUIVALENTS];

/**
 * 整个取值就是一个地名时，给出英文页面上要写的那个写法；否则返回空。
 *
 * 为什么单独一条出口，而不是并进 englishOption：英文表单缺值时默认**不写**（用户明确要求），
 * 但国别/城市不是"另外一份资料"，只是同一个事实换了写法 ——
 * 港企门户的 Country of Residence 因为"缺英文"而留空，是这批页面上最常空着的一栏，
 * 而我们有对照表，可以直接换算，不用催用户再抄一遍。
 *
 * 只认"整条相等"：'深圳市南山区' 换不出对应英文名，硬换算会写成 'Shenzhen 南山区' 这种半截话，
 * 那种情况照旧进"缺英文"名单，交人工判断。
 */
export function geoEnglishFor(value) {
  const key = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const v = key(value);
  if (!v) return '';
  for (const group of GEO_EQUIVALENTS) {
    if (!group.some(x => key(x) === v)) continue;
    const latin = group.find(x => LATIN_LABEL.test(String(x).trim()));
    return latin ? String(latin) : '';
  }
  return '';
}

export function equivalentsOf(value) {
  const v = String(value || '').trim().toLowerCase();
  if (!v) return [];
  const out = new Set([v]);
  for (const group of VALUE_EQUIVALENTS_ALL) {
    if (group.some(x => x.toLowerCase() === v)) group.forEach(x => out.add(x.toLowerCase()));
  }
  return [...out];
}

const SENSITIVE = 'S';
const MULTI = 'L';

function parseField(tuple, sectionKey, indexInSection) {
  const [key, zh, aliasStr, type, flags = ''] = tuple;
  const labels = [zh, ...(aliasStr || '').split('|').map(s => s.trim())].filter(Boolean);
  const options = flags.startsWith('O:') || flags.includes('O:')
    ? OPTION_SETS[(flags.match(/O:(\w+)/) || [])[1]] || []
    : [];
  return {
    path: indexInSection === null ? `${sectionKey}.${key}` : `${sectionKey}.${indexInSection}.${key}`,
    key,
    section: sectionKey,
    itemIndex: indexInSection,
    zh: zh.trim(),
    labels: labels.map(l => String(l).trim().toLowerCase()),
    type,
    options,
    sensitive: flags.includes(SENSITIVE),
    multi: flags.includes(MULTI),
  };
}

/**
 * 展平全部字段。list 型 section 按 maxItems 展开成 0..n-1 的槽位，
 * 这样匹配阶段可以直接把"页面上的第 2 段工作经历"映射到 work.1.company。
 */
export function buildFields() {
  const out = [];
  for (const section of SECTIONS) {
    if (section.maxItems) {
      for (let i = 0; i < section.maxItems; i++) {
        for (const tuple of section.fields) out.push(applyExtraAliases(parseField(tuple, section.k, i)));
      }
    } else {
      for (const tuple of section.fields) out.push(applyExtraAliases(parseField(tuple, section.k, null)));
    }
  }
  return out;
}

/** 有值的槽位数：侧边栏、内容脚本、体检共用同一套算法，避免"计划填 0"被误读成词典不行 */
export function countFilled(profile) {
  let n = 0;
  if (!profile) return 0;
  for (const f of buildFields()) if (String(getValueByPath(profile, f.path) ?? '').trim()) n++;
  return n;
}

export function createEmptyProfile() {
  const profile = {};
  for (const section of SECTIONS) {
    profile[section.k] = section.maxItems
      ? Array.from({ length: section.maxItems }, () => {
        const item = {};
        for (const t of section.fields) item[t[0]] = '';
        return item;
      })
      : (() => {
        const obj = {};
        for (const t of section.fields) obj[t[0]] = '';
        return obj;
      })();
  }
  // 英文取值放这个稀疏子树里（en.education.0.school）。
  // 为什么不给 537 个槽位各加一个 *En 字段：那会把 schema 翻倍，而绝大多数栏位根本不需要英文
  // （日期、数字、邮箱、链接、性别这类"选一项"的控件），它们两种语言下就是同一个值。
  // 空白模板也要带完整骨架：用户把 JSON 下载下来手写英文时，得看得见该写在哪 ——
  // en 是 {} 就等于"界面有框、文件没坑"，手写无处落脚。
  profile.en = enSkeleton();
  return profile;
}

export function getValueByPath(obj, path) {
  let cur = obj;
  for (const seg of String(path || '').split('.')) {
    if (cur == null) return '';
    cur = cur[seg];
  }
  return cur == null ? '' : cur;
}

export function setValueByPath(obj, path, value) {
  const segs = String(path).split('.');
  let cur = obj;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i];
    if (cur[seg] === undefined) cur[seg] = /^\d+$/.test(segs[i + 1]) ? [] : {};
    cur = cur[seg];
  }
  cur[segs[segs.length - 1]] = value;
  return obj;
}

export function sectionOf(key) {
  return SECTIONS.find(s => s.k === key) || null;
}

/**
 * ── 中英两份取值 ───────────────────────────────────────────────────────
 * 中文档法与英文写法都存在同一份 profile 里：中文在原路径，英文在 `en.<原路径>`。
 * 只有"真的要按语言写两种文字"的栏位需要英文值；下面这些类型两种语言是同一个值，
 * 不复制、也不该要求用户填两遍。
 */
export const EN_BUCKET = 'en';
export const LANG_NEUTRAL_TYPES = new Set(['date', 'year', 'month', 'num', 'number', 'tel', 'email', 'url', 'file', 'enum', 'bool']);

/** 这一栏是否"不需要第二份写法"（日期/数字/邮箱/下拉选项…，以及本来就指定了语言的文字栏位） */
export function isLangNeutral(field) {
  const type = String(field?.type || '').toLowerCase();
  if (LANG_NEUTRAL_TYPES.has(type)) return true;
  const key = String(field?.path || '').split('.').pop() || '';
  // 「中文姓 / 中文名」这类栏位就是给中文用的，再要一份英文值是折磨用户
  if (/中文|汉语/.test(String(field?.zh || '')) || /Zh$/.test(key)) return true;
  // 「学校英文名 / 英文地址」这类 *En 栏位的取值本身就是英文：
  // 再套一层 en.education.0.schoolEn 等于要用户在英文栏旁边再写一遍英文，
  // 更糟的是英文表单会读那个空壳、把已经填好的英文名当成"缺英文"留空。
  if (/En$/.test(key)) return true;
  return false;
}

const enPath = path => `${EN_BUCKET}.${path}`;

/**
 * 英文骨架：把"确实需要另一种文字"的栏位在 en 子树里摆成空串，结构与中文侧一一对应。
 * 只收非语言中立的栏位（日期 / 数字 / 邮箱 / 下拉这类两种语言同一个值，见 isLangNeutral）：
 * 全量 537 个槽位里有 210 个根本不需要英文，给它们留一排永远为空的框，
 * 和 en 是 {} 一样会让人猜"到底该不该填"。
 * 列表槽位预先补足长度，避免 JSON 里出现 null 洞（稀疏数组序列化就变 [null,null,...]）。
 */
export function enSkeleton(fields = buildFields()) {
  const root = {};
  for (const f of fields) {
    if (isLangNeutral(f)) continue;
    const segs = String(f.path).split('.');
    let cur = root;
    for (let i = 0; i < segs.length - 1; i++) {
      const seg = segs[i];
      const wantArray = /^\d+$/.test(segs[i + 1]);
      if (cur[seg] === undefined || cur[seg] === null) cur[seg] = wantArray ? [] : {};
      if (wantArray && Array.isArray(cur[seg])) {
        const idx = Number(segs[i + 1]);
        while (cur[seg].length <= idx) cur[seg].push({});
      }
      cur = cur[seg];
    }
    cur[segs[segs.length - 1]] = '';
  }
  return root;
}

/** 只补空缺、绝不覆盖：叶子有值（含用户手写的英文）一律留着 */
function mergeMissing(dst, src) {
  if (Array.isArray(src)) {
    const out = Array.isArray(dst) ? dst : [];
    src.forEach((sv, i) => { out[i] = mergeMissing(out[i], sv); });
    return out;
  }
  if (src && typeof src === 'object') {
    const out = dst && typeof dst === 'object' && !Array.isArray(dst) ? dst : {};
    for (const [k, sv] of Object.entries(src)) out[k] = mergeMissing(out[k], sv);
    return out;
  }
  return dst === undefined ? src : dst;
}

/**
 * 给一份已有资料补齐英文骨架（就地改并返回它）。
 * 老资料、从别处导入的 JSON、AI/简历解析的产物里 en 可能是 {} 或只有几栏；
 * 补齐后界面与导出文件看到的是同一副完整的框。
 */
export function ensureEnSkeleton(profile) {
  if (!profile || typeof profile !== 'object') return profile;
  const prev = profile.en && typeof profile.en === 'object' && !Array.isArray(profile.en) ? profile.en : {};
  profile.en = mergeMissing(prev, enSkeleton());
  return profile;
}

/**
 * 读某一语言栏位的值。
 * 英文模式下若该栏没英文值，返回 ''（不自动回退成中文）——
 * 回不退是策略决定，交给调用方：静默把中文写进英文表单是最难发现的错填。
 */
export function readLang(profile, path, lang = 'zh', { neutral = false, field = null } = {}) {
  const base = String(getValueByPath(profile, path) ?? '');
  if (lang !== 'en' || neutral || isLangNeutral(field || { path })) return base;
  const en = String(getValueByPath(profile, enPath(path)) ?? '');
  if (en) return en;
  // 值里本来就没有中日韩字符（拼音姓名 Zhang/Wei、China、数字）——英文表单要的就是它，
  // 不该在编辑区显示成"空着等你补英文"。
  return valueNeedsEnglish(base) ? '' : base;
}

export function writeLang(profile, path, lang = 'zh', value = '') {
  const target = lang === 'en' && !String(path).startsWith(`${EN_BUCKET}.`) ? enPath(path) : path;
  setValueByPath(profile, target, value);
  return profile;
}

const CJK_RE = /[\u3400-\u9fff]/;

/** 这个中文值在英文表单上是否本来就能用（没中日韩字符 → 能用：拼音姓名、China、数字…） */
export function valueNeedsEnglish(zhValue) {
  return CJK_RE.test(String(zhValue || ''));
}

/** 该栏在英文模式下是否"必须有英文值但还没有" */
export function lacksEnglishValue(profile, field) {
  if (isLangNeutral(field)) return false;
  const zh = String(getValueByPath(profile, field.path) ?? '').trim();
  if (!zh || !valueNeedsEnglish(zh)) return false;   // 没填、或本来就没中文 → 不算缺英文
  return !String(getValueByPath(profile, enPath(field.path)) ?? '').trim();
}

/** 英文取值完成度（编辑器顶部提示用：还有几栏需要补英文写法） */
export function englishCoverage(profile, fields = buildFields()) {
  const need = fields.filter(f => !isLangNeutral(f)
    && valueNeedsEnglish(String(getValueByPath(profile, f.path) ?? '')));
  const done = need.filter(f => String(getValueByPath(profile, enPath(f.path)) ?? '').trim());
  return { need: need.length, done: done.length, missing: need.filter(f => !String(getValueByPath(profile, enPath(f.path)) ?? '').trim()) };
}

const LATIN_LABEL = /^[A-Za-z][A-Za-z0-9 ()/'.\-]*$/;

/** 栏位的英文显示名：取匹配词典里第一个纯拉丁别名，标题式大写。词典本来就是中英混排的。 */
/**
 * 英文显示名：只用于界面与导出，**不参与匹配**（匹配走 labels）。
 * 为什么必须显式写出来：以前英文名是从别名里"挑第一个拉丁词"挑出来的，于是
 * work / internship / projects / campus 四个板块的开始时间全叫 'Start Date'，
 * 「本人姓名」和「家属姓名」全叫 'Name' —— English 表单里根本分不清哪一格是哪个，
 * AI 拿这份名字表去对也会认错（2026-10-02 要求：en 和 zh 都不许重名）。
 * 键是"板块.字段"（列表槽位去掉条号），没列出来的仍走原来的推导。
 */
export const EN_DISPLAY_NAMES = {
      'work.title': 'Job Title',
  'work.teamSize': 'Work Team Size',
    'education.enrollDate': 'Education Start Date', 'internship.department': 'Internship Department',
  'internship.startDate': 'Internship Start Date', 'internship.endDate': 'Internship End Date', 'internship.company': 'Internship Company',
  'internship.title': 'Internship Position', 'internship.summary': 'Internship Description',
  'projects.startDate': 'Project Start Date', 'projects.endDate': 'Project End Date', 'projects.role': 'Project Role',
  'projects.org': 'Project Organization', 'projects.description': 'Project Description', 'projects.teamSize': 'Project Team Size',
  'campus.startDate': 'Campus Activity Start Date', 'campus.endDate': 'Campus Activity End Date', 'campus.role': 'Campus Role',
  'campus.org': 'Campus Organization', 'campus.summary': 'Campus Activity Description',
  'awards.date': 'Award Date', 'awards.level': 'Award Level', 'awards.issuer': 'Award Issuer',
  'competitions.date': 'Competition Date', 'competitions.role': 'Competition Role', 'competitions.level': 'Competition Level',
  'publications.date': 'Publication Date', 'publications.title': 'Publication Title',
  'certifications.issuer': 'Certifying Body', 'certifications.name': 'Certificate Name',
  'languages.cert': 'Language Certificate', 'languages.level': 'Language Level',
  'family.name': 'Family Member Name', 'family.birthYear': 'Family Member Birth Year', 'family.position': 'Family Member Occupation',
  'family.political': 'Family Member Political Status', 'family.phone': 'Family Member Phone',
};

export function englishNameFor(field) {
  const named = EN_DISPLAY_NAMES[`${field?.section}.${field?.key}`];
  if (named) return named;
  const al = (field?.labels || []).map(s => String(s).trim()).filter(s => LATIN_LABEL.test(s) && s.length > 1);
  const base = al[0] || String(field?.zh || '');
  return base.replace(/\b[a-z]/g, c => c.toUpperCase());
}

/** 选项文案的英文版（性别/学历/是-否…）：找不到对应拉丁项就原样返回 */
export function englishOption(value) {
  const v = String(value || '').trim().toLowerCase();
  if (!v) return String(value || '');
  for (const group of VALUE_EQUIVALENTS_ALL) {
    if (!group.some(x => String(x).toLowerCase() === v)) continue;
    const latin = group.find(x => LATIN_LABEL.test(String(x).trim()));
    if (latin) return String(latin);
  }
  return String(value || '');
}

/**
 * 别名补丁：中文老式门户 / 港企英文表单里的第三种叫法，集中维护在这一处，
 * 不散落进 SECTIONS，便于 P4 之后按站点沉淀成 adapter 补丁。
 * key 支持 'section.*.field' 通配列表槽位。
 */
export const EXTRA_ALIASES = {
  'basics.name': ['贵姓', '姓名（正楷）', '中文姓名', 'name in chinese', '法定姓名', 'legal name', 'chinese name'],
  'basics.birthDate': ['出生日期（ yyyy-mm-dd ）', '出生年月日', '出生日期 yyyy/mm/dd'],
  'basics.heightCm': ['身高 cm', '身高(cm)', '身高（厘米）'],
  'basics.weightKg': ['体重 kg', '体重(kg)', '体重（公斤）'],
  'contact.emergencyPhone': ['紧急联系人电话', '紧急联系电话', '亲属电话'],
  'contact.address': ['通讯地址', '寄信地址', '现详细住址', '联系地址', '地址行 1', 'address line 1', '地址行1'],
  'intent.position': ['应聘岗位', '申请职位', '志愿岗位', '应聘职位', '期望岗位', '期望职位', '意向职位', '目标岗位'],
  'intent.cities': ['期望工作地', '意向工作地', '期望工作地点', '工作地点偏好', 'expected city', 'desired city', 'expected work location', 'preferred work location'],
  'intent.acceptRelocation': ['是否服从调剂', '服从调剂', '愿意调剂', '接受工作地点调剂'],
  'intent.channel': ['信息来源', '获知渠道', '如何得知本公司', '招聘渠道来源', '从哪里知道', '从何种渠道了解', '获取招聘信息渠道', '您是通过什么方式知道我们的', '您通过何种渠道了解到这次', 'how did you hear about this position', 'how did you hear', 'how you heard about us', 'how did you hear about us', 'how did you know about this role', 'channel'],
  'intent.availableDate': ['最早到岗时间', '可到岗日期', '入职时间'],
  'internship.*.company': ['单位名称', '实习单位名称', '所在公司'],
  'internship.*.title': ['岗位', '担任岗位', '实习岗位名称'],
  'internship.*.startDate': ['开始时间', '起始时间'],
  'internship.*.endDate': ['结束时间', '截止时间'],
  'work.*.company': ['单位名称', '现工作单位'],
  'work.*.title': ['职务', '岗位名称', '担任职位', '职务名称', 'position title'],
  'work.*.city': ['工作地点', 'job location'],
  'education.*.school': ['毕业院校', '就读学校', '学校（全称）', '学校或大学', '毕业学校或大学', 'school or university', 'university or college'],
  'education.*.major': ['所学专业', '专业方向', '所学专业的英文名称', '主修专业', '主修专业方向', 'major field of study', 'course of study'],
  'education.*.degree': ['最高学历', '学历（含在读）', '现有学历', '受教育类型', '学历类型', '最高学位', '学位'],
  'education.*.trainingMode': ['学习形式', '全日制/非全日制', '受教育形式', '是否全日制', '全日制'],
  'education.*.enrollDate': ['入学时间', '入学年月', 'course start month', 'start month'],
  'education.*.gradDate': ['毕业时间', '预计毕业时间', '毕业年月', 'course end month', 'end month'],
  'education.*.gpa': ['GPA', '平均学分绩点', '绩点（满分4.0）', '绩点', 'gpa（实绩/总分）', '成绩'],
  'education.*.overseas': ['是否海外留学生', '是否为海外及港澳台教育经历', '海外学习经历'],
  'education.*.rank': ['成绩排名', '专业排名', '排名百分比', '本科排名'],
  'languages.*.cert': ['英语等级', '语言等级', '证书等级', '外语语种及等级'],
  'languages.*.score': ['成绩', '分数', '成绩分数'],
  'records.dossierLocation': ['档案所在地', '人事档案存放单位', '档案所在人才市场'],
  'records.noCriminal': ['有无犯罪记录', '是否有违法犯罪记录', '犯罪记录', '是否违反过国家法律法规', '不良行为记录'],
  'family.*.name': ['姓名', '成员姓名'],
  'family.*.relation': ['称谓', '与本人关系', '家庭关系'],
  'family.*.employer': ['工作单位及职务', '工作单位及职位', '职业及单位'],
  'hkGlobal.needSponsorship': ['do you require sponsorship to work', '是否需要工作签证担保', 'visa sponsorship'],
  'hkGlobal.workAuth': ['你现在是否有权在本港工作', 'right to work in hong kong', '工作许可状况'],
  'hkGlobal.expectedCtc': ['期望薪酬（港元）', 'expected remuneration package', '薪酬要求'],
  'others.selfIntro': ['自荐理由', '个人简介', '自我介绍'],
  'awards.*.title': ['获奖名称', '荣誉名称', '奖项名称', '奖学金类型', '评奖评优', '竞赛获奖'],
  'certifications.*.name': ['资格证书名称', '持证名称', '证书名称', '获得证书', '英语等级证书', '其它技能'],
  'skills.domain': ['技能名称', '键入以添加技能', '添加技能', '技能专长', '计算机水平', '发表论文情况', '个人专利'],
  'languages.*.language': ['语言类别', '语种', '语言能力', '语言类型'],
  'languages.*.listening': ['听说', '听说能力'],
  'languages.*.writing': ['读写', '读写能力'],
  'intent.hasRelative': ['是否有亲友受雇于本公司', '是否有亲属在本系统', '是否有亲戚在公司', '是否内推', '亲友是否在职'],
  'intent.referralCode': ['内推码', '推荐码', '校园大使推荐'],
  'intent.referralName': ['推荐人姓名', '是否有推荐人', '内推人'],
  'others.personalSite': ['用户id/url', '个人网站', '网站'],
  'others.hobbies': ['兴趣爱好', '特长', '兴趣爱好、特长', '个人爱好', '特长与爱好'],
  'basics.health': ['健康状况', '身体健康状况'],
  'basics.lastName': ['姓 - 拼音或西方文字', '姓（拼音）', 'surname'],
  'basics.firstName': ['名 - 拼音或西方文字', '名（拼音）', 'given name'],
  'basics.lastNameZh': ['姓 中文', 'surname in chinese'],
  'basics.firstNameZh': ['名 中文', 'given name in chinese'],
  'basics.idNumber': ['证件号码', '身份证号码', '身份证号'],
  'basics.idType': ['证件类型', '身份证', '证件类别'],
  'contact.dialCode': ['国家或地区电话区号', '电话区号', 'country calling code'],
  'contact.extension': ['电话分机', 'phone extension'],
  'projects.*.role': ['承担职责', '项目中职责'],
  'records.publicOfficial': ['是否为公职人员亲属', '是否有亲属在系统内'],
};

function applyExtraAliases(field) {
  const candidates = [
    field.path,
    field.itemIndex === null ? field.path : `${field.section}.*.${field.key}`,
  ];
  for (const key of candidates) {
    for (const alias of EXTRA_ALIASES[key] || []) {
      const a = String(alias).trim().toLowerCase();
      if (a && !field.labels.includes(a)) field.labels.push(a);
    }
  }
  return field;
}

export function fieldByPath(path) {
  return buildFields().find(f => f.path === path) || null;
}
