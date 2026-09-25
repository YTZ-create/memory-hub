'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const HOME = os.homedir();
const QODER_DIR = path.join(HOME, '.qoder-cn');
const CLAUDE_DIR = path.join(HOME, '.claude');
const CODEX_DB = path.join(HOME, '.codex', 'memories_1.sqlite');
const ZCODE_DB = path.join(HOME, '.zcode', 'cli', 'db', 'db.sqlite');
const MARVIS_DB = path.join(HOME, '.marvis', 'database', 'memory.db');
const CLAUDE_SESSIONS_PER_PROJECT = 50;
const CODEX_SESSIONS_TOTAL = 100;
const TRAE_STATE_DB = path.join(HOME, 'AppData', 'Roaming', 'Trae CN', 'User', 'globalStorage', 'state.vscdb');

function statMtime(p) {
  try { return fs.statSync(p).mtimeMs; } catch { return 0; }
}

function readText(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

// 'C--Users-zhiyutong-Desktop-OpenClaw' -> 'C:\Users\zhiyutong\Desktop\OpenClaw'
// 注意：路径里的 '-'（如 Agent-5）和分隔符 '-' 在 slug 里无法区分，纯解码会失败
function decodeSlug(slug) {
  const m = slug.match(/^([A-Za-z])--(.*)$/);
  if (m) return m[1] + ':\\' + m[2].replace(/-/g, '\\');
  return slug.replace(/-/g, '\\');
}

// 真实路径 -> slug（Claude/Qoder 的编码规则：非字母数字和 -_ 的字符替换为 '-'）
function encodeSlug(dir) {
  return dir.replace(/[^A-Za-z0-9_-]/g, '-');
}

// slug 反查器：优先直接解码（目录存在时），否则用已知真实目录反查，
// 再不行就从该 slug 目录下的 Claude 会话 jsonl 里提取 cwd
function createSlugResolver() {
  const anchors = [];
  let shallowCache = null;
  const add = d => { if (d && !anchors.includes(d)) anchors.push(d); };
  function readCwdFromSessions(slugDir) {
    try {
      for (const f of fs.readdirSync(slugDir)) {
        if (!f.endsWith('.jsonl')) continue;
        const fd = fs.openSync(path.join(slugDir, f), 'r');
        const buf = Buffer.alloc(65536);
        const n = fs.readSync(fd, buf, 0, 65536, 0);
        fs.closeSync(fd);
        const m = buf.slice(0, n).toString('utf8').match(/"cwd":"((?:[^"\\]|\\.)*)"/);
        if (m) {
          const cwd = m[1].replace(/\\\\/g, '\\');
          try { if (fs.statSync(cwd).isDirectory()) return cwd; } catch { /* 继续找 */ }
        }
      }
    } catch { /* ignore */ }
    return null;
  }
  function shallowDirs() {
    if (shallowCache) return shallowCache;
    shallowCache = [];
    for (const rootDir of [HOME, path.join(HOME, 'Desktop'), path.join(HOME, 'Documents'), path.join(HOME, 'Downloads')]) {
      try {
        for (const f of fs.readdirSync(rootDir, { withFileTypes: true })) {
          if (f.isDirectory()) shallowCache.push(path.join(rootDir, f.name));
        }
      } catch { /* ignore */ }
    }
    return shallowCache;
  }
  function resolve(slug) {
    const decoded = decodeSlug(slug);
    // 盘符统一为大写，避免 'c:\...' 和 'C:\...' 被当成两个项目
    const normalized = /^[a-z]:/.test(decoded) ? decoded[0].toUpperCase() + decoded.slice(1) : decoded;
    try { if (fs.statSync(normalized).isDirectory()) { add(normalized); return normalized; } } catch { /* 解码失败走反查 */ }
    const hit = anchors.find(d => encodeSlug(d).toLowerCase() === slug.toLowerCase())
      || shallowDirs().find(d => encodeSlug(d).toLowerCase() === slug.toLowerCase());
    if (hit) { add(hit); return hit; }
    const cwd = readCwdFromSessions(path.join(CLAUDE_DIR, 'projects', slug));
    if (cwd) { add(cwd); return cwd; }
    return null;
  }
  return { resolve, add };
}

