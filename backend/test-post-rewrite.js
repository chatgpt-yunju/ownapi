require('dotenv').config();
const { rewriteContent, generateTitle } = require('./src/services/aiRewrite');
const mysql = require('mysql2/promise');

async function testPostRewrite() {
  const db = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
  });

  const postId = 24;

  // Get post
  const [posts] = await db.query('SELECT * FROM planet_posts WHERE id = ?', [postId]);
  if (!posts.length) {
    console.log('Post not found');
    return;
  }

  const post = posts[0];
  console.log('Original content:', post.content.substring(0, 100));
  console.log('Original title:', post.title);

  // Rewrite content
  const { content: rewrittenContent, model } = await rewriteContent(post.content, 'rotation');
  console.log('\nRewritten content:', rewrittenContent.substring(0, 150));
  console.log('Model used:', model);

  // Generate title if needed
  let finalTitle = post.title;
  if (!finalTitle || finalTitle === '无标题') {
    finalTitle = await generateTitle(rewrittenContent);
    console.log('\nGenerated title:', finalTitle);
  }

  // Update database
  await db.query('UPDATE planet_posts SET content = ?, title = ? WHERE id = ?',
    [rewrittenContent, finalTitle, postId]);

  console.log('\n✅ Post updated successfully!');
  await db.end();
}

testPostRewrite().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
