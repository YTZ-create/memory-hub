'use strict';
// memory-hub MCP Server（stdio 传输，零依赖）
// 供支持 MCP 的 Agent（Qoder / Claude Code / ZCode 等）实时查询本机记忆。
// 接入配置：
//   { "mcpServers": { "memory-hub": { "command": "node", "args": ["<本文件绝对路径>"] } } }

const { scanAll, HOME } = require('./lib/scan');
const { SOURCE_LABELS } = require('./lib/merge');

const VERSION = '1.0.0';
let scanCache = null;
let scanCacheAt = 0;
const TTL = 30 * 1000;

function getScan(force) {
  if (force || !scanCache || Date.now() - scanCacheAt > TTL) {
    scanCache = scanAll();
    scanCacheAt = Date.now();
  }
  return scanCache;
}

function findProject(scan, name) {
  const needle = String(name || '').trim().toLowerCase();
  if (!needle) return null;
  return scan.projects.find(p =>
    p.dir.toLowerCase() === needle ||
    p.name.toLowerCase() === needle ||
    p.dir.toLowerCase().endsWith('\\' + needle)
  ) || scan.projects.find(p => p.name.toLowerCase().includes(needle)) || null;
}

function formatEntry(e) {
  const label = SOURCE_LABELS[e.source] || e.source;
  const time = e.updatedAt ? new Date(e.updatedAt).toLocaleDateString('zh-CN') : '';
  return `## [${label}] ${e.title}\n${time ? `(${time}) ` : ''}${e.chars} 字\n\n${(e.content || '').trim()}`;
}

function projectDigest(project, maxChars) {
  const entries = Object.values(project.sources).flat()
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  let out = `# ${project.name} 的记忆（${project.dir}）\n\n共 ${entries.length} 条，按最近活动排序。\n`;
  let used = out.length;
  let skipped = 0;
  entries.forEach((e, i) => {
    let block = '\n\n' + formatEntry(e);
    if (used + block.length > maxChars) {
      if (i === 0) { block = block.slice(0, maxChars - used) + '\n……（已截断）'; out += block; }
      else skipped++;
      return;
    }
    out += block;
    used += block.length;
  });
  if (skipped) out += `\n\n……（其余 ${skipped} 条略，超出长度上限）`;
  return out;
}

const TOOLS = [
  {
    name: 'list_projects',
    description: '列出记忆中枢扫描到的本机所有 AI Agent 记忆所在的项目目录及各来源条数',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'recall',
    description: '按项目名或路径召回该项目下所有 AI Agent 的记忆（含会话中的最初需求与最终产出），开始工作前调用',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: '项目名（如 memory-hub）或项目目录路径' },
        max_chars: { type: 'number', description: '返回内容长度上限，默认 12000' }
      },
      required: ['project']
    }
  },
  {
    name: 'search',
    description: '按关键词搜索所有记忆条目（标题与正文），返回命中的条目列表',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: '关键词' } },
      required: ['query']
    }
  }
];

function callTool(name, args) {
  const scan = getScan(false);
  if (name === 'list_projects') {
    const lines = scan.projects.map(p => {
      const counts = Object.entries(p.sources).filter(([, v]) => v.length).map(([k, v]) => `${k}:${v.length}`).join(' ');
      return `- ${p.name}（${p.dir}）${counts}${p.hasAgents ? ' [已有AGENTS.md]' : ''}`;
    });
    return { content: [{ type: 'text', text: lines.join('\n') || '未发现任何项目记忆' }] };
  }
  if (name === 'recall') {
    const project = findProject(scan, args.project);
    if (!project) {
      const names = scan.projects.map(p => p.name).join('、');
      return { content: [{ type: 'text', text: `未找到项目「${args.project}」。可用项目：${names || '无'}` }], isError: true };
    }
    return { content: [{ type: 'text', text: projectDigest(project, Number(args.max_chars) || 12000) }] };
  }
  if (name === 'search') {
    const q = String(args.query || '').trim().toLowerCase();
    if (!q) return { content: [{ type: 'text', text: '请提供关键词' }], isError: true };
    const hits = [];
    for (const p of scan.projects) {
      for (const e of Object.values(p.sources).flat()) {
        if ((e.title || '').toLowerCase().includes(q) || (e.content || '').toLowerCase().includes(q)) {
          hits.push(`[${p.name}] ${formatEntry(e)}`);
        }
      }
    }
    const text = hits.length ? hits.slice(0, 20).join('\n\n---\n\n') : '没有命中的记忆';
    return { content: [{ type: 'text', text: hits.length > 20 ? text + `\n\n……共 ${hits.length} 条命中，仅显示前 20 条` : text }] };
  }
  return { content: [{ type: 'text', text: '未知工具：' + name }], isError: true };
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (line) handleMessage(line);
  }
});
process.stdin.on('end', () => process.exit(0));

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function handleMessage(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    return send({
      jsonrpc: '2.0', id: msg.id,
      result: {
        protocolVersion: msg.params && msg.params.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'memory-hub', version: VERSION }
      }
    });
  }
  if (msg.method === 'notifications/initialized' || msg.method === 'notifications/cancelled') return;
  if (msg.method === 'tools/list') {
    return send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } });
  }
  if (msg.method === 'tools/call') {
    let result;
    try { result = callTool(msg.params.name, msg.params.arguments || {}); }
    catch (e) { result = { content: [{ type: 'text', text: '执行失败：' + e.message }], isError: true }; }
    return send({ jsonrpc: '2.0', id: msg.id, result });
  }
  if (msg.method === 'ping') {
    return send({ jsonrpc: '2.0', id: msg.id, result: {} });
  }
  if (msg.id !== undefined) {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found: ' + msg.method } });
  }
}
