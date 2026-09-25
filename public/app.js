'use strict';
/* global API */

let SCAN = null;
let state = {
  view: { type: 'user', source: null }, // 或 {type:'project', dir}
  selected: new Set(),
  filter: '',
  entries: []
};

const $ = id => document.getElementById(id);
const SOURCE_LABEL = { qoder: 'Qoder', claude: 'Claude', codex: 'Codex', trae: 'Trae', zcode: 'ZCode', marvis: 'Marvis' };

function toast(msg, isErr) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast' + (isErr ? ' err' : '');
  t.hidden = false;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.hidden = true; }, isErr ? 4000 : 2500);
}

// 点击反馈：按钮变成功/失败态，约 1.5 秒后恢复
function buttonFeedback(btn, ok, text) {
  const old = btn.textContent;
  btn.textContent = text;
  btn.classList.add(ok ? 'btn-success' : 'btn-fail');
  btn.disabled = true;
  setTimeout(() => {
    btn.textContent = old;
    btn.classList.remove('btn-success', 'btn-fail');
    btn.disabled = false;
  }, 1500);
}

function fmtTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function normKey(text) {
  return (text || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 120);
}

function markDuplicates(entries) {
  const seen = new Map();
  for (const e of entries) {
    const k = e.source + ':' + normKey(e.title);
    e.dup = seen.has(k);
    seen.set(k, true);
  }
}

function currentEntries() {
  let list = [];
  if (state.view.type === 'user') {
    list = state.view.source ? (SCAN.user[state.view.source] || []) :
      Object.values(SCAN.user).flat();
  } else {
    const p = SCAN.projects.find(x => x.dir === state.view.dir);
    if (p) list = state.view.source ? (p.sources[state.view.source] || []) :
      Object.values(p.sources).flat();
  }
  const f = state.filter.trim().toLowerCase();
  if (f) list = list.filter(e => e.title.toLowerCase().includes(f) || e.content.toLowerCase().includes(f));
  markDuplicates(list);
  return list;
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
}

// ---------- 侧边栏 ----------

function renderSidebar() {
  const g = $('global-list');
  g.innerHTML = '';
  const userCounts = Object.fromEntries(Object.entries(SCAN.user).map(([k, v]) => [k, v.length]));
  const totalUser = Object.values(userCounts).reduce((a, b) => a + b, 0);
  g.appendChild(sideItem('全部全局记忆', totalUser, () => setView({ type: 'user' })));
  for (const src of ['claude', 'codex', 'trae', 'marvis']) {
    if (userCounts[src] > 0) {
      g.appendChild(sideItem(SOURCE_LABEL[src] + '（用户级）', userCounts[src], () => setView({ type: 'user', source: src })));
    }
  }

  const pl = $('project-list');
  pl.innerHTML = '';
  for (const p of SCAN.projects) {
    const item = sideItem(p.name, p.total, () => setView({ type: 'project', dir: p.dir }));
    item.title = p.dir;
    if (p.hasAgents) {
      const b = document.createElement('span');
      b.className = 'badge warn';
      b.textContent = '已有AGENTS';
      b.title = '该项目已有 AGENTS.md，合并时会先备份再覆盖';
      item.appendChild(b);
    }
    pl.appendChild(item);
  }
  if (!SCAN.projects.length) {
    pl.innerHTML = '<div class="empty">未发现含记忆的项目</div>';
  }
}

function sideItem(name, count, onClick) {
  const div = document.createElement('div');
  div.className = 'side-item';
  const n = document.createElement('span');
  n.className = 'name';
  n.textContent = name;
  const b = document.createElement('span');
  b.className = 'badge';
  b.textContent = count;
  div.append(n, b);
  div.onclick = onClick;
  return div;
}

function setActiveSide() {
  document.querySelectorAll('.side-item').forEach(el => el.classList.remove('active'));
  // 简化：不做精确高亮匹配，避免复杂 DOM 比较
}

// ---------- 主列表 ----------

function setView(view) {
  state.view = view;
  state.selected.clear();
  state.filter = '';
  $('filter').value = '';
  render();
}

function render() {
  renderSidebar();
  setActiveSide();
  const entries = currentEntries();
  state.entries = entries;

  const title = $('view-title');
  if (state.view.type === 'user') {
    title.textContent = state.view.source ? `全局记忆 · ${SOURCE_LABEL[state.view.source]}` : '全局记忆（全部工具）';
  } else {
    const p = SCAN.projects.find(x => x.dir === state.view.dir);
    title.textContent = p ? `项目 · ${p.name}` : '项目';
  }
  $('scan-time').textContent = '扫描于 ' + new Date(SCAN.scannedAt).toLocaleTimeString('zh-CN');

  const list = $('entry-list');
  list.innerHTML = '';
  if (!entries.length) {
    list.innerHTML = '<div class="empty">没有记忆条目</div>';
  }
  for (const e of entries) list.appendChild(entryRow(e));

  const dupCount = entries.filter(e => e.dup).length;
  const hint = $('dup-hint');
  hint.hidden = !dupCount;
  if (dupCount) hint.textContent = `发现 ${dupCount} 条疑似重复（同来源且标题相同），合并前请自行取消勾选。`;

  const isUser = state.view.type === 'user';
  $('merge-target-box').hidden = !isUser;
  if (isUser) {
    const sel = $('merge-target');
    sel.innerHTML = '';
    for (const p of SCAN.projects) {
      const opt = document.createElement('option');
      opt.value = p.dir;
      opt.textContent = p.name;
      sel.appendChild(opt);
    }
  }
  updateSelCount();
}

