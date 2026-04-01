const router = require('express').Router();
const db = require('../config/db');
const { getChinaDateString } = require('../utils/chinaTime');
const { auth, optionalAuth } = require('../middleware/auth');
const { requireAdmin } = require('../middleware/auth');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || 'uploads');
const { ensureQuota, addQuotaLog, getSetting } = require('./quota');
const upload = require('../middleware/upload');
const { rewriteContent, generateTitle } = require('../services/aiRewrite');
const arkRateLimiter = require('../utils/arkRateLimiter');

const DOUBAO_API_KEY = process.env.DOUBAO_API_KEY;
const DOUBAO_TEXT_MODEL = process.env.DOUBAO_TEXT_MODEL || 'doubao-seed-2-0-code-preview-260215';

// AI生成昵称函数（通过网关）
async function generateNickname() {
  try {
    const { callAI: gwCallAI } = require('../utils/aiGateway');
    const nickname = await gwCallAI('生成一个有创意的中文昵称，2-4个字，要求：1.富有诗意或趣味性 2.不要使用常见名字 3.只返回昵称本身，不要其他内容', { tier: 'simple' });
    return nickname?.trim() || `用户${Date.now().toString().slice(-6)}`;
  } catch (error) {
    console.error('AI生成昵称失败:', error.message);
    return `用户${Date.now().toString().slice(-6)}`;
  }
}

// 运行时数据库迁移
(async () => {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS planet_circles (
        id INT PRIMARY KEY AUTO_INCREMENT,
        name VARCHAR(100) NOT NULL UNIQUE,
        description TEXT,
        cover_image VARCHAR(255),
        creator_id INT NOT NULL,
        member_count INT DEFAULT 0,
        post_count INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (creator_id) REFERENCES users(id)
      )
    `).catch(() => {});

    await db.query(`
      CREATE TABLE IF NOT EXISTS planet_members (
        id INT PRIMARY KEY AUTO_INCREMENT,
        circle_id INT NOT NULL,
        user_id INT NOT NULL,
        joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY (circle_id, user_id),
        FOREIGN KEY (circle_id) REFERENCES planet_circles(id),
        FOREIGN KEY (user_id) REFERENCES users(id)
      )
    `).catch(() => {});

    await db.query(`
      CREATE TABLE IF NOT EXISTS planet_posts (
        id INT PRIMARY KEY AUTO_INCREMENT,
        circle_id INT NOT NULL,
        user_id INT NOT NULL,
        post_type ENUM('text', 'image', 'video', 'link') DEFAULT 'text',
        title VARCHAR(200) NOT NULL,
        content TEXT NOT NULL,
        images TEXT,
        video_url VARCHAR(500),
        link_url VARCHAR(500),
        link_title VARCHAR(200),
        link_cover VARCHAR(500),
        view_count INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (circle_id) REFERENCES planet_circles(id),
        FOREIGN KEY (user_id) REFERENCES users(id)
      )
    `).catch(() => {});

    await db.query(`
      CREATE TABLE IF NOT EXISTS planet_post_views (
        id INT PRIMARY KEY AUTO_INCREMENT,
        post_id INT NOT NULL,
        user_id INT NOT NULL,
        viewed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY (post_id, user_id),
        FOREIGN KEY (post_id) REFERENCES planet_posts(id),
        FOREIGN KEY (user_id) REFERENCES users(id)
      )
    `).catch(() => {});

    // 游客浏览记录表（按 IP 和日期追踪）
    await db.query(`
      CREATE TABLE IF NOT EXISTS planet_guest_views (
        id INT PRIMARY KEY AUTO_INCREMENT,
        ip_address VARCHAR(45) NOT NULL,
        post_id INT NOT NULL,
        view_date DATE NOT NULL,
        viewed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY (ip_address, post_id, view_date),
        INDEX idx_ip_date (ip_address, view_date)
      )
    `).catch(() => {});

    // 添加帖子审核状态字段
    await db.query(`
      ALTER TABLE planet_posts ADD COLUMN review_status ENUM('pending', 'approved', 'rejected') DEFAULT 'approved'
    `).catch(() => {});

    // 添加用户设置字段
    await db.query(`
      ALTER TABLE users ADD COLUMN planet_auto_view BOOLEAN DEFAULT FALSE
    `).catch(() => {});

    // 添加AI重写字段
    await db.query(`
      ALTER TABLE planet_circles ADD COLUMN ai_rewrite_enabled BOOLEAN DEFAULT FALSE
    `).catch(() => {});
    await db.query(`
      ALTER TABLE planet_circles ADD COLUMN ai_rewrite_model VARCHAR(20) DEFAULT 'kimi'
    `).catch(() => {});

    // 添加帖子AI改写状态字段
    await db.query(`
      ALTER TABLE planet_posts ADD COLUMN rewrite_status ENUM('pending', 'completed', 'failed') DEFAULT 'completed'
    `).catch(() => {});

    // 添加配置项
    await db.query(`INSERT IGNORE INTO settings (\`key\`, \`value\`) VALUES ('planet_post_reward', '5')`).catch(() => {});
    await db.query(`INSERT IGNORE INTO settings (\`key\`, \`value\`) VALUES ('planet_view_cost', '1')`).catch(() => {});
    await db.query(`INSERT IGNORE INTO settings (\`key\`, \`value\`) VALUES ('planet_polish_cost', '1')`).catch(() => {});

    // 添加圈子权限字段
    await db.query(`
      ALTER TABLE planet_circles
      ADD COLUMN permission_level ENUM('public', 'registered', 'vip') DEFAULT 'public'
      COMMENT '圈子权限：public=游客可见，registered=注册用户可见，vip=VIP可见'
    `).catch(() => {});

    // 迁移权限字段：vip → admin_only，更新ENUM
    await db.query(`UPDATE planet_circles SET permission_level = 'public' WHERE permission_level = 'vip'`).catch(() => {});
    await db.query(`
      ALTER TABLE planet_circles
      MODIFY COLUMN permission_level ENUM('public', 'registered', 'admin_only') DEFAULT 'public'
      COMMENT '圈子权限：public=游客可见浏览量，registered=注册用户可见浏览量，admin_only=仅管理员和创建者可见'
    `).catch(() => {});

    // 拆分权限字段：查看文章详情权限 & 查看文章浏览量权限
    await db.query(`
      ALTER TABLE planet_circles
      ADD COLUMN view_detail_permission ENUM('public', 'registered', 'vip') DEFAULT 'public'
      COMMENT '查看文章详情权限'
    `).catch(() => {});
    await db.query(`
      ALTER TABLE planet_circles
      ADD COLUMN view_count_permission ENUM('public', 'registered', 'admin_only') DEFAULT 'public'
      COMMENT '查看文章浏览量权限'
    `).catch(() => {});
    // 迁移旧 permission_level → view_detail_permission（仅初始迁移：当 view_detail_permission 仍为默认 public 时同步）
    await db.query(`
      UPDATE planet_circles SET view_detail_permission = permission_level WHERE view_detail_permission = 'public' AND permission_level != 'public'
    `).catch(() => {});
    // 将 view_detail_permission 的 admin_only 值迁移为 vip，并更新 ENUM
    await db.query(`UPDATE planet_circles SET view_detail_permission = 'public' WHERE view_detail_permission = 'admin_only'`).catch(() => {});
    await db.query(`
      ALTER TABLE planet_circles
      MODIFY COLUMN view_detail_permission ENUM('public', 'registered', 'vip') DEFAULT 'public'
      COMMENT '查看文章详情权限：public=游客，registered=注册用户，vip=VIP用户和创建者'
    `).catch(() => {});
  } catch (e) {
    console.error('Planet migration error:', e.message);
  }
})();