function frontmatterTitle(text, fallback) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (m) {
    const name = m[1].match(/^name:\s*(.+)$/m);
    if (name) return name[1].trim();
  }
  return fallback;
}

function listMdFiles(dir) {
  try {
    return fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.md')).map(f => path.join(dir, f));
  } catch { return []; }
}

function fileEntry(p, source, titleOverride) {
  const content = readText(p);
  if (content == null || !content.trim()) return null;
  const base = path.basename(p, '.md');
  return {
    source,
    scope: 'project',
    title: titleOverride || frontmatterTitle(content, base),
    path: p,
    content,
    updatedAt: statMtime(p),
    chars: content.length
  };
}

function openDb(file) {
  const { DatabaseSync } = require('node:sqlite');
  return new DatabaseSync(file, { readOnly: true });
}

function toTimestamp(v) {
  if (!v) return 0;
  return v < 1e12 ? v * 1000 : v;
}

// ---------- Qoder ----------

function scanQoderProjects(resolve) {
  const out = new Map(); // projectDir -> entries
  const root = path.join(QODER_DIR, 'projects');
  let slugs = [];
  try { slugs = fs.readdirSync(root); } catch { return out; }
  for (const slug of slugs) {
    const dir = resolve(slug);
    if (!dir) continue;
    const entries = listMdFiles(path.join(root, slug, 'memory'))
      .filter(p => path.basename(p) !== 'MEMORY.md')
      .map(p => fileEntry(p, 'qoder'))
      .filter(Boolean);
    if (entries.length) out.set(dir, entries);
  }
  return out;
}

// ---------- Claude Code ----------

function scanClaudeUser() {
  const p = path.join(CLAUDE_DIR, 'CLAUDE.md');
  const e = fileEntry(p, 'claude');
  return e ? [{ ...e, scope: 'user' }] : [];
}

function claudeProjectEntries(dir) {
  const candidates = [
    path.join(dir, 'CLAUDE.md'),
    path.join(dir, '.claude', 'CLAUDE.md'),
  ];
  const entries = [];
  for (const c of candidates) {
    const e = fileEntry(c, 'claude');
    if (e) entries.push(e);
  }
  for (const p of listMdFiles(path.join(dir, '.claude', 'memory'))) {
    const e = fileEntry(p, 'claude');
    if (e) entries.push(e);
  }
  return entries;
}

function claudeProjectDirs(resolve) {
  const out = [];
  let slugs = [];
  try { slugs = fs.readdirSync(path.join(CLAUDE_DIR, 'projects')); } catch { return out; }
  for (const slug of slugs) {
    const dir = resolve(slug);
    if (dir) out.push(dir);
  }
  return out;
}

// Claude Code 项目级自动记忆：~/.claude/projects/<slug>/memory/*.md
function scanClaudeAutoMemory(resolve) {
  const out = new Map(); // projectDir -> entries
  const root = path.join(CLAUDE_DIR, 'projects');
  let slugs = [];
  try { slugs = fs.readdirSync(root); } catch { return out; }
  for (const slug of slugs) {
    const dir = resolve(slug);
    if (!dir) continue;
    const entries = listMdFiles(path.join(root, slug, 'memory'))
      .filter(p => path.basename(p) !== 'MEMORY.md')
      .map(p => fileEntry(p, 'claude'))
      .filter(Boolean);
    if (entries.length) out.set(dir, entries);
  }
  return out;
}

// ---------- Codex ----------

