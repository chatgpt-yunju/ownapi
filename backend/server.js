require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');

const { authMiddleware } = require('./src/middleware/auth');
const { apiKeyAuth } = require('./src/middleware/apiKeyAuth');

const app = express();
const PORT = process.env.PORT || 3020;

// 基础中间件
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// 信任代理（Nginx）
app.set('trust proxy', true);

// API Key 鉴权路由 (/v1/*)
app.use('/v1', apiKeyAuth, require('./src/routes/chat'));

// SSO 鉴权路由 (/api/*)
app.use('/api/user', authMiddleware, require('./src/routes/user'));
app.use('/api/api-key', authMiddleware, require('./src/routes/apiKey'));
app.use('/api/logs', authMiddleware, require('./src/routes/logs'));
app.use('/api/package', authMiddleware, require('./src/routes/packages'));
app.use('/api/admin', authMiddleware, require('./src/routes/admin'));

// 支付路由（需要鉴权，除了回调接口）
const paymentRoutes = require('./src/routes/payment');
const userExtendRoutes = require('./src/routes/userExtend');
app.use('/api/payment', authMiddleware, paymentRoutes);
app.use('/api/user-extend', authMiddleware, userExtendRoutes); // 邀请、奖励、通知
// 支付宝回调不需要鉴权
app.post('/payment/alipay/notify', paymentRoutes);

// 公开路由：模型列表
app.get('/api/models', async (req, res) => {
  const db = require('./src/config/db');
  try {
    const [models] = await db.query(
      'SELECT model_id, display_name, provider, input_price_per_1k, output_price_per_1k FROM openclaw_models WHERE status = "active" ORDER BY sort_order'
    );
    res.json(models);
  } catch (err) {
    res.status(500).json({ error: '获取模型失败' });
  }
});

// 健康检查
app.get('/api/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// 全局错误处理
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: { message: 'Internal server error', type: 'server_error' } });
});

app.listen(PORT, () => {
  console.log(`OpenClaw AI Backend running on port ${PORT}`);
});
