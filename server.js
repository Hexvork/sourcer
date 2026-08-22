'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const express = require('express');
const chokidar = require('chokidar');

const db = require('./lib/db');
const parse = require('./lib/parse');
const llm = require('./lib/llm');
const pool = require('./lib/pool');

const ROOT = __dirname;
const PORT = process.env.PORT || 3000;
const app = express();

app.use(express.json({ limit: '60mb' }));
app.use(express.static(path.join(ROOT, 'public')));

pool.ensureDirs();
db.initDB();
// 启动时对账一次：清理数据库中原始文件已不存在的记录，保证状态栏数量实时、准确
try { pool.reconcileDeleted(); } catch (e) { console.error('[reconcile@boot]', e.message); }

// ---------------- 工具函数 ----------------
let processing = false;
let pendingQueue = [];
let lastScan = { time: null, total: 0, done: 0, errors: 0, running: false };

function readAllMarkdown() {
  const files = fs.readdirSync(pool.POOL_DIR)
    .filter(f => f.toLowerCase().endsWith('.md'))
    .sort((a, b) => a.localeCompare(b, 'zh-CN'));
  const chunks = [];
  for (const f of files) {
    const p = path.join(pool.POOL_DIR, f);
    chunks.push(fs.readFileSync(p, 'utf8'));
  }
  return chunks.join('\n\n');
}

function now() {
  return new Date().toLocaleString('zh-CN', { hour12: false });
}

function processQueue(files, force, multiAgent) {
  const list = Array.isArray(files) ? files : [files];
  for (const f of list) {
    pendingQueue.push({ file: f, force: !!force, multiAgent: !!multiAgent });
  }
  if (!processing) {
    lastScan.total = pendingQueue.length;
    lastScan.done = 0;
    lastScan.errors = 0;
    lastScan.skipped = 0;
    lastScan.time = now();
    lastScan.multiAgent = !!multiAgent;
    drainQueue();
  }
}

async function drainQueue() {
  if (processing) return;
  processing = true;
  lastScan.running = true;
  try {
    while (pendingQueue.length) {
      const { file, force, multiAgent } = pendingQueue.shift();
      try {
        const r = await pool.processFile(file, { force, multiAgent });
        if (r.ok) lastScan.done++;
        else if (r.skipped) lastScan.skipped++;
        else lastScan.errors++;
      } catch (e) {
        lastScan.errors++;
        console.error('[scan]', file, e.message);
      }
    }
  } finally {
    processing = false;
    lastScan.running = false;
  }
}

// ---------------- 页面 ----------------
app.get('/', (req, res) => res.sendFile(path.join(ROOT, 'public', 'index.html')));

// ---------------- 状态 ----------------
app.get('/api/state', (req, res) => {
  const s = db.stats();
  res.json({ ...s, lastScan, port: PORT });
});

// ---------------- 简历列表 ----------------
app.get('/api/resumes', (req, res) => {
  res.json(db.listResumes());
});

app.get('/api/pool-md', (req, res) => {
  const files = fs.readdirSync(pool.POOL_DIR)
    .filter(f => f.toLowerCase().endsWith('.md'))
    .map(f => ({ name: f, path: path.join(pool.POOL_DIR, f) }));
  res.json(files);
});

