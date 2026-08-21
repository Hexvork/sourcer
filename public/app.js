'use strict';

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

let apis = [];
let currentPage = 'search';
let files = { A: null, B: null };

const BAND = {
  yellow: { color: '#eab308', label: '70~80%' },
  blue: { color: '#3b82f6', label: '80~90%' },
  green: { color: '#22c55e', label: '90~100%' }
};

const ic = (name, extra = '') => `<i class="fas fa-${name} ${extra}"></i>`;

function bandOf(score) {
  if (score >= 90) return 'green';
  if (score >= 80) return 'blue';
  return 'yellow';
}

function ringSVG(score, size = 84) {
  const band = bandOf(score);
  const color = BAND[band].color;
  const C = 2 * Math.PI * 40;
  const offset = C * (1 - Math.max(0, Math.min(100, score)) / 100);
  const innerR = 12 + (Math.max(70, Math.min(100, score)) - 70) / 30 * 22;
  return `
  <svg width="${size}" height="${size}" viewBox="0 0 100 100">
    <circle cx="50" cy="50" r="40" stroke="#e2e8f0" stroke-width="8" fill="none"/>
    <circle cx="50" cy="50" r="40" stroke="${color}" stroke-width="8" fill="none"
      stroke-linecap="round" stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${offset.toFixed(1)}"
      transform="rotate(-90 50 50)" style="transition: stroke-dashoffset .8s ease"/>
    <circle cx="50" cy="50" r="${innerR.toFixed(1)}" fill="${color}" opacity="0.22"/>
    <text x="50" y="54" text-anchor="middle" font-size="19" font-weight="800" fill="${color}">${score}%</text>
    <text x="50" y="69" text-anchor="middle" font-size="8.5" fill="#64748b">匹配度</text>
  </svg>`;
}

function toast(msg, type = '') {
  const t = $('#toast');
  t.innerHTML = msg;
  t.className = 'toast' + (type ? ' ' + type : '');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add('hidden'), 3200);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  let data = {};
  try { data = await res.json(); } catch (e) { /* ignore */ }
  if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
}

// ---------------- 页面切换 ----------------
function switchPage(page) {
  currentPage = page;
  $$('.page').forEach(p => p.classList.remove('active'));
  $('#page-' + page).classList.add('active');
  $$('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.page === page));
  if (page === 'history') loadHistory();
}

// ---------------- 设置面板 ----------------
function renderApiList() {
  const list = $('#apiList');
  list.innerHTML = '';
  apis.forEach((api, idx) => {
    const card = document.createElement('div');
    card.className = 'api-card';
    card.draggable = true;
    card.dataset.idx = idx;
    card.innerHTML = `
      <div class="api-head">
        <span class="drag-handle" title="拖动调整优先级"><i class="fas fa-grip-vertical"></i></span>
        <input type="text" class="api-name" placeholder="API 名称（如：DeepSeek 官方）" value="${esc(api.name || '')}">
        <label class="mm-toggle" title="启用/停用这个 API"><input type="checkbox" class="api-enabled" ${api.enabled === false ? '' : 'checked'}>启用</label>
        <button class="btn btn-danger btn-sm api-del" title="删除此 API">${ic('xmark')}</button>
      </div>
      <div class="api-row">
        <label>Base URL（OpenAI 兼容，如 https://api.deepseek.com/v1）</label>
        <input type="text" class="api-url" placeholder="https://api.deepseek.com/v1" value="${esc(api.base_url || '')}">
      </div>
      <div class="api-row">
        <label>API Key</label>
        <input type="password" class="api-key" placeholder="sk-..." value="${esc(api.api_key || '')}">
      </div>
      <div class="api-row">
        <label>模型（1 个 Key 可配多个模型；多模态勾选 = 支持图片，不勾 = 仅文本）</label>
        <div class="model-list"></div>
        <button class="btn-add-model">${ic('plus')} 添加模型</button>
      </div>`;
    list.appendChild(card);

    const modelList = $('.model-list', card);
    (api.models && api.models.length ? api.models : [{ name: '', multimodal: false }]).forEach(m => {
      modelList.appendChild(modelRow(m));
    });

    $('.api-name', card).addEventListener('input', e => { api.name = e.target.value; });
    $('.api-url', card).addEventListener('input', e => { api.base_url = e.target.value; });
    $('.api-key', card).addEventListener('input', e => { api.api_key = e.target.value; });
    $('.api-enabled', card).addEventListener('change', e => { api.enabled = e.target.checked; });
    $('.api-del', card).addEventListener('click', () => { apis.splice(idx, 1); renderApiList(); });
    $('.btn-add-model', card).addEventListener('click', () => {
      if (!api.models) api.models = [];
      api.models.push({ name: '', multimodal: false });
      renderApiList();
    });

    card.addEventListener('dragstart', e => {
      card.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(idx));
    });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));
    card.addEventListener('dragover', e => { e.preventDefault(); });
    card.addEventListener('drop', e => {
      e.preventDefault();
      const from = Number(e.dataTransfer.getData('text/plain'));
      const to = Number(card.dataset.idx);
      if (from === to || Number.isNaN(from)) return;
      const [moved] = apis.splice(from, 1);
      apis.splice(to, 0, moved);
      renderApiList();
    });
  });
}

