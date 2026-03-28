const db = require('./src/config/db');

async function testArkSettings() {
  try {
    console.log('=== 测试ARK模型endpoint设置 ===\n');

    // 1. 插入测试设置
    console.log('1. 插入测试设置到数据库...');
    await db.query(
      'INSERT INTO settings (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = ?',
      ['ark_deepseek_endpoint', 'deepseek-v3-2-251201', 'deepseek-v3-2-251201']
    );
    await db.query(
      'INSERT INTO settings (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = ?',
      ['ark_kimi_endpoint', 'moonshot-v1-8k', 'moonshot-v1-8k']
    );
    await db.query(
      'INSERT INTO settings (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = ?',
      ['ark_glm_endpoint', 'glm-4', 'glm-4']
    );
    console.log('✓ 设置已保存\n');

    // 2. 读取设置验证
    console.log('2. 从数据库读取设置...');
    const [rows] = await db.query(
      'SELECT `key`, `value` FROM settings WHERE `key` IN (?, ?, ?)',
      ['ark_deepseek_endpoint', 'ark_kimi_endpoint', 'ark_glm_endpoint']
    );

    console.log('读取到的设置:');
    rows.forEach(row => {
      console.log(`  ${row.key}: ${row.value}`);
    });
    console.log();

    // 3. 测试aiRewrite服务能否正确读取
    console.log('3. 测试aiRewrite服务读取设置...');
    const { rewriteContent, generateTitle } = require('./src/services/aiRewrite');

    // 测试生成标题（使用deepseek）
    const testContent = '人工智能正在改变世界，机器学习技术让计算机能够从数据中学习并做出决策。';
    console.log('测试内容:', testContent);

    try {
      const title = await generateTitle(testContent);
      console.log('✓ 生成标题成功:', title);
    } catch (error) {
      console.log('✗ 生成标题失败:', error.message);
    }

    console.log('\n=== 测试完成 ===');
    process.exit(0);
  } catch (error) {
    console.error('测试失败:', error);
    process.exit(1);
  }
}

testArkSettings();