function scanCodex() {
  if (!fs.existsSync(CODEX_DB)) return [];
  const rows = [];
  try {
    const db = openDb(CODEX_DB);
    const stmt = db.prepare(
      'SELECT raw_memory, generated_at, usage_count FROM stage1_outputs ORDER BY generated_at DESC LIMIT 300'
    );
    for (const r of stmt.all()) rows.push(r);
    db.close();
  } catch (err) {
    return [{ source: 'codex', scope: 'user', title: '读取失败：' + err.message, content: String(err.message || err), updatedAt: 0, chars: 0 }];
  }
  return rows.map((r, i) => {
    const text = (r.raw_memory || '').trim();
    const firstLine = text.split(/\r?\n/)[0] || '';
    return {
      source: 'codex',
      scope: 'user',
      title: firstLine.slice(0, 60) || ('Codex 记忆 #' + (i + 1)),
      content: text,
      updatedAt: toTimestamp(r.generated_at),
      chars: text.length,
      meta: { usageCount: r.usage_count || 0 }
    };
  }).filter(e => e.content);
}

// ---------- Trae ----------

function traeProjectEntries(dir) {
  const out = [];
  const rulesDir = path.join(dir, '.trae', 'rules');
  for (const p of listMdFiles(rulesDir)) {
    const e = fileEntry(p, 'trae');
    if (e) out.push(e);
  }
  return out;
}

function scanTraeUser() {
  if (!fs.existsSync(TRAE_STATE_DB)) return [];
  try {
    const db = openDb(TRAE_STATE_DB);
    const rows = db.prepare(
      "SELECT key, value FROM ItemTable WHERE key LIKE '%rule%' OR key LIKE '%Rule%' LIMIT 50"
    ).all();
    db.close();
    return rows.map(r => {
      let text = '';
      try {
        const parsed = JSON.parse(r.value);
        text = typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2);
      } catch { text = String(r.value); }
      return {
        source: 'trae',
        scope: 'user',
        title: 'Trae 用户规则：' + r.key.slice(-40),
        content: text,
        updatedAt: 0,
        chars: text.length
      };
    }).filter(e => e.content && e.content.length > 2);
  } catch { return []; }
}

// ---------- ZCode ----------

const ZCODE_MAX_INPUT = 2000;
const ZCODE_MAX_OUTPUT = 3000;

// 提取每个会话的最初需求（首条用户输入）和最终产出（最后一条有实质内容的助手回复）
function zcodeSessionDigest(db, sessionId) {
  let firstUser = '';
  let lastAssistant = '';
  try {
    const firstRows = db.prepare(
      'SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created ASC LIMIT 8'
    ).all(sessionId);
    for (const m of firstRows) {
      let msg; try { msg = JSON.parse(m.data); } catch { continue; }
      if (msg.role !== 'user') continue;
      const parts = db.prepare('SELECT data FROM part WHERE message_id = ? ORDER BY time_created ASC').all(m.id);
      for (const p of parts) {
        let d; try { d = JSON.parse(p.data); } catch { continue; }
        if (d.type === 'text' && d.text && !d.text.startsWith('<')) { firstUser = d.text; break; }
      }
      if (firstUser) break;
    }
    const lastRows = db.prepare(
      'SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created DESC LIMIT 60'
    ).all(sessionId);
    for (const m of lastRows) {
      let msg; try { msg = JSON.parse(m.data); } catch { continue; }
      if (msg.role !== 'assistant') continue;
      const parts = db.prepare('SELECT data FROM part WHERE message_id = ? ORDER BY time_created DESC').all(m.id);
      for (const p of parts) {
        let d; try { d = JSON.parse(p.data); } catch { continue; }
        if (d.type === 'text' && d.text && d.text.trim().length > 50) { lastAssistant = d.text; break; }
      }
      if (lastAssistant) break;
    }
  } catch { /* 单个会话提取失败不影响整体 */ }
  return { firstUser, lastAssistant };
}

function capText(text, limit) {
  return text.length > limit ? text.slice(0, limit) + '\n……（超长截断）' : text;
}

