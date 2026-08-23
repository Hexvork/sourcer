'use strict';
const db = require('./db');

const CATEGORIES = [
  '人工智能', '机器人', '软件技术', '硬件技术', '数据',
  '销售', '市场营销', '财务', '人力资源', '设计',
  '运营', '医疗', '教育', '法务', '管理', '其他'
];

const TIMEOUT_MS = 120000;

function stripJson(text) {
  let t = String(text || '').trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) t = t.slice(start, end + 1);
  return t;
}

function parseJsonLoose(text) {
  try {
    return JSON.parse(stripJson(text));
  } catch (e) {
    return null;
  }
}

// 把模型返回的各种分数格式统一归一化为 0-100 的整数：
// 兼容 88 / 0.85 / 85% / 90分 / "85分" 等。避免"85分""0.85"被 Number() 转成 0 而误删高分。
function normalizeScore(s) {
  let v = 0;
  if (typeof s === 'number') v = s;
  else if (s != null) {
    const str = String(s).replace(/[%分\s]/g, '').trim();
    v = str === '' ? NaN : Number(str);
    if (Number.isNaN(v)) {
      const m = String(s).match(/(\d{1,3})(?:\.(\d{1,2}))?/);
      v = m ? Number(m[0]) : 0;
    }
  }
  if (!v || Number.isNaN(v)) v = 0;
  if (v > 0 && v <= 1) v *= 100; // 0-1 比例转 0-100
  return Math.max(0, Math.min(100, Math.round(v)));
}

function buildEndpoint(baseUrl) {
  let u = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!u) return '';
  if (/\/chat\/completions$/i.test(u)) return u;
  if (/\/v1$/i.test(u)) return u + '/chat/completions';
  return u + '/chat/completions';
}

function pickModel(api, preferredModel) {
  const models = api.models || [];
  if (models.length === 0) return null;
  if (preferredModel) {
    const hit = models.find(m => m.name === preferredModel);
    if (hit) return hit.name;
  }
  return models[0].name;
}

async function callOnce(api, model, messages, { json = false } = {}) {
  const url = buildEndpoint(api.base_url);
  if (!url) throw new Error(`API「${api.name}」的 base_url 为空`);
  const body = {
    model,
    messages,
    temperature: 0.2,
    max_tokens: 4000
  };
  // 注意：不再发送 response_format={type:'json_object'}。
  // 实测部分中转/模型（如 mimo-v2.5）带该参数会一直挂起直到 120s 超时，
  // 去掉后同样负载 25s 即返回，且提示词已要求纯 JSON、parseJsonLoose 可兜底解析。
  void json;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + (api.api_key || '')
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  let data;
  try { data = JSON.parse(text); } catch (e) { throw new Error('响应不是 JSON: ' + text.slice(0, 200)); }
  const content = data && data.choices && data.choices[0] && data.choices[0].message
    ? (data.choices[0].message.content || '')
    : (data && data.output_text ? data.output_text : '');
  if (!content) throw new Error('模型返回内容为空');
  return content;
}

/**
 * 按优先级遍历所有启用的 API，失败自动切换到下一个。
 * 返回 { content, apiName, model }
 */
async function callLLM({ messages, json = false, apiId = null, modelName = null }) {
  const apis = db.listAPIs();
  if (!apis.length) throw new Error('NO_API');
  // 指定 API 优先
  if (apiId) {
    const idx = apis.findIndex(a => Number(a.id) === Number(apiId));
    if (idx >= 0) {
      const [a] = apis.splice(idx, 1);
      apis.unshift(a);
    }
  }
  const errors = [];
  for (const api of apis) {
    const model = pickModel(api, modelName);
    if (!model) { errors.push(`${api.name}: 未配置模型`); continue; }
    try {
      const content = await callOnce(api, model, messages, { json });
      return { content, apiName: api.name, model };
    } catch (e) {
      errors.push(`${api.name}/${model}: ${e.message}`);
    }
  }
  throw new Error('所有 API 调用失败：' + errors.join(' | '));
}

function truncate(text, n) {
  const t = String(text || '');
  return t.length > n ? t.slice(0, n) + '…' : t;
}

