@echo off
cd /d %~dp0
echo AI Agent 记忆中枢启动中...
start "" http://127.0.0.1:7788
node server.js
