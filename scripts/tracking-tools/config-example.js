/**
 * 配置示例 - 批量工业化埋点
 *
 * 步骤:
 * 1. 复制此文件并修改配置
 * 2. 运行节点启用批量插入
 * 3. 部署后查看 webhook.site
 */

// ========== 第1步：获取 webhook URL ==========
// 1. 打开 https://webhook.site
// 2. 复制你的专属 URL
const WEBHOOK_URL = 'https://webhook.site/你的专属ID';

// ========== 第2步：配置项目 ==========
// 格式: [路径, 项目标识]
const PROJECTS = [
    ['../../test-projects/project-a/src', 'shop_vip'],
    ['../../test-projects/project-b/js', 'admin_pro'],
    ['../../test-projects/project-c/static', 'api_gateway'],
];

// ========== 第3步：复制 browser-beacon.js 中的埋点代码 ==========
const BEACON_TEMPLATE = `(function() {
  try {
    const PROJECT_CODE = '{PROJECT}';
    const data = {
      p: PROJECT_CODE,
      h: location.hostname,
      href: location.href,
      ua: navigator.userAgent,
      ts: new Date().toISOString()
    };
    new Image().src = '${WEBHOOK_URL}?' +
      new URLSearchParams(data).toString();
  } catch (e) {}
})();`;

// ========== 完整的配置导出 ==========
module.exports = {
    WEBHOOK_URL,
    PROJECTS,
    BEACON_TEMPLATE,

    // 告警配置（可选）
    ALERT_CONFIG: {
        // 钉钉
        DING_TOKEN: 'your-dingtalk-token',
        // 企业微信
        WECHAT_KEY: 'your-wechat-key',
        // Bark
        BARK_KEY: 'your-bark-key'
    }
};
