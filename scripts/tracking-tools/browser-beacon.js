/**
 * 客户端埋点代码 - Image Beacon 版（最隐蔽）
 *
 * 使用方法：
 * 1. 修改 WEBHOOK_URL 为你的 webhook.site 地址
 * 2. 修改 PROJECT_CODE 为项目唯一标识
 * 3. 复制到任意 JS 文件末尾（建议多处插入）
 * 4. 压缩版更难被发现
 */

// ========== 配置区（修改这3个参数） ==========
// 方案1: 使用本地免费追踪服务器（推荐）
const CONFIG = {
  WEBHOOK_URL: 'http://localhost:3003/track',  // <-- 本地服务器，完全免费

  // 方案2: 使用你的公网服务器（需部署到VPS，所有人可上报）
  // WEBHOOK_URL: 'http://你的VPS:3003/track',

  // 方案3: 使用 webhook.site（现在有额度限制）
  // WEBHOOK_URL: 'https://webhook.site/你的专属ID',

  PROJECT_CODE: 'project_01',                    // 替换为项目标识（如：shop_system）
  ALERT_TYPE: 'webhook'                          // webhook/bark/dingtalk/wechat
};

// ========== 埋点逻辑（不要修改） ==========
(function beacon() {
  try {
    // 收集部署信息
    const data = {
      p: CONFIG.PROJECT_CODE,
      h: location.hostname,
      href: location.href,
      ua: navigator.userAgent,
      ref: document.referrer,
      ts: new Date().toISOString(),
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      sw: screen.width,
      sh: screen.height,
      lang: navigator.language
    };

    // 编码数据
    const params = new URLSearchParams(data).toString();

    // 方案1: Image Beacon（跨域不报错、不阻塞页面）
    new Image().src = `${CONFIG.WEBHOOK_URL}?${params}`;

    // 方案2: Bark推送（如需手机弹窗，取消下面注释并填入你的Bark key）
    // new Image().src = `https://api.day.app/YOUR_BARK_KEY/${CONFIG.PROJECT_CODE}被部署/${location.hostname}`;

    // 方案3: Fetch方式（备用，宽松CORS下可用）
    // fetch(CONFIG.WEBHOOK_URL + '?' + params, { mode: 'no-cors' });

  } catch (e) {}
})();

// ========== CSS埋点（超级隐蔽，不需要JS）==========
// 可添加到你的CSS文件中：
// body::after { content: url(https://webhook.site/xxx?p=project_01&h=aa); display: none; }
