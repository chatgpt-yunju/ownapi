#!/usr/bin/env node
/**
 * 企业微信机器人一键配置脚本
 *
 * 用法：
 *   node setup-wechat.js YOUR_KEY
 *
 * 示例：
 *   node setup-wechat.js 693a91f6-7a0c-4bd8-8c03-e7c74d1f319d
 */

const fs = require('fs');
const path = require('path');

const KEY = process.argv[2];

if (!KEY || KEY.length < 10) {
    console.log('\n❌ 请提供企业微信机器人 key');
    console.log('\n用法：');
    console.log('  node setup-wechat.js YOUR_KEY\n');
    console.log('示例：');
    console.log('  node setup-wechat.js 693a91f6-7a0c-4bd8-8c03-e7c74d1f319d\n');
    console.log('如何获取 key？');
    console.log('  1. 企业微信群 → 设置 → 添加机器人');
    console.log('  2. 复制 Webhook 地址中的 key= 后面的部分\n');
    process.exit(1);
}

const CONFIG = {
    WECHAT_KEY: KEY,
    PORT: 3004
};

console.log('\n========================================');
console.log('  企业微信机器人配置');
console.log('========================================\n');

// 1. 修改 alert-proxy.js
const alertProxyPath = path.join(__dirname, 'alert-proxy.js');
let alertContent = fs.readFileSync(alertProxyPath, 'utf8');

// 替换 WECHAT_KEY
alertContent = alertContent.replace(
    /WECHAT_KEY: '[^']*'/,
    `WECHAT_KEY: '${KEY}'`
);

// 替换端口
alertContent = alertContent.replace(
    /PORT: process\.env\.PORT \|\| 3003/,
    `PORT: process.env.PORT || ${CONFIG.PORT}`
);

fs.writeFileSync(alertProxyPath, alertContent);
console.log('✅ alert-proxy.js 已配置');

// 2. 修改 browser-beacon.js
const beaconPath = path.join(__dirname, 'browser-beacon.js');
let beaconContent = fs.readFileSync(beaconPath, 'utf8');

// 添加企业微信上报的选项
const wechatBeacon = `
// 方案4: 企业微信推送（推荐）
// new Image().src = 'http://localhost:${CONFIG.PORT}/track?' +
//   new URLSearchParams(data).toString();`;

// 在 CONFIG 后面添加注释
beaconContent = beaconContent.replace(
    '// 加密数据',
    wechatBeacon + '\n\n// 加密数据'
);

// 修改默认 webhook 地址为 alert-proxy
beaconContent = beaconContent.replace(
    /WEBHOOK_URL: 'http:\/\/localhost:3003\/track'/,
    `WEBHOOK_URL: 'http://localhost:${CONFIG.PORT}/track'`
);

fs.writeFileSync(beaconPath, beaconContent);
console.log('✅ browser-beacon.js 已配置');

// 3. 修改 batch-inserter.py
const batchPath = path.join(__dirname, 'batch-inserter.py');
let batchContent = fs.readFileSync(batchPath, 'utf8');

batchContent = batchContent.replace(
    /WEBHOOK_URL = 'http:\/\/localhost:3003\/track'/,
    `WEBHOOK_URL = 'http://localhost:${CONFIG.PORT}/track'`
);

fs.writeFileSync(batchPath, batchContent);
console.log('✅ batch-inserter.py 已配置');

// 4. 保存配置到文件
const configPath = path.join(__dirname, 'config.json');
fs.writeFileSync(configPath, JSON.stringify(CONFIG, null, 2));
console.log('✅ 配置已保存到 config.json\n');

// 5. 生成启动脚本
const startScript = `@echo off
echo 启动企业微信推送服务...
node alert-proxy.js
pause`;

fs.writeFileSync(path.join(__dirname, 'start-wechat.bat'), startScript);
console.log('✅ 启动脚本已生成: start-wechat.bat\n');

// 完成
console.log('========================================');
console.log('  配置完成！');
console.log('========================================\n');

console.log('下一步：\n');
console.log('1. 启动推送服务：');
console.log('   node alert-proxy.js');
console.log('   或双击 start-wechat.bat\n');

console.log('2. 测试推送：');
console.log('   curl "http://localhost:' + CONFIG.PORT + '/track?p=shop_vip&h=example.com"\n');

console.log('3. 为项目插入埋点：');
console.log('   python batch-inserter.js\n');

console.log('4. 部署后看手机会收到：');
console.log('   【部署告警】shop_vip 被部署到 xxx.com\n');

console.log('配置详情：');
console.log('  Key:      ' + KEY.substring(0, 8) + '...');
console.log('  Port:     ' + CONFIG.PORT);
console.log('  Endpoint: http://localhost:' + CONFIG.PORT + '/track\n');
