const mysql = require('mysql2/promise');

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
    // Get a user ID to use for the test
    const [[user]] = await db.query('SELECT id FROM users LIMIT 1');
    if (!user) {
      console.log('✗ 没有找到用户');
      return;
    }

    // Insert a test post directly with pending status
    const testContent = '这是一个测试帖子。我们正在测试AI改写功能。帖子应该在改写完成前不可见，改写完成后才可见。这个内容需要足够长以便AI进行改写。';

    const [result] = await db.query(
      `INSERT INTO planet_posts (circle_id, user_id, title, content, post_type, review_status, rewrite_status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
      [1, user.id, '', testContent, 'text', 'approved', 'pending']
    );

    const postId = result.insertId;
    console.log(`✓ 测试帖子已创建，ID: ${postId}`);
    console.log(`  初始状态: rewrite_status = 'pending'`);
    console.log(`  初始内容: ${testContent.substring(0, 50)}...`);

    // Simulate what the API does - trigger async rewrite
    const [[circle]] = await db.query(
      'SELECT ai_rewrite_enabled, ai_rewrite_model FROM planet_circles WHERE id = ?',
      [1]
    );
    console.log(`\n圈子设置: ai_rewrite_enabled=${circle.ai_rewrite_enabled}, model=${circle.ai_rewrite_model}`);

    // Now manually trigger the rewrite by calling the service
    const { rewriteContent } = require('./src/services/aiRewrite');

    console.log('\n开始AI改写...');
    try {
      const { content: rewrittenContent, model } = await rewriteContent(testContent, circle.ai_rewrite_model);

      // Generate title if needed
      let finalTitle = null;
      if (!finalTitle) {
        const { generateTitle } = require('./src/services/aiRewrite');
        finalTitle = await generateTitle(rewrittenContent);
      }

      // Update the post
      await db.query(
        'UPDATE planet_posts SET content = ?, title = ?, rewrite_status = ? WHERE id = ?',
        [rewrittenContent, finalTitle, 'completed', postId]
      );

      console.log(`✓ 改写完成！`);
      console.log(`  状态: rewrite_status = 'completed'`);
      console.log(`  标题: ${finalTitle}`);
      console.log(`  改写后内容长度: ${rewrittenContent.length} 字符`);
      console.log(`\n改写后内容:\n${rewrittenContent}`);

      // Check if model attribution is present
      if (rewrittenContent.includes('技术支持')) {
        console.log('\n✓ 模型标注已添加');
      } else {
        console.log('\n✗ 模型标注未找到');
      }

    } catch (error) {
      console.error('✗ 改写失败:', error.message);
      await db.query(
        'UPDATE planet_posts SET rewrite_status = ? WHERE id = ?',
        ['failed', postId]
      );
    }

    // Check final status
    const [[finalPost]] = await db.query(
      'SELECT id, title, content, rewrite_status FROM planet_posts WHERE id = ?',
      [postId]
    );
    console.log(`\n最终状态: ${finalPost.rewrite_status}`);

  } catch (error) {
    console.error('测试失败:', error.message);
    console.error(error.stack);
  } finally {
    await db.end();
  }
}

test();