function modelRow(m) {
  const row = document.createElement('div');
  row.className = 'model-row';
  row.innerHTML = `
    <input type="text" class="model-name" placeholder="模型名，如 deepseek-chat" value="${esc(m.name || '')}">
    <label class="mm-toggle" title="是否多模态（支持图片输入）">
      <input type="checkbox" class="model-mm" ${m.multimodal ? 'checked' : ''}>多模态
    </label>
    <button class="model-del" title="删除模型">${ic('xmark')}</button>`;
  $('.model-name', row).addEventListener('input', e => { m.name = e.target.value; });
  $('.model-mm', row).addEventListener('change', e => { m.multimodal = e.target.checked; });
  $('.model-del', row).addEventListener('click', () => { row.remove(); });
  return row;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function loadSettings() {
  try {
    const data = await api('/api/settings');
    apis = data.apis || [];
    $('#userName').value = data.user_name || '';
    $('#userPreference').value = data.preference || '';
  } catch (e) {
    apis = [];
  }
  renderApiList();
  refreshModelSelect();
}

async function saveSettings() {
  const cards = $$('#apiList .api-card');
  apis.forEach((api, idx) => {
    const card = cards[idx];
    if (!card) return;
    api.models = $$('.model-row', card).map(row => ({
      name: $('.model-name', row).value.trim(),
      multimodal: $('.model-mm', row).checked
    })).filter(m => m.name);
  });
  try {
    await api('/api/settings', {
      method: 'PUT',
      body: { user_name: $('#userName').value.trim(), preference: $('#userPreference').value.trim(), apis }
    });
    $('#settingsStatus').innerHTML = `${ic('circle-check')} 已保存用户信息、回答偏好和 ${apis.length} 个 API`;
    toast(ic('circle-check') + ' 配置已保存', 'ok');
    refreshModelSelect();
  } catch (e) {
    $('#settingsStatus').innerHTML = `${ic('circle-xmark')} ${esc(e.message)}`;
    toast(ic('circle-xmark') + ' 保存失败：' + esc(e.message), 'error');
  }
}

function refreshModelSelect() {
  const sel = $('#modelSelect');
  const prev = sel.value;
  sel.innerHTML = '<option value="">自动（优先级最高的可用模型）</option>';
  apis.filter(a => a.enabled !== false).forEach(api => {
    const og = document.createElement('optgroup');
    og.label = (api.name || 'API') + '（优先级' + (apis.indexOf(api) + 1) + '）';
    (api.models || []).forEach(m => {
      if (!m.name) return;
      const opt = document.createElement('option');
      opt.value = api.id + ':' + m.name;
      opt.textContent = m.name + (m.multimodal ? '（多模态）' : '');
      og.appendChild(opt);
    });
    sel.appendChild(og);
  });
  sel.value = prev;
}

// ---------------- 状态栏 ----------------
async function refreshState() {
  try {
    const s = await api('/api/state');
    const parts = [
      `${ic('folder-open')} 简历池 ${s.resumes} 份简历`,
      `${ic('folder')} 已处理文件 ${s.files} 份`,
      `${ic('comments')} 历史对话 ${s.conversations} 条`,
      `${ic('plug')} 可用 API ${s.apis} 个`
    ];
    if (s.lastScan && s.lastScan.time) {
      parts.push(`${ic('rotate')} 上次扫描：${s.lastScan.time}（处理 ${s.lastScan.done}，跳过 ${s.lastScan.skipped || 0}/${s.lastScan.total}${s.lastScan.errors ? '，失败 ' + s.lastScan.errors : ''}）`);
    }
    if (s.lastScan && s.lastScan.running) parts.push(`${ic('spinner', 'fa-spin')} 后台扫描中…`);
    $('#statusBar').innerHTML = parts.map(p => `<span>${p}</span>`).join('');
  } catch (e) { /* ignore */ }
}

// ---------------- 搜索 ----------------
async function doSearch() {
  const query = $('#searchInput').value.trim();
  if (!query) { toast('请先输入岗位需求', 'error'); return; }
  const modelVal = $('#modelSelect').value;
  let apiId = null, modelName = null;
  if (modelVal) {
    const [a, m] = modelVal.split(':');
    apiId = Number(a); modelName = m;
  }
  const btn = $('#btnSearch');
  btn.disabled = true;
  btn.innerHTML = `${ic('spinner', 'fa-spin')} 匹配中…`;
  $('#searchHint').textContent = '';
  try {
    const data = await api('/api/search', { method: 'POST', body: { query, apiId, modelName } });
    renderResults(data);
    if (data.engine === 'fallback') $('#searchHint').innerHTML = `${ic('triangle-exclamation')} ${esc(data.error || '关键词粗筛模式')}`;
    else $('#searchHint').innerHTML = `${ic('circle-check')} AI 引擎：${esc(data.usedApi || '')}`;
  } catch (e) {
    toast(esc(e.message), 'error');
    $('#searchHint').innerHTML = `${ic('circle-xmark')} ${esc(e.message)}`;
  } finally {
    btn.disabled = false;
    btn.innerHTML = `${ic('wand-magic-sparkles')} 开始匹配`;
  }
}

function renderResults(data) {
  const area = $('#resultsArea');
  const results = data.results || [];
  if (!results.length) {
    area.innerHTML = `<div class="empty-tip">${ic('face-frown')} 没有找到匹配度 ≥ 70% 的简历。<br>试试放宽岗位描述，或先在「设置」里配置模型。</div>`;
    return;
  }
  const cards = results.map(r => {
    const band = bandOf(r.score);
    const genderBadge = (r.gender === '女') ? `<span class="badge female">${ic('person-dress')} 女</span>` :
      (r.gender === '男') ? `<span class="badge male">${ic('person')} 男</span>` : `<span class="badge">${ic('person')} 性别未知</span>`;
    const path = r.pool_path || r.original_path || '';
    return `
    <div class="resume-card band-${band}" data-path="${esc(path)}">
      <span class="click-hint">${ic('arrow-pointer')} 点击打开文件</span>
      <div class="score-top">
        <div class="ring-wrap">${ringSVG(r.score)}</div>
        <div class="name-line">
          <div class="name">${esc(r.name)}</div>
          <div class="badge-row">
            ${genderBadge}
            <span class="badge">${ic('cake-candles')} ${esc(r.age || '未知')}</span>
            <span class="badge">${ic('book-open')} ${esc(r.education || '学历未知')}</span>
            <span class="badge cat">${ic('tag')} ${esc(r.category || '未分类')}</span>
          </div>
        </div>
      </div>
      <div class="meta">
        <div>${ic('briefcase')} ${esc(r.occupation || '职务未知')}</div>
        <div>${ic('building')} ${esc(r.company || '主要任职公司未知')}</div>
        <div>${ic('graduation-cap')} ${esc(r.university || '大学未知')}</div>
        <div class="file-path">${ic('folder-open')} ${esc(path)}</div>
      </div>
      <div class="reason"><b>为什么匹配：</b>${esc(r.reason || '综合背景与岗位要求较为契合')}</div>
    </div>`;
  }).join('');
  area.innerHTML = `<div class="results-grid">${cards}</div>`;
  $$('.resume-card', area).forEach(card => {
    card.addEventListener('click', () => openFile(card.dataset.path));
  });
}

async function openFile(path) {
  if (!path) { toast('该简历没有记录文件路径', 'error'); return; }
  try {
    await api('/api/open-file', { method: 'POST', body: { path } });
    toast('已尝试用默认程序打开（WPS 若为默认 Word/PDF 程序会自动使用）', 'ok');
  } catch (e) {
    toast('打开失败：' + esc(e.message), 'error');
  }
}

async function doScan() {
  const btn = $('#btnScan');
  btn.disabled = true;
  btn.innerHTML = `${ic('spinner', 'fa-spin')} 扫描中…`;
  try {
    const r = await api('/api/scan', { method: 'POST', body: { force: false } });
    if (r.pending > 0) {
      toast(`简历文件夹共 ${r.total} 份文件，其中 ${r.pending} 份需要处理，${r.already_processed} 份已处理过`, 'ok');
    } else if (r.total > 0) {
      toast(`简历文件夹共 ${r.total} 份文件，都已处理过，无需重复处理`, 'ok');
    } else {
      toast('简历文件夹里没有找到 PDF/Word/TXT 文件', 'error');
    }
    setTimeout(refreshState, 1200);
  } catch (e) {
    toast(esc(e.message), 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = `${ic('rotate')} 立即扫描简历`;
  }
}

// ---------------- 简历匹配度 ----------------
function bindDropZone(zone, input, fileInfo, key) {
  zone.addEventListener('click', () => input.click());
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('dragover'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('dragover');
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) setFile(key, f);
  });
  input.addEventListener('change', () => {
    if (input.files && input.files[0]) setFile(key, input.files[0]);
  });
}