// ---------------- 分类 + 简历摘要 ----------------
async function categorizeResume(text, filename) {
  const sys = '你是一名资深猎头助理，擅长从简历原文中抽取关键信息并进行岗位分类。只输出 JSON，不要输出任何多余文字。';
  const user = `请阅读下面的简历原文（来自文件：${filename}），完成两件事：
1. 判断它最匹配的岗位分类（必须从该列表中选择一个：${CATEGORIES.join('、')}；如果确实无法判断，用「其他岗位」）。
2. 抽取简历关键信息（姓名、年龄、学历、职务、主要任职公司、经历、大学、其他），并用中文做简洁表述。

严格要求：
- name（姓名）必须从正文中提取真实人名，禁止用文件名、城市名、状态词、未知等占位。
- occupation（岗位/职务）必须从正文中提取，禁止用"状态/未知/相关"等占位。
- birth_year（出生年份）必须填 4 位数字；如果正文只有年龄，请用当前年份（2026）减去年龄计算出来。
- 如果这份内容确实是简历，name、occupation、birth_year 三项都必须有值。
- 如果这份内容不是简历（例如试题、资料、文章、地图），则 name 和 occupation 都返回空字符串，category 返回"其他岗位"。

重要：文件名可能来自旧版错误命名（例如带【】、把城市名/岗位词当姓名、姓名写反），文件名里的姓名不一定可信，请以简历正文中的真实姓名为准，不要被文件名误导。

严格输出如下 JSON（不要包含 Markdown 代码块）：
{
  "category": "人工智能",
  "name": "张三",
  "gender": "男",
  "age": "28",
  "birth_year": "1998",
  "education": "本科",
  "occupation": "AI 算法工程师",
  "company": "某科技有限公司",
  "experience": "5年经验：在A公司做推荐算法，在B公司做NLP……（简洁概括）",
  "university": "浙江大学",
  "other": "关键技能、证书、亮点等",
  "summary": "对这份简历的 2-3 句话简洁概述"
}

简历原文：
${truncate(text, 6000)}`;

  const { content } = await callLLM({
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: user }
    ],
    json: true
  });
  const data = parseJsonLoose(content);
  if (!data) throw new Error('分类返回无法解析: ' + truncate(content, 200));
  return {
    category: CATEGORIES.includes(data.category) ? data.category : (data.category || '其他岗位'),
    name: data.name || '',
    gender: data.gender || '未知',
    age: data.age || '未知',
    birth_year: data.birth_year || '',
    occupation: data.occupation || '',
    experience: data.experience || '',
    university: data.university || '未知',
    other: data.other || '',
    summary: data.summary || ''
  };
}

function profileBlock(profile) {
  const p = profile || {};
  const lines = [];
  if (p.user_name) lines.push(`用户名称：${p.user_name}`);
  if (p.preference) lines.push(`用户偏好：${p.preference}`);
  return lines.length ? lines.join('\n') : '';
}

// ---------------- 搜索匹配 ----------------
async function searchResumes(query, markdown, profile) {
  const extra = profileBlock(profile);
  const sys = '你是一名资深猎头，负责从简历池中匹配合适候选人。只输出 JSON，不要输出任何多余文字。'
    + (extra ? '\n\n' + extra : '');
  const user = `客户岗位需求：
${query}

下面是简历池（Markdown 格式，每个「## 姓名」就是一个候选人）：
${truncate(markdown, 30000)}

请逐一评估每个候选人与岗位的匹配度（0-100 的整数）。只输出匹配度 >= 70 的候选人，按匹配度从高到低排序。如果没有任何人达到 70 分，results 返回空数组。
对每个候选人给出：name（简历中的姓名）、score（70-100 的整数）、reason（为什么匹配度高，结合其经历、技能、岗位要求，50 字以内，具体清晰）、category（该简历所在分类）。

严格输出 JSON：
{"results":[{"name":"张三","score":88,"reason":"……","category":"人工智能岗位"}]}`;

  const { content, apiName, model } = await callLLM({
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: user }
    ],
    json: true
  });
  const data = parseJsonLoose(content);
  if (!data || !Array.isArray(data.results)) throw new Error('匹配返回无法解析: ' + truncate(content, 200));
  const results = data.results
    .map(r => ({
      name: String(r.name || '').trim(),
      score: normalizeScore(r.score),
      reason: String(r.reason || ''),
      category: String(r.category || '')
    }))
    .filter(r => r.name && r.score >= 70)
    .sort((a, b) => b.score - a.score);
  return { results, apiName, model };
}

