# 更新日志 (Changelog)

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [1.0.1] - 2026-09-25

### 新增

- MCP Server（`mcp-server.js`，stdio 零依赖）：任何支持 MCP 的 Agent 可通过 `list_projects` / `recall` / `search` 三个工具实时查询本机记忆
- Claude Code SessionEnd Hook（`notify-rescan.js`）：会话结束时自动触发记忆中枢重新扫描
- 已将 memory-hub MCP 注册进 Claude Code（用户级）、Qoder（用户级）、ZCode（`~/.zcode/cli/config.json`）

### 说明

- 经查证，ZCode 原生读取 AGENTS.md，合并产物对它直接生效
- 小米 MiMo 的对话记忆存于小米云端，本地仅有产物文件清单（非项目记忆），故不接入；Trae 聊天记录存云端、VS Code Copilot 会话库为空、slock 仅 agent 人设文档，同样无可读取内容

## [1.0.0] - 2026-09-25

首个正式版本。

### 主要功能

- 统一扫描本机六个 AI Agent 来源的记忆与会话：Qoder、Claude Code、Codex、Trae、ZCode、Marvis
- 用户级（全局）记忆与项目级记忆分区展示，全局记忆可注入任意项目
- Claude Code 与 Codex 的会话记录自动提取【最初需求】与【最终产出】，ZCode 会话从 message/part 表提取完整摘要，不再受截断标题影响
- 一键合并勾选的记忆条目，写入目标项目根目录的 `AGENTS.md`（合并前自动备份原文件）
- 可选生成 `CLAUDE.md` / `QODER.md` / `.trae/rules/project_rules.md` 指针文件，指向同目录 `AGENTS.md`
- 本地极简 Web 界面：项目列表、条目预览、搜索过滤、疑似重复提示、逐条复制（带点击反馈）
- 三级 slug 反查：带连字符的项目路径（如 `Agent-5`）也能准确还原项目目录

### 修复

- 扫描缓存增加 30 秒有效期：删除 `AGENTS.md` 等外部变动最迟 30 秒后反映到页面，点「重新扫描」立即生效
- Codex 会话 cwd 盘符大小写归一，避免同一项目被重复列出
- 过滤 ZCode 子代理会话（`sess_subagent_*`），不再产生噪音条目

### 已知限制

- Trae 聊天记录存储于 IndexedDB（LevelDB 格式），暂不支持解析
- Kimi / ChatGPT / 千问 / 豆包等桌面聊天应用的对话主体在服务端，本地无可扫描内容

[1.0.0]: https://github.com/YTZ-create/memory-hub/releases/tag/v1.0.0
