const router = require('express').Router();
const db = require('../../config/db');
const jwt = require('jsonwebtoken');
const { auth, requireAdmin } = require('../../middleware/auth');
const multer = require('multer');
const path = require('path');
const { calcSinglePrice, calcPackagePrice } = require('./services/pricing');
const { sendPurchaseEmail, sendVipEmail } = require('./services/mailer');

const UPLOADS_DIR = path.join(__dirname, '../../../uploads/aikaoyan');
const fs = require('fs');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname),
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

// ============ SSO ============
router.get('/sso/silent', async (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: '未登录' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const userId = decoded.id || decoded.userId;
    const username = decoded.username || '';
    const nickname = decoded.nickname || decoded.username || '';
    const email = decoded.email || '';
    const role = decoded.role || 'user';
    await db.query(
      `INSERT INTO ky_users (id, username, nickname, email, role, last_login)
       VALUES (?, ?, ?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE nickname=VALUES(nickname), email=VALUES(email), role=VALUES(role), last_login=NOW()`,
      [userId, username, nickname, email, role]
    );
    const [[user]] = await db.query('SELECT * FROM ky_users WHERE id = ?', [userId]);
    res.json({ user });
  } catch { res.status(401).json({ error: 'token无效' }); }
});

// ============ SCHOOL ============
router.get('/school/list', async (req, res) => {
  try {
    const { keyword, tier, page = 1, pageSize = 20 } = req.query;
    let where = ['is_active = 1'], params = [];
    if (keyword) { where.push('name LIKE ?'); params.push(`%${keyword}%`); }
    if (tier) { where.push('tier = ?'); params.push(tier); }
    const offset = (Math.max(1, Number(page)) - 1) * Number(pageSize);
    const [[{ total }]] = await db.query(
      `SELECT COUNT(*) as total FROM ky_schools WHERE ${where.join(' AND ')}`, params
    );
    const [rows] = await db.query(
      `SELECT * FROM ky_schools WHERE ${where.join(' AND ')} ORDER BY tier='985' DESC, tier='211' DESC, paper_count DESC LIMIT ? OFFSET ?`,
      [...params, Number(pageSize), offset]
    );
    const [[stats]] = await db.query(`
      SELECT
        (SELECT COUNT(*) FROM ky_schools WHERE is_active=1) as school_count,
        (SELECT COUNT(*) FROM ky_majors) as major_count,
        (SELECT COUNT(*) FROM ky_exam_papers WHERE is_active=1) as paper_count
    `);
    res.json({ total, list: rows, page: Number(page), pageSize: Number(pageSize), stats });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/school/:id', async (req, res) => {
  try {
    const [[school]] = await db.query('SELECT * FROM ky_schools WHERE id = ? AND is_active = 1', [req.params.id]);
    if (!school) return res.status(404).json({ error: '学校不存在' });
    res.json(school);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ MAJOR ============
router.get('/major/hot', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 8;
    const [rows] = await db.query(
      `SELECT m.*, s.name as school_name FROM ky_majors m
       JOIN ky_schools s ON m.school_id = s.id
       WHERE m.is_hot = 1 AND m.paper_count > 0
       ORDER BY m.paper_count DESC, RAND() LIMIT ?`, [limit]
    );
    res.json({ list: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/major/list', async (req, res) => {
  try {
    const { school_id, keyword } = req.query;
    if (!school_id) return res.status(400).json({ error: '缺少school_id' });
    let where = ['school_id = ?'], params = [school_id];
    if (keyword) { where.push('name LIKE ?'); params.push(`%${keyword}%`); }
    const [rows] = await db.query(
      `SELECT * FROM ky_majors WHERE ${where.join(' AND ')} ORDER BY is_hot DESC, paper_count DESC`, params
    );
    res.json({ list: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/major/:id', async (req, res) => {
  try {
    const [[major]] = await db.query('SELECT * FROM ky_majors WHERE id = ?', [req.params.id]);
    if (!major) return res.status(404).json({ error: '专业不存在' });
    res.json(major);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ EXAM ============
router.get('/exam/preview/:id', async (req, res) => {
  try {
    const [[paper]] = await db.query(
      'SELECT preview_path, subject_name, year FROM ky_exam_papers WHERE id=? AND is_active=1', [req.params.id]
    );
    if (!paper || !paper.preview_path) return res.status(404).json({ error: '预览不可用' });
    // 先查新目录，再查旧目录
    let filePath = path.join(UPLOADS_DIR, paper.preview_path);
    if (!fs.existsSync(filePath)) {
      filePath = path.join('/home/ubuntu/aikaoyan.opensora2.cn/backend/uploads', paper.preview_path);
    }
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: '文件不存在' });
    res.download(filePath, `${paper.subject_name}_${paper.year}年_预览.pdf`);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/exam/list', async (req, res) => {
  try {
    const { major_id, school_id } = req.query;
    let where = ['is_active = 1'], params = [];
    if (major_id) { where.push('major_id = ?'); params.push(major_id); }
    if (school_id) { where.push('school_id = ?'); params.push(school_id); }
    const [rows] = await db.query(
      `SELECT * FROM ky_exam_papers WHERE ${where.join(' AND ')} ORDER BY year DESC, subject_name`, params
    );
    res.json({ list: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/exam/package', async (req, res) => {
  try {
    const { school_id, major_id } = req.query;
    if (!school_id || !major_id) return res.status(400).json({ error: '缺少参数' });
    const [papers] = await db.query(
      'SELECT * FROM ky_exam_papers WHERE school_id=? AND major_id=? AND is_active=1 ORDER BY year DESC',
      [school_id, major_id]
    );
    const pkg = calcPackagePrice(papers);
    res.json({ papers, ...pkg });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/exam/buy/single', auth, async (req, res) => {
  try {
    const { paper_id, email } = req.body;
    if (!paper_id || !email) return res.status(400).json({ error: '缺少参数' });
    const [[paper]] = await db.query('SELECT * FROM ky_exam_papers WHERE id=? AND is_active=1', [paper_id]);
    if (!paper) return res.status(404).json({ error: '真题不存在' });
    const userId = req.user.id || req.user.userId;
    const [[user]] = await db.query('SELECT * FROM ky_users WHERE id=?', [userId]);
    const amount = user && user.is_vip ? 0 : Number(paper.price);
    const orderNo = 'KY' + Date.now() + Math.random().toString(36).slice(2, 6).toUpperCase();
    await db.query(
      `INSERT INTO ky_orders (order_no, user_id, order_type, school_id, major_id, paper_ids, amount, email, pay_status, deliver_status)
       VALUES (?,?,'single',?,?,?,?,?,?,?)`,
      [orderNo, userId, paper.school_id, paper.major_id, JSON.stringify([paper.id]),
       amount, email, amount === 0 ? 'paid' : 'pending', 'pending']
    );
    res.json({ orderNo, amount, message: amount === 0 ? 'VIP免费，订单已创建' : '订单已创建，请完成支付' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/exam/buy/package', auth, async (req, res) => {
  try {
    const { school_id, major_id, email } = req.body;
    if (!school_id || !major_id || !email) return res.status(400).json({ error: '缺少参数' });
    const [papers] = await db.query(
      'SELECT * FROM ky_exam_papers WHERE school_id=? AND major_id=? AND is_active=1', [school_id, major_id]
    );
    if (!papers.length) return res.status(404).json({ error: '无可购买真题' });
    const userId = req.user.id || req.user.userId;
    const [[user]] = await db.query('SELECT * FROM ky_users WHERE id=?', [userId]);
    const pkg = calcPackagePrice(papers);
    const amount = user && user.is_vip ? 0 : pkg.amount;
    const orderNo = 'KY' + Date.now() + Math.random().toString(36).slice(2, 6).toUpperCase();
    await db.query(
      `INSERT INTO ky_orders (order_no, user_id, order_type, school_id, major_id, paper_ids, amount, email, pay_status)
       VALUES (?,?,'package',?,?,?,?,?,?)`,
      [orderNo, userId, school_id, major_id, JSON.stringify(papers.map(p => p.id)),
       amount, email, amount === 0 ? 'paid' : 'pending']
    );
    res.json({ orderNo, amount, discount: pkg.discount, total: pkg.total, message: amount === 0 ? 'VIP免费' : '订单已创建' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ MEMBER ============
router.post('/member/activate', auth, async (req, res) => {
  try {
    const userId = req.user.id || req.user.userId;
    const [[user]] = await db.query('SELECT * FROM ky_users WHERE id=?', [userId]);
    if (!user) return res.status(404).json({ error: '用户不存在' });
    if (user.is_vip) return res.json({ message: '您已是VIP会员' });
    const VIP_PRICE = 99;
    const orderNo = 'KYVIP' + Date.now() + Math.random().toString(36).slice(2, 6).toUpperCase();
    await db.query(
      `INSERT INTO ky_orders (order_no, user_id, order_type, amount, email, pay_status)
       VALUES (?,?,'vip',?,?,?)`,
      [orderNo, userId, VIP_PRICE, req.body.email || user.email || '', 'pending']
    );
    res.json({ orderNo, amount: VIP_PRICE, message: '订单已创建，请完成支付' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ ORDER ============
router.get('/order/list', auth, async (req, res) => {
  try {
    const userId = req.user.id || req.user.userId;
    const [rows] = await db.query(
      'SELECT * FROM ky_orders WHERE user_id=? ORDER BY created_at DESC', [userId]
    );
    res.json({ list: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/order/:orderNo', auth, async (req, res) => {
  try {
    const userId = req.user.id || req.user.userId;
    const [[order]] = await db.query(
      'SELECT * FROM ky_orders WHERE order_no=? AND user_id=?', [req.params.orderNo, userId]
    );
    if (!order) return res.status(404).json({ error: '订单不存在' });
    res.json(order);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ EMAIL ============
router.post('/email/resend', auth, async (req, res) => {
  try {
    const { order_no } = req.body;
    const userId = req.user.id || req.user.userId;
    const [[order]] = await db.query('SELECT * FROM ky_orders WHERE order_no=? AND user_id=?', [order_no, userId]);
    if (!order) return res.status(404).json({ error: '订单不存在' });
    if (order.pay_status !== 'paid') return res.status(400).json({ error: '订单未支付' });
    const paperIds = JSON.parse(order.paper_ids || '[]');
    if (!paperIds.length) return res.status(400).json({ error: '无真题文件' });
    const [papers] = await db.query(
      `SELECT * FROM ky_exam_papers WHERE id IN (${paperIds.map(() => '?').join(',')})`, paperIds
    );
    try {
      await sendPurchaseEmail(order.email, order.order_no, papers, order.amount);
      await db.query("UPDATE ky_orders SET deliver_status='sent' WHERE id=?", [order.id]);
      await db.query(
        'INSERT INTO ky_email_logs (order_id, user_id, email, subject, status) VALUES (?,?,?,?,?)',
        [order.id, userId, order.email, `订单${order.order_no}真题`, 'success']
      );
      res.json({ message: '邮件已重新发送' });
    } catch (e) {
      await db.query(
        'INSERT INTO ky_email_logs (order_id, user_id, email, subject, status, error_msg) VALUES (?,?,?,?,?,?)',
        [order.id, userId, order.email, `订单${order.order_no}真题`, 'failed', e.message]
      );
      res.status(500).json({ error: '邮件发送失败: ' + e.message });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ ADMIN ============
router.post('/admin/school', auth, requireAdmin, async (req, res) => {
  try {
    const { id, name, tier, province, logo_url } = req.body;
    if (id) {
      await db.query('UPDATE ky_schools SET name=?, tier=?, province=?, logo_url=? WHERE id=?',
        [name, tier, province, logo_url, id]);
    } else {
      await db.query('INSERT INTO ky_schools (name, tier, province, logo_url) VALUES (?,?,?,?)',
        [name, tier || '普通', province, logo_url]);
    }
    res.json({ message: '保存成功' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/admin/major', auth, requireAdmin, async (req, res) => {
  try {
    const { id, school_id, name, code, college, is_hot } = req.body;
    if (id) {
      await db.query('UPDATE ky_majors SET school_id=?, name=?, code=?, college=?, is_hot=? WHERE id=?',
        [school_id, name, code, college, is_hot ? 1 : 0, id]);
    } else {
      await db.query('INSERT INTO ky_majors (school_id, name, code, college, is_hot) VALUES (?,?,?,?,?)',
        [school_id, name, code, college, is_hot ? 1 : 0]);
    }
    res.json({ message: '保存成功' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/admin/exam/upload', auth, requireAdmin, upload.single('file'), async (req, res) => {
  try {
    const { school_id, major_id, subject_name, year } = req.body;
    if (!school_id || !major_id || !subject_name || !year)
      return res.status(400).json({ error: '缺少必填字段' });
    if (!req.file) return res.status(400).json({ error: '请上传文件' });

    const [[school]] = await db.query('SELECT tier FROM ky_schools WHERE id=?', [school_id]);
    const [[major]] = await db.query('SELECT is_hot FROM ky_majors WHERE id=?', [major_id]);
    const price = calcSinglePrice(school?.tier, Number(year), major?.is_hot);
    const filePath = req.file.filename;
    const fileType = path.extname(req.file.originalname).slice(1);
    const fileSize = req.file.size;

    let previewPath = null;
    if (fileType.toLowerCase() === 'pdf') {
      try {
        const { PDFDocument } = require('pdf-lib');
        const fullPath = path.join(UPLOADS_DIR, filePath);
        const pdfBytes = fs.readFileSync(fullPath);
        const pdfDoc = await PDFDocument.load(pdfBytes);
        if (pdfDoc.getPageCount() > 0) {
          const previewDoc = await PDFDocument.create();
          const [firstPage] = await previewDoc.copyPages(pdfDoc, [0]);
          previewDoc.addPage(firstPage);
          const previewBytes = await previewDoc.save();
          const previewFilename = 'preview_' + filePath;
          fs.writeFileSync(path.join(UPLOADS_DIR, previewFilename), previewBytes);
          previewPath = previewFilename;
        }
      } catch (err) {
        console.error('[aikaoyan] 提取预览失败:', err.message);
      }
    }

    await db.query(
      `INSERT INTO ky_exam_papers (school_id, major_id, subject_name, year, file_path, preview_path, file_type, file_size, price)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [school_id, major_id, subject_name, year, filePath, previewPath, fileType, fileSize, price]
    );
    await db.query('UPDATE ky_schools SET paper_count = paper_count + 1 WHERE id=?', [school_id]);
    await db.query('UPDATE ky_majors SET paper_count = paper_count + 1 WHERE id=?', [major_id]);
    res.json({ message: '上传成功', price, hasPreview: !!previewPath });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/admin/orders', auth, requireAdmin, async (req, res) => {
  try {
    const { page = 1, pageSize = 20, pay_status } = req.query;
    let where = [], params = [];
    if (pay_status) { where.push('pay_status = ?'); params.push(pay_status); }
    const wStr = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const offset = (Math.max(1, Number(page)) - 1) * Number(pageSize);
    const [[{ total }]] = await db.query(`SELECT COUNT(*) as total FROM ky_orders ${wStr}`, params);
    const [rows] = await db.query(
      `SELECT * FROM ky_orders ${wStr} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, Number(pageSize), offset]
    );
    res.json({ total, list: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/admin/order/confirm', auth, requireAdmin, async (req, res) => {
  try {
    const { order_no } = req.body;
    const [[order]] = await db.query('SELECT * FROM ky_orders WHERE order_no=?', [order_no]);
    if (!order) return res.status(404).json({ error: '订单不存在' });
    await db.query("UPDATE ky_orders SET pay_status='paid', paid_at=NOW() WHERE id=?", [order.id]);
    if (order.order_type === 'vip') {
      await db.query('UPDATE ky_users SET is_vip=1, vip_activated_at=NOW() WHERE id=?', [order.user_id]);
      if (order.email) { try { await sendVipEmail(order.email); } catch {} }
    }
    if (order.order_type !== 'vip' && order.email) {
      const paperIds = JSON.parse(order.paper_ids || '[]');
      if (paperIds.length) {
        const [papers] = await db.query(
          `SELECT * FROM ky_exam_papers WHERE id IN (${paperIds.map(() => '?').join(',')})`, paperIds
        );
        try {
          await sendPurchaseEmail(order.email, order.order_no, papers, order.amount);
          await db.query("UPDATE ky_orders SET deliver_status='sent' WHERE id=?", [order.id]);
        } catch {}
      }
    }
    res.json({ message: '支付已确认' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/admin/stats', auth, requireAdmin, async (req, res) => {
  try {
    const [[{ schoolCount }]] = await db.query('SELECT COUNT(*) as schoolCount FROM ky_schools WHERE is_active=1');
    const [[{ paperCount }]] = await db.query('SELECT COUNT(*) as paperCount FROM ky_exam_papers WHERE is_active=1');
    const [[{ orderCount }]] = await db.query('SELECT COUNT(*) as orderCount FROM ky_orders');
    const [[{ revenue }]] = await db.query("SELECT COALESCE(SUM(amount),0) as revenue FROM ky_orders WHERE pay_status='paid'");
    res.json({ schoolCount, paperCount, orderCount, revenue });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