// ---------------- 搜索 ----------------
app.post('/api/search', async (req, res) => {
  const query = String(req.body.query || '').trim();
  if (!query) return res.status(400).json({ error: '请输入岗位需求' });
  const apiId = req.body.apiId || null;
  const modelName = req.body.modelName || null;
  const multiAgent = !!req.body.multiAgent;

  let results = [];
  let engine = 'ai';
  let usedApi = null;
  let error = null;
  const markdown0 = readAllMarkdown();

  // 自愈：若简历池 markdown 为空但数据库里已有记录（例如 markdown 曾被清空），
  // 从 DB 重建后再搜索，避免「简历池空却提示已同步」「明明有≥70%却搜不到」。
  if (!markdown0.trim() && db.stats().resumes > 0) {
    try {
      pool.ensurePoolMarkdown();
    } catch (_) { /* 忽略重建失败，走下一步 */ }
  }
  const markdown = readAllMarkdown();

  if (!markdown.trim()) {
    return res.status(404).json({ error: '简历池还是空的。请先把简历放进「简历」文件夹，系统会自动归类；或点击「立即扫描」。', results: [] });
  }

  try {
    const profile = db.getUserProfile();
    let r;
    if (multiAgent) {
      // 多 Agent 协同：简历库小时（<=12 人）全员进短名单；大库时先用本地关键词毫秒级粗筛 Top 12。
      // 短名单条目用 pool.buildEntryBlock 生成——与简历池 md 完全一致的完整结构化信息（学历/经历/技能等），
      // 交给子 Agent 分批并发评估 + 主 Agent 核查。调用次数 = 批数 + 1（8 人约 3 次），速度快且结果完整。
      const all = db.listResumes();
      let picked;
      if (all.length <= 12) {
        picked = all.map(x => ({ row: x, score: 0, hits: [] }));
      } else {
        const kw = all.map(x => {
          const m = llm.keywordMatch(query, (x.content || '') + '\n' + x.summary + '\n' + x.occupation + '\n' + x.experience);
          return { row: x, score: m.score, hits: m.hits };
        }).sort((a, b) => b.score - a.score);
        picked = kw.filter(x => x.score > 0).slice(0, 12);
        if (picked.length === 0) picked = kw.slice(0, 12);
      }
      if (picked.length > 0) {
        // 精简条目：与简历池 md 同源的字段，但去掉「文件路径」等对匹配无用的长文本，减少 token、加快响应
        const shortlistMd = picked.map(x => {
          const r = x.row;
          return [
            `## ${r.name}（${r.gender}，${r.age}）`,
            `- 职务：${r.occupation || '未提取'}`,
            `- 学历：${r.education || '未提取'}`,
            `- 主要任职公司：${r.company || '未提取'}`,
            `- 经历：${r.experience || '未提取'}`,
            `- 大学：${r.university || '未提取'}`,
            `- 其他重要信息：${r.other || '无'}`,
            `- 简述：${r.summary || ''}`
          ].join('\n');
        }).join('\n\n');
        r = await llm.searchResumesShortlistMultiAgent(query, shortlistMd, profile);
        r.shortlistCount = picked.length;
      } else {
        r = await llm.searchResumesMultiAgent(query, markdown, profile);
      }
    } else {
      r = await llm.searchResumes(query, markdown, profile);
    }
    results = r.results;
    usedApi = r.apiName + ' / ' + r.model;
    if (multiAgent) usedApi = '多 Agent 协同（' + (r.shortlistCount || '') + '人分批→主Agent核查）：' + usedApi;
  } catch (e) {
    if (e.message === 'NO_API') {
      engine = 'fallback';
      error = '尚未配置模型，已用关键词规则粗筛。配置模型后可获得更精准的 AI 匹配。';
    } else {
      engine = 'fallback';
      error = '模型调用失败，已用关键词规则粗筛：' + e.message;
    }
  }

  if (engine === 'fallback') {
    const all = db.listResumes();
    const scored = all.map(r => {
      const { score, hits } = llm.keywordMatch(query, (r.content || '') + '\n' + r.summary + '\n' + r.occupation + '\n' + r.experience);
      return {
        name: r.name,
        score,
        reason: hits.length ? '命中关键词：' + hits.join('、') : '关键词匹配度一般',
        category: r.category
      };
    }).filter(x => x.score >= 70).sort((a, b) => b.score - a.score);
    results = scored;
  }

  // 兜底：AI 判定没有任何 ≥70% 的简历，但简历池非空且确实有关键词高命中者时，
  // 改用关键词粗筛补上，避免明明有相关简历却误报「没有找到匹配度 ≥70% 的简历」。
  if (engine === 'ai' && results.length === 0) {
    const all = db.listResumes();
    const kwScored = all.map(r => {
      const { score, hits } = llm.keywordMatch(query, (r.content || '') + '\n' + r.summary + '\n' + r.occupation + '\n' + r.experience);
      return {
        name: r.name,
        score,
        reason: hits.length ? '关键词命中：' + hits.join('、') : '关键词匹配度一般',
        category: r.category
      };
    }).filter(x => x.score >= 70).sort((a, b) => b.score - a.score);
    if (kwScored.length) {
      results = kwScored;
      engine = 'fallback';
      error = 'AI 判定此岗位无 ≥70% 的简历，已临时用关键词粗筛兜底展示相关候选人，请人工核对。';
    }
  }

  // 关联数据库中的简历详情
  const enriched = results.map(r => {
    const row = db.getResumeByName(r.name) || db.listResumes().find(x => x.name && String(x.name).includes(String(r.name)));
    if (row) {
      return {
        id: row.id,
        name: row.name,
        gender: row.gender,
        age: row.age,
        birth_date: row.birth_date,
        education: row.education,
        occupation: row.occupation,
        company: row.company,
        university: row.university,
        category: row.category,
        pool_path: row.pool_path,
        original_path: row.original_path,
        score: r.score,
        reason: r.reason,
        ring: ringClass(r.score)
      };
    }
    return { ...r, id: null, gender: '未知', age: '未知', birth_date: '', education: '', occupation: '', company: '', university: '', pool_path: '', original_path: '', ring: ringClass(r.score) };
  }).filter(r => r.score >= 70).sort((a, b) => b.score - a.score);

  // 保存历史
  const title = query.slice(0, 30) + (query.length > 30 ? '…' : '');
  const convId = db.createConversation(title, 'search');
  db.addMessage(convId, 'user', query, '');
  db.addMessage(convId, 'assistant', engine === 'ai' ? `为你找到 ${enriched.length} 份匹配度 ≥70% 的简历` : (error || '关键词粗筛结果'), JSON.stringify(enriched));

  res.json({ results: enriched, conversationId: convId, engine, usedApi, error, total: enriched.length });
});