function setFile(key, f) {
  files[key] = f;
  $('#' + (key === 'A' ? 'fileA' : 'fileB')).innerHTML = `${ic('paperclip')} ${esc(f.name)}（${(f.size / 1024).toFixed(0)} KB）`;
}

function readBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}

async function doMatch() {
  if (!files.A || !files.B) { toast('请先把两份简历都拖进来', 'error'); return; }
  const btn = $('#btnMatch');
  btn.disabled = true;
  btn.innerHTML = `${ic('spinner', 'fa-spin')} 匹配中…`;
  $('#matchStatus').textContent = '正在解析并对比两份简历…';
  try {
    const [dataA, dataB] = await Promise.all([readBase64(files.A), readBase64(files.B)]);
    const data = await api('/api/match-resumes', {
      method: 'POST',
      body: { fileA: { name: files.A.name, data: dataA }, fileB: { name: files.B.name, data: dataB } }
    });
    renderMatchResult(data);
    $('#matchStatus').innerHTML = data.engine === 'fallback'
      ? `${ic('triangle-exclamation')} 关键词粗筛模式`
      : `${ic('circle-check')} AI 引擎：${esc(data.usedApi || '')}`;
  } catch (e) {
    toast('匹配失败：' + esc(e.message), 'error');
    $('#matchStatus').innerHTML = `${ic('circle-xmark')} ${esc(e.message)}`;
  } finally {
    btn.disabled = false;
    btn.innerHTML = `${ic('magnifying-glass')} 开始匹配`;
  }
}

