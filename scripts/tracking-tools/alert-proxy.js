/**
 * 告警转发服务 - 接收 webhook 并推送到手机
 *
 * 功能:
 * 1. 接收 webhook.site 数据
 * 2. 推送到 DingTalk / 企业微信
 * 3. 推送到 Bark (iPhone)
 * 4. 推送到 Server 酱 (微信)
 *
 * 使用方法:
 * 1. 部署到 Node 服务器
 * 2. 配置下方的 DING_TOKEN / WECHAT_KEY / BARK_KEY
 * 3. webhook.site 的 URL 指向此服务
 * 4. 手机收到实时告警
 */

const express = require('express');
const axios = require('axios');

// ========== 配置（填你自己的）==========
const CONFIG = {
  // DingTalk 机器人
  DING_TOKEN: process.env.DING_TOKEN || '',  // 钉钉机器人的 access_token

  // 企业微信机器人（推荐）
  // 获取方法：企业微信群 → 设置 → 添加机器人 → 复制 key
  WECHAT_KEY: process.env.WECHAT_KEY || '',  // 企微机器人的 key

  // Bark App (iPhone推通知，免费)
  // 下载 Bark App → 复制专属 key
  BARK_KEY: process.env.BARK_KEY || '',  // Bark App 中的 key

  // Server 酱 (微信推通知)
  // 关注 Server酱公众号 → 获取 key
  SC_KEY: process.env.SC_KEY || '',  // Server 酱的 key

  // 端口
  PORT: process.env.ALERT_PORT || 3004
};

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/**
 * 主要的接收端点
 * 例如：POST http://yourserver:3003/track
 */
app.all('/track', async (req, res) => {
  try {
    // 解析上报数据
    const data = {
      ...req.query,
      ...req.body,
      ip: req.ip?.replace('::ffff:', ''),
      ua: req.headers['user-agent']
    };

    console.log('[Track] 收到上报:', new Date().toISOString(), data);

    // 发送告警
    await sendAlerts(data);

    res.json({ ok: true, received: true });
  } catch (e) {
    console.error('[Track] Error:', e.message);
    res.status(200).json({ ok: false });  // 返回200避免暴露错误
  }
});

/**
 * 发送告警到多个渠道
 */
async function sendAlerts(data) {
  const { p: project, h: host, href, ts } = data;
  const time = ts ? new Date(ts).toLocaleString('zh-CN') : new Date().toLocaleString('zh-CN');

  // 方案1: DingTalk
  if (CONFIG.DING_TOKEN && CONFIG.DING_TOKEN !== 'xxx-xxx-xxx') {
    await sendDingTalk(project, host, time, data.ip);
  }

  // 方案2: 企业微信
  if (CONFIG.WECHAT_KEY && CONFIG.WECHAT_KEY !== 'xxx-xxx-xxx') {
    await sendWeChat(project, host, time);
  }

  // 方案3: Bark (iPhone)
  if (CONFIG.BARK_KEY && CONFIG.BARK_KEY !== 'xxx') {
    await sendBark(project, host, time);
  }

  // 方案4: Server 酱
  if (CONFIG.SC_KEY && CONFIG.SC_KEY !== 'SCTxxx') {
    await sendServerChan(project, host, time);
  }
}

/**
 * DingTalk 推送
 */
async function sendDingTalk(project, host, time, ip) {
  try {
    await axios.post(
      `https://oapi.dingtalk.com/robot/send?access_token=${CONFIG.DING_TOKEN}`,
      {
        msgtype: 'markdown',
        markdown: {
          title: '【部署告警】',
          text: `## 🚨 检测到新的代码部署\n\n**项目：** ${project}\n**域名：** ${host}\n**IP：** ${ip || '未知'}\n**时间：** ${time}\n\n请及时检查是否为授权部署。`
        }
      },
      { timeout: 5000 }
    );
    console.log('[Alert] DingTalk sent');
  } catch (e) {
    console.error('[Alert] DingTalk failed:', e.message);
  }
}

/**
 * 企业微信推送
 */
async function sendWeChat(project, host, time) {
  try {
    await axios.post(
      `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${CONFIG.WECHAT_KEY}`,
      {
        msgtype: 'text',
        text: {
          content: `【部署告警】\n项目：${project}\n域名：${host}\n时间：${time}\n请及时检查。`,
          mentioned_mobile_list: []  // 可选：@手机号
        }
      },
      { timeout: 5000 }
    );
    console.log('[Alert] WeChat sent');
  } catch (e) {
    console.error('[Alert] WeChat failed:', e.message);
  }
}

/**
 * Bark 推送 (iPhone)
 */
async function sendBark(project, host, time) {
  try {
    const title = encodeURIComponent(project + ' 被部署');
    const body = encodeURIComponent(`域名：${host}\n时间：${time}`);
    await axios.get(
      `https://api.day.app/${CONFIG.BARK_KEY}/${title}/${body}`,
      { timeout: 5000 }
    );
    console.log('[Alert] Bark sent');
  } catch (e) {
    console.error('[Alert] Bark failed:', e.message);
  }
}

/**
 * Server 酱推送 (微信)
 */
async function sendServerChan(project, host, time) {
  try {
    await axios.post(
      `https://sctapi.ftqq.com/${CONFIG.SC_KEY}.send`,
      {
        title: `${project} 被部署`,
        desp: `域名：${host}\n时间：${time}`
      },
      { timeout: 5000 }
    );
    console.log('[Alert] ServerChan sent');
  } catch (e) {
    console.error('[Alert] ServerChan failed:', e.message);
  }
}

// 启动服务
app.listen(CONFIG.PORT, () => {
  console.log(`[Alert Proxy] 启动在端口 ${CONFIG.PORT}`);
  console.log('[Alert Proxy] 接收端点: http://localhost:' + CONFIG.PORT + '/track');
});

module.exports = app;