function ringClass(score) {
  if (score >= 90) return 'green';
  if (score >= 80) return 'blue';
  return 'yellow';
}

// ---------------- 简历 ↔ 岗位要求 1v1 精细匹配 ----------------
const matchProgress = {}; // runId -> { step, ts, done }
app.post('/api/match-resumes', async (req, res) => {
  const A = req.body.fileA || {};
  const B = req.body.fileB || {};
  const resumeText = String(req.body.resumeText || '').trim();
  const reqText = String(req.body.requirementText || '').trim();
  const multiAgent = !!req.body.multiAgent;
  const resumeNameFromUI = String(req.body.nameA || '').trim();
  const runId = String(req.body.runId || ('m' + Date.now()));
  matchProgress[runId] = { step: '排队中…', ts: Date.now(), done: false };
  const setProgress = (step) => { if (matchProgress[runId]) { matchProgress[runId].step = step; matchProgress[runId].ts = Date.now(); } };
  const finishProgress = () => { if (matchProgress[runId]) matchProgress[runId].done = true; };
  if (!A.data && !resumeText) return res.status(400).json({ error: '请放入候选人的简历文件，或粘贴简历原文' });
  if (!B.data && !reqText) return res.status(400).json({ error: '请放入岗位要求文件，或直接粘贴岗位要求文字' });

  let textA, textB;
  let nameA = A.name || resumeNameFromUI || '候选人简历';
  let nameB = B.name || '岗位要求';
  try {
    setProgress('正在解析简历文件…');
    textA = resumeText ? resumeText : await parse.parseBuffer(Buffer.from(A.data, 'base64'), A.name || 'resume.pdf');
    if (B.data) {
      textB = await parse.parseBuffer(Buffer.from(B.data, 'base64'), B.name || 'jd.pdf');
      nameB = B.name || '岗位要求文件';
    } else {
      textB = reqText;
      nameB = '粘贴的岗位要求';
    }
  } catch (e) {
    finishProgress();
    return res.status(400).json({ error: '文件解析失败：' + e.message });
  }

  let out;
  let engine = 'ai';
  try {
    out = multiAgent
      ? await llm.matchResumeToRequirementMultiAgent(textA, nameA, textB, nameB, db.getUserProfile(), setProgress)
      : (setProgress('AI 匹配分析中…'), await llm.matchResumeToRequirement(textA, nameA, textB, nameB, db.getUserProfile()));
    setProgress('匹配完成');
  } catch (e) {
    engine = 'fallback';
    const kw = llm.keywordMatch(textB, textA);
    const score = kw.score;
    out = {
      score,
      summary: score >= 70 ? '简历与岗位要求关键词重合度较高（规则粗筛）。' : '简历与岗位要求关键词重合度一般（规则粗筛）。',
      overlap: kw.hits.slice(0, 8).map(h => `命中关键词：${h}`),
      gap: ['规则模式暂无法输出详细差异，请配置模型获得精细分析'],
      suggestion: '配置模型后可获得针对性改进建议',
      usedApi: null,
      model: null
    };
    setProgress('模型调用失败，已用关键词粗筛兜底');
  }

  const convId = db.createConversation(`${nameA} ↔ ${nameB} 匹配度`, 'match');
  db.addMessage(convId, 'user', `简历「${nameA}」与岗位要求「${nameB}」匹配分析`, '');
  db.addMessage(convId, 'assistant', `匹配度 ${out.score}%。${out.summary}`, JSON.stringify({ score: out.score, summary: out.summary, overlap: out.overlap, gap: out.gap, suggestion: out.suggestion }));

  finishProgress();
  res.json({ score: out.score, summary: out.summary, overlap: out.overlap, gap: out.gap, suggestion: out.suggestion, engine, usedApi: (multiAgent ? '多 Agent 协同：' : '') + (out.apiName ? `${out.apiName} / ${out.model}` : ''), names: [nameA, nameB] });
});

