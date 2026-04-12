/* 云聚API - API Client */
const API_BASE = '/api';
function getLoginUrl() {
  const next = window.location.pathname + window.location.search;
  return `/login.html?return_url=` + encodeURIComponent(next || '/console.html');
}

const api = {
  // 动态获取 token，每次请求时重新读取
  get token() { return localStorage.getItem('token') || localStorage.getItem('openclaw_token'); },
  set token(t) { localStorage.setItem('token', t); localStorage.setItem('openclaw_token', t); },

  setToken(t) {
    localStorage.setItem('token', t);
    localStorage.setItem('openclaw_token', t);
  },
  clearToken() {
    localStorage.removeItem('token');
    localStorage.removeItem('openclaw_token');
  },

  async request(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`;
    const res = await fetch(API_BASE + path, { ...opts, headers });
    if (res.status === 401) {
      this.clearToken();
      window.location.href = getLoginUrl();
      throw new Error('未登录');
    }
    const data = await res.json();
    if (!res.ok) {
      const err = new Error(data.error || data.message || '请求失败');
      if (data.needSetPassword) err.needSetPassword = true;
      if (data.needBindEmail) err.needBindEmail = true;
      if (data.needEmailCode) err.needEmailCode = true;
      throw err;
    }
    return data;
  },

  get(path) { return this.request(path); },
  post(path, body) { return this.request(path, { method: 'POST', body: JSON.stringify(body) }); },
  patch(path, body) { return this.request(path, { method: 'PATCH', body: JSON.stringify(body) }); },
  put(path, body) { return this.request(path, { method: 'PUT', body: JSON.stringify(body) }); },
  del(path) { return this.request(path, { method: 'DELETE' }); },

  // User
  getUserInfo() { return this.get('/user/info'); },
  getBalance() { return this.get('/user/balance'); },

  // API Keys
  getApiKeys() { return this.get('/api-key/list'); },
  createApiKey(name, emailCode) { return this.post('/api-key/create', { name, email_code: emailCode }); },
  toggleApiKey(id) { return this.post('/api-key/toggle', { id }); },
  deleteApiKey(id) { return this.post('/api-key/delete', { id }); },

  // Logs
  getLogs(params = {}) {
    const q = new URLSearchParams(params).toString();
    return this.get('/logs' + (q ? '?' + q : ''));
  },
  getStats() { return this.get('/logs/stats'); },

  // Models
  async getModels() {
    const res = await fetch(API_BASE + '/models');
    return res.json();
  },

  // Packages
  getPackages() { return this.get('/package/list'); },
  buyPackage(package_id) { return this.post('/package/buy', { package_id }); },
  getMyPackages() { return this.get('/package/my'); },

  // Payment
  createPackagePayment(package_id) { return this.post('/payment/create-package', { package_id }); },
  getPaymentOrder(out_trade_no) { return this.get('/payment/order/' + out_trade_no); },
  createRecharge(amount) { return this.post('/payment/create-recharge', { amount }); },
  getMyOrders(params = {}) {
    const q = new URLSearchParams(params).toString();
    return this.get('/payment/my-orders' + (q ? '?' + q : ''));
  },
  verifyPayment(out_trade_no) { return this.post('/payment/verify/' + out_trade_no); },

  // User Extend (邀请、奖励、通知)
  getInviteInfo() { return this.get('/user-extend/invite'); },
  getRewards() { return this.get('/user-extend/rewards'); },
  claimReward(id) { return this.post(`/user-extend/rewards/${id}/claim`); },
  getNotifications() { return this.get('/user-extend/notifications'); },
  markNotificationRead(id) { return this.post(`/user-extend/notifications/${id}/read`); },
  markAllNotificationsRead() { return this.post('/user-extend/notifications/read-all'); },
  getStatistics() { return this.get('/logs/statistics'); },

  // Admin
  adminOverview() { return this.get('/admin/overview'); },
  adminStatsRange(start, end, filters = {}) {
    const params = new URLSearchParams({ start, end });
    if (filters.model) params.set('model', filters.model);
    if (filters.user_id) params.set('user_id', filters.user_id);
    if (filters.api_key_id) params.set('api_key_id', filters.api_key_id);
    return this.get('/admin/stats/range?' + params.toString());
  },
  adminStatsRangeOptions() { return this.get('/admin/stats/range/options'); },
  adminUsers(params = {}) {
    const q = new URLSearchParams(params).toString();
    return this.get('/admin/users' + (q ? '?' + q : ''));
  },
  adminCharge(user_id, amount, remark, balance_type = 'wallet') { return this.post('/admin/charge', { user_id, amount, remark, balance_type }); },
  adminGetModels() { return this.get('/admin/models'); },
  adminUpdateModel(id, data) { return this.put('/admin/models/' + id, data); },
  adminCreateModel(data) { return this.post('/admin/models', data); },
  adminGetProviders() { return this.get('/admin/providers'); },
  adminCreateProvider(data) { return this.post('/admin/providers', data); },
  adminUpdateProvider(id, data) { return this.put('/admin/providers/' + id, data); },
  adminDeleteProvider(id) { return this.del('/admin/providers/' + id); },
  adminDeleteModel(id) { return this.del('/admin/models/' + id); },
  adminGetUserDetail(userId) { return this.get('/admin/users/' + userId); },
  adminCcclubMessages(params = {}) {
    const q = new URLSearchParams(params).toString();
    return this.get('/admin/ccclub/messages' + (q ? '?' + q : ''));
  },
  adminSendCcclubMessagesEmail(payload) {
    return this.post('/admin/ccclub/messages/send-email', payload);
  },
  adminSendBulkEmail(payload) {
    return this.post('/admin/emails/send', payload);
  },
  adminCcclubLatencyTest(payload) {
    return this.post('/admin/ccclub/test-latency', payload);
  },
  adminGetHuoshanKeyResets() {
    return this.get('/admin/huoshan/key-resets');
  },
  adminRecoverHuoshanKeyReset(api_key) {
    return this.post('/admin/huoshan/key-resets/recover', { api_key });
  },
  adminSendHuoshanKeyResetsEmail(to) {
    return this.post('/admin/huoshan/key-resets/send-email', to ? { to } : {});
  },
  adminGetRequestDebugTraces(params = {}) {
    const q = new URLSearchParams(params).toString();
    return this.get('/admin/request-debug/traces' + (q ? '?' + q : ''));
  },
  adminGetRequestDebugTrace(requestId) {
    return this.get('/admin/request-debug/traces/' + requestId);
  },
  adminRunRequestDebug(payload) {
    return this.post('/admin/request-debug/run', payload);
  },
  adminStatsTrends(days = 7) { return this.get(`/admin/stats/trends?days=${days}`); },
  adminStatsModelDistribution(days = 7) { return this.get(`/admin/stats/model-distribution?days=${days}`); },
  adminSetUserStatus(id, status) { return this.put(`/admin/users/${id}/status`, { status }); },
  adminSetUserRole(id, role) { return this.put(`/admin/users/${id}/role`, { role }); },
  adminGetCardKeys() { return this.get('/cardkey/list'); },
  adminGenerateCardKeys(quota, count, vip_days) { return this.post('/cardkey/generate', { quota, count, vip_days }); },
  adminDeleteCardKey(id) { return this.del(`/cardkey/${id}`); },
  adminGetAppMarket() { return this.get('/admin/app-market'); },
  adminCreateAppMarketApp(data) { return this.post('/admin/app-market', data); },
  adminUpdateAppMarketApp(id, data) { return this.put('/admin/app-market/' + id, data); },
  adminDeleteAppMarketApp(id) { return this.del('/admin/app-market/' + id); },
  getAppMarket() { return this.get('/app-market'); },
  adminGetBlogPosts() { return this.get('/admin/blog'); },
  adminGetBlogPost(id) { return this.get('/admin/blog/' + id); },
  adminCreateBlogPost(data) { return this.post('/admin/blog', data); },
  adminUpdateBlogPost(id, data) { return this.put('/admin/blog/' + id, data); },
  adminDeleteBlogPost(id) { return this.del('/admin/blog/' + id); },
  adminBlogAiChat(id, payload) { return this.post('/admin/blog/' + id + '/ai-chat', payload); },
  adminBlogAiRewrite(id, payload) { return this.post('/admin/blog/' + id + '/ai-rewrite-sentence', payload); },
};

// Check SSO callback token
(function checkSSOCallback() {
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token');
  const error = params.get('error');

  if (token) {
    api.setToken(token);
    window.history.replaceState({}, '', window.location.pathname);
  } else if (error) {
    const msg = params.get('msg') || 'QQ登录失败';
    console.error('SSO Login Error:', error, msg);
    // 清除错误参数
    window.history.replaceState({}, '', window.location.pathname);
    // 显示错误提示（如果页面已加载完成）
    if (document.readyState === 'complete') {
      showToast(decodeURIComponent(msg), 'error');
    } else {
      window.addEventListener('DOMContentLoaded', () => {
        showToast(decodeURIComponent(msg), 'error');
      });
    }
  }
})();

// Toast utility
function showToast(msg, type = 'info') {
  let container = document.querySelector('.oc-toast-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'oc-toast-container';
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  toast.className = `oc-toast ${type}`;
  toast.textContent = msg;
  container.appendChild(toast);
  setTimeout(() => { toast.remove(); }, 3000);
}

// Copy to clipboard
function copyText(text) {
  navigator.clipboard.writeText(text).then(() => showToast('已复制', 'success')).catch(() => showToast('复制失败', 'error'));
}

// Format number
function formatNum(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

// Format date
function formatDate(d) {
  if (!d) return '-';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return '-';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(dt).replace(/\//g, '-');
}

// Auth guard
function requireAuth() {
  const token = localStorage.getItem('token') || localStorage.getItem('openclaw_token');
  if (!token) {
    window.location.href = getLoginUrl();
    return false;
  }
  return true;
}
