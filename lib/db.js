'use strict';
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const DB_PATH = process.env.RESUME_DB_PATH || path.join(DATA_DIR, 'resume.db');

let db = null;

function initDB() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS resumes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT DEFAULT '',
      gender TEXT DEFAULT '',
      age TEXT DEFAULT '',
      education TEXT DEFAULT '',
      occupation TEXT DEFAULT '',
      company TEXT DEFAULT '',
      experience TEXT DEFAULT '',
      university TEXT DEFAULT '',
      other TEXT DEFAULT '',
      category TEXT DEFAULT '其他岗位',
      original_path TEXT DEFAULT '',
      pool_path TEXT DEFAULT '',
      source_file TEXT DEFAULT '',
      file_hash TEXT DEFAULT '',
      content TEXT DEFAULT '',
      summary TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS processed_files (
      path TEXT PRIMARY KEY,
      hash TEXT DEFAULT '',
      mtime REAL DEFAULT 0,
      status TEXT DEFAULT 'pending',
      error TEXT DEFAULT '',
      resume_id INTEGER,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS apis (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT DEFAULT '',
      base_url TEXT DEFAULT '',
      api_key TEXT DEFAULT '',
      priority INTEGER DEFAULT 100,
      enabled INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS models (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      api_id INTEGER NOT NULL,
      name TEXT DEFAULT '',
      multimodal INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT DEFAULT '',
      type TEXT DEFAULT 'search',
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL,
      role TEXT DEFAULT '',
      content TEXT DEFAULT '',
      results TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS user_profile (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      user_name TEXT DEFAULT '',
      preference TEXT DEFAULT '',
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    );
    INSERT OR IGNORE INTO user_profile (id, user_name, preference) VALUES (1, '', '');

    CREATE INDEX IF NOT EXISTS idx_resumes_name ON resumes(name);
    CREATE INDEX IF NOT EXISTS idx_resumes_category ON resumes(category);
    CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id);
  `);
  // 旧库迁移：补全新字段
  const resumeCols = db.prepare('PRAGMA table_info(resumes)').all().map(c => c.name);
  if (!resumeCols.includes('education')) db.exec("ALTER TABLE resumes ADD COLUMN education TEXT DEFAULT ''");
  if (!resumeCols.includes('company')) db.exec("ALTER TABLE resumes ADD COLUMN company TEXT DEFAULT ''");
  return db;
}

function getDB() {
  if (!db) initDB();
  return db;
}

// ---------- resumes ----------
function upsertResume(fields) {
  const d = getDB();
  const existing = d.prepare('SELECT id FROM resumes WHERE source_file = ? AND file_hash = ?').get(fields.source_file || '', fields.file_hash || '');
  if (existing) {
    const keys = Object.keys(fields).filter(k => k !== 'id');
    const sets = keys.map(k => `${k} = ?`).join(', ');
    d.prepare(`UPDATE resumes SET ${sets}, updated_at = datetime('now','localtime') WHERE id = ?`)
      .run(...keys.map(k => fields[k]), existing.id);
    return existing.id;
  }
  const keys = Object.keys(fields);
  const cols = keys.join(', ');
  const ph = keys.map(() => '?').join(', ');
  const info = d.prepare(`INSERT INTO resumes (${cols}) VALUES (${ph})`).run(...keys.map(k => fields[k]));
  return Number(info.lastInsertRowid);
}

function listResumes(filter = {}) {
  const d = getDB();
  let sql = 'SELECT * FROM resumes WHERE 1=1';
  const args = [];
  if (filter.category) { sql += ' AND category = ?'; args.push(filter.category); }
  if (filter.keyword) { sql += ' AND (name LIKE ? OR occupation LIKE ? OR content LIKE ?)'; const kw = `%${filter.keyword}%`; args.push(kw, kw, kw); }
  sql += ' ORDER BY id DESC';
  return d.prepare(sql).all(...args);
}

function getResumeByName(name) {
  const d = getDB();
  return d.prepare('SELECT * FROM resumes WHERE name = ? ORDER BY id DESC LIMIT 1').get(name);
}

function deleteResume(id) {
  const d = getDB();
  const r = d.prepare('SELECT * FROM resumes WHERE id = ?').get(id);
  if (r) {
    d.prepare('DELETE FROM resumes WHERE id = ?').run(id);
    d.prepare('DELETE FROM processed_files WHERE path = ?').run(r.original_path);
  }
  return r;
}

// ---------- processed files ----------
function getProcessedFile(filePath) {
  const d = getDB();
  return d.prepare('SELECT * FROM processed_files WHERE path = ?').get(filePath);
}

function markProcessed(filePath, data) {
  const d = getDB();
  d.prepare(`INSERT INTO processed_files (path, hash, mtime, status, error, resume_id, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, datetime('now','localtime'))
             ON CONFLICT(path) DO UPDATE SET
               hash=excluded.hash, mtime=excluded.mtime, status=excluded.status,
               error=excluded.error, resume_id=excluded.resume_id,
               updated_at=excluded.updated_at`)
    .run(filePath, data.hash || '', data.mtime || 0, data.status || 'done', data.error || '', data.resume_id || null);
}

function listProcessed() {
  const d = getDB();
  return d.prepare('SELECT * FROM processed_files ORDER BY updated_at DESC').all();
}

// ---------- settings / apis ----------
function listAPIs() {
  const d = getDB();
  const apis = d.prepare('SELECT * FROM apis WHERE enabled = 1 ORDER BY priority ASC, id ASC').all();
  for (const api of apis) {
    api.models = d.prepare('SELECT id, name, multimodal FROM models WHERE api_id = ? ORDER BY id ASC').all(api.id);
  }
  return apis;
}

function saveAPIs(apis) {
  const d = getDB();
  d.exec('BEGIN');
  try {
    d.prepare('DELETE FROM models').run();
    d.prepare('DELETE FROM apis').run();
    const insApi = d.prepare('INSERT INTO apis (name, base_url, api_key, priority, enabled) VALUES (?, ?, ?, ?, ?)');
    const insModel = d.prepare('INSERT INTO models (api_id, name, multimodal) VALUES (?, ?, ?)');
    (apis || []).forEach((api, idx) => {
      const info = insApi.run(api.name || 'API-' + (idx + 1), api.base_url || '', api.api_key || '', api.priority != null ? api.priority : idx + 1, api.enabled === false ? 0 : 1);
      const apiId = Number(info.lastInsertRowid);
      (api.models || []).forEach(m => {
        if (m.name && String(m.name).trim()) {
          insModel.run(apiId, String(m.name).trim(), m.multimodal ? 1 : 0);
        }
      });
    });
    d.exec('COMMIT');
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

// ---------- conversations ----------
function createConversation(title, type) {
  const d = getDB();
  const info = d.prepare("INSERT INTO conversations (title, type) VALUES (?, ?)").run(title, type);
  return Number(info.lastInsertRowid);
}

function addMessage(conversationId, role, content, resultsJson) {
  const d = getDB();
  d.prepare("INSERT INTO messages (conversation_id, role, content, results) VALUES (?, ?, ?, ?)")
    .run(conversationId, role, content, resultsJson || '');
}

function listConversations(limit = 100) {
  const d = getDB();
  return d.prepare('SELECT * FROM conversations ORDER BY id DESC LIMIT ?').all(limit);
}

function getConversation(id) {
  const d = getDB();
  const conv = d.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
  if (conv) {
    conv.messages = d.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id ASC').all(id);
  }
  return conv;
}

function deleteConversation(id) {
  const d = getDB();
  d.prepare('DELETE FROM messages WHERE conversation_id = ?').run(id);
  d.prepare('DELETE FROM conversations WHERE id = ?').run(id);
}

function getUserProfile() {
  const d = getDB();
  return d.prepare('SELECT user_name, preference FROM user_profile WHERE id = 1').get() || { user_name: '', preference: '' };
}

function saveUserProfile(userName, preference) {
  const d = getDB();
  d.prepare("UPDATE user_profile SET user_name = ?, preference = ?, updated_at = datetime('now','localtime') WHERE id = 1")
    .run(userName || '', preference || '');
}

function stats() {
  const d = getDB();
  const resumes = d.prepare('SELECT COUNT(*) AS n FROM resumes').get().n;
  const files = d.prepare('SELECT COUNT(*) AS n FROM processed_files').get().n;
  const conversations = d.prepare('SELECT COUNT(*) AS n FROM conversations').get().n;
  const apis = d.prepare('SELECT COUNT(*) AS n FROM apis WHERE enabled = 1').get().n;
  return { resumes, files, conversations, apis };
}

module.exports = {
  DB_PATH,
  initDB,
  getDB,
  upsertResume,
  listResumes,
  getResumeByName,
  deleteResume,
  getProcessedFile,
  markProcessed,
  listProcessed,
  listAPIs,
  saveAPIs,
  getUserProfile,
  saveUserProfile,
  createConversation,
  addMessage,
  listConversations,
  getConversation,
  deleteConversation,
  stats,
};