// ---------------- 简历 ↔ 岗位要求 1v1 精细匹配 ----------------
async function matchResumeToRequirement(textResume, resumeName, textRequirement, reqName, profile) {
  const extra = profileBlock(profile);
  const sys = '你是一名资深猎头/HR 专家，擅长做简历与岗位要求的精细 1v1 匹配分析。只输出 JSON，不要输出任何多余文字。'
    + (extra ? '\n\n' + extra : '');
  const user = `请把这一份候选人的简历，与这份岗位要求做精细的 1v1 匹配分析。

候选人简历（${resumeName}）：
${truncate(textResume, 8000)}

岗位要求（${reqName}）：
${truncate(textRequirement, 8000)}

要求：
1. 输出综合匹配度 score（0-100 的整数）。
2. summary：用一两句话给出总体判断。
3. overlap（相同点/契合点）：逐条、具体地列出简历与岗位要求相匹配的地方，要结合简历经历和岗位要求说明，越详细越好，至少 3 条。
4. gap（不同点/差距）：逐条、具体地列出候选人不足或与岗位要求有差异的地方，越详细越好，至少 2 条。
5. suggestion：给这位候选人的针对性改进建议。

严格输出 JSON：
{
  "score": 85,
  "summary": "总体结论",
  "overlap": ["契合点1", "契合点2", "契合点3"],
  "gap": ["差距/不同点1", "差距/不同点2"],
  "suggestion": "改进建议"
}`;

  const { content, apiName, model } = await callLLM({
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: user }
    ],
    json: true
  });
  const data = parseJsonLoose(content);
  if (!data) throw new Error('匹配分析返回无法解析: ' + truncate(content, 200));
  return {
    score: normalizeScore(data.score),
    summary: data.summary || '',
    overlap: Array.isArray(data.overlap) ? data.overlap : [],
    gap: Array.isArray(data.gap) ? data.gap : [],
    suggestion: data.suggestion || '',
    apiName,
    model
  };
}

// ---------------- 简历 ↔ 岗位要求 1v1 精细匹配（多 Agent 协同）----------------
/**
 * 多 Agent 协同 1v1 匹配：多个子 Agent 从不同维度并发评审简历，
 * 各子 Agent 出结果后交给主 Agent 复核、汇总为最终匹配结论。
 */
