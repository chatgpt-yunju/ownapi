const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const app = express();

// Security headers
try {
  const helmet = require('helmet');
  app.use(helmet({ contentSecurityPolicy: false }));
} catch {}

// CORS whitelist
const envOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
let dbOrigins = [];
(async () => {
  try {
    const { getSettingCached } = require('./routes/quota');
    const raw = await getSettingCached('sso_sub_sites', '[]');
    const sites = JSON.parse(raw);
    dbOrigins = sites.map(s => s.domain).filter(Boolean);
  } catch {}
})();
app.use(cors({
  origin: (origin, cb) => {
    const all = [...envOrigins, ...dbOrigins];
    if (!origin || all.length === 0 || all.includes(origin)) return cb(null, true);
    cb(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));

// Trust nginx proxy (required for correct IP detection with X-Forwarded-For)
app.set('trust proxy', 1);

// Global rate limit
function isAiGatewayPath(pathname = '') {
  return (
    pathname.startsWith('/v1/') ||
    pathname === '/v1' ||
    pathname.startsWith('/v1beta/') ||
    pathname === '/v1beta' ||
    pathname === '/api/models' ||
    pathname === '/api/health' ||
    pathname === '/api/package/list' ||
    pathname === '/api/internal/metrics'
  );
}

app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => isAiGatewayPath(req.path || ''),
}));