function entryRow(e) {
  const row = document.createElement('div');
  row.className = 'entry' + (e.dup ? ' dup' : '');

  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = state.selected.has(e.id);
  cb.onchange = () => {
    cb.checked ? state.selected.add(e.id) : state.selected.delete(e.id);
    updateSelCount();
  };

  const main = document.createElement('div');
  main.className = 'entry-main';
  main.onclick = () => showPreview(e);

  const titleLine = document.createElement('div');
  titleLine.className = 'entry-title';
  titleLine.textContent = e.title;
  if (e.dup) {
    const tag = document.createElement('span');
    tag.className = 'dup-tag';
    tag.textContent = '疑似重复';
    titleLine.appendChild(document.createTextNode(' '));
    titleLine.appendChild(tag);
  }

  const meta = document.createElement('div');
  meta.className = 'entry-meta';
  const time = fmtTime(e.updatedAt);
  meta.textContent = [time, e.chars + ' 字', e.meta && e.meta.usageCount ? `使用 ${e.meta.usageCount} 次` : ''].filter(Boolean).join(' · ');

  const preview = document.createElement('div');
  preview.className = 'entry-preview';
  preview.textContent = e.content.slice(0, 120);

  main.append(titleLine, meta, preview);

  const copyBtn = document.createElement('button');
  copyBtn.className = 'btn btn-ghost btn-sm';
  copyBtn.textContent = '复制';
  copyBtn.onclick = async (ev) => {
    ev.stopPropagation();
    try {
      await navigator.clipboard.writeText(e.content);
      buttonFeedback(copyBtn, true, '已复制');
    } catch {
      buttonFeedback(copyBtn, false, '失败');
    }
  };

  row.append(cb, main, copyBtn);
  return row;
}

function showPreview(e) {
  $('preview').hidden = false;
  $('preview-title').textContent = `[${SOURCE_LABEL[e.source]}] ${e.title}`;
  $('preview-body').textContent = e.content;
}

function updateSelCount() {
  $('sel-count').textContent = state.selected.size;
}

// ---------- 合并 ----------

async function doMerge() {
  const btn = $('btn-merge');
  if (!state.selected.size) { toast('请先勾选要合并的记忆条目', true); return; }
  const projectDir = state.view.type === 'project' ? state.view.dir : $('merge-target').value;
  if (!projectDir) { toast('请选择合并目标项目', true); return; }
  btn.disabled = true;
  try {
    const data = await api('/api/merge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectDir,
        entries: [...state.selected],
        pointers: {
          claude: $('ptr-claude').checked,
          qoder: $('ptr-qoder').checked,
          trae: $('ptr-trae').checked
        }
      })
    });
    buttonFeedback(btn, true, '已写入');
    const lines = data.results.map(r => `${r.file}：${r.action}`).join('\n');
    toast('合并完成：\n' + lines);
    state.selected.clear();
    SCAN = data.scan;
    render();
  } catch (err) {
    buttonFeedback(btn, false, '失败');
    toast('合并失败：' + err.message, true);
  }
}

// ---------- 事件 ----------

$('btn-rescan').onclick = async () => {
  const btn = $('btn-rescan');
  try {
    SCAN = await api('/api/scan?force=1');
    buttonFeedback(btn, true, '已重新扫描');
    state.selected.clear();
    render();
  } catch (err) {
    buttonFeedback(btn, false, '失败');
    toast('扫描失败：' + err.message, true);
  }
};

$('filter').oninput = e => {
  state.filter = e.target.value;
  renderListOnly();
};

function renderListOnly() {
  const keepTitle = $('view-title').textContent;
  const keepScan = $('scan-time').textContent;
  render();
  $('view-title').textContent = keepTitle;
  $('scan-time').textContent = keepScan;
}

$('preview-close').onclick = () => { $('preview').hidden = true; };
$('check-all').onchange = e => {
  if (e.target.checked) for (const en of state.entries) state.selected.add(en.id);
  else state.selected.clear();
  document.querySelectorAll('.entry input[type=checkbox]').forEach(cb => { cb.checked = e.target.checked; });
  updateSelCount();
};
$('btn-merge').onclick = doMerge;

// ---------- 启动 ----------

(async function init() {
  try {
    SCAN = await api('/api/scan');
    render();
  } catch (err) {
    $('view-title').textContent = '加载失败';
    toast('加载失败：' + err.message, true);
  }
})();