function renderMatchResult(data) {
  $('#matchResult').classList.remove('hidden');
  $('#matchScoreBox').innerHTML = `
    ${ringSVG(data.score, 150)}
    <div style="margin-top:6px;font-size:12px;color:${BAND[bandOf(data.score)].color};font-weight:800">${BAND[bandOf(data.score)].label}</div>`;
  $('#matchSummary').textContent = data.summary || '';
  $('#matchOverlap').innerHTML = (data.overlap || []).map(x => `<li>${esc(x)}</li>`).join('') || '<li>无</li>';
  $('#matchGap').innerHTML = (data.gap || []).map(x => `<li>${esc(x)}</li>`).join('') || '<li>无</li>';
  $('#matchResult').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ---------------- 历史 ----------------
async function loadHistory() {
  const list = $('#historyList');
  try {
    const convs = await api('/api/history');
    if (!convs.length) {
      list.innerHTML = `<div class="empty-tip">${ic('clock-rotate-left')} 还没有历史记录。去搜一次或匹配一次吧！</div>`;
      return;
    }
    list.innerHTML = convs.map(c => `
      <div class="history-item" data-id="${c.id}">
        <div>
          <div class="h-title">${c.type === 'match' ? ic('code-compare') : ic('magnifying-glass')} ${esc(c.title)}</div>
          <div class="h-time">${esc(c.created_at)}</div>
        </div>
        <button class="btn btn-danger btn-sm h-del" data-id="${c.id}">${ic('trash')} 删除</button>
      </div>`).join('');
    $$('.history-item', list).forEach(item => {
      item.addEventListener('click', e => {
        if (e.target.closest('.h-del')) return;
        showHistoryDetail(Number(item.dataset.id));
      });
    });
    $$('.h-del', list).forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await api('/api/history/' + btn.dataset.id, { method: 'DELETE' });
        toast('已删除', 'ok');
        loadHistory();
      });
    });
  } catch (e) {
    list.innerHTML = `<div class="empty-tip">${ic('circle-xmark')} ${esc(e.message)}</div>`;
  }
}