async function matchResumeToRequirementMultiAgent(textResume, resumeName, textRequirement, reqName, profile, onProgress) {
  const extra = profileBlock(profile);
  onProgress && onProgress('启动多 Agent 协同匹配…');
  const dims = [
    { key: '技能', label: '专业技能与硬性要求（技术栈、工具、证书、语言等）' },
    { key: '经验', label: '职责、项目与行业经验（做过什么、年限、规模）' },
    { key: '素质', label: '综合素质与软性背景（学历、稳定性、职业规划、通用能力）' }
  ];

  // 1. 子 Agent 并发评审：每个维度一个 Agent
  const subResults = await Promise.all(dims.map(async (dim) => {
    onProgress && onProgress(`子 Agent「${dim.label}」评审中…`);
    const t0 = Date.now();
    const sys = '你是一名资深猎头/HR 面试官，负责从单一维度评审候选人。只输出 JSON，不要多余文字。'
      + (extra ? '\n\n' + extra : '');
    const user = `候选人简历：
${truncate(textResume, 6000)}

岗位要求：
${truncate(textRequirement, 6000)}

请只从「${dim.label}」这一维度，客观评估候选人与岗位要求的契合程度。
输出 score（0-100 整数，代表该维度的匹配度）、fits（契合点数组，每项一句话）、gaps（不足/差距数组，每项一句话）。
严格输出 JSON（不要代码块）：
{"score":82,"fits":["契合点1","契合点2"],"gaps":["差距1","差距2"]}`;
    try {
      const { content } = await callLLM({
        messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
        json: true
      });
      const d = parseJsonLoose(content);
      onProgress && onProgress(`子 Agent「${dim.label}」完成${normalizeScore(d && d.score)}分（${((Date.now()-t0)/1000).toFixed(1)}s）`);
      return {
        key: dim.label,
        score: normalizeScore(d && d.score),
        fits: Array.isArray(d && d.fits) ? d.fits : [],
        gaps: Array.isArray(d && d.gaps) ? d.gaps : []
      };
    } catch (e) {
      console.error('[match-multiAgent-dim]', dim.label, e.message);
      onProgress && onProgress(`子 Agent「${dim.label}」失败，已跳过`);
      return { key: dim.label, score: 0, fits: [], gaps: [], error: e.message };
    }
  }));
  onProgress && onProgress('3 个子 Agent 评审完成，主 Agent 复核汇总中…');

  // 2. 主 Agent 复核：综合各维度，修正偏差并输出最终结论
  const subAvg = subResults.length
    ? Math.round(subResults.reduce((s, r) => s + r.score, 0) / subResults.length)
    : 0;
  let apiName = '子 Agent 汇总', model = '多 Agent 协同';
  let final = null;
  const t1 = Date.now();
  onProgress && onProgress('主 Agent 复核中…');

  const sysMain = '你是一名资深猎头总监，负责复核并综合多个评审 Agent 的结果，给出最终结论。只输出 JSON，不要多余文字。'
    + (extra ? '\n\n' + extra : '');
  const userMain = `请把对候选人「${resumeName}」与岗位「${reqName}」的多维度评审，复核并汇总为最终匹配结论。

岗位要求：
${truncate(textRequirement, 6000)}

各维度评审结果：
${subResults.map(r => `- ${r.key}：${r.score}分
  契合：${(r.fits || []).join('；') || '无'}
  差距：${(r.gaps || []).join('；') || '无'}`).join('\n')}

要求：
1. 给出最终综合匹配度 score（0-100 整数），如某维度分数偏差明显，请予修正。
2. summary：一句话总体判断。
3. overlap：契合点数组，合并并去重，尽量具体，至少 3 条。
4. gap：不足/差距数组，至少 2 条。
5. suggestion：给这位候选人的针对性改进建议。

严格输出 JSON（不要代码块）：
{"score":85,"summary":"总体结论","overlap":["契合点1","契合点2","契合点3"],"gap":["差距1","差距2"],"suggestion":"建议"}`;

  try {
    const { content, apiName: an, model: md } = await callLLM({
      messages: [{ role: 'system', content: sysMain }, { role: 'user', content: userMain }],
      json: true
    });
    const d = parseJsonLoose(content);
    if (d) {
      final = {
        score: normalizeScore(d.score),
        summary: d.summary || '',
        overlap: Array.isArray(d.overlap) ? d.overlap : [],
        gap: Array.isArray(d.gap) ? d.gap : [],
        suggestion: d.suggestion || ''
      };
      apiName = an;
      model = md;
      onProgress && onProgress(`主 Agent 复核完成 ${final.score}分（${((Date.now()-t1)/1000).toFixed(1)}s）`);
    }
  } catch (e) {
    console.error('[match-multiAgent-main]', e.message);
    onProgress && onProgress('主 Agent 复核失败，使用子 Agent 汇总兜底');
  }

  // 主 Agent 复核失败时，用子 Agent 结果兜底
  if (!final) {
    final = {
      score: subAvg,
      summary: '多维度评审的平均综合结果（主 Agent 复核失败，已用子 Agent 结果兜底）。',
      overlap: subResults.flatMap(r => r.fits || []),
      gap: subResults.flatMap(r => r.gaps || []),
      suggestion: ''
    };
  }

  return { ...final, apiName, model };
}

// ---------------- 关键词兜底（未配置模型时也能用） ----------------
function tokenize(s) {
  const tokens = new Set();
  const str = String(s || '').toLowerCase();
  // 英文/数字词
  str.split(/[^a-z0-9\u4e00-\u9fa5]+/).forEach(w => {
    if (w && w.length >= 2) tokens.add(w);
  });
  // 中文 bigram + 单个汉字
  const cjk = str.match(/[\u4e00-\u9fa5]+/g) || [];
  cjk.forEach(seg => {
    if (seg.length === 1) tokens.add(seg);
    for (let i = 0; i + 1 < seg.length; i++) tokens.add(seg.slice(i, i + 2));
  });
  return [...tokens];
}

function keywordMatch(query, resumeText) {
  const qTokens = tokenize(query).filter(t => !/^(的|了|和|与|及|或|在|是|有|等|对|为|你|我|他|她|它|请|帮|找|要|想|需|求|招|聘|岗位|职位|简历|候选人|一个|一位|名|年|岁|经验|要求|负责|能力|熟悉|优先|以上|学历|本科|硕士|博士)$/.test(t));
  if (qTokens.length === 0) return { score: 0, hits: [] };
  const text = String(resumeText || '').toLowerCase();
  const hits = [];
  let weight = 0;
  for (const t of qTokens) {
    const w = t.length >= 4 ? 2 : 1;
    weight += w;
    if (text.includes(t)) hits.push(t);
  }
  const hitWeight = hits.reduce((sum, t) => sum + (t.length >= 4 ? 2 : 1), 0);
  const coverage = weight ? hitWeight / weight : 0;
  const score = Math.round(50 + 45 * coverage);
  // 命中去噪：长词优先，被长词包含的短片段不再展示
  const sorted = [...hits].sort((a, b) => b.length - a.length);
  const clean = [];
  for (const h of sorted) {
    if (!clean.some(c => c.includes(h))) clean.push(h);
    if (clean.length >= 8) break;
  }
  return { score: Math.min(95, score), hits: clean };
}

