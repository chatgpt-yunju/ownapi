const router = require('express').Router();
const { auth, requireAdmin } = require('../middleware/auth');
const { getChinaDate } = require('../utils/chinaTime');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const nodemailer = require('nodemailer');
const { getSetting } = require('./quota');

const BACKUP_DIR = path.join(__dirname, '../../backups');
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'opensora2.cn@gmail.com';

async function getTransporter() {
  const host = await getSetting('smtp_host') || 'smtp.qq.com';
  const port = parseInt(await getSetting('smtp_port')) || 465;
  const user = await getSetting('smtp_user');
  const pass = await getSetting('smtp_pass');
  if (!user || !pass) return null;
  return nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass } });
}

// POST /api/backup — 触发数据库备份并发送邮件
router.post('/', auth, requireAdmin, (req, res) => {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

  const dbName = process.env.DB_NAME || 'wechat_cms';
  const dbUser = process.env.DB_USER || 'root';
  const dbPass = process.env.DB_PASSWORD || '';
  const dbHost = process.env.DB_HOST || 'localhost';
  const dbPort = process.env.DB_PORT || '3306';

  const timestamp = getChinaDate().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `backup-${timestamp}.sql`;
  const filepath = path.join(BACKUP_DIR, filename);

  // 安全转义：只允许合法字符，防止命令注入
  const safeStr = (s) => s.replace(/[^a-zA-Z0-9_\-\.@]/g, '');
  const safeHost = safeStr(dbHost);
  const safePort = safeStr(dbPort);
  const safeUser = safeStr(dbUser);
  const safeName = safeStr(dbName);

  // 使用 execFile + MYSQL_PWD 环境变量，避免密码出现在命令行参数和进程列表中
  const args = [`-h${safeHost}`, `-P${safePort}`, `-u${safeUser}`, '--result-file=' + filepath, safeName];
  const env = { ...process.env };
  if (dbPass) env.MYSQL_PWD = dbPass;

  execFile('mysqldump', args, { env }, async (err) => {
    if (err) {
      console.error('Backup error:', err);
      return res.status(500).json({ message: '备份失败，请检查数据库配置' });
    }
    const size = fs.statSync(filepath).size;

    // 发送邮件
    let mailSent = false;
    try {
      const transporter = await getTransporter();
      if (transporter) {
        await transporter.sendMail({
          from: await getSetting('smtp_user'),
          to: ADMIN_EMAIL,
          subject: `数据库备份 ${timestamp}`,
          text: `备份文件：${filename}\n大小：${(size / 1024).toFixed(1)} KB\n时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
          attachments: [{ filename, path: filepath }],
        });
        mailSent = true;
      }
    } catch (e) {
      console.error('Backup mail error:', e);
    }

    res.json({ message: '备份成功', filename, size, mailSent });
  });
});

// GET /api/backup — 获取备份列表
router.get('/', auth, requireAdmin, (req, res) => {
  if (!fs.existsSync(BACKUP_DIR)) return res.json([]);
  const files = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.endsWith('.sql'))
    .map(f => {
      const stat = fs.statSync(path.join(BACKUP_DIR, f));
      return { filename: f, size: stat.size, created_at: stat.mtime };
    })
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  res.json(files);
});

// GET /api/backup/:filename — 下载备份文件
router.get('/:filename', auth, requireAdmin, (req, res) => {
  const filename = path.basename(req.params.filename);
  if (!filename.endsWith('.sql')) return res.status(400).json({ message: '无效文件' });
  const filepath = path.join(BACKUP_DIR, filename);
  if (!fs.existsSync(filepath)) return res.status(404).json({ message: '文件不存在' });
  res.download(filepath, filename);
});

module.exports = router;
