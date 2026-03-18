#!/usr/bin/env node

const jwt = require('jsonwebtoken');
const axios = require('axios');

// 生成测试 token（模拟主站 SSO）
const JWT_SECRET = 'afa5469ba65ffa2f257b0456d7ae288fd8e0329008c5968ca3f08e553c315da0'; // 与主站一致
const testUser = {
  id: 1,
  username: 'admin',
  role: 'admin'
};

const token = jwt.sign(testUser, JWT_SECRET, { expiresIn: '1h' });
console.log('Generated test token:', token.substring(0, 20) + '...\n');

const BASE_URL = 'http://localhost:3021';
const headers = {
  'Authorization': `Bearer ${token}`,
  'Content-Type': 'application/json'
};

async function testAPIs() {
  console.log('========================================');
  console.log('OpenClaw 控制台 API 测试');
  console.log('========================================\n');

  try {
    // 测试 1: 统计接口
    console.log('测试 1: GET /api/logs/statistics');
    console.log('-----------------------------------');
    const stats = await axios.get(`${BASE_URL}/api/logs/statistics`, { headers });
    console.log('响应:', JSON.stringify(stats.data, null, 2));
    console.log('');

    // 测试 2: 邀请码接口
    console.log('测试 2: GET /api/user-extend/invite');
    console.log('-----------------------------------');
    const inviteCode = await axios.get(`${BASE_URL}/api/user-extend/invite`, { headers });
    console.log('响应:', JSON.stringify(inviteCode.data, null, 2));
    console.log('');

    // 测试 3: 奖励记录接口
    console.log('测试 3: GET /api/user-extend/rewards');
    console.log('-----------------------------------');
    const rewards = await axios.get(`${BASE_URL}/api/user-extend/rewards`, { headers });
    console.log('响应:', JSON.stringify(rewards.data, null, 2));
    console.log('');

    // 测试 4: 通知接口
    console.log('测试 4: GET /api/user-extend/notifications');
    console.log('-----------------------------------');
    const notifications = await axios.get(`${BASE_URL}/api/user-extend/notifications`, { headers });
    console.log('响应:', JSON.stringify(notifications.data, null, 2));
    console.log('');

    console.log('========================================');
    console.log('所有测试完成！');
    console.log('========================================');

  } catch (error) {
    console.error('错误:', error.response?.data || error.message);
    console.error('状态码:', error.response?.status);
  }
}

testAPIs();