// ---------------- 多 Agent 并发搜寻 ----------------
/**
 * 多 Agent 并发搜寻：以简历池（资料库）里的每个分类 md 为一个子 Agent 的搜索范围，
 * 多个子 Agent 并行在各自分类 md 中搜寻候选人，最后交给主 Agent 核查汇总。
 */
async function searchResumesMultiAgent(query, markdown, profile) {
  const extra = profileBlock(profile);

  // 1. 把简历池 markdown 按「# 分类」拆成多个子 Agent 的搜索范围（对应资料库里的各 md 文件）
  const categories = splitMarkdownByCategory(markdown);
  if (categories.length === 0) {
    return { results: [], apiName: '', model: '', multiAgent: true };
  }

  // 2. 并发 Agent：每个子 Agent 在各自分类 md 整份内容里搜寻，所有分类并行
  const subAgentResults = [];
  const subAgentErrors = [];

  await Promise.all(categories.map(async (chunk) => {
    const catMatch = chunk.match(/^#\s+(.+)/);
    const category = catMatch ? catMatch[1].trim() : '简历池';
    const sys = '你是一名资深猎头，负责在简历池的一个岗位分类中搜寻与岗位需求匹配的候选人。只输出 JSON，不要多余文字。'
      + (extra ? '\n\n' + extra : '');
    const user = `顾客岗位需求：
${query}

下面是简历池中「${category}」分类的全部候选人（Markdown，每个「## 姓名」就是一个候选人）：
${truncate(chunk, 20000)}

请逐一评估该分类内每个候选人与岗位的匹配度（0-100 整数）。只返回匹配度 >= 70 的候选人，数组按匹配度从高到低排序；没有则返回空数组。
对每个候选人给出：name（那行 ## 后面的姓名）、score（70-100 整数）、reason（为什么匹配，结合其经历/技能/岗位要求，50 字以内）、category（固定为「${category}」）。

严格输出 JSON（不要代码块）：
{"results":[{"name":"张三","score":88,"reason":"……","category":"${category}"}]}`;
    try {
      const { content, apiName, model } = await callLLM({
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: user }
        ],
        json: true
      });
      const data = parseJsonLoose(content);
      const list = (data && Array.isArray(data.results)) ? data.results : [];
      for (const r of list) {
        const sc = normalizeScore(r && r.score);
        const name = String((r && r.name) || '').trim();
        if (name && sc >= 70) {
          subAgentResults.push({ name, score: sc, reason: String((r && r.reason) || ''), category: category, apiName, model });
        }
      }
    } catch (e) {
      subAgentErrors.push(e.message);
    }
  }));

  // 3. 主 Agent 核查：对跨分类初筛结果去重、核查并按匹配度汇总
  if (subAgentResults.length === 0) {
    return { results: [], apiName: '', model: '', multiAgent: true };
  }

  const sysMain = '你是一名资深猎头总监，负责核查和验证多个 Agent 的简历匹配结果。只输出 JSON，不要多余文字。'
    + (extra ? '\n\n' + extra : '');
  const userMain = `顾客岗位需求：
${query}

以下是各子 Agent 在简历池各分类中初筛出的候选人（姓名 / 匹配度 / 所属分类 / 理由）：
${subAgentResults.map(r => `- ${r.name}（${r.category}）：匹配度 ${r.score}，理由：${r.reason || '无'}`).join('\n')}

请做以下工作：
1. 若有同名候选人（可能出现在多个分类），合并为一条，取最高匹配度与最优理由。
2. 核查每个候选人的匹配度是否合理，如有明显偏差请修正（0-100 整数）。
3. 只保留匹配度 >= 70 的候选人，按匹配度从高到低排序。
4. 对每个候选人给出最终理由（50 字以内，具体清晰）并给出其所属 category。

严格输出 JSON（不要代码块）：
{"results":[{"name":"张三","score":88,"reason":"……","category":"人工智能"}]}`;

  let mainResult = {
    results: subAgentResults.map(r => ({
      name: r.name,
      score: normalizeScore(r.score),
      reason: r.reason || '',
      category: r.category || ''
    }))
  };
  // 本地先去重：同名取最高分
  const best = new Map();
  for (const r of mainResult.results) {
    const prev = best.get(r.name);
    if (!prev || r.score > prev.score) best.set(r.name, r);
  }
  mainResult.results = [...best.values()].filter(r => r.score >= 70).sort((a, b) => b.score - a.score);

  try {
    const { content, apiName, model } = await callLLM({
      messages: [
        { role: 'system', content: sysMain },
        { role: 'user', content: userMain }
      ],
      json: true
    });
    const data = parseJsonLoose(content);
    if (data && Array.isArray(data.results)) {
      // 主 Agent 结果同样做本地去重兜底，防止同名重复
      const merged = new Map();
      for (const r of data.results) {
        const name = String(r.name || '').trim();
        const sc = normalizeScore(r.score);
        if (!name) continue;
        const prev = merged.get(name);
        if (!prev || sc > prev.score) merged.set(name, { name, score: sc, reason: String(r.reason || ''), category: String(r.category || '') });
      }
      mainResult = {
        results: [...merged.values()].filter(r => r.score >= 70).sort((a, b) => b.score - a.score)
      };
    }
    mainResult.apiName = apiName;
    mainResult.model = model;
  } catch (e) {
    // 主 Agent 核查失败，使用子 Agent 原始结果
    mainResult.apiName = '子 Agent 汇总';
    mainResult.model = '多 Agent 并发';
  }

  mainResult.multiAgent = true;
  return mainResult;
}