function scanZcodeSessions() {
  if (!fs.existsSync(ZCODE_DB)) return new Map();
  const out = new Map(); // projectDir -> entries
  try {
    const db = openDb(ZCODE_DB);
    const rows = db.prepare(
      "SELECT id, title, directory, time_updated FROM session WHERE id NOT LIKE 'sess_subagent%' ORDER BY time_updated DESC LIMIT 400"
    ).all();
    for (const r of rows) {
      const dir = (r.directory || '').trim();
      if (!dir || !fs.existsSync(dir)) continue;
      const when = toTimestamp(r.time_updated);
      const d = when ? new Date(when).toLocaleDateString('zh-CN') : '';
      if (!out.has(dir)) out.set(dir, []);
      const lines = [r.title || '未命名会话', '目录：' + dir];
      if (d) lines.push('最近活动：' + d);
      const { firstUser, lastAssistant } = zcodeSessionDigest(db, r.id);
      if (firstUser) lines.push('', '【最初需求】', capText(firstUser, ZCODE_MAX_INPUT));
      if (lastAssistant) lines.push('', '【最终产出】', capText(lastAssistant, ZCODE_MAX_OUTPUT));
      const content = lines.join('\n');
      out.get(dir).push({
        source: 'zcode',
        scope: 'project',
        title: r.title || '未命名会话',
        content,
        updatedAt: when,
        chars: content.length
      });
    }
    db.close();
  } catch { /* ignore */ }
  for (const list of out.values()) {
    list.sort((a, b) => b.updatedAt - a.updatedAt);
  }
  return out;
}

// ---------- Marvis ----------

function scanMarvis() {
  if (!fs.existsSync(MARVIS_DB)) return [];
  try {
    const db = openDb(MARVIS_DB);
    const rows = db.prepare(
      "SELECT title, full, type, agent_name, created_at, accessed_times FROM memory_entries WHERE status = 'active' ORDER BY id DESC LIMIT 300"
    ).all();
    db.close();
    return rows.map((r, i) => {
      const text = (r.full || '').trim();
      const t = Date.parse(r.created_at || '');
      return {
        source: 'marvis',
        scope: 'user',
        title: (r.title || '').trim().slice(0, 80) || ('Marvis 记忆 #' + (i + 1)),
        content: text,
        updatedAt: Number.isNaN(t) ? 0 : t,
        chars: text.length,
        meta: {
          type: r.type || '',
          agent: r.agent_name || '',
          usageCount: r.accessed_times || 0
        }
      };
    }).filter(e => e.content);
  } catch { return []; }
}

// ---------- 会话记录通用 ----------
// 记忆不限于 memory 文件：会话里说过的话（最初需求/最终产出）也是记忆

function readHeadChunk(file, bytes = 131072) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    fs.closeSync(fd);
    return buf.slice(0, n).toString('utf8');
  } catch { return ''; }
}

function readTailChunk(file, bytes = 131072) {
  try {
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, Math.max(0, size - bytes));
    fs.closeSync(fd);
    return buf.slice(0, n).toString('utf8');
  } catch { return ''; }
}

function extractText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(x => x && x.type === 'text').map(x => x.text || '').join('\n');
}

function isRealUserText(t) {
  const s = (t || '').trim();
  return s.length > 0 && !s.startsWith('<') && !s.startsWith('Caveat:');
}

// ---------- Claude Code 会话（~/.claude/projects/<slug>/*.jsonl） ----------