// 服务端请求超时保护：非流式请求 130s 后自动返回 503，防止僵尸连接耗尽连接池
// 流式请求（SSE）通过检测 Accept 头跳过，不受超时影响
app.use((req, res, next) => {
  if (req.headers.accept?.includes('text/event-stream')) return next();
  const timer = setTimeout(() => {
    if (!res.headersSent) {
      res.status(503).json({ error: { message: 'Request timeout', type: 'server_error' } });
    }
  }, 130 * 1000);
  res.on('finish', () => clearTimeout(timer));
  res.on('close', () => clearTimeout(timer));
  next();
});

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Nginx 会把 /api/* 改写成 /api/plugins/ai-gateway/api/*。
// 这里先剥掉兼容前缀，让后面的现有路由继续按 /api/pay、/api/guest 等原始路径工作。
app.use((req, _res, next) => {
  const compatPrefix = '/api/plugins/ai-gateway';
  if (typeof req.url === 'string' && req.url.startsWith(compatPrefix)) {
    const stripped = req.url.slice(compatPrefix.length) || '/';
    req.url = stripped.startsWith('/') ? stripped : `/${stripped}`;
  }
  next();
});

// QQ OAuth relay: login.yunjunet.cn 302→ api.yunjunet.cn/return.php，转发到实际回调
app.get('/return.php', (req, res) => {
  const qs = require('querystring').stringify(req.query);
  res.redirect(`/api/auth/qq/callback?${qs}`);
});

// 静态页面：支持 /console.html /admin.html /login.html 直连访问
const rootPublicDir = path.join(__dirname, '../../public');
const backendPublicDir = path.join(__dirname, '../public');
app.use(express.static(rootPublicDir));
app.use(express.static(backendPublicDir));

// 博客文章 SEO 友好 URL：/blog/:id.html → 返回 blog.html（前端 JS 解析路径中的 id）
app.get(/^\/blog\/(\d+)\.html$/, (req, res) => {
  res.sendFile(path.join(rootPublicDir, 'blog.html'));
});

app.use('/api/captcha', require('./routes/captcha'));
app.use('/api/email-code', require('./routes/emailCode'));
app.use('/api/guest', require('./routes/guest'));
// Start scheduler
try { require('./scheduler'); } catch (e) { console.error('Scheduler error:', e.message); }

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/content', require('./routes/content'));
app.use('/api/categories', require('./routes/categories'));
app.use('/api/ratings', require('./routes/ratings'));
app.use('/api/claims', require('./routes/claims'));
app.use('/api/stats', require('./routes/stats'));
app.use('/api/media', require('./routes/media'));
app.use('/api/quota', require('./routes/quota'));
app.use('/api/tasks', require('./routes/tasks').router);
app.use('/api/benchmark', require('./routes/benchmark'));
app.use('/api/pay', require('./routes/pay'));
app.use('/api/balance', require('./routes/balance'));
app.use('/api/cardkey', require('./routes/cardkey'));
app.use('/api/rewrite', require('./routes/rewrite'));
app.use('/api/locks', require('./routes/locks'));
app.use('/api/users', require('./routes/users'));
app.use('/api/review', require('./routes/review'));
const { apiKeyGuest } = require('./middleware/apiKeyGuest');
app.use('/api/aitools', apiKeyGuest, require('./routes/aitools'));
app.use('/api/analyze', require('./routes/analyze'));
app.use('/api/backup', require('./routes/backup'));
app.use('/api/requirements', require('./routes/requirements'));
app.use('/api/templates', require('./routes/templates'));
app.use('/api/favorites', require('./routes/favorites'));
app.use('/api/shop', require('./routes/shop'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/search', apiKeyGuest, require('./routes/search'));
app.use('/api/news', require('./routes/news'));
app.use('/api/ai-employees', apiKeyGuest, require('./routes/aiEmployees'));
app.use('/api/sso', require('./routes/sso'));
app.use('/api/planet', require('./routes/planet'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/plugins', require('./routes/plugins'));

// 插件系统加载
const { loadPlugins } = require('./plugin-loader');
loadPlugins(app).catch(err => console.error('[plugin-loader] 加载失败:', err.message));

// CC Club key 自动禁启守护：记录限流重置时间并按时间自动恢复
try {
  const { startCcClubKeyGuard } = require('./plugins/ai-gateway/utils/ccClubKeyGuard');
  startCcClubKeyGuard();
} catch (e) {
  console.error('[ccclub-key-guard] 启动失败:', e.message);
}

// 火山引擎 key 自动禁启守护：记录限流重置时间并按时间自动恢复
try {
  const { startHuoshanKeyGuard } = require('./plugins/ai-gateway/utils/huoshanKeyGuard');
  startHuoshanKeyGuard();
} catch (e) {
  console.error('[huoshan-key-guard] 启动失败:', e.message);
}

// AI 网关兼容直出：恢复 /v1/*、/v1beta/*、/api/models 入口
// 插件系统仍保留 /api/plugins/ai-gateway 前缀，此处仅做外部兼容路由桥接
try {
  const aiGatewayRouter = require('./plugins/ai-gateway/routes');
  app.use((req, res, next) => {
    const p = req.path || '';
    if (
      p.startsWith('/v1/') ||
      p === '/v1' ||
      p.startsWith('/v1beta/') ||
      p === '/v1beta' ||
      p.startsWith('/api/user') ||
      p.startsWith('/api/api-key') ||
      p.startsWith('/api/logs') ||
      p.startsWith('/api/package') ||
      p.startsWith('/api/payment') ||
      p.startsWith('/api/user-extend') ||
      p.startsWith('/api/guest') ||
      p.startsWith('/api/admin') ||
      p === '/api/app-market' ||
      p.startsWith('/api/blog') ||
      p === '/api/models' ||
      p === '/api/health' ||
      p === '/api/package/list' ||
      p === '/api/internal/metrics'
    ) {
      return aiGatewayRouter(req, res, next);
    }
    return next();
  });
} catch (e) {
  console.error('[ai-gateway] 兼容路由挂载失败:', e.message);
}

// Global error handler
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') {
    const isApiRoute = req.path.includes('/v1/') || req.path.includes('/api/plugins/ai-gateway');
    if (isApiRoute) {
      return res.status(413).json({ type: 'error', error: { type: 'invalid_request_error', message: `Request body too large (${err.length} bytes). Maximum allowed is 50MB.` } });
    }
    return res.status(413).json({ message: `Request body too large (${err.length} bytes)` });
  }
  console.error(err);
  res.status(500).json({ message: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
const server = http.createServer(app);
server.keepAliveTimeout = Math.max(65000, parseInt(process.env.KEEP_ALIVE_TIMEOUT_MS, 10) || 65000);
server.headersTimeout = Math.max(server.keepAliveTimeout + 1000, parseInt(process.env.HEADERS_TIMEOUT_MS, 10) || 66000);
server.requestTimeout = parseInt(process.env.SERVER_REQUEST_TIMEOUT_MS, 10) || 0;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