/**
 * 短名单多 Agent：只对已经过本地关键词粗筛的一小批简历（完整简历池条目）做并发评估 + 主 Agent 核查。
 * 按批评估（每批 BATCH_SIZE 人一个子 Agent），控制模型调用次数：
 * 8 人内通常只要 2 个子 Agent + 1 个主 Agent = 3 次调用，速度快且结果完整。
 */
async function searchResumesShortlistMultiAgent(query, shortlistMd, profile) {
  const extra = profileBlock(profile);
  const BATCH_SIZE = 4;
  const entries = splitMarkdownEntries(shortlistMd).slice(0, 12); // 短名单上限 12 人
  if (entries.length === 0) {
    return { results: [], apiName: '', model: '', multiAgent: true };
  }
  const batches = [];
  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    batches.push(entries.slice(i, i + BATCH_SIZE));
  }

  // 子 Agent 并发：每个子 Agent 一次评估一批候选人（看到的是完整简历池条目）
  const subAgentResults = [];
  const errors = [];
  await Promise.all(batches.map(async (batch) => {
    const sys = '你是一名资深猎头，负责评估候选人与岗位需求的匹配度。只输出 JSON，不要多余文字。'
      + (extra ? '\n\n' + extra : '');
    const user = `顾客岗位需求：
${query}

下面是 ${batch.length} 位候选人的简历池条目（Markdown，每个「## 姓名」是一位候选人，含学历、经历、技能等完整信息）：
${batch.map(e => truncate(e, 3500)).join('\n\n')}

请逐一评估每位候选人与岗位的匹配度（0-100 整数）。注意：只要候选人的技能、经历与岗位有实质相关性（技能对口、行业相关、经验可迁移），就应给出 70 分以上并说明理由；只有完全不相关才不打分。返回所有匹配度 >= 70 的候选人，按分数从高到低排序；没有则返回空数组。
对每人给出：name（那行 ## 后面的姓名，去掉括号内容）、score、reason（为什么匹配，30 字内，简明扼要）。

严格输出 JSON（不要代码块）：
{"results":[{"name":"张三","score":88,"reason":"该候选人有3年大模型经验，熟悉RAG和微调，与岗位高度匹配。"}]}`;
    try {
      const { content, apiName, model } = await callLLM({
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: user }
        ],
        json: true
      });
      const d = parseJsonLoose(content);
      const list = (d && Array.isArray(d.results)) ? d.results : [];
      for (const r of list) {
        const nm = String((r && r.name) || '').replace(/（[^）]*）/g, '').trim();
        const sc = normalizeScore(r && r.score);
        if (nm && sc >= 70) {
          subAgentResults.push({ name: nm, score: sc, reason: String((r && r.reason) || ''), apiName, model });
        }
      }
    } catch (e) {
      errors.push(e.message);
    }
  }));

  // 本地去重：同名取最高分
  const best = new Map();
  for (const r of subAgentResults) {
    const prev = best.get(r.name);
    if (!prev || r.score > prev.score) best.set(r.name, r);
  }
  const recognized = [...best.values()].filter(r => r.score >= 70).sort((a, b) => b.score - a.score);

  if (recognized.length === 0) {
    return { results: [], apiName: '', model: '', multiAgent: true };
  }

  // 主 Agent 核查：验证分数、修正偏差、给出最终理由并排序
  const sysMain = '你是一名资深猎头总监，负责核查多个 Agent 的简历匹配结果。只输出 JSON，不要多余文字。'
    + (extra ? '\n\n' + extra : '');
  const userMain = `顾客岗位需求：
${query}

各子 Agent 初筛结果：
${recognized.map(r => `- ${r.name}：匹配度 ${r.score}，理由：${r.reason || '无'}`).join('\n')}

请核查：修正不合理的匹配度(0-100)，同名只保留一条，只保留>=70，按匹配度从高到低排序，给出最终理由(30字内)。
注意：不要过度苛刻，技能对口、经验相关、可迁移的候选人应保留 70 分以上。只输出最终 JSON 数组，不要解释。

严格 JSON（不要代码块）：
{"results":[{"name":"张三","score":88,"reason":"……"}]}`;

  let mainResult = { results: recognized, apiName: '子 Agent 汇总', model: '多 Agent 并发核查' };
  try {
    const { content, apiName, model } = await callLLM({
      messages: [
        { role: 'system', content: sysMain },
        { role: 'user', content: userMain }
      ],
      json: true
    });
    const d = parseJsonLoose(content);
    if (d && Array.isArray(d.results)) {
      const merged = new Map();
      for (const r of d.results) {
        const nm = String(r.name || '').replace(/（[^）]*）/g, '').trim();
        const sc = normalizeScore(r.score);
        if (!nm) continue;
        const prev = merged.get(nm);
        if (!prev || sc > prev.score) merged.set(nm, { name: nm, score: sc, reason: String(r.reason || ''), category: String(r.category || '') });
      }
      mainResult = {
        results: [...merged.values()].filter(r => r.score >= 70).sort((a, b) => b.score - a.score),
        apiName,
        model
      };
    }
  } catch (e) {
    // 主 Agent 核查失败，用子 Agent 结果兜底
  }

  mainResult.multiAgent = true;
  return mainResult;
}

