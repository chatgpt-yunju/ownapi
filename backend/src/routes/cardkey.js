const router = require('express').Router();
const db = require('../config/db');
const { auth, requireAdmin } = require('../middleware/auth');
const crypto = require('crypto');

function genKey() {
  // Format: XXXX-XXXX-XXXX-XXXX
  return Array.from({ length: 4 }, () =>
    crypto.randomBytes(2).toString('hex').toUpperCase()
  ).join('-');
}

// POST /api/cardkey/generate — 管理员批量生成卡密
router.post('/generate', auth, requireAdmin, async (req, res) => {
  const { quota, count = 1 } = req.body;
  if (!quota || quota < 1) return res.status(400).json({ message: '请指定有效的配额数量' });
  const num = Math.min(parseInt(count) || 1, 100);

  const keys = [];
  for (let i = 0; i < num; i++) {
    let key, inserted = false;
    while (!inserted) {
      key = genKey();
      try {
        await db.query(
          'INSERT INTO card_keys (`key`, quota) VALUES (?, ?)',
          [key, quota]
        );
        inserted = true;
      } catch (e) {
        if (e.code !== 'ER_DUP_ENTRY') throw e;
      }
    }
    keys.push(key);
  }
  res.json({ keys });
});

// GET /api/cardkey/list — 管理员查看所有卡密
router.get('/list', auth, requireAdmin, async (req, res) => {
  const [rows] = await db.query(
    'SELECT id, `key`, quota, status, used_by, used_at, created_at FROM card_keys ORDER BY created_at DESC'
  );
  res.json(rows);
});

// DELETE /api/cardkey/:id — 管理员删除卡密
router.delete('/:id', auth, requireAdmin, async (req, res) => {
  await db.query('DELETE FROM card_keys WHERE id = ? AND status = "unused"', [req.params.id]);
  res.json({ message: '删除成功' });
});

// POST /api/cardkey/redeem — 用户兑换卡密
router.post('/redeem', auth, async (req, res) => {
  const { key } = req.body;
  if (!key) return res.status(400).json({ message: '请输入卡密' });

  const [[card]] = await db.query('SELECT * FROM card_keys WHERE `key` = ?', [key.trim().toUpperCase()]);
  if (!card) return res.status(404).json({ message: '卡密不存在' });
  if (card.status !== 'unused') return res.status(400).json({ message: '该卡密已被使用' });

  await db.query(
    'UPDATE card_keys SET status = "used", used_by = ?, used_at = NOW() WHERE id = ? AND status = "unused"',
    [req.user.id, card.id]
  );
  // Check affected rows to prevent race condition
  const [[{ affected }]] = await db.query('SELECT ROW_COUNT() as affected');
  if (affected === 0) return res.status(400).json({ message: '该卡密已被使用' });

  await db.query(
    'INSERT INTO user_quota (user_id, extra_quota) VALUES (?, ?) ON DUPLICATE KEY UPDATE extra_quota = extra_quota + ?',
    [req.user.id, card.quota, card.quota]
  );
  const { addQuotaLog } = require('./quota');
  await addQuotaLog(req.user.id, card.quota, `卡密兑换`);

  res.json({ message: `兑换成功，获得 ${card.quota} 次领取配额`, quota: card.quota });
});

module.exports = router;