function claudeSessionDigest(file) {
  let firstUser = '';
  let title = '';
  for (const line of readHeadChunk(file).split('\n')) {
    if (!line.startsWith('{')) continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    if (!title && d.type === 'ai-title' && d.aiTitle) title = d.aiTitle.trim();
    if (!firstUser && d.type === 'user' && !d.isMeta && !d.isSidechain && d.message) {
      const t = extractText(d.message.content).trim();
      if (isRealUserText(t)) firstUser = t;
    }
    if (title && firstUser) break;
  }
  let lastAssistant = '';
  for (const line of readTailChunk(file).split('\n').filter(Boolean).reverse()) {
    if (!line.startsWith('{')) continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    if (d.type !== 'assistant' || !d.message) continue;
    const t = extractText(d.message.content).trim();
    if (t.length > 50) { lastAssistant = t; break; }
  }
  return { title, firstUser, lastAssistant };
}

function scanClaudeSessions(resolve) {
  const out = new Map(); // projectDir -> entries
  const root = path.join(CLAUDE_DIR, 'projects');
  let slugs = [];
  try { slugs = fs.readdirSync(root); } catch { return out; }
  for (const slug of slugs) {
    const dir = resolve(slug);
    if (!dir) continue;
    let files = [];
    try {
      files = fs.readdirSync(path.join(root, slug))
        .filter(f => f.endsWith('.jsonl'))
        .map(f => { const p = path.join(root, slug, f); return { p, m: statMtime(p) }; })
        .sort((a, b) => b.m - a.m)
        .slice(0, CLAUDE_SESSIONS_PER_PROJECT);
    } catch { continue; }
    const entries = [];
    for (const { p, m } of files) {
      const { title, firstUser, lastAssistant } = claudeSessionDigest(p);
      if (!firstUser && !lastAssistant) continue;
      const lines = [title || (firstUser || '未命名会话').slice(0, 80), '目录：' + dir, '最近活动：' + new Date(m).toLocaleDateString('zh-CN')];
      if (firstUser) lines.push('', '【最初需求】', capText(firstUser, ZCODE_MAX_INPUT));
      if (lastAssistant) lines.push('', '【最终产出】', capText(lastAssistant, ZCODE_MAX_OUTPUT));
      const content = lines.join('\n');
      entries.push({ source: 'claude', scope: 'project', title: lines[0], content, updatedAt: m, chars: content.length });
    }
    if (entries.length) out.set(dir, entries);
  }
  return out;
}

// ---------- Codex 会话（~/.codex/sessions/**/*.jsonl rollout） ----------

function codexSessionDigest(file) {
  const head = readHeadChunk(file);
  let cwd = '';
  let firstUser = '';
  for (const line of head.split('\n')) {
    if (!line.startsWith('{')) continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    if (!cwd && d.type === 'session_meta' && d.payload) {
      cwd = (d.payload.cwd || '').trim();
    }
    if (!firstUser && d.type === 'event_msg' && d.payload && d.payload.type === 'user_message') {
      const t = (d.payload.message || '').trim();
      if (isRealUserText(t)) firstUser = t;
    }
    if (cwd && firstUser) break;
  }
  let lastAssistant = '';
  for (const line of readTailChunk(file).split('\n').filter(Boolean).reverse()) {
    if (!line.startsWith('{')) continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    if (d.type === 'event_msg' && d.payload && d.payload.type === 'agent_message') {
      const t = (d.payload.message || '').trim();
      if (t.length > 50) { lastAssistant = t; break; }
    }
  }
  return { cwd, firstUser, lastAssistant };
}