// POST /api/planet/circles - 创建圈子
router.post('/circles', auth, async (req, res) => {
  const { name, description, cover_image } = req.body;

  if (!name || name.trim().length === 0) {
    return res.status(400).json({ message: '圈子名称不能为空' });
  }

  try {
    const [result] = await db.query(
      'INSERT INTO planet_circles (name, description, cover_image, creator_id) VALUES (?, ?, ?, ?)',
      [name.trim(), description || '', cover_image || '', req.user.id]
    );

    // 创建者自动加入圈子
    await db.query(
      'INSERT INTO planet_members (circle_id, user_id) VALUES (?, ?)',
      [result.insertId, req.user.id]
    );

    await db.query('UPDATE planet_circles SET member_count = 1 WHERE id = ?', [result.insertId]);

    res.json({ id: result.insertId, message: '圈子创建成功' });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ message: '圈子名称已存在' });
    }
    throw e;
  }
});

// GET /api/planet/circles - 获取圈子列表（游客可查看）
router.get('/circles', optionalAuth, async (req, res) => {
  const userId = req.user?.id || null;
  const [circles] = await db.query(`
    SELECT c.*, u.username as creator_name,
      ${userId ? `EXISTS(SELECT 1 FROM planet_members WHERE circle_id = c.id AND user_id = ?)` : 'false'} as is_member
    FROM planet_circles c
    LEFT JOIN users u ON c.creator_id = u.id
    ORDER BY c.created_at DESC
  `, userId ? [userId] : []);

  res.json(circles);
});

// GET /api/planet/circles/:id - 获取圈子详情（游客可查看）
router.get('/circles/:id', optionalAuth, async (req, res) => {
  const userId = req.user?.id || null;
  const [[circle]] = await db.query(`
    SELECT c.*, u.username as creator_name,
      ${userId ? `EXISTS(SELECT 1 FROM planet_members WHERE circle_id = c.id AND user_id = ?)` : 'false'} as is_member
    FROM planet_circles c
    LEFT JOIN users u ON c.creator_id = u.id
    WHERE c.id = ?
  `, userId ? [userId, req.params.id] : [req.params.id]);

  if (!circle) {
    return res.status(404).json({ message: '圈子不存在' });
  }

  res.json(circle);
});

// POST /api/planet/circles/:id/join - 加入圈子
router.post('/circles/:id/join', auth, async (req, res) => {
  const circleId = req.params.id;

  const [[circle]] = await db.query('SELECT id FROM planet_circles WHERE id = ?', [circleId]);
  if (!circle) {
    return res.status(404).json({ message: '圈子不存在' });
  }

  try {
    await db.query('INSERT INTO planet_members (circle_id, user_id) VALUES (?, ?)', [circleId, req.user.id]);
    await db.query('UPDATE planet_circles SET member_count = member_count + 1 WHERE id = ?', [circleId]);
    res.json({ message: '加入成功' });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ message: '已经是圈子成员' });
    }
    throw e;
  }
});

// POST /api/planet/circles/:id/leave - 退出圈子
router.post('/circles/:id/leave', auth, async (req, res) => {
  const circleId = req.params.id;

  const [result] = await db.query('DELETE FROM planet_members WHERE circle_id = ? AND user_id = ?', [circleId, req.user.id]);

  if (result.affectedRows === 0) {
    return res.status(400).json({ message: '不是圈子成员' });
  }

  await db.query('UPDATE planet_circles SET member_count = GREATEST(0, member_count - 1) WHERE id = ?', [circleId]);
  res.json({ message: '退出成功' });
});

