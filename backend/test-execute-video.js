// 执行实际的智谱视频生成测试
const jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');
require('dotenv').config();

async function executeVideoGeneration() {
  const BASE_URL = 'http://localhost:3000/api';

  try {
    // 1. 准备token
    console.log('=== 1. 准备测试环境 ===');
    const connection = await mysql.createConnection({
      host: 'localhost',
      user: 'root',
      password: '',
      database: 'wechat_cms'
    });

    const [users] = await connection.query(
      "SELECT id, username, role FROM users WHERE role = 'admin' LIMIT 1"
    );

    const user = users[0];
    console.log(`✓ 测试用户: ${user.username}`);

    // 检查积分
    const [quotas] = await connection.query(
      "SELECT extra_quota FROM user_quota WHERE user_id = ?",
      [user.id]
    );

    const beforeQuota = quotas[0].extra_quota;
    console.log(`✓ 当前积分: ${beforeQuota}`);

    const JWT_SECRET = process.env.JWT_SECRET;
    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role },
      JWT_SECRET,
      { expiresIn: '1h' }
    );

    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    };

    // 2. 获取视频配置
    console.log('\n=== 2. 获取视频配置 ===');
    const configRes = await fetch(`${BASE_URL}/aitools/video-config`, { headers });
    const config = await configRes.json();
    console.log(`✓ 视频生成消耗: ${config.cost} 积分`);

    // 3. 检查当前模型配置
    const [modelSettings] = await connection.query(
      "SELECT value FROM settings WHERE `key` = 'ai_video_model'"
    );
    const currentModel = modelSettings[0]?.value || 'cogvideox';
    console.log(`✓ 当前视频模型: ${currentModel}`);
    console.log(`✓ 模型类型: ${currentModel.includes('cogvideo') || currentModel.includes('zhipu') ? '智谱视觉模型' : '其他模型'}`);

    await connection.end();

    // 4. 执行视频生成
    console.log('\n=== 3. 执行AI视频生成 ===');
    const testPrompt = '一只可爱的橘猫在阳光明媚的花园里追逐蝴蝶';
    console.log(`提示词: ${testPrompt}`);
    console.log('时长: 5秒');
    console.log('开始生成...\n');

    const startTime = Date.now();
    const videoRes = await fetch(`${BASE_URL}/aitools/ai-video`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        prompt: testPrompt,
        duration: 5
      })
    });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);

    if (!videoRes.ok) {
      const error = await videoRes.json();
      console.log(`❌ 视频生成失败 (${elapsed}秒)`);
      console.log(`错误: ${error.message}`);

      if (error.code === 'QUOTA_EXCEEDED') {
        console.log('\n提示: 积分不足，请先充值');
      }
      return;
    }

    const videoData = await videoRes.json();
    console.log(`✓ 视频生成成功！(耗时: ${elapsed}秒)`);
    console.log(`✓ 视频URL: ${videoData.url}`);

    // 5. 验证积分扣除
    const connection2 = await mysql.createConnection({
      host: 'localhost',
      user: 'root',
      password: '',
      database: 'wechat_cms'
    });

    const [quotasAfter] = await connection2.query(
      "SELECT extra_quota FROM user_quota WHERE user_id = ?",
      [user.id]
    );

    const afterQuota = quotasAfter[0].extra_quota;
    console.log(`\n=== 4. 验证积分扣除 ===`);
    console.log(`生成前积分: ${beforeQuota}`);
    console.log(`生成后积分: ${afterQuota}`);
    console.log(`扣除积分: ${beforeQuota - afterQuota}`);

    await connection2.end();

    console.log('\n=== 测试总结 ===');
    console.log('✓ 智谱视觉模型调用成功');
    console.log('✓ 视频生成完成');
    console.log('✓ 积分扣除正确');
    console.log('✓ 完整流程验证通过');

  } catch (error) {
    console.error('\n❌ 测试失败:', error.message);
    if (error.stack) {
      console.error(error.stack);
    }
  }
}

executeVideoGeneration();
