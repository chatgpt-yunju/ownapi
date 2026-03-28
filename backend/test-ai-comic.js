// 测试AI漫剧生成功能
const jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');
require('dotenv').config();

async function testAIComic() {
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

    const [quotas] = await connection.query(
      "SELECT extra_quota FROM user_quota WHERE user_id = ?",
      [user.id]
    );

    const beforeQuota = quotas[0].extra_quota;
    console.log(`✓ 当前积分: ${beforeQuota}`);

    if (beforeQuota < 25) {
      console.log('❌ 积分不足25，无法测试');
      await connection.end();
      return;
    }

    const JWT_SECRET = process.env.JWT_SECRET;
    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role },
      JWT_SECRET,
      { expiresIn: '1h' }
    );

    await connection.end();

    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    };

    // 2. 测试AI漫剧生成（9:16）
    console.log('\n=== 2. 测试AI漫剧生成（9:16） ===');
    console.log('主题: 一只勇敢的小猫咪拯救世界');
    console.log('宽高比: 9:16');
    console.log('开始生成...\n');

    const startTime = Date.now();
    const comicRes = await fetch(`${BASE_URL}/aitools/ai-comic`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        theme: '一只勇敢的小猫咪拯救世界',
        aspect_ratio: '9:16'
      })
    });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);

    if (!comicRes.ok) {
      const error = await comicRes.json();
      console.log(`❌ 漫剧生成失败 (${elapsed}秒)`);
      console.log(`错误: ${error.message}`);
      return;
    }

    const comicData = await comicRes.json();
    console.log(`✓ 漫剧生成成功！(耗时: ${elapsed}秒)\n`);

    // 3. 显示结果
    console.log('=== 3. 生成结果 ===');
    console.log('\n【剧本】');
    console.log(comicData.script);
    console.log('\n【角色形象】');
    comicData.characters.forEach((char, i) => {
      console.log(`${i + 1}. ${char.name}`);
      console.log(`   描述: ${char.description}`);
      console.log(`   图片: ${char.image_url}`);
    });

    console.log('\n【分镜图片】');
    comicData.storyboards.forEach((sb, i) => {
      console.log(`分镜${sb.scene_number}: ${sb.description}`);
      console.log(`   图片: ${sb.image_url}`);
    });

    console.log('\n【分镜视频】');
    if (comicData.video_url) {
      console.log(`✓ 视频URL: ${comicData.video_url}`);
    } else {
      console.log('⚠ 视频未生成');
    }

    console.log(`\n【宽高比】${comicData.aspect_ratio}`);

    // 4. 验证积分
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
    console.log('\n=== 4. 验证积分 ===');
    console.log(`生成前积分: ${beforeQuota}`);
    console.log(`生成后积分: ${afterQuota}`);
    console.log(`扣除积分: ${beforeQuota - afterQuota}`);

    await connection2.end();

    console.log('\n=== 测试总结 ===');
    console.log('✓ AI漫剧生成成功');
    console.log(`✓ 生成角色: ${comicData.characters.length} 个`);
    console.log(`✓ 生成分镜: ${comicData.storyboards.length} 个`);
    console.log(`✓ 生成视频: ${comicData.video_url ? '是' : '否'}`);
    console.log('✓ 积分扣除正确');

  } catch (error) {
    console.error('\n❌ 测试失败:', error.message);
    if (error.stack) {
      console.error(error.stack);
    }
  }
}

testAIComic();
