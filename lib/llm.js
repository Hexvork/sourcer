'use strict';
const db = require('./db');

const CATEGORIES = [
  '人工智能岗位', '机器人岗位', '软件技术岗位', '硬件技术岗位', '数据岗位',
  '销售岗位', '市场营销岗位', '财务岗位', '人力资源岗位', '设计岗位',
  '运营岗位', '医疗岗位', '教育岗位', '法务岗位', '管理岗位', '其他岗位'
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
  if (json) body.response_format = { type: 'json_object' };

  const doFetch = async (b) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + (api.api_key || '')
      },
      body: JSON.stringify(b),
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
  };

  try {
    return await doFetch(body);
  } catch (e) {
    // 有些供应商不支持 response_format，去掉后重试一次
    if (json && body.response_format) {
      delete body.response_format;
      return await doFetch(body);
    }
    throw e;
  }
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
2. 抽取简历关键信息，并用中文做简洁表述。

严格输出如下 JSON（不要包含 Markdown 代码块）：
{
  "category": "人工智能岗位",
  "name": "张三",
  "gender": "男",
  "age": "28",
  "occupation": "AI 算法工程师",
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
    name: data.name || filename.replace(/\.[^.]+$/, ''),
    gender: data.gender || '未知',
    age: data.age || '未知',
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
      score: Math.max(0, Math.min(100, Math.round(Number(r.score) || 0))),
      reason: String(r.reason || ''),
      category: String(r.category || '')
    }))
    .filter(r => r.name && r.score >= 70)
    .sort((a, b) => b.score - a.score);
  return { results, apiName, model };
}

// ---------------- 两份简历对比 ----------------
async function matchTwoResumes(textA, nameA, textB, nameB, profile) {
  const extra = profileBlock(profile);
  const sys = '你是一名资深猎头/HR 专家，擅长对比两份简历的匹配程度。只输出 JSON，不要输出任何多余文字。'
    + (extra ? '\n\n' + extra : '');
  const user = `请对比以下两份简历，评估他们之间的综合匹配度（0-100 的整数，代表两个人背景/技能/经历/方向的相似与互补程度）。
简历A（${nameA}）：
${truncate(textA, 6000)}

简历B（${nameB}）：
${truncate(textB, 6000)}

严格输出 JSON：
{
  "score": 85,
  "summary": "两者匹配度很高的总体结论（一句话）",
  "overlap": ["共同点1", "共同点2", "共同点3"],
  "gap": ["差异点1", "差异点2"]
}`;

  const { content, apiName, model } = await callLLM({
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: user }
    ],
    json: true
  });
  const data = parseJsonLoose(content);
  if (!data) throw new Error('对比返回无法解析: ' + truncate(content, 200));
  return {
    score: Math.max(0, Math.min(100, Math.round(Number(data.score) || 0))),
    summary: data.summary || '',
    overlap: Array.isArray(data.overlap) ? data.overlap : [],
    gap: Array.isArray(data.gap) ? data.gap : [],
    apiName,
    model
  };
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

module.exports = {
  CATEGORIES,
  callLLM,
  categorizeResume,
  searchResumes,
  matchTwoResumes,
  keywordMatch,
  tokenize,
  truncate,
  parseJsonLoose
};
