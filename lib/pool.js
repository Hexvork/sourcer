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

function ensureDirs() {
  fs.mkdirSync(RESUME_DIR, { recursive: true });
  fs.mkdirSync(POOL_DIR, { recursive: true });
}

function fileHash(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('md5').update(buf).digest('hex').slice(0, 16);
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
  const name = pickRegex(t, /(?:姓名|名字)[\s:：]{1,}([^\s,，。；;]{2,20})/) || nameFromFilename(filename) || filename.replace(/\.[^.]+$/, '');
  const gender = /女/.test(t.slice(0, 200)) ? '女' : (/男/.test(t.slice(0, 200)) ? '男' : '未知');
  const hasCn = (s) => /[\u4e00-\u9fa5]/.test(String(s || ''));
  const birth = extractBirth(t, filename);
  const age = birth.age || pickRegex(t, /(?:年龄)[\s:：]{1,}(\d{2,3})/) || pickRegex(t, /(\d{2,3})\s*岁/) || '未知';
  const education = detectEducation(t) || '未知';
  const university = pickRegex(t, /([\u4e00-\u9fa5]{2,20}(?:大学|学院))/) || pickRegex(t, /(?:大学|学院|学校)[\s:：]{1,}([^\s,，。；;\n]{2,20})/) || '未知';
  const occupation = pickRegex(t, /(?:求职意向|应聘|岗位|职位|职业|职务)[\s:：]{1,}([^\s,，。；;\n]{2,30})/) || category + '相关';
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
  const existing = new Set();
  if (fs.existsSync(RESUME_DIR)) {
    for (const f of fs.readdirSync(RESUME_DIR)) {
      existing.add(path.resolve(path.join(RESUME_DIR, f)));
    }
  }
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

// ---------------- 简历原文件自动重命名：姓名-出生年份 ----------------
// 不再拼接职位或性别；只有抽到可靠姓名时才改。出生年份优先取 4 位年份，简历只给年龄时用当前年份减出来。

function sanitizeNamePart(s) {
  return String(s || '')
    .replace(/[\\/:*?"<>|\r\n\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[. ]+|[. ]+$/g, '');
}

// 清洗姓名：去掉“女/男/先生/女士/老师”等尾巴和括号备注，避免“陈艳萍女”这种脏名字
function cleanName(name) {
  let s = sanitizeNamePart(name);
  if (!s) return '';
  s = s
    .replace(/[（(]\s*(?:女|男|先生|女士|小姐)\s*[）)]/gu, '')
    .trim();
  // 称呼类尾巴：直接删；若剩 1 个字会被 entryNameable 判为不可靠，不会拿去命名
  s = s.replace(/(?:先生|女士|小姐|老师)$/u, '').trim();
  // 性别单字尾巴：只有原名至少 4 个字时才删，避免“张伟男”这种真名被误伤
  s = s.replace(/(?:女|男)$/u, (m) => (s.length - m.length >= 3 ? '' : m)).trim();
  return s;
}

// 常见职位/称呼词，用于从“职位-姓名”这种原始文件名里把姓名段挑出来
const JOB_WORDS = [
  '教师', '老师', '工程师', '总监', '经理', '主管', '专员', '顾问', '培养生', '实习生',
  '负责人', '助理', '设计师', '分析师', '编辑', '编导', '销售', '运营', '管理', '会计',
  '出纳', '律师', '医生', '护士', '研究员', '讲师', '教授', '教练', '策划', '客服',
  '采购', '物流', '开发', '测试', '运维', '产品', '市场', '品牌', '公关', '人力',
  '招聘', '薪酬', '绩效', '培训', '法务', '财务', '投资', '招商', '算法', '总裁',
  '总经理', '董事', '创始人', '合伙人', '校长', '院长', '主任', '文员', '秘书', '司机'
];

function isJobWord(s) {
  const t = String(s || '');
  return JOB_WORDS.some(w => t.includes(w));
}

// 从“营销培养生-刘新伟.docx / 李生-资深算法工程师-1981年.pdf”这类原始文件名里尽量拆出姓名；
// 拆不到返回空字符串，绝不硬猜。
function nameFromFilename(filename) {
  const base = String(filename || '').replace(/\.[^.]+$/, '');
  if (!base) return '';
  const segments = base.split(/[-_ ]+/).map(s => s.trim()).filter(Boolean);
  if (!segments.length) return '';
  const candidates = segments.filter(s =>
    /^[\u4e00-\u9fa5·]{2,4}$/.test(s) &&          // 纯中文 2~4 字
    !isJobWord(s) &&                               // 不是职位段
    !/先生|女士|小姐|老师$/.test(s)               // 不是称呼占位
  );
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    // 多个候选时优先 2~3 字（常见姓名长度），仍多个就取第一个
    const short = candidates.filter(s => s.length <= 3);
    return short.length === 1 ? short[0] : candidates[0];
  }
  return '';
}

// 最终用于命名的姓名：优先 DB/AI 抽出的姓名；若它是“职位-姓名”整串占位，再尝试从原文件名拆
function effectiveName(entry) {
  const direct = cleanName(entry.name);
  if (direct && !/[-_|/\\]/.test(direct) && !/\d/.test(direct) && direct.length >= 2) return direct;
  const fromFile = nameFromFilename(entry.source_file);
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

// 目标文件名主体：姓名-出生年份（不再拼职位/性别；年份缺失就只保留姓名）
function resumeFileName(entry) {
  const name = effectiveName(entry);
  const year = birthYearOf(entry);
  return year ? `${name}-${year}` : name;
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
  if (!name || name.length < 2) return false;
  // 姓名里带文件名连接符/路径分隔符，说明很可能是“职位-姓名”这种没拆开的占位名
  if (/[-_|/\\]/.test(name)) return false;
  // 姓名里混入数字也视为不可靠
  if (/\d/.test(name)) return false;
  // fallback 特征：姓名没抽到，直接拿原文件名兜底
  if (entry.source_file) {
    const base = sanitizeNamePart(path.basename(entry.source_file, path.extname(entry.source_file)));
    if (name === base) return false;
  }
  return true;
}

/**
 * 把简历原文件重命名为「姓名-出生年份」并同步 DB（与简历池，可选）。
 * @param {boolean} [options.rebuildMd=true] 改名后是否立即重建简历池条目（补命名场景用；
 *        入库流程中由 processFile 在改名后统一写入 Markdown，传 false 避免重复写）
 * @returns {null | {oldPath: string, newPath: string}} 未改名（信息不足/已同名/失败）返回 null
 */
function renameResumeFile(filePath, entry, { resumeId = null, rebuildMd = true } = {}) {
  const oldAbs = path.resolve(filePath);
  // 数据不足以支撑命名（姓名为占位/含职位连接符等）时不改名，防止污染文件名
  if (!entryNameable(entry)) return null;
  const dir = path.dirname(oldAbs);
  const ext = path.extname(oldAbs);
  const target = resumeFileName(entry);
  if (!target) return null;

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
    let entry;
    try {
      const ai = multiAgent
        ? await llm.categorizeResumeMultiAgent(text, path.basename(abs))
        : await llm.categorizeResume(text, path.basename(abs));
      entry = { ...ai, fallback: false };
    } catch (e) {
      if (e.message === 'NO_API') {
        entry = fallbackCategorize(text, path.basename(abs));
      } else {
        entry = fallbackCategorize(text, path.basename(abs));
        entry.fallback = true;
        entry.other = (entry.other ? entry.other + '；' : '') + '（分类时模型调用失败，已用规则兜底）';
      }
    }
    // 原文件保留在「简历」文件夹，简历池只放 Markdown
    // 出生日期/年龄/学历用规则层可靠抽取并覆盖，避免 AI 识别不出
    const birth = extractBirth(text, path.basename(abs));
    const edu = detectEducation(text);
    const fullEntry = {
      name: entry.name,
      gender: entry.gender,
      age: birth.age || entry.age || '未知',
      birth_date: birth.birth_date,
      education: edu || entry.education || '',
      occupation: entry.occupation,
      company: entry.company || '',
      experience: entry.experience,
      university: entry.university,
      other: entry.other,
      category: entry.category,
      original_path: abs,
      pool_path: abs,
      source_file: path.basename(abs),
      file_hash: hash,
      content: text,
      summary: entry.summary
    };
    // needs_ai：规则匹配不到姓名（占位数据）→ 标记待 AI 补全；
    // 配好 AI 后对标记的简历重新抽取并重命名、清除标记。已匹配到的不重复处理。
    const needsAI = (!entryNameable(fullEntry)) ? 1 : 0;
    fullEntry.needs_ai = needsAI;
    resumeId = db.upsertResume(fullEntry);
    // 第一步：先给原文件重命名「姓名-出生年份」（规则/AI 能搜到姓名就改；
    // 年份缺失就只留姓名；搜不到的占位数据被 entryNameable 拦截，保持原名并靠 needs_ai 等 AI 补全）
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
  const files = fs.readdirSync(RESUME_DIR)
    .filter(f => !f.startsWith('~$') && !f.startsWith('.'))
    .filter(f => parse.SUPPORTED.includes(parse.extOf(f)))
    .map(f => path.join(RESUME_DIR, f));
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
  renameResumeFile
};
