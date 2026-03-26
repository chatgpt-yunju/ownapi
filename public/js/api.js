/* OpenClaw AI - API Client */
const API_BASE = '/api';
const SSO_LOGIN_URL = 'https://yunjunet.cn/login?return_url=' + encodeURIComponent(window.location.origin + '/console.html');

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
      window.location.href = SSO_LOGIN_URL;
      throw new Error('未登录');
    }
    const data = await res.json();
    if (!res.ok) {
      const err = new Error(data.error || data.message || '请求失败');
      if (data.needSetPassword) err.needSetPassword = true;
      throw err;
    }
    return data;
  },

  get(path) { return this.request(path); },
  post(path, body) { return this.request(path, { method: 'POST', body: JSON.stringify(body) }); },
  put(path, body) { return this.request(path, { method: 'PUT', body: JSON.stringify(body) }); },
  del(path) { return this.request(path, { method: 'DELETE' }); },

  // User
  getUserInfo() { return this.get('/user/info'); },
  getBalance() { return this.get('/user/balance'); },

  // API Keys
  getApiKeys() { return this.get('/api-key/list'); },
  createApiKey(name, password) { return this.post('/api-key/create', { name, password }); },
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
  adminUsers(params = {}) {
    const q = new URLSearchParams(params).toString();
    return this.get('/admin/users' + (q ? '?' + q : ''));
  },
  adminCharge(user_id, amount, remark) { return this.post('/admin/charge', { user_id, amount, remark }); },
  adminGetModels() { return this.get('/admin/models'); },
  adminUpdateModel(id, data) { return this.put('/admin/models/' + id, data); },
  adminCreateModel(data) { return this.post('/admin/models', data); },
  adminGetProviders() { return this.get('/admin/providers'); },
  adminCreateProvider(data) { return this.post('/admin/providers', data); },
  adminUpdateProvider(id, data) { return this.put('/admin/providers/' + id, data); },
  adminDeleteProvider(id) { return this.del('/admin/providers/' + id); },
  adminDeleteModel(id) { return this.del('/admin/models/' + id); },
  adminGetUserDetail(userId) { return this.get('/admin/users/' + userId); },
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
  return dt.toLocaleDateString('zh-CN') + ' ' + dt.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

// Auth guard
function requireAuth() {
  const token = localStorage.getItem('token') || localStorage.getItem('openclaw_token');
  if (!token) {
    window.location.href = SSO_LOGIN_URL;
    return false;
  }
  return true;
}
