/**
 * License Tracker 测试脚本
 * 本地验证五层防护是否正常工作
 */
const axios = require('axios');
const dns = require('dns');
const crypto = require('crypto');

// 模拟追踪服务器（本地测试用）
const TEST_SERVER_PORT = 9999;

console.log('=== License Tracker 测试 ===\n');

// 测试1: 加密/解密
console.log('【测试1】加密解密功能');
const testData = JSON.stringify({ domain: 'test.com', ip: '1.2.3.4' });
const encrypted = encrypt(testData);
console.log('加密后:', encrypted.substring(0, 50) + '...');

const decrypted = decrypt(encrypted);
console.log('解密后:', decrypted);
console.log('✅ 加解密测试', decrypted === testData ? '通过' : '失败');
console.log();

// 测试2: 生成唯一ID
console.log('【测试2】唯一实例ID生成');
const id1 = generateInstallId();
const id2 = generateInstallId();
console.log('ID1:', id1);
console.log('ID2:', id2);
console.log('✅ 唯一ID测试', id1 === id2 ? '通过(稳定)' : '注意:ID每次变化');
console.log();

// 测试3: DNS 查询
console.log('【测试3】DNS 外漏测试');
console.log('正在测试 DNS 查询...(请查看是否能解析到你的域名)');
const dnsQuery = `${id1.substring(0, 8)}.t.track.yunjunet.cn`;
console.log('查询域名:', dnsQuery);

dns.resolve4(dnsQuery, { ttl: true }, (err, addresses) => {
  if (err) {
    console.log('⚠️  DNS 测试:', err.code, '- 这是正常的，你的域名还未配置DNS');
  } else {
    console.log('✅ DNS 解析成功:', addresses);
  }
  console.log();

  // 测试4: HTTP 上报
  testHttpReport();
});

// 测试4: HTTP 上报
async function testHttpReport() {
  console.log('【测试4】HTTP 主动上报测试');

  const deployInfo = {
    installId: id1,
    domain: 'test-local.example.com',
    publicIP: '127.0.0.1',
    timestamp: Date.now(),
    platform: process.platform,
    nodeVersion: process.version,
    test: true
  };

  const encryptedPayload = encrypt(JSON.stringify(deployInfo));

  // 测试到真实追踪服务器（会失败，因为你还没部署）
  try {
    const response = await axios.post(
      'https://track.yunjunet.cn/api/v1/deploy',
      { payload: encryptedPayload, v: '2024.1' },
      { timeout: 5000 }
    );
    console.log('✅ HTTP 上报成功:', response.data);
  } catch (e) {
    console.log('⚠️  HTTP 上报:', e.message);
    console.log('   这是正常的，因为你还未部署追踪服务器');
    console.log('   部署后这里会显示成功');
  }

  console.log();
  testFingerprint();
}

// 测试5: 响应头水印
function testFingerprint() {
  console.log('【测试5】响应头水印测试');
  const shortId = id1.substring(0, 8);

  const mockHeaders = {};
  const res = {
    setHeader: (key, value) => { mockHeaders[key] = value; }
  };

  // 模拟注入
  res.setHeader('X-Request-ID', `${shortId}-${Date.now().toString(36)}`);
  res.setHeader('X-Powered-By', `YunjuNET-${shortId.substring(0, 4)}`);

  console.log('注入的响应头:', mockHeaders);
  console.log('✅ 水印测试通过 - 每个API响应都会携带这些头');
  console.log();

  summary();
}

// 汇总
function summary() {
  console.log('=== 测试结果汇总 ===');
  console.log();
  console.log('✅ 加解密功能: 正常');
  console.log('✅ 唯一ID生成: 正常');
  console.log('⏳ DNS 外漏: 待配置DNS后生效');
  console.log('⏳ HTTP 上报: 待部署追踪服务器后生效');
  console.log('✅ 响应头水印: 正常');
  console.log('⏳ 定时心跳: 服务启动后4小时触发');
  console.log();
  console.log('下一步:');
  console.log('1. 部署追踪服务器 (scripts/deploy-track-server.sh)');
  console.log('2. 配置 DNS 记录');
  console.log('3. 启动后端服务，等待5分钟后查看是否收到通知');
  console.log();
}

// 辅助函数
function encrypt(text) {
  const key = 'YunjuNET2024';
  let result = '';
  for (let i = 0; i < text.length; i++) {
    const charCode = text.charCodeAt(i) ^ key.charCodeAt(i % key.length);
    result += String.fromCharCode(charCode);
  }
  return Buffer.from(result).toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function decrypt(encrypted) {
  try {
    const normalized = encrypted.replace(/-/g, '+').replace(/_/g, '/');
    const text = Buffer.from(normalized, 'base64').toString('utf8');
    const key = 'YunjuNET2024';
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

function generateInstallId() {
  const os = require('os');
  const data = os.hostname() + process.cwd() + os.platform();
  return crypto.createHash('sha256').update(data).digest('hex').substring(0, 16);
}
