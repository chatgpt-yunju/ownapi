const router = require('express').Router();
const db = require('../../../config/db');
const { auth, requireAdmin } = require('../middleware/auth');
const upload = require('../middleware/upload');
const path = require('path');

// 初始化默认值
(async () => {
  await db.query(
    'INSERT IGNORE INTO settings (`key`, `value`) VALUES (?, ?)',
    ['nav_visibility', '{"home":true,"tools":true,"image":true,"video":true,"meeting":true}']
  ).catch(() => {});
  await db.query(
    'INSERT IGNORE INTO settings (`key`, `value`) VALUES (?, ?)',
    ['post_fields_visibility', '{"show_title":true,"show_author":true,"show_rewrite":true,"show_charcount":true}']
  ).catch(() => {});
  await db.query(
    'INSERT IGNORE INTO settings (`key`, `value`) VALUES (?, ?)',
    ['planet_tagline', '助力一万人All In AI']
  ).catch(() => {});
  await db.query(
    'INSERT IGNORE INTO settings (`key`, `value`) VALUES (?, ?)',
    ['popup_config', JSON.stringify({
      enabled: false,
      text: '小龙虾系统一键部署，专业技术支持，微信：15953077610',
      image_url: '',
      frequency: 'once_per_day'
    })]
  ).catch(() => {});
  await db.query(
    'INSERT INTO settings (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = VALUES(`value`)',
    ['popup_config', JSON.stringify({
      enabled: false,
      text: '小龙虾系统一键部署，专业技术支持，微信：15953077610',
      image_url: '',
      frequency: 'once_per_day'
    })]
  ).catch(() => {});
})();

const publicAllowedKeys = new Set(['nav_visibility', 'contact_wechat', 'contact_email', 'post_fields_visibility', 'planet_tagline', 'popup_config']);

// GET /api/settings/public — 无需认证
router.get('/public', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT `key`, `value` FROM settings');
    const result = {};
    rows.forEach(r => {
      if (publicAllowedKeys.has(r.key)) result[r.key] = r.value;
    });
    res.json(result);
  } catch (error) {
    console.error('获取公开配置失败:', error);
    res.status(500).json({ message: '服务器错误' });
  }
});

// PUT /api/settings — admin only
router.put('/', auth, requireAdmin, async (req, res) => {
  const { nav_visibility, post_fields_visibility, planet_tagline, popup_config } = req.body;
  if (nav_visibility !== undefined) {
    await db.query(
      'INSERT INTO settings (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = ?',
      ['nav_visibility', nav_visibility, nav_visibility]
    );
  }
  if (post_fields_visibility !== undefined) {
    await db.query(
      'INSERT INTO settings (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = ?',
      ['post_fields_visibility', post_fields_visibility, post_fields_visibility]
    );
  }
  if (planet_tagline !== undefined) {
    await db.query(
      'INSERT INTO settings (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = ?',
      ['planet_tagline', planet_tagline, planet_tagline]
    );
  }
  if (popup_config !== undefined) {
    await db.query(
      'INSERT INTO settings (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = ?',
      ['popup_config', popup_config, popup_config]
    );
  }
  res.json({ message: 'Saved' });
});

// POST /api/settings/upload-popup-image — admin only
router.post('/upload-popup-image', auth, requireAdmin, upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ message: '未上传文件' });
  const relativePath = `/uploads/images/${path.basename(req.file.path)}`;
  // 返回主站完整URL，实现跨站图片共享
  const fullUrl = `https://opensora2.cn${relativePath}`;
  res.json({ url: fullUrl });
});

module.exports = router;