// 匹配进度查询
app.get('/api/match-progress/:runId', (req, res) => {
  const p = matchProgress[req.params.runId];
  if (!p) return res.status(404).json({ error: 'not found' });
  res.json(p);
});

// ---------------- 打开文件（默认程序 / WPS） ----------------
app.post('/api/open-file', (req, res) => {
  const p = String(req.body.path || '').trim();
  if (!p) return res.status(400).json({ error: '路径为空' });
  if (!fs.existsSync(p)) return res.status(404).json({ error: '文件不存在：' + p });
  const abs = path.resolve(p);
  try {
    if (os.platform() === 'win32') {
      execFile('cmd.exe', ['/c', 'start', '', abs], (err) => {
        if (err) console.error('[open]', err.message);
      });
    } else if (os.platform() === 'darwin') {
      execFile('open', [abs], (err) => { if (err) console.error('[open]', err.message); });
    } else {
      execFile('xdg-open', [abs], (err) => { if (err) console.error('[open]', err.message); });
    }
    res.json({ ok: true, path: abs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------- 历史 ----------------
app.get('/api/history', (req, res) => {
  res.json(db.listConversations(200));
});

app.get('/api/history/:id', (req, res) => {
  const conv = db.getConversation(Number(req.params.id));
  if (!conv) return res.status(404).json({ error: '未找到该对话' });
  conv.messages = (conv.messages || []).map(m => ({
    id: m.id,
    role: m.role,
    content: m.content,
    results: m.results ? JSON.parse(m.results || '[]') : [],
    created_at: m.created_at
  }));
  res.json(conv);
});

app.delete('/api/history/:id', (req, res) => {
  db.deleteConversation(Number(req.params.id));
  res.json({ ok: true });
});

// ---------------- 设置 ----------------
app.get('/api/settings', (req, res) => {
  const profile = db.getUserProfile();
  res.json({
    user_name: profile.user_name,
    preference: profile.preference,
    apis: db.listAPIs(),
    app: {
      multiAgentSearch: db.getAppSetting('multiAgentSearch', '0'),
      multiAgentPool: db.getAppSetting('multiAgentPool', '1')
    }
  });
});

app.put('/api/settings', (req, res) => {
  try {
    db.saveUserProfile(req.body.user_name || '', req.body.preference || '');
    db.saveAPIs(req.body.apis || []);
    if (req.body.app) {
      if (req.body.app.multiAgentSearch != null) db.setAppSetting('multiAgentSearch', req.body.app.multiAgentSearch ? '1' : '0');
      if (req.body.app.multiAgentPool != null) db.setAppSetting('multiAgentPool', req.body.app.multiAgentPool ? '1' : '0');
    }
    // 配置好 API 后第一件事：补命名已有简历文件为「岗位-姓名-出生年份」并同步简历池
    // （未配 API 入库时跳过重命名；这里拿到 API 立即把欠下的重命名补上）
    if (db.listAPIs().length > 0) {
      try {
        const files = fs.readdirSync(pool.RESUME_DIR)
          .filter(f => !f.startsWith('~$') && !f.startsWith('.'))
          .filter(f => parse.SUPPORTED.includes(parse.extOf(f)))
          .map(f => path.join(pool.RESUME_DIR, f));
        const plan = planResumeQueue(files);
        if (plan.toProcess.length) {
          console.log('[settings] 配置 API 后补命名：需重命名', plan.renameQueued, '份，待处理', plan.pending, '份');
          const multiAgent = db.getAppSetting('multiAgentPool', '1') === '1';
          processQueue(plan.toProcess, plan.renameQueued > 0, multiAgent);
        }
      } catch (e) {
        console.error('[settings-rename]', e.message);
      }
    }
    const profile = db.getUserProfile();
    res.json({
      ok: true,
      user_name: profile.user_name,
      preference: profile.preference,
      apis: db.listAPIs(),
      app: {
        multiAgentSearch: db.getAppSetting('multiAgentSearch', '0'),
        multiAgentPool: db.getAppSetting('multiAgentPool', '1')
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 扫描队列规划：
// - 未处理文件 → 入队处理
// - needs_ai=1（规则匹配不到姓名/岗位）→ 配好 API 后入队 force，AI 补全并重命名
// - 已处理（hash 未变）但文件名不符合「岗位-姓名-出生年份」→ 数据齐全直接用 DB 记录改名（不重复调 AI）
function planResumeQueue(files) {
  const toProcess = [];
  let pending = 0, already = 0, renameQueued = 0;
  // 未配置 API 时不做「AI 补全」的重处理（改了也只会是规则占位数据），等配好 API 后点扫描再补
  const hasApi = db.listAPIs().length > 0;
  for (const f of files) {
    const abs = path.resolve(f);
    const prev = db.getProcessedFile(abs);
    let isDone = false;
    if (prev && prev.status === 'done') {
      try { isDone = prev.hash === pool.fileHash(abs); } catch (e) { isDone = false; }
    }
    if (!isDone) { pending++; toProcess.push(abs); continue; }
    const row = db.getResumeByPath(abs);
    if (!row) { already++; continue; }
    if (row.needs_ai === 1) {
      // 规则匹配不到的简历：等 AI 补全（配好 API 后重新抽取 → 重命名 → 清除标记）
      if (hasApi) { renameQueued++; toProcess.push(abs); } else { already++; }
    } else if (pool.needsRename(abs, row)) {
      if (pool.entryNameable(row)) {
        try {
          const r = pool.renameResumeFile(abs, row, { resumeId: row.id });
          if (r) console.log('[rename]', r.oldPath, '→', r.newPath);
        } catch (e) {
          console.error('[rename] 失败:', abs, e.message);
          renameQueued++; toProcess.push(abs);
        }
      } else {
        already++;
      }
    } else {
      already++;
    }
  }
  return { toProcess, pending, already, renameQueued };
}

// ---------------- 手动扫描 ----------------
app.post('/api/scan', async (req, res) => {
  const force = !!req.body.force;
  const multiAgent = db.getAppSetting('multiAgentPool', '1') === '1';
  // 自愈：扫描前先从 DB 重建简历池 markdown，防止数据库有记录但简历池为空
  try { pool.ensurePoolMarkdown(); } catch (_e) { /* 忽略 */ }
  const files = fs.readdirSync(pool.RESUME_DIR)
    .filter(f => !f.startsWith('~$') && !f.startsWith('.'))
    .filter(f => parse.SUPPORTED.includes(parse.extOf(f)))
    .map(f => path.join(pool.RESUME_DIR, f));
  const plan = planResumeQueue(files);
  res.json({ ok: true, total: files.length, pending: plan.pending, already_processed: plan.already, queued: plan.toProcess.length, rename_queued: plan.renameQueued, multiAgent });
  processQueue(plan.toProcess, force || plan.renameQueued > 0, multiAgent);
});

// ---------------- 启动 ----------------
app.listen(PORT, () => {
  console.log('');
  console.log('  ┌──────────────────────────────────────────────┐');
  console.log('  │  猎头简历搜寻系统已启动                        │');
  console.log(`  │  前端地址: http://127.0.0.1:${PORT}              │`);
  console.log('  │  简历文件夹: ' + pool.RESUME_DIR);
  console.log('  │  简历池:     ' + pool.POOL_DIR);
  console.log('  └──────────────────────────────────────────────┘');
  console.log('');

  // 自愈：启动即从 DB 重建简历池 markdown，防止数据库有记录但简历池为空
  try {
    const _r = pool.ensurePoolMarkdown();
    if (_r.rebuilt) console.log('[启动重建] 已从数据库重建简历池条目', _r.rebuilt, '条');
  } catch (_e) { /* 忽略 */ }

  // 后台扫描启动时已有的简历（不阻塞服务）；已处理但文件名不符合新格式的会直接补命名
  const initialFiles = fs.readdirSync(pool.RESUME_DIR)
    .filter(f => !f.startsWith('~$') && !f.startsWith('.'))
    .filter(f => parse.SUPPORTED.includes(parse.extOf(f)))
    .map(f => path.join(pool.RESUME_DIR, f));
  if (initialFiles.length) {
    const plan = planResumeQueue(initialFiles);
    console.log('[启动扫描] 发现', initialFiles.length, '份文件，待处理', plan.pending, '份，需补命名', plan.renameQueued, '份');
    const multiAgent = db.getAppSetting('multiAgentPool', '1') === '1';
    if (multiAgent) console.log('[启动扫描] 多 Agent 并发模式已开启');
    if (plan.toProcess.length) processQueue(plan.toProcess, plan.renameQueued > 0, multiAgent);
  }
});

// 实时监测简历文件夹
const watcher = chokidar.watch(pool.RESUME_DIR, {
  ignoreInitial: true,
  awaitWriteFinish: { stabilityThreshold: 1500, pollInterval: 200 },
  ignored: [/^~.*/, /(^|[\\/])\.[^\\/.]/]
});
watcher.on('add', (p) => {
  if (parse.SUPPORTED.includes(parse.extOf(p))) {
    console.log('[watch] 新文件:', p);
    const multiAgent = db.getAppSetting('multiAgentPool', '1') === '1';
    processQueue([p], false, multiAgent);
  }
});
watcher.on('change', (p) => {
  if (parse.SUPPORTED.includes(parse.extOf(p))) {
    console.log('[watch] 文件变化:', p);
    const multiAgent = db.getAppSetting('multiAgentPool', '1') === '1';
    // 不强制重处理：如果只是重命名触发的 change（hash 没变），跳过；内容真的变了 hash 会变，照样会处理
    processQueue([p], false, multiAgent);
  }
});
watcher.on('unlink', (p) => {
  if (parse.SUPPORTED.includes(parse.extOf(p))) {
    console.log('[watch] 文件删除:', p);
    pool.reconcileDeleted();
  }
});
watcher.on('error', (e) => console.error('[watch]', e.message));
