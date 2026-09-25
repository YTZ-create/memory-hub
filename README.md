# 记忆中枢 (Memory Hub)

一个极简的本地 Web 工具，统一管理本机所有 AI Agent 的记忆文件。同一个项目用不同的 AI 工具轮流开发时，把各家积累的记忆合并成一份 AGENTS.md，任何工具开始工作前先读它，不用每次重新说明需求。

版本历史见 [CHANGELOG.md](CHANGELOG.md)。

## 功能

- 全盘扫描本机各 AI 工具的记忆与会话记录，按项目目录自动归类
- 勾选任意条目，合并写入目标项目的 `AGENTS.md`（合并前自动备份原文件）
- 可选生成指针文件（`CLAUDE.md` / `QODER.md` / `.trae/rules/project_rules.md`），内容指向同目录的 `AGENTS.md`
- 会话记录自动提取【最初需求】和【最终产出】两条精华，而不是只存截断的标题

## 支持的扫描来源

| 来源 | 用户级记忆 | 项目级记忆 | 会话记录 |
|---|---|---|---|
| Qoder | 不展示（文件保留在 `~/.qoder-cn/memory/`，由 Qoder 自行管理） | `~/.qoder-cn/projects/<项目>/memory/*.md` | 不支持 |
| Claude Code | `~/.claude/CLAUDE.md` | 项目 `CLAUDE.md`、`.claude/memory/`、`~/.claude/projects/<项目>/memory/` | 会话 jsonl 提取需求与产出 |
| Codex | `~/.codex/memories_1.sqlite` | 会话按 cwd 自动归项目 | `~/.codex/sessions` rollout 提取 |
| Trae | 用户规则（state.vscdb） | 项目 `.trae/rules/*.md` | 不支持 |
| ZCode | 不支持 | 会话按目录归项目 | 会话正文从 message/part 表提取 |
| Marvis | `~/.marvis/database/memory.db` | 不支持 | 不支持 |

带连字符的项目路径（如 `Agent-5`）无法从 slug 直接还原，采用三级反查：已知真实路径锚点、常见目录枚举匹配、Claude 会话文件提取 cwd。

## 运行

```bash
node server.js
```

启动后访问 <http://127.0.0.1:7788>。也可以双击 `启动记忆中枢.cmd`。

依赖：Node.js 22+（使用了内置的 `node:sqlite`）。

## 使用流程

1. 启动服务，左侧选择一个项目（或一组用户级记忆）
2. 勾选要合并的条目，可先在搜索框过滤
3. 选择合并目标项目，点击合并
4. 项目根目录生成 `AGENTS.md`，各 AI 工具开始工作前先完整阅读该文件

## 项目结构

```
server.js       HTTP 服务与 API（scan / file / merge）
lib/scan.js     各来源扫描与 slug 反查
lib/merge.js    AGENTS.md 生成与指针文件写入
mcp-server.js   MCP Server（供 Agent 实时查询记忆）
notify-rescan.js  Claude Code SessionEnd Hook 入口
public/         前端单页界面
```

## MCP 接入（Agent 实时查询记忆）

任何支持 MCP 的 Agent（Qoder、Claude Code、ZCode 等）都可接入 memory-hub，在工作时实时拉取记忆而非只在开头读一次 AGENTS.md。提供三个工具：

- `list_projects`：列出所有扫描到的项目及各来源条数
- `recall`：按项目名召回该项目全部记忆（含会话中的最初需求与最终产出）
- `search`：跨来源关键词搜索

在 Agent 的 MCP 配置中加入：

```json
{
  "mcpServers": {
    "memory-hub": {
      "command": "node",
      "args": ["<memory-hub 所在目录>\\mcp-server.js"]
    }
  }
}
```

注意：MCP Server 是独立进程，自己完成扫描，不需要先启动 `server.js`；网页界面和合并功能则需要 `server.js` 保持运行。

## Claude Code 自动刷新

已支持通过 SessionEnd Hook 在 Claude Code 会话结束时自动触发重新扫描（`~/.claude/settings.json` 的 `hooks.SessionEnd` 调用 `notify-rescan.js`），新会话立即出现在界面，无需手动刷新。

## 说明

- 所有数据均保存在本机，扫描使用只读方式打开各工具的数据库
- 扫描结果缓存 30 秒，手动删除 `AGENTS.md` 等外部变动最迟 30 秒后反映到页面，点「重新扫描」立即刷新
- 合并只会新建或覆盖 `AGENTS.md` 与指针文件，不会改动任何工具自身的记忆数据
- 合并覆盖前原文件自动备份为 `AGENTS.md.bak-<时间戳>`

## 协议

[MIT](LICENSE)