// POST /api/planet/upload - 上传图片或视频
router.post('/upload', auth, upload.fields([
  { name: 'images', maxCount: 9 },
  { name: 'video', maxCount: 1 }
]), (req, res) => {
  const result = {};
  if (req.files?.images) {
    result.images = req.files.images.map(f => {
      const sub = f.mimetype.startsWith('video/') ? 'videos' : 'images';
      return `/uploads/${sub}/${f.filename}`;
    });
  }
  if (req.files?.video) {
    result.video_url = `/uploads/videos/${req.files.video[0].filename}`;
  }
  res.json(result);
});

// POST /api/planet/posts - 发帖（奖励积分）
router.post('/posts', auth, async (req, res) => {
  const { circle_id, post_type, title, content, images, video_url, link_url, link_title, link_cover, author_username } = req.body;

  if (!circle_id || !content) {
    return res.status(400).json({ message: '圈子ID和内容不能为空' });
  }

  // 检查是否是圈子成员
  const [[member]] = await db.query('SELECT id FROM planet_members WHERE circle_id = ? AND user_id = ?', [circle_id, req.user.id]);
  if (!member) {
    return res.status(403).json({ message: '必须是圈子成员才能发帖' });
  }

  // 确定帖子作者
  let post_user_id = req.user.id;
  let newRandomUserId = null; // 记录新建随机用户ID，用于异步生成昵称

  // 如果是管理员且指定了作者用户名
  if (req.user.role === 'admin' && author_username && author_username.trim()) {
    const [[targetUser]] = await db.query('SELECT id FROM users WHERE username = ?', [author_username.trim()]);
    if (!targetUser) {
      return res.status(404).json({ message: '指定的作者用户不存在' });
    }
    post_user_id = targetUser.id;
  }
  // 如果是管理员但未指定作者，立即创建随机用户（临时昵称），AI昵称异步生成
  else if (req.user.role === 'admin' && (!author_username || !author_username.trim())) {
    try {
      const tempNickname = `用户${Date.now().toString().slice(-6)}`;
      const randomUsername = 'user_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
      const randomPassword = Math.random().toString(36).substring(2, 15);
      const hashedPassword = await bcrypt.hash(randomPassword, 10);

      const [userResult] = await db.query(
        'INSERT INTO users (username, password, nickname, role) VALUES (?, ?, ?, ?)',
        [randomUsername, hashedPassword, tempNickname, 'user']
      );
      post_user_id = userResult.insertId;
      newRandomUserId = post_user_id;

      // 初始化新用户的积分
      await ensureQuota(post_user_id);
    } catch (error) {
      console.error('创建随机用户失败:', error);
      return res.status(500).json({ message: '创建作者失败' });
    }
  }

  // 检查圈子是否启用AI重写
  const [[circle]] = await db.query('SELECT ai_rewrite_enabled, ai_rewrite_model FROM planet_circles WHERE id = ?', [circle_id]);
  const needRewrite = circle?.ai_rewrite_enabled && circle.ai_rewrite_model;
  const needTitleGen = !title || !title.trim() || title.trim() === '无标题';
  // 只要需要改写、生成标题或更新AI昵称，均进入pending异步流程
  const needAsync = needRewrite || needTitleGen || !!newRandomUserId;

  // 服务端自动检测：文字帖含链接时自动转为链接帖
  let detectedPostType = post_type || 'text';
  let detectedLinkUrl = link_url || null;
  if (detectedPostType === 'text' && content) {
    const urlMatch = content.match(/https?:\/\/[^\s\u4e00-\u9fa5，。！？、；：""''（）【】《》]+/);
    if (urlMatch) {
      detectedPostType = 'link';
      if (!detectedLinkUrl) detectedLinkUrl = urlMatch[0].replace(/[.,;!?）】》]+$/, '');
      console.log(`[planet] 文字帖含链接，自动转为链接帖: ${detectedLinkUrl}`);
    }
  }

  // 保存帖子，如果需要异步处理则状态为pending
  const [result] = await db.query(
    `INSERT INTO planet_posts (circle_id, user_id, post_type, title, content, images, video_url, link_url, link_title, link_cover, rewrite_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [circle_id, post_user_id, detectedPostType, title?.trim() || '无标题', content,
     images ? JSON.stringify(images) : null, video_url || null, detectedLinkUrl, link_title || null, link_cover || null,
     needAsync ? 'pending' : 'completed']
  );

  const postId = result.insertId;

  // 更新圈子帖子数
  await db.query('UPDATE planet_circles SET post_count = post_count + 1 WHERE id = ?', [circle_id]);

  // 奖励积分
  const reward = parseInt(await getSetting('planet_post_reward')) || 5;
  await ensureQuota(req.user.id);
  await db.query('UPDATE user_quota SET extra_quota = extra_quota + ? WHERE user_id = ?', [reward, req.user.id]);
  await addQuotaLog(req.user.id, reward, `发帖奖励（帖子ID: ${postId}）`);

  // 立即返回成功
  res.json({ id: postId, message: '发帖成功', reward, rewrite_status: needAsync ? 'pending' : 'completed' });

  // 如果不需要异步处理，直接返回
  if (!needAsync) {
    return;
  }

  // 异步处理：AI改写内容 + 服务端生成标题
  (async () => {
    try {
      let finalContent = content;
      let finalTitle = title?.trim() || '无标题';
      let rewriteSuccess = false;

      // AI改写内容（圈子启用时）
      if (needRewrite) {
        try {
          const { content: rewrittenContent, model } = await rewriteContent(content, circle.ai_rewrite_model);
          finalContent = rewrittenContent;
          rewriteSuccess = true;
          console.log(`[planet] 帖子${postId}内容已用${model}改写`);
        } catch (error) {
          console.error(`[planet] 帖子${postId} AI改写失败:`, error.message);
          // 改写失败，使用原内容
        }
      }

      // 服务端自动生成标题（标题为空时始终执行）
      if (needTitleGen) {
        try {
          const generatedTitle = await generateTitle(finalContent);
          finalTitle = generatedTitle;
          console.log(`[planet] 帖子${postId}标题已生成: ${generatedTitle}`);
        } catch (error) {
          console.error(`[planet] 帖子${postId} 生成标题失败:`, error.message);
        }
      }

      // 服务端异步更新随机用户的AI昵称
      if (newRandomUserId) {
        try {
          const aiNickname = await generateNickname();
          await db.query('UPDATE users SET nickname = ? WHERE id = ?', [aiNickname, newRandomUserId]);
          console.log(`[planet] 随机用户${newRandomUserId}昵称已更新: ${aiNickname}`);
        } catch (error) {
          console.error(`[planet] 随机用户${newRandomUserId}昵称更新失败:`, error.message);
        }
      }

      // 更新帖子内容和状态
      // 若只需生成标题（无改写），状态直接completed；若需改写，按改写结果决定
      const finalStatus = needRewrite ? (rewriteSuccess ? 'completed' : 'failed') : 'completed';
      await db.query(
        'UPDATE planet_posts SET content = ?, title = ?, rewrite_status = ? WHERE id = ?',
        [finalContent, finalTitle, finalStatus, postId]
      );
      console.log(`[planet] 帖子${postId}已更新，状态: ${finalStatus}`);
    } catch (error) {
      console.error(`[planet] 帖子${postId}异步处理失败:`, error.message);
      await db.query('UPDATE planet_posts SET rewrite_status = ? WHERE id = ?', ['failed', postId]);
    }
  })();
});

// GET /api/planet/posts - 获取帖子列表（游客可查看已审核且改写完成的帖子）
router.get('/posts', optionalAuth, async (req, res) => {
  const { circle_id } = req.query;
  const userId = req.user?.id || null;
  const isAdmin = req.user?.role === 'admin';
  let query = `
    SELECT p.*, COALESCE(u.nickname, u.username) as author_name, c.name as circle_name,
      c.view_detail_permission as circle_detail_permission, c.view_count_permission as circle_count_permission,
      c.creator_id as circle_creator_id,
      ${userId ? `EXISTS(SELECT 1 FROM planet_post_views WHERE post_id = p.id AND user_id = ?)` : 'false'} as has_viewed
    FROM planet_posts p
    LEFT JOIN users u ON p.user_id = u.id
    LEFT JOIN planet_circles c ON p.circle_id = c.id
    WHERE p.review_status = 'approved' AND p.rewrite_status = 'completed'
  `;
  const params = userId ? [userId] : [];

  // 广场展示所有圈子文章（不过滤权限），仅在详情页检查权限

  if (circle_id) {
    query += ' AND p.circle_id = ?';
    params.push(circle_id);
  }

  query += ' ORDER BY p.created_at DESC';

  const [posts] = await db.query(query, params);

  // 解析 images 字段 & 按权限屏蔽 view_count & 截取前20%内容作为预览
  posts.forEach(post => {
    if (post.images) {
      try {
        post.images = JSON.parse(post.images);
      } catch (e) {
        post.images = [];
      }
    }
    // 若用户无查看浏览量权限，则隐藏 view_count
    const cp = post.circle_count_permission;
    const isCreator = post.circle_creator_id === userId;
    const canSeeCount = isAdmin || isCreator
      || cp === 'public'
      || (cp === 'registered' && !!userId);
    if (!canSeeCount) post.view_count = null;

    // 广场仅显示前20%内容作为预览
    if (post.content) {
      const previewLength = Math.ceil(post.content.length * 0.2);
      post.content_preview = post.content.substring(0, previewLength);
      post.is_preview = true; // 标记为预览模式
    }
  });

  res.json(posts);
});

// GET /api/planet/posts/:id - 获取帖子详情（游客可查看已审核且改写完成的帖子）
router.get('/posts/:id', optionalAuth, async (req, res) => {
  const [[post]] = await db.query(`
    SELECT p.*, COALESCE(u.nickname, u.username) as author_name, c.name as circle_name,
      c.view_detail_permission as circle_detail_permission, c.view_count_permission as circle_count_permission,
      c.creator_id as circle_creator_id
    FROM planet_posts p
    LEFT JOIN users u ON p.user_id = u.id
    LEFT JOIN planet_circles c ON p.circle_id = c.id
    WHERE p.id = ?
  `, [req.params.id]);

  if (!post) {
    return res.status(404).json({ message: '帖子不存在' });
  }

  // 查看文章详情权限检查
  const detailPerm = post.circle_detail_permission || 'public';
  if (detailPerm === 'vip') {
    if (!req.user) {
      return res.status(401).json({ requireLogin: true, message: '请先登录' });
    }
    const isAdmin = req.user.role === 'admin';
    const isCreator = post.circle_creator_id === req.user.id;
    if (!isAdmin && !isCreator) {
      const [[quota]] = await db.query('SELECT vip_expires_at FROM user_quota WHERE user_id = ?', [req.user.id]);
      const isVip = !!(quota?.vip_expires_at && new Date(quota.vip_expires_at) > new Date());
      if (!isVip) {
        return res.status(403).json({ requireVip: true, message: '此圈子仅VIP用户和圈子创建者可见' });
      }
    }
  } else if (detailPerm === 'registered') {
    if (!req.user) {
      return res.status(401).json({ requireLogin: true, message: '请先登录查看此圈子内容' });
    }
  }
  // public：无需检查

  // 游客只能查看已审核且改写完成的帖子
  if (!req.user && (post.review_status !== 'approved' || post.rewrite_status !== 'completed')) {
    return res.status(403).json({ message: '该帖子暂不可查看' });
  }

  // 解析 images 字段
  if (post.images) {
    try {
      post.images = JSON.parse(post.images);
    } catch (e) {
      post.images = [];
    }
  }

  // 登录用户：检查成员资格并扣除积分
  if (req.user) {
    const [[member]] = await db.query('SELECT id FROM planet_members WHERE circle_id = ? AND user_id = ?', [post.circle_id, req.user.id]);
    if (!member && post.user_id !== req.user.id) {
      // 非成员也允许查看，但需扣积分
    }

    // 如果不是自己的帖子且未浏览过，扣除积分
    if (post.user_id !== req.user.id) {
      const [[viewed]] = await db.query('SELECT id FROM planet_post_views WHERE post_id = ? AND user_id = ?', [req.params.id, req.user.id]);

      if (!viewed) {
        const cost = parseInt(await getSetting('planet_view_cost')) || 1;
        const quota = await ensureQuota(req.user.id);

        if (quota.extra_quota < cost) {
          return res.status(403).json({ message: '积分不足，无法查看帖子' });
        }

        await db.query('UPDATE user_quota SET extra_quota = extra_quota - ? WHERE user_id = ?', [cost, req.user.id]);
        await addQuotaLog(req.user.id, -cost, `浏览帖子（帖子ID: ${req.params.id}）`);
        await db.query('INSERT INTO planet_post_views (post_id, user_id) VALUES (?, ?)', [req.params.id, req.user.id]);

        await db.query('UPDATE planet_posts SET view_count = view_count + 1 WHERE id = ?', [req.params.id]);
        post.view_count += 1;
      }
    }
  } else {
    // 游客：检查每日浏览限制（10篇/天）
    const guestIp = req.ip || req.connection.remoteAddress || 'unknown';
    const today = getChinaDateString(); // YYYY-MM-DD

    // 检查今天是否已浏览过此帖子
    const [[alreadyViewed]] = await db.query(
      'SELECT id FROM planet_guest_views WHERE ip_address = ? AND post_id = ? AND view_date = ?',
      [guestIp, req.params.id, today]
    );

    if (!alreadyViewed) {
      // 检查今天已浏览的不同帖子数量
      const [[{ count }]] = await db.query(
        'SELECT COUNT(DISTINCT post_id) as count FROM planet_guest_views WHERE ip_address = ? AND view_date = ?',
        [guestIp, today]
      );

      if (count >= 10) {
        return res.status(403).json({
          message: '游客每天最多浏览 10 篇文章，请登录以继续阅读',
          code: 'GUEST_LIMIT_EXCEEDED',
          limit: 10,
          current: count
        });
      }

      // 记录游客浏览
      await db.query(
        'INSERT INTO planet_guest_views (ip_address, post_id, view_date) VALUES (?, ?, ?)',
        [guestIp, req.params.id, today]
      ).catch(() => {}); // 忽略重复插入错误

      // 更新浏览数
      await db.query('UPDATE planet_posts SET view_count = view_count + 1 WHERE id = ?', [req.params.id]);
      post.view_count += 1;
    }
  }

  // 按查看浏览量权限屏蔽 view_count
  const countPerm = post.circle_count_permission || 'public';
  const isAdminUser = req.user?.role === 'admin';
  const isPostCreator = post.circle_creator_id === req.user?.id;
  const canSeeCount = isAdminUser || isPostCreator
    || countPerm === 'public'
    || (countPerm === 'registered' && !!req.user);
  if (!canSeeCount) post.view_count = null;

  res.json(post);
});

// GET /api/planet/my-posts - 获取我的帖子
router.get('/my-posts', auth, async (req, res) => {
  const [posts] = await db.query(`
    SELECT p.*, c.name as circle_name
    FROM planet_posts p
    LEFT JOIN planet_circles c ON p.circle_id = c.id
    WHERE p.user_id = ?
    ORDER BY p.created_at DESC
  `, [req.user.id]);

  // 解析 images 字段
  posts.forEach(post => {
    if (post.images) {
      try {
        post.images = JSON.parse(post.images);
      } catch (e) {
        post.images = [];
      }
    }
  });

  res.json(posts);
});

// PUT /api/planet/posts/:id - 编辑自己的帖子
router.put('/posts/:id', auth, async (req, res) => {
  const { id } = req.params;
  const { post_type, title, content, images, video_url, link_url, link_title, link_cover } = req.body;

  if (!content) {
    return res.status(400).json({ message: '内容不能为空' });
  }

  // 检查帖子是否存在且属于当前用户
  const [[post]] = await db.query('SELECT user_id FROM planet_posts WHERE id = ?', [id]);
  if (!post) {
    return res.status(404).json({ message: '帖子不存在' });
  }
  if (post.user_id !== req.user.id) {
    return res.status(403).json({ message: '只能编辑自己的帖子' });
  }

  await db.query(
    `UPDATE planet_posts SET post_type = ?, title = ?, content = ?, images = ?, video_url = ?, link_url = ?, link_title = ?, link_cover = ?
     WHERE id = ?`,
    [post_type || 'text', title || '无标题', content,
     images ? JSON.stringify(images) : null, video_url || null, link_url || null, link_title || null, link_cover || null, id]
  );

  res.json({ message: '编辑成功' });
});

// POST /api/planet/posts/polish - AI润色帖子内容
router.post('/posts/polish', auth, async (req, res) => {
  const { content } = req.body;

  if (!content || content.trim().length === 0) {
    return res.status(400).json({ message: '内容不能为空' });
  }

  // AI 调用费用由 api.yunjunet.cn USD 余额承担，不再扣积分
  try {
    const { callAI: plCallAI } = require('../utils/aiGateway');
    const polished = await plCallAI(content, {
      userId: req.user.id,
      system: '你是一个专业的文案润色助手。请对用户提供的内容进行润色，使其更加流畅、生动、有吸引力。保持原意不变，只优化表达方式。直接返回润色后的内容，不要添加任何解释或前缀。',
      tier: 'simple',
    });

    res.json({ original: content, polished });
  } catch (e) {
    console.error('Polish error:', e);
    res.status(500).json({ message: 'AI润色失败，请稍后重试' });
  }
});

// POST /api/planet/posts/:id/summary - AI生成帖子摘要
router.post('/posts/:id/summary', auth, async (req, res) => {
  const [[post]] = await db.query('SELECT * FROM planet_posts WHERE id = ?', [req.params.id]);

  if (!post) {
    return res.status(404).json({ message: '帖子不存在' });
  }

  // 检查积分
  const cost = 1;
  const quota = await ensureQuota(req.user.id);

  // AI 费用走网关 USD 余额
  try {
    const { callAI: sumCallAI } = require('../utils/aiGateway');
    const summary = await sumCallAI(`标题：${post.title}\n\n内容：${post.content}`, {
      userId: req.user.id,
      system: '你是一个专业的内容摘要助手。请为用户提供的内容生成简洁的摘要，控制在50-80字以内。直接返回摘要内容，不要添加任何解释或前缀。',
      tier: 'simple',
    });
    if (!summary?.trim()) throw new Error('AI返回内容为空');
    res.json({ summary: summary.trim() });
  } catch (error) {
    console.error('AI摘要失败:', error);
    res.status(500).json({ message: 'AI摘要失败，请稍后重试' });
  }
});

// POST /api/planet/posts/generate-content - 根据标题生成内容
router.post('/posts/generate-content', auth, async (req, res) => {
  const { title } = req.body;

  if (!title || title.trim().length === 0) {
    return res.status(400).json({ message: '标题不能为空' });
  }

  // AI 费用走网关 USD 余额
  try {
    const { callAI: genCallAI } = require('../utils/aiGateway');
    const genContent = await genCallAI(title, {
      userId: req.user.id,
      system: '你是一个专业的内容创作助手。根据用户提供的标题，生成相关的内容，控制在200-500字。内容要有价值、有深度、有吸引力。直接返回内容，不要添加任何解释或前缀。',
      tier: 'medium',
    });
    // 删掉旧的 response 处理残留，直接返回
    res.json({ content: genContent?.trim() || '' });
  } catch (error2) {
    console.error('AI内容生成失败:', error2.message);
    res.status(500).json({ message: 'AI内容生成失败' });
  }
});

// generate-content 旧残留已清理

// POST /api/planet/posts/generate-title - 根据内容生成标题
router.post('/posts/generate-title', auth, async (req, res) => {
  const { content } = req.body;

  if (!content || content.trim().length === 0) {
    return res.status(400).json({ message: '内容不能为空' });
  }

  try {
    const { callAI: gwCallAI } = require('../utils/aiGateway');
    const title = await gwCallAI(
      `请根据以下内容生成标题：${content.substring(0, 500)}`,
      {
        userId: req.user.id,
        system: '你是一个专业的标题生成助手。根据用户提供的内容，生成一个简洁、吸引人的标题，控制在15字以内。直接返回标题，不要添加任何解释、前缀或引号。',
        tier: 'simple',
      }
    );
    if (!title) throw new Error('AI返回内容为空');
    res.json({ title: title.trim() });
  } catch (error) {
    console.error('AI生成标题失败:', error);
    res.status(500).json({ message: 'AI生成标题失败，请稍后重试' });
  }
});

// GET /api/planet/settings - 获取用户星球设置
router.get('/settings', auth, async (req, res) => {
  try {
    const [[user]] = await db.query('SELECT planet_auto_view FROM users WHERE id = ?', [req.user.id]);
    res.json({ auto_view: user?.planet_auto_view || false });
  } catch (error) {
    console.error('获取设置失败:', error);
    res.status(500).json({ message: '获取设置失败' });
  }
});

// PUT /api/planet/settings - 更新用户星球设置
router.put('/settings', auth, async (req, res) => {
  const { auto_view } = req.body;

  try {
    await db.query('UPDATE users SET planet_auto_view = ? WHERE id = ?', [!!auto_view, req.user.id]);
    res.json({ message: '设置已更新', auto_view: !!auto_view });
  } catch (error) {
    console.error('更新设置失败:', error);
    res.status(500).json({ message: '更新设置失败' });
  }
});

// POST /api/planet/posts/:id/poster - AI生成分享海报（游客可用）
router.post('/posts/:id/poster', optionalAuth, async (req, res) => {
  try {
    const [[post]] = await db.query(`
      SELECT p.*, COALESCE(u.nickname, u.username) as author_name, c.name as circle_name
      FROM planet_posts p
      LEFT JOIN users u ON p.user_id = u.id
      LEFT JOIN planet_circles c ON p.circle_id = c.id
      WHERE p.id = ? AND p.review_status = 'approved'
    `, [req.params.id]);

    if (!post) return res.status(404).json({ message: '帖子不存在' });

    const title = post.title || 'AI星球精选';
    const circleName = post.circle_name || 'AI星球';
    const excerpt = (post.content || '').substring(0, 200);
    const posterUserId = req.user?.id || 1;

    // 1. AI生成海报金句文字（通过网关）
    const { callAI: posterCallAI } = require('../utils/aiGateway');
    const sloganResult = await posterCallAI(
      `根据以下文章，生成一句适合海报展示的精炼金句（15-25字），要有感染力和传播性，体现文章核心价值：\n标题：${title}\n内容：${excerpt}\n\n只输出金句本身，不要引号和任何解释。`,
      { userId: posterUserId, tier: 'simple', max_tokens: 60 }
    );
    const posterSlogan = sloganResult?.trim() || title;

    // 2. AI生成海报图片（通过yunjunet-common）
    const imagePrompt = `Design a modern Chinese technology article sharing poster. Style: minimalist, premium, tech-forward. Background: deep purple-to-blue gradient. Layout: vertical portrait format. Content to display: Circle name "${circleName}" as small badge top-left, Title "${title}" in large bold white Chinese text center-top, Slogan "${posterSlogan}" in medium elegant white Chinese text below title, Author "${post.author_name || 'AI星球用户'}" in small text bottom-left. IMPORTANT: Leave bottom-right area (200x200px) completely blank/clean for QR code placement. No QR code in image. Clean whitespace at bottom. High quality, 2048x2048.`;
    const { callImage: posterCallImage } = require('yunjunet-common/backend-core/ai/doubao');
    const remoteUrl = await posterCallImage(imagePrompt, 0, posterUserId, 'AI海报');
    if (!remoteUrl) throw new Error('未获取到图片URL');

    // 3. 下载并保存到本地
    const imgFetch = await fetch(remoteUrl);
    const arrayBuffer = await imgFetch.arrayBuffer();
    const postersDir = path.join(UPLOAD_DIR, 'posters');
    fs.mkdirSync(postersDir, { recursive: true });
    const filename = `poster-${Date.now()}-${Math.random().toString(36).slice(2)}.png`;
    fs.writeFileSync(path.join(postersDir, filename), Buffer.from(arrayBuffer));

    res.json({ poster_url: `/uploads/posters/${filename}`, poster_slogan: posterSlogan });
  } catch (e) {
    console.error('AI生成海报失败:', e);
    res.status(500).json({ message: 'AI生成海报失败：' + e.message });
  }
});

// ── Admin 接口 ──────────────────────────────────────────────

// GET /api/planet/admin/circles - 获取所有圈子（admin）
router.get('/admin/circles', auth, requireAdmin, async (req, res) => {
  const [rows] = await db.query(
    `SELECT c.*, u.username as creator_name FROM planet_circles c
     LEFT JOIN users u ON c.creator_id = u.id
     ORDER BY c.created_at DESC`
  );
  res.json(rows);
});

// PUT /api/planet/admin/circles/:id - 编辑圈子（admin）
router.put('/admin/circles/:id', auth, requireAdmin, async (req, res) => {
  const { name, description, cover_image, ai_rewrite_enabled, ai_rewrite_model, view_detail_permission, view_count_permission } = req.body;
  console.log('[planet] 更新圈子:', { id: req.params.id, ai_rewrite_enabled, ai_rewrite_model, view_detail_permission, view_count_permission });
  if (!name || !name.trim()) return res.status(400).json({ message: '圈子名称不能为空' });

  const validDetailPerms = ['public', 'registered', 'vip'];
  const validCountPerms = ['public', 'registered', 'admin_only'];
  if (view_detail_permission && !validDetailPerms.includes(view_detail_permission)) {
    return res.status(400).json({ message: '查看文章详情权限级别无效' });
  }
  if (view_count_permission && !validCountPerms.includes(view_count_permission)) {
    return res.status(400).json({ message: '查看文章浏览量权限级别无效' });
  }

  const [[circle]] = await db.query('SELECT id FROM planet_circles WHERE id = ?', [req.params.id]);
  if (!circle) return res.status(404).json({ message: '圈子不存在' });

  const enabledValue = ai_rewrite_enabled ? 1 : 0;
  await db.query(
    'UPDATE planet_circles SET name=?, description=?, cover_image=?, ai_rewrite_enabled=?, ai_rewrite_model=?, view_detail_permission=?, view_count_permission=? WHERE id=?',
    [name.trim(), description?.trim() || null, cover_image?.trim() || null,
     enabledValue, ai_rewrite_model || 'kimi',
     view_detail_permission || 'public', view_count_permission || 'public', req.params.id]
  );
  console.log('[planet] 圈子已更新，详情权限:', view_detail_permission, '浏览量权限:', view_count_permission);
  res.json({ message: '圈子已更新' });
});

// GET /api/planet/admin/posts - 获取所有帖子（admin）
router.get('/admin/posts', auth, requireAdmin, async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = 20;
  const offset = (page - 1) * limit;
  const circle_id = req.query.circle_id || null;
  const conditions = circle_id ? 'WHERE p.circle_id = ?' : '';
  const params = circle_id ? [circle_id, limit, offset] : [limit, offset];
  const [rows] = await db.query(
    `SELECT p.id, p.title, p.content, p.post_type, p.view_count, p.created_at, p.review_status, p.rewrite_status,
            p.circle_id, c.name as circle_name,
            u.username as author
     FROM planet_posts p
     LEFT JOIN planet_circles c ON p.circle_id = c.id
     LEFT JOIN users u ON p.user_id = u.id
     ${conditions}
     ORDER BY p.created_at DESC LIMIT ? OFFSET ?`,
    params
  );
  const [[{ total }]] = await db.query(
    `SELECT COUNT(*) as total FROM planet_posts p ${conditions}`,
    circle_id ? [circle_id] : []
  );
  res.json({ data: rows, total, page });
});

// POST /api/planet/admin/posts - 创建帖子（admin）
router.post('/admin/posts', auth, requireAdmin, upload.fields([
  { name: 'images', maxCount: 9 }
]), async (req, res) => {
  try {
    let { circle_id, title, content, author_username } = req.body;

    if (!circle_id) return res.status(400).json({ message: '请选择圈子' });
    if (!content || !content.trim()) return res.status(400).json({ message: '内容不能为空' });

    // 如果标题为空，使用AI生成
    if (!title || !title.trim()) {
      try {
        title = await generateTitle(content.trim());
      } catch (error) {
        console.error('AI生成标题失败:', error);
        // 如果AI生成失败，使用内容前20字作为标题
        title = content.trim().substring(0, 20) + (content.trim().length > 20 ? '...' : '');
      }
    }

    // 验证圈子是否存在
    const [[circle]] = await db.query('SELECT id FROM planet_circles WHERE id = ?', [circle_id]);
    if (!circle) return res.status(404).json({ message: '圈子不存在' });

    // 处理上传的图片
    let images = [];
    if (req.files?.images) {
      images = req.files.images.map(f => {
        const sub = f.mimetype.startsWith('video/') ? 'videos' : 'images';
        return `/uploads/${sub}/${f.filename}`;
      });
    }
    // 如果没有上传文件，但有从相册选择的图片URL
    else if (req.body.selected_image_url) {
      images = [req.body.selected_image_url];
    }

    let user_id;

    if (author_username && author_username.trim()) {
      // 如果指定了作者用户名，查找该用户
      const [[user]] = await db.query('SELECT id FROM users WHERE username = ?', [author_username.trim()]);
      if (!user) return res.status(404).json({ message: '指定的作者用户不存在' });
      user_id = user.id;
    } else {
      // 如果未指定作者，异步创建随机用户
      // 生成随机中文昵称
      const surnames = ['李', '王', '张', '刘', '陈', '杨', '黄', '赵', '周', '吴', '徐', '孙', '马', '朱', '胡', '郭', '何', '林', '罗', '高'];
      const names = ['明', '华', '强', '伟', '芳', '娜', '静', '丽', '敏', '秀', '英', '杰', '涛', '磊', '军', '勇', '艳', '超', '鹏', '飞'];
      const randomNickname = surnames[Math.floor(Math.random() * surnames.length)] +
                            names[Math.floor(Math.random() * names.length)] +
                            names[Math.floor(Math.random() * names.length)];

      // 生成随机用户名（避免冲突）
      const randomUsername = 'user_' + Date.now() + '_' + Math.floor(Math.random() * 10000);
      const randomPassword = Math.random().toString(36).slice(-10);

      // 创建用户
      const [userResult] = await db.query(
        'INSERT INTO users (username, password, nickname) VALUES (?, ?, ?)',
        [randomUsername, randomPassword, randomNickname]
      );
      user_id = userResult.insertId;
    }

    // 创建帖子（默认为图文类型，状态为已通过）
    // 根据是否有图片判断post_type：有图片为image，无图片为text
    const post_type = images.length > 0 ? 'image' : 'text';
    const [result] = await db.query(
      'INSERT INTO planet_posts (circle_id, user_id, title, content, images, post_type, review_status) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [circle_id, user_id, title.trim(), content.trim(), images.length > 0 ? JSON.stringify(images) : null, post_type, 'approved']
    );

    res.json({ message: '帖子已创建', post_id: result.insertId });
  } catch (error) {
    console.error('[planet/admin/create-post] Error:', error);
    res.status(500).json({ message: '创建失败：' + error.message });
  }
});

// PUT /api/planet/admin/posts/:id - 编辑帖子（admin）
router.put('/admin/posts/:id', auth, requireAdmin, async (req, res) => {
  const { title, content } = req.body;
  if (!title || !title.trim()) return res.status(400).json({ message: '标题不能为空' });
  if (!content || !content.trim()) return res.status(400).json({ message: '内容不能为空' });
  const [[post]] = await db.query('SELECT id FROM planet_posts WHERE id = ?', [req.params.id]);
  if (!post) return res.status(404).json({ message: '帖子不存在' });
  await db.query('UPDATE planet_posts SET title=?, content=? WHERE id=?', [title.trim(), content.trim(), req.params.id]);
  res.json({ message: '帖子已更新' });
});

// POST /api/planet/admin/posts/:id/reject - 不通过帖子（admin）
router.post('/admin/posts/:id/reject', auth, requireAdmin, async (req, res) => {
  try {
    const [[post]] = await db.query('SELECT id FROM planet_posts WHERE id = ?', [req.params.id]);
    if (!post) return res.status(404).json({ message: '帖子不存在' });
    await db.query('UPDATE planet_posts SET review_status=? WHERE id=?', ['rejected', req.params.id]);
    res.json({ message: '帖子已标记为不通过' });
  } catch (error) {
    console.error('[planet/reject] Error:', error);
    res.status(500).json({ message: '操作失败：' + error.message });
  }
});

// POST /api/planet/admin/posts/:id/approve - 通过帖子（admin）
router.post('/admin/posts/:id/approve', auth, requireAdmin, async (req, res) => {
  try {
    const [[post]] = await db.query('SELECT id FROM planet_posts WHERE id = ?', [req.params.id]);
    if (!post) return res.status(404).json({ message: '帖子不存在' });
    await db.query('UPDATE planet_posts SET review_status=? WHERE id=?', ['approved', req.params.id]);
    res.json({ message: '帖子已通过' });
  } catch (error) {
    console.error('[planet/approve] Error:', error);
    res.status(500).json({ message: '操作失败：' + error.message });
  }
});

module.exports = router;
