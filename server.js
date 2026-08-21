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

// ---------------- 工具函数 ----------------
let processing = false;
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

async function processQueue(files, force) {
  if (processing) return;
  processing = true;
  lastScan.running = true;
  lastScan.total = files.length;
  lastScan.done = 0;
  lastScan.errors = 0;
  lastScan.skipped = 0;
  lastScan.time = now();
  try {
    for (const f of files) {
      try {
        const r = await pool.processFile(f, { force });
        if (r.ok) lastScan.done++;
        else if (r.skipped) lastScan.skipped++;
        else lastScan.errors++;
      } catch (e) {
        lastScan.errors++;
        console.error('[scan]', f, e.message);
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

  let results = [];
  let engine = 'ai';
  let usedApi = null;
  let error = null;
  const markdown = readAllMarkdown();

  if (!markdown.trim()) {
    return res.status(404).json({ error: '简历池还是空的。请先把简历放进「简历」文件夹，系统会自动归类；或点击「立即扫描」。', results: [] });
  }

  try {
    const profile = db.getUserProfile();
    const r = await llm.searchResumes(query, markdown, profile);
    results = r.results;
    usedApi = r.apiName + ' / ' + r.model;
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

  // 关联数据库中的简历详情
  const enriched = results.map(r => {
    const row = db.getResumeByName(r.name) || db.listResumes().find(x => x.name && String(x.name).includes(String(r.name)));
    if (row) {
      return {
        id: row.id,
        name: row.name,
        gender: row.gender,
        age: row.age,
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
    return { ...r, id: null, gender: '未知', age: '未知', education: '', occupation: '', company: '', university: '', pool_path: '', original_path: '', ring: ringClass(r.score) };
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
app.post('/api/match-resumes', async (req, res) => {
  const A = req.body.fileA || {};
  const B = req.body.fileB || {};
  const reqText = String(req.body.requirementText || '').trim();
  if (!A.data) return res.status(400).json({ error: '请先放入候选人的简历文件' });
  if (!B.data && !reqText) return res.status(400).json({ error: '请放入岗位要求文件，或直接粘贴岗位要求文字' });

  let textA, textB;
  let nameA = A.name || '候选人简历';
  let nameB = B.name || '岗位要求';
  try {
    textA = await parse.parseBuffer(Buffer.from(A.data, 'base64'), A.name || 'resume.pdf');
    if (B.data) {
      textB = await parse.parseBuffer(Buffer.from(B.data, 'base64'), B.name || 'jd.pdf');
      nameB = B.name || '岗位要求文件';
    } else {
      textB = reqText;
      nameB = '粘贴的岗位要求';
    }
  } catch (e) {
    return res.status(400).json({ error: '文件解析失败：' + e.message });
  }

  let out;
  let engine = 'ai';
  try {
    out = await llm.matchResumeToRequirement(textA, nameA, textB, nameB, db.getUserProfile());
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
  }

  const convId = db.createConversation(`${nameA} ↔ ${nameB} 匹配度`, 'match');
  db.addMessage(convId, 'user', `简历「${nameA}」与岗位要求「${nameB}」匹配分析`, '');
  db.addMessage(convId, 'assistant', `匹配度 ${out.score}%。${out.summary}`, JSON.stringify({ score: out.score, summary: out.summary, overlap: out.overlap, gap: out.gap, suggestion: out.suggestion }));

  res.json({ score: out.score, summary: out.summary, overlap: out.overlap, gap: out.gap, suggestion: out.suggestion, engine, usedApi: out.apiName ? `${out.apiName} / ${out.model}` : null, names: [nameA, nameB] });
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
  res.json({ user_name: profile.user_name, preference: profile.preference, apis: db.listAPIs() });
});

app.put('/api/settings', (req, res) => {
  try {
    db.saveUserProfile(req.body.user_name || '', req.body.preference || '');
    db.saveAPIs(req.body.apis || []);
    const profile = db.getUserProfile();
    res.json({ ok: true, user_name: profile.user_name, preference: profile.preference, apis: db.listAPIs() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------- 手动扫描 ----------------
app.post('/api/scan', async (req, res) => {
  const force = !!req.body.force;
  const files = fs.readdirSync(pool.RESUME_DIR)
    .filter(f => !f.startsWith('~$') && !f.startsWith('.'))
    .filter(f => parse.SUPPORTED.includes(parse.extOf(f)))
    .map(f => path.join(pool.RESUME_DIR, f));
  let pending = 0;
  let already = 0;
  for (const f of files) {
    const abs = path.resolve(f);
    const prev = db.getProcessedFile(abs);
    let isDone = false;
    if (prev && prev.status === 'done') {
      try { isDone = prev.hash === pool.fileHash(abs); } catch (e) { isDone = false; }
    }
    if (isDone) already++; else pending++;
  }
  res.json({ ok: true, total: files.length, pending, already_processed: already, queued: pending });
  processQueue(files, force);
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

  // 后台扫描启动时已有的简历（不阻塞服务）
  const initialFiles = fs.readdirSync(pool.RESUME_DIR)
    .filter(f => !f.startsWith('~$') && !f.startsWith('.'))
    .filter(f => parse.SUPPORTED.includes(parse.extOf(f)))
    .map(f => path.join(pool.RESUME_DIR, f));
  if (initialFiles.length) {
    console.log('[启动扫描] 发现', initialFiles.length, '份待处理文件');
    processQueue(initialFiles, false);
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
    processQueue([p], false);
  }
});
watcher.on('change', (p) => {
  if (parse.SUPPORTED.includes(parse.extOf(p))) {
    console.log('[watch] 文件变化:', p);
    processQueue([p], true);
  }
});
watcher.on('error', (e) => console.error('[watch]', e.message));
