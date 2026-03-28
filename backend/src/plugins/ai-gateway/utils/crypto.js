const crypto = require('crypto');

// 生成 API Key: sk-<48位随机hex>
function generateApiKey() {
  const random = crypto.randomBytes(24).toString('hex');
  return `sk-${random}`;
}

// 哈希 API Key
function hashApiKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

// 生成显示用的脱敏 key: sk-abcd...wxyz
function maskApiKey(key) {
  return `${key.slice(0, 7)}...${key.slice(-4)}`;
}

module.exports = { generateApiKey, hashApiKey, maskApiKey };
