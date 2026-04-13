#!/usr/bin/env node
/**
 * 企业微信配置向导
 * 引导用户完成企业微信机器人配置
 */

const readline = require('readline');
const fs = require('fs');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

console.log('\n========================================');
console.log('  企业微信机器人配置向导');
console.log('========================================\n');

console.log('本向导将帮助你完成企业微信机器人配置。');
console.log('');

// 检查是否已有配置
const configPath = './config.json';
let existingConfig = {};
try {
    if (fs.existsSync(configPath)) {
        existingConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
} catch (e) {}

const questions = [
    {
        text: '\n步骤1: 获取企业微信机器人 Key\n\n' +
              '请按照以下步骤操作:\n' +
              '1. 打开企业微信，进入一个群聊\n' +
              '2. 点击右上角 "..." → "群设置" → "群机器人"\n' +
              '3. 点击 "添加机器人" → "新建机器人"\n' +
              '4. 记下 Webhook 地址中 key= 后面的部分\n\n' +
              '例如: https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=693axxx6-7a0c-4xxx-8c03-e7xxxxxxxx19\n' +
              '                                            ^-- 复制这部分 --^\n\n' +
              '请输入你的 Key (或按回车跳过): ',
        key: 'WECHAT_KEY',
        default: existingConfig.WECHAT_KEY || ''
    },
    {
        text: '\n步骤2: 选择推送方式\n\n' +
              '1. 仅企业微信 (推荐)\n' +
              '2. 同时推送到本地服务器和企业微信\n' +
              '3. 仅本地服务器\n\n' +
              '请选择 (1-3) [默认: 1]: ',
        key: 'MODE',
        default: '1'
    }
];

let currentQuestion = 0;
const answers = { ...existingConfig };

function askQuestion() {
    if (currentQuestion >= questions.length) {
        finishConfig();
        return;
    }

    const q = questions[currentQuestion];
    const defaultText = q.default ? ` [默认: ${q.default}]` : '';

    rl.question(q.text.replace('[默认: 1]', defaultText), (answer) => {
        answers[q.key] = answer.trim() || q.default;
        currentQuestion++;
        askQuestion();
    });
}

function finishConfig() {
    console.log('\n========================================');
    console.log('  配置总结');
    console.log('========================================\n');

    // 如果没有提供key，提示使用测试模式
    if (!answers.WECHAT_KEY || answers.WECHAT_KEY.length < 10) {
        console.log('⚠️  未提供企业微信 Key，启用测试模式');
        console.log('   你将只能看到控制台输出，不会收到手机通知\n');
        answers.WECHAT_KEY = 'test-mode';
    } else {
        console.log('✅ Key 已配置: ' + answers.WECHAT_KEY.substring(0, 8) + '...');
    }

    // 保存配置
    fs.writeFileSync(configPath, JSON.stringify(answers, null, 2));
    console.log('✅ 配置已保存到 config.json\n');

    // 根据模式应用配置
    if (answers.MODE === '1' || answers.MODE === '2') {
        applyWechatConfig(answers.WECHAT_KEY);
    }

    console.log('下一步操作:\n');
    console.log('1. 启动推送服务:');
    console.log('   node alert-proxy.js\n');
    console.log('2. 测试推送:');
    console.log('   curl "http://localhost:3004/track?p=test&h=example.com"\n');
    console.log('3. 如果配置了企业微信，你的手机会收到通知\n');

    rl.close();
}

function applyWechatConfig(key) {
    const alertPath = './alert-proxy.js';
    let content = fs.readFileSync(alertPath, 'utf8');

    // 替换 WECHAT_KEY
    content = content.replace(
        /WECHAT_KEY: '[^']*'/,
        `WECHAT_KEY: '${key}'`
    );

    // 如果是测试模式，添加注释
    if (key === 'test-mode') {
        content = content.replace(
            /WECHAT_KEY: 'test-mode'/,
            `WECHAT_KEY: '' // 测试模式 - 未配置企业微信`
        );
    }

    fs.writeFileSync(alertPath, content);
    console.log('✅ alert-proxy.js 已更新\n');
}

// 开始
askQuestion();
