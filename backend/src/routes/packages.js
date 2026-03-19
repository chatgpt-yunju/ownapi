const router = require('express').Router();
const db = require('../config/db');
const { generateApiKey, hashApiKey, maskApiKey } = require('../utils/crypto');

// 获取套餐列表
router.get('/list', async (req, res) => {
  try {
    const [packages] = await db.query('SELECT * FROM openclaw_packages WHERE status = "active" ORDER BY price');
    res.json({ packages });
  } catch (err) {
    res.status(500).json({ error: '获取套餐失败' });
  }
});

// 购买套餐（用余额购买）
router.post('/buy', async (req, res) => {
  const { package_id } = req.body;
  try {
    const [[pkg]] = await db.query('SELECT * FROM openclaw_packages WHERE id = ? AND status = "active"', [package_id]);
    if (!pkg) return res.status(404).json({ error: '套餐不存在' });

    if (pkg.type === 'free') {
      const conn = await db.getConnection();
      try {
        await conn.beginTransaction();

        // 检查10密钥上限
        const [[{ cnt }]] = await conn.query(
          'SELECT COUNT(*) as cnt FROM openclaw_api_keys WHERE user_id = ?',
          [req.user.id]
        );
        if (cnt >= 10) {
          await conn.rollback();
          return res.status(400).json({ error: '已达到10个密钥上限，请先删除旧密钥' });
        }

        // 充值月度配额
        const monthlyQuota = Number(pkg.monthly_quota);
        if (monthlyQuota > 0) {
          // 确保 openclaw_quota 记录存在
          await conn.query(
            'INSERT INTO openclaw_quota (user_id, balance) VALUES (?, 0) ON DUPLICATE KEY UPDATE user_id = user_id',
            [req.user.id]
          );

          const [[currentQuota]] = await conn.query('SELECT balance FROM openclaw_quota WHERE user_id = ?', [req.user.id]);
          const balanceBefore = Number(currentQuota?.balance || 0);
          const balanceAfter = balanceBefore + monthlyQuota;

          await conn.query('UPDATE openclaw_quota SET balance = ? WHERE user_id = ?', [balanceAfter, req.user.id]);

          await conn.query(
            'INSERT INTO balance_logs (user_id, amount, balance_before, balance_after, type, description) VALUES (?, ?, ?, ?, "recharge", ?)',
            [req.user.id, monthlyQuota, balanceBefore, balanceAfter, `购买${pkg.name}套餐，获得月度配额 $${monthlyQuota}`]
          );
        }

        // 创建用户套餐记录
        const [pkgResult] = await conn.query(
          'INSERT INTO openclaw_user_packages (user_id, package_id, expires_at, status) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 30 DAY), "active")',
          [req.user.id, pkg.id]
        );
        const userPackageId = pkgResult.insertId;

        // 创建API密钥
        const key = generateApiKey();
        const keyHash = hashApiKey(key);
        const keyDisplay = maskApiKey(key);
        const keyPrefix = key.slice(0, 7);
        const keyName = `${pkg.name} - ${new Date().toISOString().split('T')[0]}`;

        await conn.query(
          'INSERT INTO openclaw_api_keys (user_id, package_id, key_prefix, key_hash, key_display, name) VALUES (?, ?, ?, ?, ?, ?)',
          [req.user.id, userPackageId, keyPrefix, keyHash, keyDisplay, keyName]
        );

        await conn.commit();
        return res.json({
          message: `已购买${pkg.name}套餐，获得 ¥${monthlyQuota} 月度配额`,
          api_key: key,
          key_display: keyDisplay,
          notice: '请保存此密钥，后续无法再次查看完整密钥'
        });
      } catch (e) {
        await conn.rollback();
        throw e;
      } finally {
        conn.release();
      }
    }

    // 付费套餐：从 openclaw_quota 余额扣费
    const [[quota]] = await db.query('SELECT balance FROM openclaw_quota WHERE user_id = ?', [req.user.id]);
    if (!quota || Number(quota.balance) < Number(pkg.price)) {
      return res.status(400).json({ error: '余额不足，请先充值' });
    }

    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();

      const [[{ cnt }]] = await conn.query(
        'SELECT COUNT(*) as cnt FROM openclaw_api_keys WHERE user_id = ?',
        [req.user.id]
      );
      if (cnt >= 10) {
        await conn.rollback();
        return res.status(400).json({ error: '已达到10个密钥上限，请先删除旧密钥' });
      }

      const [[currentQuota]] = await conn.query('SELECT balance FROM openclaw_quota WHERE user_id = ?', [req.user.id]);
      const balanceBefore = Number(currentQuota.balance);
      const balanceAfter = balanceBefore - Number(pkg.price);

      await conn.query('UPDATE openclaw_quota SET balance = balance - ? WHERE user_id = ?', [pkg.price, req.user.id]);

      await conn.query(
        'INSERT INTO balance_logs (user_id, amount, balance_before, balance_after, type, description, created_at) VALUES (?, ?, ?, ?, "buy_quota", ?, NOW())',
        [req.user.id, -pkg.price, balanceBefore, balanceAfter, `购买套餐: ${pkg.name}`]
      );

      const [pkgResult] = await conn.query(
        'INSERT INTO openclaw_user_packages (user_id, package_id, expires_at, status) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 30 DAY), "active")',
        [req.user.id, pkg.id]
      );
      const userPackageId = pkgResult.insertId;

      const key = generateApiKey();
      const keyHash = hashApiKey(key);
      const keyDisplay = maskApiKey(key);
      const keyPrefix = key.slice(0, 7);
      const keyName = `${pkg.name} - ${new Date().toISOString().split('T')[0]}`;

      await conn.query(
        'INSERT INTO openclaw_api_keys (user_id, package_id, key_prefix, key_hash, key_display, name) VALUES (?, ?, ?, ?, ?, ?)',
        [req.user.id, userPackageId, keyPrefix, keyHash, keyDisplay, keyName]
      );

      await conn.commit();
      res.json({
        message: `已购买${pkg.name}套餐`,
        api_key: key,
        key_display: keyDisplay,
        notice: '请保存此密钥，后续无法再次查看完整密钥'
      });
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '购买失败' });
  }
});

// 获取用户当前套餐
router.get('/my', async (req, res) => {
  try {
    const [pkgs] = await db.query(
      `SELECT up.*, p.name, p.type, p.daily_limit, p.monthly_quota
       FROM openclaw_user_packages up JOIN openclaw_packages p ON up.package_id = p.id
       WHERE up.user_id = ? AND up.status = "active" AND (up.expires_at IS NULL OR up.expires_at > NOW())
       ORDER BY up.started_at DESC LIMIT 1`,
      [req.user.id]
    );
    res.json({ package: pkgs[0] || null });
  } catch (err) {
    res.status(500).json({ error: '获取套餐失败' });
  }
});

module.exports = router;
