'use strict';
const fs = require('node:fs');
const path = require('node:path');

const SOURCE_LABELS = {
  qoder: 'Qoder',
  claude: 'Claude Code',
  codex: 'Codex',
  trae: 'Trae',
  zcode: 'ZCode',
  marvis: 'Marvis',
  mimo: 'MiMo'
};

function buildAgentsMd(projectName, groups, dateStr) {
  const lines = [];
  lines.push('# AGENTS.md（AI Agent 共享记忆）');
  lines.push('');
  lines.push(`> 由记忆中枢于 ${dateStr} 合并生成。各 AI 工具开始工作前请先完整阅读本文件。`);
  for (const g of groups) {
    lines.push('');
    lines.push(`## 来自 ${SOURCE_LABELS[g.source] || g.source} 的记忆`);
    for (const e of g.entries) {
      lines.push('');
      lines.push(`### ${e.title}`);
      lines.push('');
      lines.push(e.content.trim());
    }
  }
  lines.push('');
  return lines.join('\n');
}

const POINTER_FILES = {
  claude: {
    file: 'CLAUDE.md',
    body: '@AGENTS.md\n\n本项目的共享记忆在同目录的 AGENTS.md 中，每次开始工作前请先完整阅读。'
  },
  qoder: {
    file: 'QODER.md',
    body: '本项目的共享记忆在同目录的 AGENTS.md 中，每次开始工作前请先完整阅读。'
  },
  trae: {
    file: path.join('.trae', 'rules', 'project_rules.md'),
    body: '本项目的共享记忆位于项目根目录的 AGENTS.md 中，每次开始工作前请先完整阅读。'
  }
};

function backupIfExists(file, ts) {
  try {
    if (fs.existsSync(file)) {
      const bak = file + '.bak-' + ts;
      fs.copyFileSync(file, bak);
      return bak;
    }
  } catch { /* ignore */ }
  return null;
}

// entries: [{source, title, content}]
// pointers: {claude: bool, qoder: bool, trae: bool}
function writeMerge(projectDir, entries, pointers) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dateStr = new Date().toLocaleString('zh-CN');
  const groups = [];
  for (const e of entries) {
    let g = groups.find(x => x.source === e.source);
    if (!g) { g = { source: e.source, entries: [] }; groups.push(g); }
    g.entries.push(e);
  }

  const results = [];
  const agentsPath = path.join(projectDir, 'AGENTS.md');
  const bak = backupIfExists(agentsPath, ts);
  fs.writeFileSync(agentsPath, buildAgentsMd(path.basename(projectDir), groups, dateStr), 'utf8');
  results.push({
    file: 'AGENTS.md',
    action: '已写入' + (bak ? '（原文件已备份为 ' + path.basename(bak) + '）' : ''),
    path: agentsPath
  });

  for (const [key, def] of Object.entries(POINTER_FILES)) {
    if (!pointers || !pointers[key]) continue;
    const target = path.join(projectDir, def.file);
    if (fs.existsSync(target)) {
      results.push({ file: def.file, action: '已存在，未改动', path: target });
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, def.body + '\n', 'utf8');
    results.push({ file: def.file, action: '已创建', path: target });
  }
  return results;
}

module.exports = { writeMerge, SOURCE_LABELS };