async function showHistoryDetail(id) {
  try {
    const conv = await api('/api/history/' + id);
    const box = $('#historyDetail');
    box.classList.remove('hidden');
    box.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <h3 style="font-size:16px">${esc(conv.title)} <span style="color:#94a3b8;font-size:12px">${esc(conv.created_at)}</span></h3>
        <button class="btn btn-outline btn-sm" id="btnBackHistory">${ic('arrow-left')} 返回列表</button>
      </div>
      ${conv.messages.map(m => `
        <div class="msg ${m.role}">
          <div style="font-size:12px;color:#94a3b8;margin-bottom:4px">${m.role === 'user' ? ic('user') + ' 你' : ic('robot') + ' AI'}</div>
          <div>${esc(m.content)}</div>
          ${m.results && m.results.length ? renderMiniCards(m.results) : ''}
        </div>`).join('')}`;
    $('#btnBackHistory').addEventListener('click', () => { box.classList.add('hidden'); });
    $$('.history-mini', box).forEach(el => {
      el.addEventListener('click', () => openFile(el.dataset.path));
    });
    box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (e) {
    toast(esc(e.message), 'error');
  }
}

function renderMiniCards(results) {
  const arr = Array.isArray(results) ? results : [];
  return `<div class="history-mini-cards">${arr.map(r => `
    <div class="history-mini" data-path="${esc(r.pool_path || r.original_path || '')}">
      <span class="mini-ring" style="color:${BAND[bandOf(r.score)].color}">${r.score}%</span>
      <span>${esc(r.name)}</span>
    </div>`).join('')}</div>`;
}

// ---------------- 初始化 ----------------
async function init() {
  $$('.nav-btn').forEach(btn => btn.addEventListener('click', () => switchPage(btn.dataset.page)));
  $('.brand-btn').addEventListener('click', () => switchPage('search'));

  $('#btnAddApi').addEventListener('click', () => {
    apis.push({ name: '', base_url: '', api_key: '', models: [{ name: '', multimodal: false }], enabled: true });
    renderApiList();
  });
  $('#btnSaveSettings').addEventListener('click', saveSettings);

  $('#btnSearch').addEventListener('click', doSearch);
  $('#searchInput').addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) doSearch();
  });
  $('#btnScan').addEventListener('click', doScan);

  bindDropZone($('#dropA'), $('#inputA'), $('#fileA'), 'A');
  bindDropZone($('#dropB'), $('#inputB'), $('#fileB'), 'B');
  $('#btnMatch').addEventListener('click', doMatch);

  await loadSettings();
  refreshState();
  setInterval(refreshState, 5000);
}

document.addEventListener('DOMContentLoaded', init);
