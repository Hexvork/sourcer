'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const parse = require('./parse');
const llm = require('./llm');
const db = require('./db');

const ROOT = path.join(__dirname, '..');
const RESUME_DIR = process.env.RESUME_DIR || path.join(ROOT, '简历');
const POOL_DIR = process.env.POOL_DIR || path.join(ROOT, '简历池');

// 内存中的文件改名日志（重启会清空，仅用于前端实时展示）
const renameLog = [];
let renameSeq = 0;
function recordRename(entry) {
  renameLog.push({ id: ++renameSeq, time: new Date().toLocaleString('zh-CN', { hour12: false }), ...entry });
  if (renameLog.length > 500) renameLog.shift();
}
function getRenameLog() {
  return renameLog.slice().reverse();
}
function clearRenameLog() {
  renameLog.length = 0;
}

function ensureDirs() {
  fs.mkdirSync(RESUME_DIR, { recursive: true });
  fs.mkdirSync(POOL_DIR, { recursive: true });
}

function fileHash(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('md5').update(buf).digest('hex').slice(0, 16);
}

// WPS/Office 临时文件：~$xxx、.~xxx、xxx.docx.2B101950....wps、*.tmp 都不处理
function isTempResumeFile(name) {
  const n = String(name || '');
  if (n.startsWith('~$') || n.startsWith('.~') || n.startsWith('.')) return true;
  if (/\.(docx?|pdf|txt|md)\./i.test(n)) return true; // xxx.docx.xxx.wps 这类 WPS 缓存
  if (/\.(tmp|temp|bak|wbk)$/i.test(n)) return true;
  return false;
}

// 递归列出简历目录下所有支持的文件（含二级/三级子文件夹），保留各自所在目录
function listResumeFiles(dir = RESUME_DIR) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (isTempResumeFile(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...listResumeFiles(full));
    } else if (parse.SUPPORTED.includes(parse.extOf(entry.name))) {
      results.push(full);
    }
  }
  return results;
}