/**
 * 将简历池 Markdown 按「# 分类」标题拆分为多个子 Agent 的搜索范围（对应资料库里的各 md 文件）。
 */
function splitMarkdownByCategory(markdown) {
  const lines = markdown.split('\n');
  const chunks = [];
  let current = [];
  for (const line of lines) {
    if (/^#\s/.test(line) && current.length > 0) {
      if (current.join('\n').trim()) chunks.push(current.join('\n'));
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length && current.join('\n').trim()) chunks.push(current.join('\n'));
  return chunks;
}

/**
 * 将 Markdown 简历池拆分为单个候选人条目（按 ## 标题分割）
 */
function splitMarkdownEntries(markdown) {
  const lines = markdown.split('\n');
  const entries = [];
  let current = [];
  for (const line of lines) {
    if (/^##\s/.test(line) && current.length > 0) {
      entries.push(current.join('\n'));
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) entries.push(current.join('\n'));
  return entries.filter(e => e.trim().length > 0);
}

// ---------------- 多 Agent 并发简历处理 ----------------
/**
 * 多 Agent 并发处理简历：每个 Agent 处理一份简历的摘要/分类，
 * 所有 Agent 并发运行，完成后返回结果。
 */
async function categorizeResumeMultiAgent(text, filename) {
  // 拆分为多个子任务并发
  const sys = '你是一名资深猎头助理，擅长从简历原文中抽取关键信息并进行岗位分类。只输出 JSON，不要输出任何多余文字。';
  const user = `请阅读下面的简历原文（来自文件：${filename}），完成两件事：
1. 判断它最匹配的岗位分类（必须从该列表中选择一个：${CATEGORIES.join('、')}；如果确实无法判断，用「其他岗位」）。
2. 抽取简历关键信息（姓名、年龄、学历、职务、主要任职公司、经历、大学、其他），并用中文做简洁表述。

严格要求：
- name（姓名）必须从正文中提取真实人名，禁止用文件名、城市名、状态词、未知等占位。
- occupation（岗位/职务）必须从正文中提取，禁止用"状态/未知/相关"等占位。
- birth_year（出生年份）必须填 4 位数字；如果正文只有年龄，请用当前年份（2026）减去年龄计算出来。
- 如果这份内容确实是简历，name、occupation、birth_year 三项都必须有值。
- 如果这份内容不是简历（例如试题、资料、文章、地图），则 name 和 occupation 都返回空字符串，category 返回"其他岗位"。

重要：文件名可能来自旧版错误命名（例如带【】、把城市名/岗位词当姓名、姓名写反），文件名里的姓名不一定可信，请以简历正文中的真实姓名为准，不要被文件名误导。

严格输出如下 JSON（不要包含 Markdown 代码块）：
{
  "category": "人工智能",
  "name": "张三",
  "gender": "男",
  "age": "28",
  "birth_year": "1998",
  "education": "本科",
  "occupation": "AI 算法工程师",
  "company": "某科技有限公司",
  "experience": "5年经验：在A公司做推荐算法，在B公司做NLP……（简洁概括）",
  "university": "浙江大学",
  "other": "关键技能、证书、亮点等",
  "summary": "对这份简历的 2-3 句话简洁概述"
}

简历原文：
${truncate(text, 6000)}`;

  try {
    const { content, apiName, model } = await callLLM({
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: user }
      ],
      json: true
    });
    const data = parseJsonLoose(content);
    if (!data) throw new Error('分类返回无法解析: ' + truncate(content, 200));
    return {
      category: CATEGORIES.includes(data.category) ? data.category : (data.category || '其他岗位'),
      name: data.name || '',
      gender: data.gender || '未知',
      age: data.age || '未知',
      birth_year: data.birth_year || '',
      occupation: data.occupation || '',
      experience: data.experience || '',
      university: data.university || '未知',
      other: data.other || '',
      summary: data.summary || '',
      apiName,
      model
    };
  } catch (e) {
    throw e;
  }
}