function scanCodexSessions() {
  const out = new Map(); // projectDir -> entries
  const root = path.join(HOME, '.codex', 'sessions');
  const files = [];
  (function walk(d) {
    try {
      for (const it of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, it.name);
        if (it.isDirectory()) walk(p);
        else if (it.name.endsWith('.jsonl')) files.push({ p, m: statMtime(p) });
      }
    } catch { /* ignore */ }
  })(root);
  files.sort((a, b) => b.m - a.m);
  for (const { p, m } of files.slice(0, CODEX_SESSIONS_TOTAL)) {
    const { cwd: rawCwd, firstUser, lastAssistant } = codexSessionDigest(p);
    // 盘符统一大写，避免和其它来源的项目目录重复
    const cwd = /^[a-z]:/.test(rawCwd) ? rawCwd[0].toUpperCase() + rawCwd.slice(1) : rawCwd;
    if (!cwd || !fs.existsSync(cwd) || (!firstUser && !lastAssistant)) continue;
    if (!out.has(cwd)) out.set(cwd, []);
    const lines = [(firstUser || '未命名会话').slice(0, 80), '目录：' + cwd, '最近活动：' + new Date(m).toLocaleDateString('zh-CN')];
    if (firstUser) lines.push('', '【最初需求】', capText(firstUser, ZCODE_MAX_INPUT));
    if (lastAssistant) lines.push('', '【最终产出】', capText(lastAssistant, ZCODE_MAX_OUTPUT));
    const content = lines.join('\n');
    out.get(cwd).push({ source: 'codex', scope: 'project', title: lines[0], content, updatedAt: m, chars: content.length });
  }
  for (const list of out.values()) list.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

// ---------- 汇总 ----------

function discoverProjectDirs(qoderProjects, zcodeProjects, claudeEntriesByDir, codexSessions) {
  const set = new Set();
  for (const dir of qoderProjects.keys()) set.add(dir);
  for (const dir of zcodeProjects.keys()) set.add(dir);
  for (const dir of claudeEntriesByDir.keys()) set.add(dir);
  for (const dir of codexSessions.keys()) set.add(dir);
  return [...set].filter(d => {
    try { return fs.statSync(d).isDirectory(); } catch { return false; }
  });
}

function scanAll() {
  // ZCode 会话记录的是真实路径，先扫它，作为 slug 反查的锚点目录
  const zcodeProjects = scanZcodeSessions();
  const { resolve, add } = createSlugResolver();
  for (const d of zcodeProjects.keys()) add(d);

  const qoderProjects = scanQoderProjects(resolve);
  for (const d of qoderProjects.keys()) add(d);

  const claudeEntriesByDir = new Map();
  for (const dir of claudeProjectDirs(resolve)) {
    const entries = claudeProjectEntries(dir);
    if (entries.length) claudeEntriesByDir.set(dir, entries);
  }
  for (const [dir, entries] of scanClaudeAutoMemory(resolve)) {
    const existing = claudeEntriesByDir.get(dir) || [];
    claudeEntriesByDir.set(dir, existing.concat(entries));
  }
  for (const [dir, entries] of scanClaudeSessions(resolve)) {
    const existing = claudeEntriesByDir.get(dir) || [];
    claudeEntriesByDir.set(dir, existing.concat(entries));
  }
  const codexSessions = scanCodexSessions();

  const projectDirs = discoverProjectDirs(qoderProjects, zcodeProjects, claudeEntriesByDir, codexSessions);
  const projects = projectDirs.map(dir => {
    const sources = {
      qoder: qoderProjects.get(dir) || [],
      claude: claudeEntriesByDir.get(dir) || [],
      codex: codexSessions.get(dir) || [],
      trae: traeProjectEntries(dir),
      zcode: zcodeProjects.get(dir) || []
    };
    const agentsPath = path.join(dir, 'AGENTS.md');
    const agentsContent = readText(agentsPath);
    return {
      dir,
      name: path.basename(dir),
      sources,
      total: sources.qoder.length + sources.claude.length + sources.codex.length + sources.trae.length + sources.zcode.length,
      hasAgents: agentsContent != null,
      agentsPreview: agentsContent ? agentsContent.slice(0, 400) : null
    };
  }).filter(p => p.total > 0 || p.hasAgents).sort((a, b) => b.total - a.total);

  return {
    scannedAt: Date.now(),
    user: {
      claude: scanClaudeUser(),
      codex: scanCodex(),
      trae: scanTraeUser(),
      marvis: scanMarvis()
    },
    projects
  };
}

module.exports = { scanAll, HOME };
