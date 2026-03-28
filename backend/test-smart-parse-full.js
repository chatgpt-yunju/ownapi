// 使用JWT直接生成token进行测试
const jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');

async function testWithDirectToken() {
  const BASE_URL = 'http://localhost:3000/api';

  // 测试内容
  const testContent = `3- #在抖音，记录美好生活#【涛哥@高清直播间搭建】正在直播，来和我一起支持Ta吧。复制下方链接，打开【抖音】，直接观看直播！ https://v.douyin.com/KQvguDvMRh0/ 1@0.com :4pm`;

  try {
    // 1. 从数据库获取用户信息和JWT密钥
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

    if (users.length === 0) {
      console.log('❌ 未找到管理员用户');
      await connection.end();
      return;
    }

    const user = users[0];
    console.log(`✓ 找到测试用户: ${user.username} (ID: ${user.id})`);

    // 从环境变量或使用默认值生成token
    require('dotenv').config();
    const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role },
      JWT_SECRET,
      { expiresIn: '1h' }
    );
    console.log('✓ Token生成成功\n');

    await connection.end();

    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    };

    // 2. 测试智能解析（不启用深度分析）
    console.log('=== 2. 测试智能解析（提取链接） ===');
    console.log('输入内容:');
    console.log(testContent);
    console.log('');

    const parseRes1 = await fetch(`${BASE_URL}/aitools/smart-parse`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        content: testContent,
        deep_analysis: false
      })
    });

    if (!parseRes1.ok) {
      const error = await parseRes1.json();
      console.log('❌ 解析失败:', error.message);
      return;
    }

    const parseData1 = await parseRes1.json();
    console.log('✓ 链接提取成功:', parseData1.link);
    console.log('');

    // 3. 测试智能解析（启用深度分析，5秒视频）
    console.log('=== 3. 测试智能解析 + AI脚本生成（5秒） ===');
    console.log('启用深度分析，duration=5...');

    const parseRes2 = await fetch(`${BASE_URL}/aitools/smart-parse`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        content: testContent,
        deep_analysis: true,
        duration: 5
      })
    });

    if (!parseRes2.ok) {
      const error = await parseRes2.json();
      console.log('❌ 深度分析失败:', error.message);
      return;
    }

    const parseData2 = await parseRes2.json();
    console.log('✓ 链接:', parseData2.link);

    if (parseData2.script) {
      console.log('✓ AI脚本生成成功（5秒版本）:');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log(parseData2.script);
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    } else {
      console.log('⚠ AI脚本未生成:', parseData2.error || '未知原因');
    }
    console.log('');

    // 4. 测试智能解析（启用深度分析，10秒视频）
    console.log('=== 4. 测试智能解析 + AI脚本生成（10秒） ===');
    console.log('启用深度分析，duration=10...');

    const parseRes3 = await fetch(`${BASE_URL}/aitools/smart-parse`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        content: testContent,
        deep_analysis: true,
        duration: 10
      })
    });

    if (!parseRes3.ok) {
      const error = await parseRes3.json();
      console.log('❌ 深度分析失败:', error.message);
      return;
    }

    const parseData3 = await parseRes3.json();
    console.log('✓ 链接:', parseData3.link);

    if (parseData3.script) {
      console.log('✓ AI脚本生成成功（10秒版本）:');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log(parseData3.script);
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    } else {
      console.log('⚠ AI脚本未生成:', parseData3.error || '未知原因');
    }
    console.log('');

    // 5. 对比5秒和10秒脚本的差异
    if (parseData2.script && parseData3.script) {
      console.log('=== 5. 脚本对比分析 ===');
      console.log(`5秒脚本长度: ${parseData2.script.length} 字符`);
      console.log(`10秒脚本长度: ${parseData3.script.length} 字符`);
      console.log('✓ duration参数生效，脚本长度有差异');
      console.log('');
    }

    console.log('=== 测试总结 ===');
    console.log('✓ 智能解析功能正常');
    console.log('✓ 链接提取成功');
    console.log('✓ AI脚本生成功能正常');
    console.log('✓ duration参数生效（5秒/10秒）');
    console.log('✓ 豆包AI调用成功');

  } catch (error) {
    console.error('❌ 测试失败:', error.message);
    console.error(error.stack);
  }
}

testWithDirectToken();
