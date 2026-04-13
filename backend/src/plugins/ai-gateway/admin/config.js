/**
 * AI Gateway 管理配置面板
 * 所有变量可通过 Web 界面配置
 */

const express = require('express');
const router = express.Router();
const fs = require('fs').promises;
const path = require('path');
const db = require('../../../config/db');

const CONFIG_FILE = path.join(__dirname, '../config/system-config.json');

// 默认配置
const DEFAULT_CONFIG = {
  // 上游 Endpoint 配置
  endpoints: {
    maxInflight: 10,        // 最大并发数
    failureThreshold: 5,    // 熔断触发阈值
    circuitOpenMs: 60000,   // 熔断持续时间
    leaseTTL: 180000,       // 租约有效期
    healthTTL: 86400000,    // 健康检查有效期
  },

  // 调度算法配置
  scheduler: {
    algorithm: 'weighted',  // weighted | round-robin | least-connections
    healthCheck: true,      // 健康检查开关
    circuitBreaker: true,   // 熔断保护开关
    stickySession: false,   // 粘性会话
  },

  // 限流配置
  rateLimit: {
    enabled: true,
    requestsPerMinute: 60,
    burstSize: 10,
  },

  // 缓存配置
  cache: {
    enabled: true,
    ttl: 600,               // 缓存时间(秒)
    maxSize: 1000,          // 最大条目
  },

  // 日志配置
  logging: {
    level: 'info',          // debug | info | warn | error
    saveRequests: true,     // 保存请求日志
    saveResponses: false, // 保存响应日志
    rotation: '7d',         // 日志轮转
  },

  // 模型映射
  models: {
    // 模型ID -> 上游模型映射
    mappings: {},
    // 默认上游配置
    defaults: {}
  }
};

// 配置管理器
class GatewayConfigManager {
  constructor() {
    this.config = null;
  }

  async load() {
    try {
      const data = await fs.readFile(CONFIG_FILE, 'utf8');
      this.config = JSON.parse(data);
    } catch {
      this.config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
      await this.save();
    }
    return this.config;
  }

  async save() {
    await fs.mkdir(path.dirname(CONFIG_FILE), { recursive: true });
    await fs.writeFile(CONFIG_FILE, JSON.stringify(this.config, null, 2));
  }

  async get() {
    if (!this.config) await this.load();
    return this.config;
  }

  async update(updates) {
    if (!this.config) await this.load();
    Object.assign(this.config, updates);
    await this.save();
  }
}

const configManager = new GatewayConfigManager();

// API 路由

// 获取完整配置
router.get('/api/config', async (req, res) => {
  const config = await configManager.get();
  res.json(config);
});

// 更新配置
router.post('/api/config', async (req, res) => {
  await configManager.update(req.body);
  res.json({ success: true });
});

// 获取 Endpoint 列表
router.get('/api/endpoints', async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT id, provider_name, base_url, api_key, weight,
              is_enabled, priority, created_at
       FROM openclaw_model_upstreams
       ORDER BY priority DESC`
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 添加 Endpoint
router.post('/api/endpoints', async (req, res) => {
  const {
    provider_name, base_url, api_key, weight = 100,
    is_enabled = 1, priority = 0
  } = req.body;

  try {
    const [result] = await db.query(
      `INSERT INTO openclaw_model_upstreams
       (provider_name, base_url, api_key, weight, is_enabled, priority, created_at)
       VALUES (?, ?, ?, ?, ?, ?, NOW())`,
      [provider_name, base_url, api_key, weight, is_enabled, priority]
    );
    res.json({ success: true, id: result.insertId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 更新 Endpoint
router.put('/api/endpoints/:id', async (req, res) => {
  const { id } = req.params;
  const updates = req.body;

  try {
    const fields = [];
    const values = [];
    for (const [key, value] of Object.entries(updates)) {
      fields.push(`${key} = ?`);
      values.push(value);
    }
    values.push(id);

    await db.query(
      `UPDATE openclaw_model_upstreams SET ${fields.join(', ')} WHERE id = ?`,
      values
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 删除 Endpoint
router.delete('/api/endpoints/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM openclaw_model_upstreams WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 获取调度统计
router.get('/api/stats', async (req, res) => {
  try {
    // Endpoint 统计
    const [endpointStats] = await db.query(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN is_enabled = 1 THEN 1 ELSE 0 END) as active,
        SUM(CASE WHEN is_enabled = 0 THEN 1 ELSE 0 END) as disabled
      FROM openclaw_model_upstreams
    `);

    // 今日请求统计
    const [todayStats] = await db.query(`
      SELECT COUNT(*) as requests
      FROM openclaw_request_logs
      WHERE DATE(created_at) = CURDATE()
    `);

    res.json({
      endpoints: endpointStats[0],
      today: todayStats[0]
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 测试 Endpoint
router.post('/api/endpoints/:id/test', async (req, res) => {
  const { id } = req.params;

  try {
    const [rows] = await db.query(
      'SELECT base_url, api_key FROM openclaw_model_upstreams WHERE id = ?',
      [id]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Endpoint not found' });
    }

    const { base_url, api_key } = rows[0];

    // 简单的连通性测试
    const axios = require('axios');
    const start = Date.now();

    try {
      await axios.get(base_url.replace(/\/+$/, '') + '/health', {
        headers: { Authorization: `Bearer ${api_key}` },
        timeout: 5000
      });

      res.json({
        success: true,
        latency: Date.now() - start,
        message: 'Endpoint is healthy'
      });
    } catch (e) {
      res.json({
        success: false,
        latency: Date.now() - start,
        message: e.message
      });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = { router, configManager };