function sanitizeDir(name) {
  return String(name || '其他').replace(/[\\/:*?"<>|]/g, '_');
}

// ---------------- 无模型时的兜底分类 ----------------
// 字段标签抽取：要求「姓名/求职意向」等标签后紧跟冒号或空白（至少 1 个分隔符），
// 避免正文里恰好出现「姓名」「职位」字样被误抽成整句，匹配不到则走文件名/分类兜底并标记 needs_ai。
function fallbackCategorize(text, filename) {
  const t = String(text || '');
  const category = detectCategory(t);
  const name = pickRegex(t, /(?:姓名|名字)[\s:：]{1,}([^\s,，。；;\n]{2,20}?)(?=\s*(?:性别|年龄|学历|籍贯|婚育|目前|手机|电话|邮箱|现居|居住地|工作|求职|期望|政治|民族|出生年月|出生日期|出生时间|生日|出生)[\s:：]|$)/) || nameFromFilename(filename) || filename.replace(/\.[^.]+$/, '');
  const gender = /女/.test(t.slice(0, 200)) ? '女' : (/男/.test(t.slice(0, 200)) ? '男' : '未知');
  const hasCn = (s) => /[\u4e00-\u9fa5]/.test(String(s || ''));
  const birth = extractBirth(t, filename);
  const age = birth.age || pickRegex(t, /(?:年龄)[\s:：]{1,}(\d{2,3})/) || pickRegex(t, /(\d{2,3})\s*岁/) || '未知';
  const education = detectEducation(t) || '未知';
  const university = pickRegex(t, /([\u4e00-\u9fa5]{2,20}(?:大学|学院))/) || pickRegex(t, /(?:大学|学院|学校)[\s:：]{1,}([^\s,，。；;\n]{2,20})/) || '未知';
  const occupation = pickRegex(t, /(?:职位名称|求职意向|应聘|岗位|职位|职业|职务)[\s:：]{1,}([^\s,，。；;\n]{2,30}?)(?=\s*(?:期望薪资|期望|薪资|姓名|性别|年龄|学历|籍贯|婚育|目前薪酬|目前|手机|电话|邮箱|现居|居住地|工作经历|求职意向|政治面貌|政治|民族|出生年月|出生日期|出生时间|生日|出生)[\s:：]|$)/)
    || pickRegex(t, /(?:公司|集团|科技|银行|医院|大学|学院)[^\n]{0,6}?([\u4e00-\u9fa5]{2,10}?(?:工程师|研发岗|算法岗|运营岗|销售岗|产品岗|测试岗|开发岗|设计岗|市场岗|人力岗|财务岗|法务岗|管理岗|技术岗|数据分析岗|负责人|总监|经理|主管|专员))/)   // “歌尔微电子有限公司算法研发岗”这类无标签岗位
    || category + '相关';
  const companyRaw = pickRegex(t, /(?:主要任职公司|任职公司|工作单位|当前公司|公司名称)[\s:：]{1,}([^\s,，。；;\n]{2,30})/) || pickRegex(t, /(?:曾任职于|就职于|任职于|在)([^\s,，。；;\n]{2,20}(?:公司|集团|科技|有限|股份|银行|医院))/) || pickRegex(t, /(\d{4}[^\n]{0,20}(?:公司|集团|科技|有限|股份)[^\n]{0,20})/) || '';
  const company = hasCn(companyRaw) ? companyRaw : '未知';
  const experienceRaw = pickRegex(t, /(?:工作经历|工作内容|项目经历|经历|经验)[\s:：]{1,}([^\n]{0,120}[\u4e00-\u9fa5][^\n]{0,80})/) || '';
  const experience = hasCn(experienceRaw) ? experienceRaw : '';
  const other = '';
  const summary = `${name}，${gender}，${age || '年龄未知'}，${education}，${occupation}。` + (experience ? ` 经历：${experience.slice(0, 80)}` : '');
  return { category, name, gender, age, birth_date: birth.birth_date, education, occupation, company, experience, university, other, summary, fallback: true };
}

function detectCategory(t) {
  const rules = [
    ['人工智能', /人工智能|AI\s*(算法|工程师|研究员)|算法工程师|机器学习|深度学习|大模型|NLP|计算机视觉|CV|推荐算法|数据挖掘|AIGC|智能问答|语音识别/i],
    ['机器人', /机器人|ROS|机械臂|运动控制|SLAM|自动驾驶|无人驾驶|具身智能|伺服|路径规划/i],
    ['数据', /数据分析|数据科学|大数据|数据仓库|ETL|BI|商业智能|爬虫/i],
    ['软件技术', /软件|后端|前端|Java|Python|C\+\+|Golang|Go|Node\.js|PHP|架构师|测试|运维|DevOps|嵌入式|单片机|小程序|Android|iOS|Flutter/i],
    ['硬件技术', /硬件|电路|PCB|FPGA|芯片|模拟|射频|Layout|结构设计|模具/i],
    ['销售', /销售|客户经理|商务|渠道|大客户|BD|拓展|招商|导购|零售/i],
    ['市场营销', /市场|营销|品牌|公关|新媒体|文案|策划|活动执行|增长|投放/i],
    ['财务', /财务|会计|出纳|审计|税务|成本|资金|风控|合规/i],
    ['人力资源', /人力资源|HR|招聘|薪酬|绩效|培训|员工关系|行政/i],
    ['设计', /设计|UI|UX|视觉|交互|平面|室内|工业设计|原画|美工/i],
    ['运营', /运营|产品经理|项目管理|PM|客服|电商|供应链|物流|采购/i],
    ['医疗', /医生|护士|临床|医药|医疗|护理|药|医师|康复/i],
    ['教育', /教师|老师|讲师|培训|教研|课程|教务/i],
    ['法务', /法务|律师|法律|合规|知识产权|专利/i],
    ['管理', /总经理|总监|经理|主管|COO|CEO|CTO|CFO|副总裁|合伙人/i],
    ['其他', /其他/]
  ];
  for (const [cat, re] of rules) {
    if (re.test(t)) return cat;
  }
  return '其他';
}

function pickRegex(t, re) {
  const m = String(t || '').match(re);
  return m ? m[1].trim() : '';
}

// ---------------- 学历 / 出生日期 可靠抽取（不依赖 AI 也能拿到） ----------------
const EDU_LEVELS = [
  ['博士后', '博士后'], ['博士研究生', '研究生'], ['博士', '博士'], ['硕士研究生', '研究生'], ['研究生', '研究生'],
  ['硕士', '硕士'], ['本科学历', '本科'], ['本科', '本科'], ['学士', '本科'], ['专科学历', '专科'], ['专科', '专科'],
  ['大专', '大专'], ['中专', '中专'], ['高中学历', '高中'], ['高中', '高中'], ['高职', '高职'], ['技校', '技校'],
  ['初中', '初中'], ['MBA', 'MBA'], ['EMBA', 'EMBA']
];
// 识别简历里出现的最高学历（职称类词如「研究生」若前面紧跟「博士/硕士」会被更具体词先命中）
function detectEducation(text) {
  const t = String(text || '');
  const idxList = [];
  for (const [kw, ly] of EDU_LEVELS) {
    const i = t.indexOf(kw);
    if (i >= 0) idxList.push([i, ly]);
  }
  if (!idxList.length) {
    const label = pickRegex(t, /(?:学历|教育背景|最高学历)[\s:：]{1,}([^\s,，。；;\n]{1,20})/);
    if (label && /[\u4e00-\u9fa5]/.test(label)) return label;
    return '';
  }
  // 取最先出现、且级别更高的一项；同一位置按更长关键词优先
  idxList.sort((a, b) => a[0] - b[0] || (EDU_LY_RANK[b[1]] || 99) - (EDU_LY_RANK[a[1]] || 99));
  return idxList[0][1];
}
const EDU_LY_RANK = { '博士后': 90, '博士': 80, '研究生': 70, '硕士': 60, 'MBA': 65, 'EMBA': 65, '本科': 50, '专科': 40, '大专': 40, '中专': 30, '高中': 25, '高职': 25, '技校': 20, '初中': 10 };

function extractBirth(text, filename) {
  const t = String(text || '');
  let m = t.match(/(?:出生(?:年月|日期|时间)?|生日)[\s:：]{1,}(\d{4})\s*年?\s*(\d{1,2})?\s*月?/i)
    || t.match(/(\d{4})\s*年\s*(\d{1,2})?\s*月?\s*(?:出生|生)/i);
  if (!m) m = String(filename || '').match(/[-_ ](\d{4})\s*年?\s*(\d{1,2})?\s*月?/);
  if (!m) {
    // 简历只写年龄时，用「当前年份 - 年龄」反推出生年份
    const ageM = t.match(/(?:年龄)[\s:：]{1,}(\d{2,3})/) || t.match(/(\d{2,3})\s*岁/);
    if (ageM) {
      const age = Number(ageM[1]);
      if (age >= 16 && age <= 70) {
        const year = new Date().getFullYear() - age;
        return { birth_date: `${year}年`, age: String(age) };
      }
    }
    return { birth_date: '', age: '' };
  }
  const year = Number(m[1]);
  const month = m[2] ? Number(m[2]) : null;
  const birth_date = month ? `${year}年${month}月` : `${year}年`;
  const now = new Date();
  let age = now.getFullYear() - year;
  if (month != null && (now.getMonth() + 1) < month) age -= 1;
  return { birth_date, age: String(age) };
}

// ---------------- Markdown 写入 ----------------
function buildEntryBlock(entry) {
  const lines = [];
  lines.push(`<!-- resume:${entry.file_hash} START -->`);
  lines.push(`## ${entry.name}（${entry.gender}，${entry.age}）`);
  lines.push('');
  lines.push(`- **文件路径**：${entry.original_path}`);
  lines.push(`- **职务**：${entry.occupation}`);
  lines.push(`- **出生日期**：${entry.birth_date || '未提取'}`);
  lines.push(`- **年龄**：${entry.age && entry.age !== '未知' ? entry.age + '岁' : (entry.age || '未提取')}`);
  lines.push(`- **学历**：${entry.education || '未提取'}`);
  lines.push(`- **主要任职公司**：${entry.company || '未提取'}`);
  lines.push(`- **经历**：${entry.experience || '未提取'}`);
  lines.push(`- **大学**：${entry.university}`);
  lines.push(`- **其他重要信息**：${entry.other || '无'}`);
  lines.push(`- **简述**：${entry.summary}`);
  lines.push('');
  lines.push(`<!-- resume:${entry.file_hash} END -->`);
  return lines.join('\n');
}

function replaceMarkdownEntry(category, hash, block) {
  const file = markdownPath(category);
  let md = '';
  if (fs.existsSync(file)) md = fs.readFileSync(file, 'utf8');
  const startTag = `<!-- resume:${hash} START -->`;
  const endTag = `<!-- resume:${hash} END -->`;
  const startIdx = md.indexOf(startTag);
  const endIdx = md.indexOf(endTag);
  if (startIdx >= 0 && endIdx >= 0) {
    md = md.slice(0, startIdx) + block + md.slice(endIdx + endTag.length);
  } else {
    if (md && !md.endsWith('\n')) md += '\n';
    md += block + '\n';
  }
  // 标题
  if (!md.startsWith('# ')) {
    md = `# ${category}\n\n> 本文件由系统自动维护，请勿手动编辑\n\n` + md;
  }
  fs.writeFileSync(file, md, 'utf8');
}

// 从简历池 markdown 中移除某条（按 hash 标签）。若分类文件里已无任何简历条目，则删除该 md 文件。
function removeMarkdownEntry(category, hash) {
  if (!hash) return false;
  const file = markdownPath(category);
  if (!fs.existsSync(file)) return false;
  const startTag = `<!-- resume:${hash} START -->`;
  const endTag = `<!-- resume:${hash} END -->`;
  let md = fs.readFileSync(file, 'utf8');
  const s = md.indexOf(startTag);
  const e = md.indexOf(endTag);
  if (s < 0 || e < 0) return false;
  md = md.slice(0, s) + md.slice(e + endTag.length).replace(/^\r?\n/, '');
  if (!/<!-- resume:.* START -->/.test(md)) {
    fs.unlinkSync(file);
  } else {
    fs.writeFileSync(file, md, 'utf8');
  }
  return true;
}

// 对账：遍历数据库记录，凡是原始简历文件已不存在的，删除 DB 记录与简历池条目（真实文件被删除时兜底清理）
function reconcileDeleted() {
  const existing = new Set(listResumeFiles().map(f => path.resolve(f)));
  const rows = db.listResumes();
  let removed = 0;
  for (const r of rows) {
    if (!existing.has(r.original_path)) {
      db.deleteResume(r.id);
      removeMarkdownEntry(r.category, r.file_hash || `f${r.id}`);
      removed++;
      console.log('[reconcile] 移除已删除简历:', r.original_path);
    }
  }
  // 清理孤立的处理记录：原始文件已不存在但尚未对应任何简历的记录
  for (const p of db.listProcessed()) {
    if (!existing.has(p.path) && !db.listResumes().some(r => r.original_path === p.path)) {
      db.deleteProcessedFile(p.path);
    }
  }
  return removed;
}

function markdownPath(category) {
  return path.join(POOL_DIR, `${sanitizeDir(category)}.md`);
}

// ---------------- 简历原文件自动重命名：岗位-姓名-出生年份 ----------------
// 只有抽到可靠姓名和岗位时才改；出生年份优先取 4 位年份，简历只给年龄时用当前年份减出来。

function sanitizeNamePart(s) {
  return String(s || '')
    .replace(/[\\/:*?"<>|\r\n\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[. ]+|[. ]+$/g, '');
}

// AI/规则可能返回“未提供/名称/岗位”这类占位垃圾，统一视为不可用
const INVALID_NAME_WORDS = new Set(['未提供', '无', '未知', '暂无', '待定', '不详', '名称', '姓名', '不祥', '本科', '硕士', '博士', '大专', '中专', '高中', '研究生', '学士', '年龄', '性别', '学历', '专业', '学校', '民族', '出生', '身高', '体重', '政治面貌', '户口', '籍贯', '现居', '期望', '求职', '薪资', '状态', '目前', '当前', '在职', '离职', '已婚', '未婚', '保密', '不限', '及以上', '以下', '以上']);
const INVALID_OCCUPATION_WORDS = new Set(['未提供', '无', '未知', '暂无', '待定', '不详', '名称', '姓名', '岗位', '职位', '职业', '职务', '相关', '未命名', '状态', '状况', '婚姻', '在职', '离职', '求职', '目前', '当前', '工作状态', '婚姻状况']);

// 清洗姓名：去掉“女/男/先生/女士/老师”等尾巴和括号备注，避免“陈艳萍女”这种脏名字
function cleanName(name) {
  let s = sanitizeNamePart(name);
  if (!s) return '';
  s = s
    .replace(/[（(]\s*(?:女|男|先生|女士|小姐)\s*[）)]/gu, '')
    .replace(/性别\s*[:：]?\s*[男女]/gu, '')
    .trim();
  // 称呼类尾巴：去掉后至少剩 2 个字才删；像“吕先生”这种只剩 1 个字时保留原名，避免无法命名
  s = s.replace(/(?:先生|女士|小姐|老师)$/u, (m) => (s.length - m.length >= 2 ? '' : m)).trim();
  // 性别单字尾巴：只有原名至少 4 个字时才删，避免“张伟男”这种真名被误伤
  s = s.replace(/(?:女|男)$/u, (m) => (s.length - m.length >= 3 ? '' : m)).trim();
  // 中文姓名后跟英文昵称：郑利韦krystal → 郑利韦；陈艳萍 Krystal → 陈艳萍
  const enSuffix = s.match(/^([\u4e00-\u9fa5·]{2,4})\s*[a-zA-Z]+$/);
  if (enSuffix && !INVALID_NAME_WORDS.has(enSuffix[1])) s = enSuffix[1];
  return INVALID_NAME_WORDS.has(s) ? '' : s;
}

// 清洗岗位：去掉“英语教师-女 / 工程师（男）”这类混进岗位里的性别杂质
function cleanOccupation(occ) {
  let s = sanitizeNamePart(occ);
  if (!s) return '';
  s = s
    .replace(/[（(][^）)]*[）)]/gu, '')          // 去掉“CHO（首席人力资源官）”里的括号说明
    .replace(/[-–—]\s*(?:女|男)$/u, '')
    .replace(/(?:女|男)$/u, '')
    .replace(/[-–—]\s*$/u, '')
    .replace(/^ai(?=[\u4e00-\u9fa5])/i, 'AI')    // ai算法工程师 → AI算法工程师
    .replace(/\bvp$/i, 'VP')
    .replace(/^cho$/i, 'CHO')
    .replace(/^(?:的|级|以上|等)+/, '')   // “的人力资源部门负责人/级领导力/以上项目经理”这类开头噪声
    .replace(/[【】]/g, '')               // 清除【】方括号（历史遗留格式垃圾）
    .trim();
  if (INVALID_OCCUPATION_WORDS.has(s)) return '';
  // 历史垃圾岗位：整段标签/期望/薪资/地点/日期范围等都不是岗位
  if (/[：:]/.test(s)) return '';
  if (/期望|薪资|工作性质|工作地点|目标职位|月薪|全职|兼职|至今|年龄|性别|学历|专业|民族|出生/.test(s)) return '';
  if (/^\d{4}[./-]/.test(s)) return '';
  // 纯中文 2~4 字但不是已知岗位词的，多半是“云爻”这类公司名，不能当岗位
  if (/^[\u4e00-\u9fa5]{2,4}$/.test(s) && !isJobWord(s)) return '';
  return s;
}

// 常见职位/称呼词，用于从“职位-姓名”这种原始文件名里把姓名段挑出来
const JOB_WORDS = [
  '教师', '老师', '工程师', '总监', '经理', '主管', '专员', '顾问', '培养生', '实习生',
  '负责人', '助理', '设计师', '分析师', '编辑', '编导', '销售', '运营', '管理', '会计',
  '出纳', '律师', '医生', '护士', '研究员', '讲师', '教授', '教练', '策划', '客服',
  '采购', '物流', '开发', '测试', '运维', '产品', '市场', '品牌', '公关', '人力',
  '招聘', '薪酬', '绩效', '培训', '法务', '财务', '投资', '招商', '算法', '总裁',
  '总经理', '董事', '创始人', '合伙人', '校长', '院长', '主任', '文员', '秘书', '司机',
  '保安', '保洁', '厨师', '前台', '店长', '导购', '收银', '电工', '焊工', '木工',
  '翻译', '保姆', '快递', '外卖', '家教', '护理', '康复', '理疗', '美容', '美发'
];

function isJobWord(s) {
  const t = String(s || '');
  return JOB_WORDS.some(w => t.includes(w));
}

// 常见姓氏，用于多个候选里优先挑真名（避免把“美速”公司名当姓名）
const COMMON_SURNAMES = new Set(('李王张刘陈杨赵黄周吴徐孙胡朱高林何郭马罗梁宋郑谢韩唐冯于董萧程曹袁邓许傅沈曾彭吕苏卢蒋蔡贾丁魏薛叶阎余潘杜戴夏钟汪田任姜范方石姚谭廖邹熊金陆郝孔白崔康毛邱秦江史顾侯邵孟龙万段钱汤尹黎易常武乔贺赖龚文欧区覃冼韦邝麦蓝司穆岑倪滕殷毕邬安乐时皮卞齐伍元卜平').split(''));

function isLikelyChineseName(s) {
  return COMMON_SURNAMES.has(String(s || '').charAt(0));
}

// 从“营销培养生-刘新伟.docx / 李生-资深算法工程师-1981年.pdf”这类原始文件名里尽量拆出姓名；
// 拆不到返回空字符串，绝不硬猜。
function nameFromFilename(filename) {
  const base = String(filename || '').replace(/\.[^.]+$/, '').replace(/[【】]/g, ' ');
  if (!base) return '';
  const segments = base.split(/[-–—―_ ]+/).map(s => s.trim()).filter(Boolean);
  if (!segments.length) return '';
  const generic = /^(个人简历|简历|推荐报告|速聘专猎推荐报告|最新|更新|副本|猎聘简历)$/i;
  const candidates = [];
  for (const s of segments) {
    if (generic.test(s)) continue;
    if (INVALID_NAME_WORDS.has(s)) continue;
    if (/^[\u4e00-\u9fa5·]{2,4}$/.test(s) && !isJobWord(s) && !/先生|女士|小姐|老师$/.test(s)) {
      candidates.push(s);
      continue;
    }
    // “郑鑫0722”“刘泓佚8795dbfe...”这种：名字后面跟了编号/随机串，拆出纯中文名字
    const m = s.match(/^([\u4e00-\u9fa5·]{2,4})[0-9a-zA-Z]+$/);
    if (m && !isJobWord(m[1]) && !/先生|女士|小姐|老师$/.test(m[1]) && !INVALID_NAME_WORDS.has(m[1])) {
      candidates.push(m[1]);
    }
  }
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    // 多个候选时优先带常见姓氏的（李平 > 美速），再优先 2~3 字
    const surname = candidates.filter(isLikelyChineseName);
    if (surname.length === 1) return surname[0];
    if (surname.length > 1) {
      const short = surname.filter(s => s.length <= 3);
      return short.length === 1 ? short[0] : surname[0];
    }
    const short = candidates.filter(s => s.length <= 3);
    return short.length === 1 ? short[0] : candidates[0];
  }
  // 实在没有纯姓名时，允许“吕先生”这种称呼占位作为名字，避免整份简历无法命名
  // 也处理“林女士ead025fa9b…猎聘简历”这种随机 ID 串前的称呼
  const honorific = segments.find(s => /^[\u4e00-\u9fa5]{1,2}(?:先生|女士|小姐)(?:[0-9a-zA-Z]+.*)?$/.test(s))
    || segments.find(s => /^[\u4e00-\u9fa5]{1,2}(?:先生|女士|小姐)$/.test(s));
  return honorific ? honorific.match(/^[\u4e00-\u9fa5]{1,2}(?:先生|女士|小姐)/)[0] : '';
}

// 从“赵亚洲-CHO-速聘专猎推荐报告.pdf / 朱天鸿-肯特-投资vp.pdf”这类文件名里尽量拆出岗位段
function occupationFromFilename(filename) {
  const base = String(filename || '').replace(/\.[^.]+$/, '').replace(/[【】]/g, ' ');
  const rawSegments = base.split(/[-–—―_ ]+/).map(s => s.trim()).filter(Boolean);
  if (!rawSegments.length) return '';
  // 把“AI 算法工程师”这种被空格拆开的岗位段重新拼起来
  const segments = [];
  for (let i = 0; i < rawSegments.length; i++) {
    let s = rawSegments[i];
    if (/^ai$/i.test(s) && i + 1 < rawSegments.length && isJobWord(rawSegments[i + 1])) {
      s = 'AI ' + rawSegments[++i];
    }
    segments.push(s);
  }
  const name = nameFromFilename(filename);
  const yearRe = /^\d{4}\s*年?/;
  const generic = /^(个人简历|简历|推荐报告|速聘专猎推荐报告|最新|更新|副本|猎聘简历)$/i;
  const candidates = segments.filter(s =>
    s !== name &&
    !(name && s.startsWith(name) && s.length > name.length) && // “郑鑫0722”这种名字+编号不算岗位
    !yearRe.test(s) &&
    !generic.test(s) &&
    !INVALID_OCCUPATION_WORDS.has(s) &&
    !/^\d+$/.test(s)
  );
  if (!candidates.length) return '';
  const jobCandidates = candidates.filter(isJobWord);
  if (!jobCandidates.length) return ''; // 没有明显岗位词时宁可不猜，避免把“云爻”这种公司名当岗位
  // 多个岗位候选时优先短的
  return jobCandidates.slice().sort((a, b) => a.length - b.length || a.localeCompare(b, 'zh-CN'))[0];
}

// 最终用于命名的岗位：优先用原文件名里已有的岗位段（用户自己起的岗位名最可信）；
// 如果 DB/AI 岗位是文件名的超集（如文件名“算法工程师”，AI 是“AI 算法工程师”），则用更完整的 AI 岗位；
// AI 的“分类相关”占位直接丢弃
function effectiveOccupation(entry) {
  const name = effectiveName(entry);
  let fromFile = cleanOccupation(occupationFromFilename(entry.source_file));
  let direct = cleanOccupation(entry.occupation);
  const placeholder = entry.category && direct === sanitizeNamePart(entry.category) + '相关';
  // 岗位和姓名相同（如“唐飞-唐飞-1991”）说明岗位没抽出来，不能拿来当岗位
  if (name && direct === name) direct = '';
  if (name && fromFile === name) fromFile = '';
  if (fromFile) {
    if (direct && !placeholder && direct !== fromFile && (direct.includes(fromFile) || fromFile.includes(direct))) {
      return direct.length >= fromFile.length ? direct : fromFile;
    }
    return fromFile;
  }
  return direct && !placeholder ? direct : '';
}

// 最终用于命名的姓名：优先 DB/AI 抽出的姓名；若它是“职位-姓名”整串占位，再尝试从原文件名拆
function effectiveName(entry) {
  const direct = cleanName(entry.name);
  const fromFile = nameFromFilename(entry.source_file);
  // DB/AI 把公司名当姓名（如“美速”），但文件名里有更像真名的候选（如“李平”）→ 用文件名
  if (direct && fromFile && /^[\u4e00-\u9fa5·]{2,4}$/.test(direct) && !isLikelyChineseName(direct) && isLikelyChineseName(fromFile)) {
    return fromFile;
  }
  if (direct && !/[-_|/\\]/.test(direct) && !/\d/.test(direct) && direct.length >= 2) return direct;
  return fromFile || direct;
}

// 出生年份：优先取 4 位年份；简历只给年龄时用「当前年份 - 年龄」推算
function birthYearOf(entry) {
  const m = String(entry.birth_date || '').match(/(\d{4})/);
  if (m) return m[1];
  const age = Number(String(entry.age || '').replace(/[^\d]/g, ''));
  if (age >= 16 && age <= 70) return String(new Date().getFullYear() - age);
  return '';
}

// 目标文件名主体：岗位-姓名-出生年份（缺哪段就省略哪段，不拼性别）
function resumeFileName(entry) {
  const occ = effectiveOccupation(entry);
  const name = effectiveName(entry);
  const year = birthYearOf(entry);
  return [occ, name, year].filter(Boolean).join('-');
}

// 当前文件名是否已符合「姓名」格式（已符合则无需重命名）
function needsRename(filePath, entry) {
  const target = resumeFileName(entry);
  if (!target) return false;
  const ext = path.extname(filePath);
  const currentBase = sanitizeNamePart(path.basename(filePath, ext));
  return currentBase !== target;
}

// 数据是否足以支撑重命名（排除 fallback 占位数据：姓名为原文件名兜底、姓名里夹着职位/连接符等）
function entryNameable(entry) {
  const name = effectiveName(entry);
  const occ = effectiveOccupation(entry);
  if (!name || name.length < 2) return false;
  if (!occ) return false;
  // 姓名里带文件名连接符/路径分隔符，说明很可能是“职位-姓名”这种没拆开的占位名
  if (/[-_|/\\]/.test(name)) return false;
  // 姓名里混入数字也视为不可靠
  if (/\d/.test(name)) return false;
  // 纯中文短名但不像常见姓氏开头（如“杭州”“美速”）→ 不可靠，交 AI 重新确认
  if (/^[\u4e00-\u9fa5·]{2,4}$/.test(name) && !isLikelyChineseName(name)) return false;
  // 职位是“分类 + 相关”这种占位时不改，等 AI 补全
  if (entry.category && occ === sanitizeNamePart(entry.category) + '相关') return false;
  // fallback 特征：姓名没抽到，直接拿原文件名兜底
  if (entry.source_file) {
    const base = sanitizeNamePart(path.basename(entry.source_file, path.extname(entry.source_file)));
    if (name === base) return false;
  }
  return true;
}

/**
 * 把简历原文件重命名为「岗位-姓名-出生年份」并同步 DB（与简历池，可选）。
 * @param {boolean} [options.rebuildMd=true] 改名后是否立即重建简历池条目（补命名场景用；
 *        入库流程中由 processFile 在改名后统一写入 Markdown，传 false 避免重复写）
 * @returns {null | {oldPath: string, newPath: string}} 未改名（信息不足/已同名/失败）返回 null
 */
function renameResumeFile(filePath, entry, { resumeId = null, rebuildMd = true } = {}) {
  const oldAbs = path.resolve(filePath);
  const dir = path.dirname(oldAbs);
  const ext = path.extname(oldAbs);
  const currentBase = path.basename(oldAbs, ext);
  const bracketClean = currentBase.replace(/[【】]/g, '').replace(/\s+/g, ' ').trim();
  const canName = entryNameable(entry);

  let target;
  if (canName) {
    target = resumeFileName(entry);
    if (!target) return null;
  } else if (bracketClean && bracketClean !== currentBase) {
    // 兜底：姓名/岗位虽不完善，但原文件名残留【】这类格式垃圾时，先把格式清掉
    target = bracketClean;
  } else {
    return null; // 数据不足以支撑命名且没有格式垃圾可清
  }

  // 冲突检测：目标名已存在则追加 (1)(2)…；若目标就是当前文件本身则无需改名
  let name = target + ext;
  let i = 1;
  while (fs.existsSync(path.join(dir, name))) {
    if (path.join(dir, name) === oldAbs) return null;
    name = `${target}(${i})${ext}`;
    i++;
  }
  const newPath = path.join(dir, name);

  try {
    fs.renameSync(oldAbs, newPath);
  } catch (e) {
    console.error('[rename] 失败:', oldAbs, '→', newPath, e.message);
    recordRename({ oldPath: oldAbs, newPath, status: 'failed', error: e.message });
    return null;
  }

  // 同步 DB：resumes 路径字段
  let rid = resumeId;
  if (rid == null) {
    const row = db.getResumeByPath(oldAbs);
    if (row) rid = row.id;
  }
  if (rid != null) db.updateResumePath(rid, newPath);

  // 同步 processed_files：旧路径记录迁移到新路径，避免 watcher 重复处理
  const prev = db.getProcessedFile(oldAbs);
  if (prev) {
    db.deleteProcessedFile(oldAbs);
    db.markProcessed(newPath, { hash: prev.hash, mtime: prev.mtime, status: prev.status || 'done', error: prev.error || '', resume_id: prev.resume_id || rid || null });
  }

  // 重建简历池条目（文件路径字段变化）——补命名场景需要；入库流程由 processFile 统一写，传 rebuildMd=false
  if (rebuildMd) {
    try {
      const row = db.getResumeByPath(newPath);
      if (row && row.category) {
        const blockKey = row.file_hash || `f${row.id}`;
        replaceMarkdownEntry(row.category, blockKey, buildEntryBlock({ ...row, original_path: newPath, file_hash: blockKey }));
      }
    } catch (e) {
      console.error('[rename-md]', e.message);
    }
  }

  console.log('[rename]', oldAbs, '→', newPath);
  recordRename({ oldPath: oldAbs, newPath, status: 'renamed' });
  return { oldPath: oldAbs, newPath };
}

// ---------------- 主处理流程 ----------------
async function processFile(filePath, { force = false, multiAgent = false } = {}) {
  const abs = path.resolve(filePath);
  const stat = fs.statSync(abs);
  const hash = fileHash(abs);
  const prev = db.getProcessedFile(abs);
  if (!force && prev && prev.hash === hash && (prev.status === 'done' || prev.status === 'processing')) {
    return { skipped: true, reason: '已处理过' };
  }
  db.markProcessed(abs, { hash, mtime: stat.mtimeMs, status: 'processing', error: '' });

  let resumeId = null;
  try {
    const text = await parse.parseFile(abs);
    const sourceName = path.basename(abs);
    const birth = extractBirth(text, sourceName);
    const edu = detectEducation(text);

    // 统一构造入库字段（只取 DB 需要的字段，不要把 llm 的 apiName/model 带进去）
    const buildFull = (baseEntry) => {
      const safeEntry = {
        name: effectiveName({ name: baseEntry.name, source_file: sourceName }),
        occupation: effectiveOccupation({ ...baseEntry, source_file: sourceName }),
        source_file: sourceName
      };
      return {
        ...safeEntry,
        gender: baseEntry.gender,
        age: birth.age || baseEntry.age || '未知',
        birth_date: birth.birth_date,
        education: edu || baseEntry.education || '',
        company: baseEntry.company || '',
        experience: baseEntry.experience,
        university: baseEntry.university,
        other: baseEntry.other,
        category: baseEntry.category,
        original_path: abs,
        pool_path: abs,
        file_hash: hash,
        content: text,
        summary: baseEntry.summary
      };
    };

    // 1. 正则优先：能完整抽出姓名+岗位就直接用正则结果，不调 AI
    let entry = fallbackCategorize(text, sourceName);
    let fullEntry = buildFull(entry);
    let usedAI = false;

    // 1.5 正则结果复核：即使正则能抽出完整信息，也轻量级交给 AI 快速过一遍，
    //    检查姓名/岗位是否明显不合理（如“杭州”当姓名、“状态”当岗位），
    //    如果发现明显问题，就调用完整的 AI 抽取来修正。
    if (entryNameable(fullEntry) && db.listAPIs().length > 0) {
      try {
        const review = await llm.reviewExtractedFields(
          sourceName, entry.name, entry.occupation, entry.birth_date
        );
        if (review && !review.correct) {
          // AI 复核说有问题，用完整 AI 抽取替换
          const ai = multiAgent
            ? await llm.categorizeResumeMultiAgent(text, sourceName)
            : await llm.categorizeResume(text, sourceName);
          entry = { ...ai, fallback: false };
          usedAI = true;
          fullEntry = buildFull(entry);
        }
      } catch (e) {
        // 复核失败不阻塞，继续用正则结果（e.message === 'NO_API' 说明 API 已断，不报错）
        if (e.message !== 'NO_API') {
          console.error('[复核] 轻量复核失败，继续用正则结果:', e.message);
        }
      }
    }

    // 2. 正则不完整（姓名/岗位缺失或占位）→ 有 AI 时交给 AI 补全
    if (!entryNameable(fullEntry) && db.listAPIs().length > 0) {
      try {
        const ai = multiAgent
          ? await llm.categorizeResumeMultiAgent(text, sourceName)
          : await llm.categorizeResume(text, sourceName);
        entry = { ...ai, fallback: false };
        usedAI = true;
        fullEntry = buildFull(entry);
      } catch (e) {
        // AI 失败仍保留正则结果，靠 needs_ai 等下次再补
        entry.other = (entry.other ? entry.other + '；' : '') + (e.message === 'NO_API' ? '' : `（模型调用失败：${e.message}）`);
      }
    }

    // 正则/AI 都补不齐的标记 needs_ai=1，配好 AI 后重新处理
    const needsAI = (!entryNameable(fullEntry)) ? 1 : 0;
    fullEntry.needs_ai = needsAI;
    resumeId = db.upsertResume(fullEntry);
    // 第一步：先给原文件重命名「岗位-姓名-出生年份」（规则/AI 能搜到姓名和岗位就改；
    // 年份缺失就省略；搜不到的占位数据被 entryNameable 拦截，保持原名并靠 needs_ai 等 AI 补全）
    const renamed = renameResumeFile(abs, fullEntry, { resumeId, rebuildMd: false });
    const finalPath = renamed ? renamed.newPath : abs;
    // 第二步：再把重命名后的简历投入简历池，生成分类 Markdown 条目（用最终路径）
    const poolRow = db.getResumeByPath(finalPath) || { ...fullEntry, original_path: finalPath, source_file: path.basename(finalPath), pool_path: finalPath };
    replaceMarkdownEntry(entry.category, hash, buildEntryBlock({ ...poolRow, original_path: finalPath, file_hash: hash }));
    db.markProcessed(finalPath, { hash, mtime: stat.mtimeMs, status: 'done', error: '', resume_id: resumeId });
    return { ok: true, name: entry.name, category: entry.category, resumeId, renamed: !!renamed, needsAI };
  } catch (e) {
    db.markProcessed(abs, { hash, mtime: stat.mtimeMs, status: 'error', error: e.message });
    return { ok: false, error: e.message };
  }
}

async function scanAll({ force = false } = {}) {
  ensureDirs();
  const files = listResumeFiles();
  const results = [];
  for (const f of files) {
    results.push(await processFile(f, { force }));
  }
  return results;
}

// 从数据库记录重建简历池 markdown（幂等）。当 markdown 丢失/被清空、而数据库仍有记录时，
// 扫描会因为 hash 匹配而跳过不重建，导致「简历池空但提示已同步」。此函数直接从 DB 兜底重建。
function ensurePoolMarkdown() {
  try {
    ensureDirs();
    const rows = db.listResumes();
    let rebuilt = 0;
    for (const r of rows) {
      if (!r.category) continue;
      const blockKey = r.file_hash || `f${r.id}`;
      const block = buildEntryBlock({ ...r, file_hash: blockKey });
      replaceMarkdownEntry(r.category, blockKey, block);
      rebuilt++;
    }
    return { rebuilt, total: rows.length };
  } catch (e) {
    return { rebuilt: 0, total: 0, error: e.message };
  }
}

module.exports = {
  RESUME_DIR,
  POOL_DIR,
  ensureDirs,
  isTempResumeFile,
  listResumeFiles,
  processFile,
  scanAll,
  ensurePoolMarkdown,
  reconcileDeleted,
  markdownPath,
  buildEntryBlock,
  removeMarkdownEntry,
  fileHash,
  resumeFileName,
  needsRename,
  entryNameable,
  renameResumeFile,
  getRenameLog,
  clearRenameLog
};
