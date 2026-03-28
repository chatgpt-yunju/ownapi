const axios = require('axios');

class SSOClient {
  constructor() {
    this.appId = process.env.SSO_APP_ID;
    this.appSecret = process.env.SSO_APP_SECRET;
    this.baseUrl = process.env.SSO_BASE_URL;
    this.redirectUri = process.env.SSO_REDIRECT_URI;
    console.log('SSOClient initialized:', {
      appId: this.appId,
      appSecretLength: this.appSecret?.length,
      baseUrl: this.baseUrl,
      redirectUri: this.redirectUri
    });
  }

  // 生成授权 URL
  getAuthUrl(state = '') {
    const params = new URLSearchParams({
      app_id: this.appId,
      redirect_uri: this.redirectUri,
      state: state
    });
    return `${this.baseUrl}/authorize?${params}`;
  }

  // 用 code 换取 token
  async getToken(code) {
    try {
      const payload = {
        app_id: this.appId,
        app_secret: this.appSecret,
        code: code
      };
      console.log('SSO getToken request:', {
        url: `${this.baseUrl}/token`,
        payload: { ...payload, app_secret: '***' }
      });
      const response = await axios.post(`${this.baseUrl}/token`, payload);
      console.log('SSO getToken success:', response.data);
      return response.data;
    } catch (error) {
      console.error('SSO getToken error:', error.response?.data || error.message);
      console.error('SSO getToken request details:', {
        app_id: this.appId,
        app_secret_length: this.appSecret?.length,
        code: code
      });
      throw new Error(error.response?.data?.message || '获取 token 失败');
    }
  }

  // 获取用户信息
  async getUserInfo(token) {
    try {
      const response = await axios.get(`${this.baseUrl}/userinfo`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      return response.data;
    } catch (error) {
      console.error('SSO getUserInfo error:', error.response?.data || error.message);
      throw new Error(error.response?.data?.message || '获取用户信息失败');
    }
  }

  // 扣除用户积分
  async deductQuota(userId, amount, reason) {
    try {
      const response = await axios.post(`${this.baseUrl}/quota/deduct`, {
        app_id: this.appId,
        app_secret: this.appSecret,
        user_id: userId,
        amount: amount,
        reason: reason
      });
      return response.data;
    } catch (error) {
      console.error('SSO deductQuota error:', error.response?.data || error.message);
      throw new Error(error.response?.data?.message || '扣除积分失败');
    }
  }
}

module.exports = new SSOClient();