// ---------------- 文件名/提取结果 AI 复核 ----------------
/**
 * 轻量级复核：AI 读取文件名和提取的字段，判断是否明显不合理。
 * 如果合理 → { correct: true }
 * 如果不合理 → { correct: false, name, occupation, birthYear } 给出修正值
 * 不传入简历原文，纯靠文件名和字段上下文判断，只抓明显错误。
 */
async function reviewExtractedFields(fileName, name, occupation, birthYear) {
  const sys = '你是简历文件名审核专家。审核系统提取的姓名和岗位是否合理，只输出JSON。';
  const user = `系统根据简历内容提取了以下信息，准备生成文件名：
文件名候选：${occupation || '（无）'}-${name || '（无）'}${birthYear && birthYear !== '未知' ? '-'+birthYear : ''}.pdf
提取的姓名：${name || '（空）'}
提取的岗位：${occupation || '（空）'}
提取的出生年份：${birthYear || '未知'}

请判断：姓名和岗位是否明显不合理（例如姓名是"杭州""状态""年龄""本科"这类非人名，岗位是"状态""年龄""功能""性能"这类非岗位词，或者姓名和岗位明显是占位/噪声）？
如果合理，只输出：{"correct":true}
如果不合理，输出正确的值（只改明显错误的字段，不确定的字段留空让后续处理）：{"correct":false,"name":"正确的姓名","occupation":"正确的岗位","birthYear":"正确的出生年份"}`;

  const { content, apiName, model } = await callLLM({
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: user }
    ],
    json: true
  });
  const data = parseJsonLoose(content);
  if (!data || data.correct === true) return { correct: true };
  return {
    correct: false,
    name: data.name || '',
    occupation: data.occupation || '',
    birthYear: data.birthYear || ''
  };
}
module.exports = {
  CATEGORIES,
  callLLM,
  categorizeResume,
  categorizeResumeMultiAgent,
  reviewExtractedFields,
  searchResumes,
  searchResumesMultiAgent,
  searchResumesShortlistMultiAgent,
  matchResumeToRequirement,
  matchResumeToRequirementMultiAgent,
  keywordMatch,
  tokenize,
  truncate,
  parseJsonLoose,
  splitMarkdownEntries
};
