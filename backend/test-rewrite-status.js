const mysql = require('mysql2/promise');
const axios = require('axios');

const db = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'wechat_cms',
  waitForConnections: true,
  connectionLimit: 10
});

async function test() {
  try {
    // Get admin token
    const loginRes = await axios.post('http://localhost:3000/api/auth/login', {
      username: 'admin',
      password: 'admin123'
    });
    const token = loginRes.data.token;
    console.log('✓ Logged in as admin');

    // Create a test post in circle 1 (has AI rewrite enabled with kimi)
    const postData = {
      circle_id: 1,
      content: '这是一个测试帖子。我们正在测试AI改写功能。帖子应该在改写完成前不可见，改写完成后才可见。',
      post_type: 'text'
    };

    console.log('\n创建测试帖子...');
    const createRes = await axios.post('http://localhost:3000/api/planet/posts', postData, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const postId = createRes.data.id;
    console.log(`✓ 帖子已创建，ID: ${postId}`);

    // Check initial status
    const [rows1] = await db.query(
      'SELECT id, title, content, rewrite_status FROM planet_posts WHERE id = ?',
      [postId]
    );
    console.log(`\n初始状态: rewrite_status = '${rows1[0].rewrite_status}'`);
    console.log(`初始内容长度: ${rows1[0].content.length} 字符`);

    // Wait for rewrite to complete
    console.log('\n等待AI改写完成...');
    let completed = false;
    let attempts = 0;
    while (!completed && attempts < 30) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      const [rows2] = await db.query(
        'SELECT rewrite_status, title, content FROM planet_posts WHERE id = ?',
        [postId]
      );
      if (rows2[0].rewrite_status !== 'pending') {
        completed = true;
        console.log(`\n✓ 改写完成！状态: ${rows2[0].rewrite_status}`);
        console.log(`标题: ${rows2[0].title || '(无标题)'}`);
        console.log(`改写后内容长度: ${rows2[0].content.length} 字符`);
        console.log(`\n改写后内容预览:\n${rows2[0].content.substring(0, 200)}...`);

        // Check if model attribution is present
        if (rows2[0].content.includes('技术支持')) {
          console.log('\n✓ 模型标注已添加');
        }
      } else {
        attempts++;
        process.stdout.write('.');
      }
    }

    if (!completed) {
      console.log('\n✗ 改写超时（60秒）');
    }

    // Check if post is visible on frontend (without auth)
    try {
      const frontendRes = await axios.get(`http://localhost:3000/api/planet/posts/${postId}`);
      console.log('\n✓ 帖子在前台可见');
    } catch (err) {
      if (err.response?.status === 403) {
        console.log('\n✗ 帖子在前台不可见（状态可能仍为pending或failed）');
      } else {
        console.log(`\n✗ 前台访问错误: ${err.message}`);
      }
    }

  } catch (error) {
    console.error('测试失败:', error.response?.data || error.message);
  } finally {
    await db.end();
  }
}

test();
