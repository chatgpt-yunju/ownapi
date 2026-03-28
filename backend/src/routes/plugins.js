const router = require('express').Router();
const db = require('../config/db');
const { auth, requireAdmin } = require('../middleware/auth');
const { discoverPlugins, PLUGINS_DIR } = require('../plugin-loader');

// GET /api/plugins — 列出所有插件（DB记录 + 文件系统发现）
router.get('/', auth, requireAdmin, async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT name, display_name, description, version, enabled, config, route_prefix, updated_at FROM plugins ORDER BY name'
    );

    // 补充文件系统中存在但DB未登记的插件（刚放入但未重启）
    const discovered = discoverPlugins().map(m => m.name || m._dirName);
    const dbNames = new Set(rows.map(r => r.name));
    const onDisk = discovered.filter(n => !dbNames.has(n));

    res.json({
      plugins: rows.map(r => ({
        ...r,
        config: r.config || {},
        enabled: !!r.enabled,
        onDisk: true,
      })),
      unregistered: onDisk,
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// PUT /api/plugins/:name/toggle — 启用 / 禁用插件
router.put('/:name/toggle', auth, requireAdmin, async (req, res) => {
  try {
    const { name } = req.params;
    const [[row]] = await db.query('SELECT enabled FROM plugins WHERE name = ?', [name]);
    if (!row) return res.status(404).json({ message: '插件不存在' });

    const newEnabled = row.enabled ? 0 : 1;
    await db.query('UPDATE plugins SET enabled = ? WHERE name = ?', [newEnabled, name]);

    res.json({ name, enabled: !!newEnabled, message: newEnabled ? '已启用（重启后生效）' : '已禁用（重启后生效）' });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// PUT /api/plugins/:name/config — 更新插件配置
router.put('/:name/config', auth, requireAdmin, async (req, res) => {
  try {
    const { name } = req.params;
    const { config } = req.body;
    if (typeof config !== 'object' || config === null) {
      return res.status(400).json({ message: 'config 必须是对象' });
    }

    const [[row]] = await db.query('SELECT id FROM plugins WHERE name = ?', [name]);
    if (!row) return res.status(404).json({ message: '插件不存在' });

    await db.query('UPDATE plugins SET config = ? WHERE name = ?', [JSON.stringify(config), name]);
    res.json({ name, config });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

module.exports = router;
