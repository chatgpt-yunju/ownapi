#!/usr/bin/env node
/**
 * 最终综合测试脚本
 * 验证整个埋点系统是否正常工作
 */

const http = require('http');
const axios = require('axios');

const TEST_CONFIG = {
    LOCAL_TRACKER: 'http://localhost:3003',
    ALERT_PROXY: 'http://localhost:3004',
    PROJECT_CODE: 'test_final'
};

console.log('\n========================================');
console.log('  埋点系统最终测试');
console.log('========================================\n');

async function testLocalTracker() {
    console.log('[测试1] 本地追踪服务器');
    try {
        const res = await axios.get(`${TEST_CONFIG.LOCAL_TRACKER}/admin`, { timeout: 5000 });
        console.log('  ✓ 本地追踪服务器响应正常');
        console.log(`  ✓ 管理面板可访问: ${TEST_CONFIG.LOCAL_TRACKER}/admin\n`);
        return true;
    } catch (e) {
        console.log('  ✗ 本地追踪服务器未启动');
        console.log(`    请运行: node local-server.js\n`);
        return false;
    }
}

async function testAlertProxy() {
    console.log('[测试2] 企业微信推送服务');
    try {
        // 发送测试上报
        const testData = {
            p: TEST_CONFIG.PROJECT_CODE,
            h: 'test.example.com',
            ua: 'Mozilla/5.0 Test',
            ts: new Date().toISOString()
        };

        const res = await axios.get(`${TEST_CONFIG.ALERT_PROXY}/track`, {
            params: testData,
            timeout: 5000
        });

        if (res.data && res.data.ok) {
            console.log('  ✓ 上报发送成功');
            console.log(`  ✓ 项目: ${testData.p}`);
            console.log(`  ✓ 域名: ${testData.h}\n`);
            return true;
        }
    } catch (e) {
        console.log('  ✗ 推送服务未启动或配置错误');
        console.log(`    错误: ${e.message}\n`);
        return false;
    }
}

async function testEmbeddedBeacons() {
    console.log('[测试3] 已插入的埋点代码');

    const testFiles = [
        '../../test-projects/project-a/src/utils.js',
        '../../test-projects/project-a/src/app.js'
    ];

    const fs = require('fs');
    let found = 0;

    for (const file of testFiles) {
        try {
            const content = fs.readFileSync(file, 'utf8');
            if (content.includes('performance') || content.includes('Image().src') || content.includes('fetch')) {
                console.log(`  ✓ ${file.split('/').pop()} 已包含埋点代码`);
                found++;
            } else {
                console.log(`  ✗ ${file.split('/').pop()} 未找到埋点`);
            }
        } catch (e) {
            console.log(`  ✗ ${file} 不存在`);
        }
    }

    console.log(`\n  结果: ${found}/${testFiles.length} 个文件已插入埋点\n`);
    return found > 0;
}

async function generateSummary() {
    console.log('========================================');
    console.log('  测试完成 - 系统状态');
    console.log('========================================\n');

    console.log('访问地址:');
    console.log(`  追踪面板: ${TEST_CONFIG.LOCAL_TRACKER}/admin`);
    console.log(`  接收端点: ${TEST_CONFIG.ALERT_PROXY}/track\n`);

    console.log('使用流程:');
    console.log('  1. 在真实项目中运行: python batch-inserter.py');
    console.log('  2. 部署项目到服务器');
    console.log('  3. 打开管理面板查看部署列表');
    console.log('  4. 企业微信收到实时通知\n');

    console.log('命令参考:');
    console.log('  启动追踪:  node local-server.js');
    console.log('  启动推送:  node alert-proxy.js');
    console.log('  插入埋点:  python batch-inserter.py');
    console.log('  恢复代码:  python batch-inserter.py --restore\n');
}

async function main() {
    const results = {
        tracker: await testLocalTracker(),
        alert: await testAlertProxy(),
        beacons: await testEmbeddedBeacons()
    };

    await generateSummary();

    // 总体评估
    const allPass = results.tracker && results.alert && results.beacons;

    if (allPass) {
        console.log('✅ 所有测试通过！系统已就绪\n');
        process.exit(0);
    } else {
        console.log('⚠️  部分测试未通过，请检查上述错误\n');
        process.exit(1);
    }
}

main().catch(console.error);
