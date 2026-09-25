'use strict';
// Claude Code SessionEnd hook：会话结束时通知记忆中枢强制重新扫描
// 失败静默（记忆中枢未启动时不影响 Claude Code 退出）
fetch('http://127.0.0.1:7788/api/scan?force=1').catch(() => {});
