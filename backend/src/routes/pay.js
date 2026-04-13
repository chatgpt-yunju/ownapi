const router = require('express').Router();
const db = require('../config/db');
const { auth } = require('../middleware/auth');
const { getSetting, addQuotaLog, getSettingCached } = require('./quota');
const { sendPaymentBackup } = require('../scheduler');

function formatPemKey(key, type) {
  const clean = key.replace(/-----.*?-----/g, '').replace(/\s/g, '');
  const header = type === 'private' ? '-----BEGIN PRIVATE KEY-----' : '-----BEGIN PUBLIC KEY-----';
  const footer = type === 'private' ? '-----END PRIVATE KEY-----' : '-----END PUBLIC KEY-----';
  const body = clean.match(/.{1,64}/g).join('\n');
  return `${header}\n${body}\n${footer}`;
}

function makeTradeNo(userId) {
  return `${Date.now()}${userId}${Math.floor(Math.random() * 10000)}`;
}

function isMobile(req) {
  const ua = (req.headers['user-agent'] || '').toLowerCase();
  return /mobile|android|iphone|ipad|ipod|windows phone/i.test(ua);
}

function getH5OrderMeta(order) {
  const amount = Number(order.actual_paid || order.amount || 0);
  if (order.order_type === 'vip') {
    return {
      amount,
      subject: `VIP会员 ${order.vip_days}天`,
    };
  }
  if (order.order_type === 'guest_key') {
    return {
      amount,
      subject: 'OpenClaw AI - 游客自动发卡',
    };
  }
  return {
    amount,
    subject: 'OpenClaw AI 额度充值',
  };
}

// GET /api/pay/options — 公开获取充值套餐和签到奖励
router.get('/options', async (req, res) => {
  const optionsStr = await getSetting('recharge_options');
  const checkinReward = await getSetting('checkin_reward');
  const inviteReward = await getSetting('invite_reward');
  const vipOptionsStr = await getSetting('vip_recharge_options');
  const vipCostPerDay = await getSetting('vip_cost_per_day');
  res.json({
    options: JSON.parse(optionsStr || '[]'),
    checkin_reward: parseInt(checkinReward) || 1,
    invite_reward: parseInt(inviteReward) || 10,
    vip_options: JSON.parse(vipOptionsStr || '[]'),
    vip_cost_per_day: parseInt(vipCostPerDay) || 1,
  });
});

// POST /api/pay/create — 创建充值订单（PC端返回JSON，手机端直接响应HTML跳转）
router.post('/create', auth, async (req, res) => {
  const { amount } = req.body;
  if (!amount) return res.status(400).json({ message: '请选择充值金额' });

  const optionsStr = await getSetting('recharge_options');
  const options = JSON.parse(optionsStr || '[]');
  const option = options.find(o => String(o.amount) === String(amount));
  if (!option) return res.status(400).json({ message: '无效的充值套餐' });

  const appId = await getSetting('alipay_app_id');
  const privateKey = await getSetting('alipay_private_key');
  const alipayPublicKey = await getSetting('alipay_public_key');

  if (!appId || !privateKey || !alipayPublicKey) {
    return res.status(500).json({ message: '支付宝配置未完成，请联系管理员' });
  }

  const { AlipaySdk, AlipayFormData } = require('alipay-sdk');

  const alipaySdk = new AlipaySdk({
    appId,
    privateKey: formatPemKey(privateKey, 'private'),
    alipayPublicKey: formatPemKey(alipayPublicKey, 'public'),
    keyType: 'PKCS8',
    gateway: 'https://openapi.alipay.com/gateway.do',
  });

  const outTradeNo = makeTradeNo(req.user.id);
  await db.query(
    'INSERT INTO recharge_orders (out_trade_no, user_id, amount, quota) VALUES (?, ?, ?, ?)',
    [outTradeNo, req.user.id, option.amount, option.quota]
  );

  const notifyUrl = await getSetting('alipay_notify_url') || '';
  const returnUrl = await getSetting('alipay_return_url') || '';

  const mobile = isMobile(req);
  const bizParams = {
    method: 'GET',
    bizContent: {
      outTradeNo,
      productCode: mobile ? 'QUICK_WAP_WAY' : 'FAST_INSTANT_TRADE_PAY',
      totalAmount: String(option.amount),
      subject: `视频领取配额 x${option.quota}`,
    },
  };
  if (notifyUrl) bizParams.notifyUrl = notifyUrl;
  if (returnUrl) bizParams.returnUrl = returnUrl;

  const apiMethod = mobile ? 'alipay.trade.wap.pay' : 'alipay.trade.page.pay';
  const rawResult = await alipaySdk.pageExecute(apiMethod, bizParams);

  if (mobile) {
    // 手机端：返回 tradeNo，前端用 location.href 跳转到 /api/pay/h5/:tradeNo
    return res.json({ mobile: true, tradeNo: outTradeNo });
  }

  // PC端：提取纯 URL，前端新标签页打开
  let payUrl = rawResult;
  if (typeof rawResult === 'string' && rawResult.includes('<form')) {
    const match = rawResult.match(/action="([^"]+)"/);
    if (match) payUrl = match[1].replace(/&amp;/g, '&');
  }
  res.json({ payUrl, mobile: false });
});

// POST /api/pay/create-vip — 支付宝购买VIP
router.post('/create-vip', auth, async (req, res) => {
  const { days } = req.body;
  if (!days || days < 1) return res.status(400).json({ message: '请选择VIP天数' });

  const vipOptionsStr = await getSetting('vip_recharge_options');
  const vipOptions = JSON.parse(vipOptionsStr || '[]');
  const opt = vipOptions.find(o => String(o.days) === String(days));
  if (!opt || !opt.alipay_price) return res.status(400).json({ message: '该套餐不支持支付宝购买' });

  const appId = await getSetting('alipay_app_id');
  const privateKey = await getSetting('alipay_private_key');
  const alipayPublicKey = await getSetting('alipay_public_key');
  if (!appId || !privateKey || !alipayPublicKey) {
    return res.status(500).json({ message: '支付宝配置未完成，请联系管理员' });
  }

  const { AlipaySdk } = require('alipay-sdk');
  const alipaySdk = new AlipaySdk({
    appId,
    privateKey: formatPemKey(privateKey, 'private'),
    alipayPublicKey: formatPemKey(alipayPublicKey, 'public'),
    keyType: 'PKCS8',
    gateway: 'https://openapi.alipay.com/gateway.do',
  });

  const outTradeNo = makeTradeNo(req.user.id);
  await db.query(
    'INSERT INTO recharge_orders (out_trade_no, user_id, amount, quota, order_type, vip_days) VALUES (?, ?, ?, ?, "vip", ?)',
    [outTradeNo, req.user.id, opt.alipay_price, opt.bonus_quota || 0, days]
  );

  const notifyUrl = await getSetting('alipay_notify_url') || '';
  const returnUrl = await getSetting('alipay_return_url') || '';
  const mobile = isMobile(req);
  const bizParams = {
    method: 'GET',
    bizContent: {
      outTradeNo,
      productCode: mobile ? 'QUICK_WAP_WAY' : 'FAST_INSTANT_TRADE_PAY',
      totalAmount: String(opt.alipay_price),
      subject: `VIP会员 ${days}天`,
    },
  };
  if (notifyUrl) bizParams.notifyUrl = notifyUrl;
  if (returnUrl) bizParams.returnUrl = returnUrl;

  const apiMethod = mobile ? 'alipay.trade.wap.pay' : 'alipay.trade.page.pay';
  const rawResult = await alipaySdk.pageExecute(apiMethod, bizParams);

  if (mobile) {
    return res.json({ mobile: true, tradeNo: outTradeNo });
  }
  let payUrl = rawResult;
  if (typeof rawResult === 'string' && rawResult.includes('<form')) {
    const match = rawResult.match(/action="([^"]+)"/);
    if (match) payUrl = match[1].replace(/&amp;/g, '&');
  }
  res.json({ payUrl, mobile: false });
});

// POST /api/pay/recharge-balance — 余额充值（支付宝）
router.post('/recharge-balance', auth, async (req, res) => {
  const { amount } = req.body;
  if (!amount || amount <= 0) {
    return res.status(400).json({ message: '充值金额必须大于0' });
  }

  const appId = await getSetting('alipay_app_id');
  const privateKey = await getSetting('alipay_private_key');
  const alipayPublicKey = await getSetting('alipay_public_key');
  if (!appId || !privateKey || !alipayPublicKey) {
    return res.status(500).json({ message: '支付宝配置未完成，请联系管理员' });
  }

  const { AlipaySdk } = require('alipay-sdk');
  const alipaySdk = new AlipaySdk({
    appId,
    privateKey: formatPemKey(privateKey, 'private'),
    alipayPublicKey: formatPemKey(alipayPublicKey, 'public'),
    keyType: 'PKCS8',
    gateway: 'https://openapi.alipay.com/gateway.do',
  });

  const outTradeNo = makeTradeNo(req.user.id);
  await db.query(
    'INSERT INTO recharge_orders (out_trade_no, user_id, amount, quota, order_type) VALUES (?, ?, ?, 0, "balance")',
    [outTradeNo, req.user.id, amount]
  );

  const notifyUrl = await getSetting('alipay_notify_url') || '';
  const returnUrl = await getSetting('alipay_return_url') || '';
  const mobile = isMobile(req);
  const bizParams = {
    method: 'GET',
    bizContent: {
      outTradeNo,
      productCode: mobile ? 'QUICK_WAP_WAY' : 'FAST_INSTANT_TRADE_PAY',
      totalAmount: String(amount),
      subject: `余额充值 ${amount}元`,
    },
  };
  if (notifyUrl) bizParams.notifyUrl = notifyUrl;
  if (returnUrl) bizParams.returnUrl = returnUrl;

  const apiMethod = mobile ? 'alipay.trade.wap.pay' : 'alipay.trade.page.pay';
  const rawResult = await alipaySdk.pageExecute(apiMethod, bizParams);

  if (mobile) {
    return res.json({ mobile: true, tradeNo: outTradeNo });
  }
  let payUrl = rawResult;
  if (typeof rawResult === 'string' && rawResult.includes('<form')) {
    const match = rawResult.match(/action=\"([^\"]+)\"/);
    if (match) payUrl = match[1].replace(/&amp;/g, '&');
  }
  res.json({ payUrl, mobile: false });
});

// POST /api/pay/buy-vip-with-quota — 已禁用（积分不可购买VIP）
router.post('/buy-vip-with-quota', auth, async (req, res) => {
  return res.status(403).json({ disabled: true, message: '积分购买VIP已关闭，请使用支付宝或余额购买' });
  const { days } = req.body;
  const vipDurationStr = await getSettingCached('vip_duration_options', '[7,30,90,180,365]');
  const validDays = JSON.parse(vipDurationStr);
  if (!days || !validDays.includes(Number(days))) {
    return res.status(400).json({ message: '无效的天数' });
  }

  const vipOptionsStr = await getSetting('vip_recharge_options');
  const vipOptions = JSON.parse(vipOptionsStr || '[]');
  const opt = vipOptions.find(o => String(o.days) === String(days));
  if (!opt || !opt.quota_price) {
    return res.status(400).json({ message: '该套餐暂不支持积分购买' });
  }

  const [[quota]] = await db.query('SELECT extra_quota FROM user_quota WHERE user_id = ?', [req.user.id]);
  const currentQuota = quota?.extra_quota || 0;
  if (currentQuota < opt.quota_price) {
    return res.status(400).json({
      message: '积分不足',
      required: opt.quota_price,
      current: currentQuota
    });
  }

  await db.query('UPDATE user_quota SET extra_quota = extra_quota - ? WHERE user_id = ?', [opt.quota_price, req.user.id]);

  const now = new Date();
  const [[q]] = await db.query('SELECT vip_expires_at FROM user_quota WHERE user_id = ?', [req.user.id]);
  const base = q?.vip_expires_at && new Date(q.vip_expires_at) > now ? new Date(q.vip_expires_at) : now;
  const newExpiry = new Date(base.getTime() + days * 86400000);
  await db.query('UPDATE user_quota SET vip_expires_at = ?, vip_tier = ? WHERE user_id = ?', [newExpiry, days, req.user.id]);

  const outTradeNo = makeTradeNo(req.user.id);
  await db.query(
    'INSERT INTO recharge_orders (out_trade_no, user_id, amount, quota, order_type, vip_days, status, paid_at) VALUES (?, ?, ?, ?, "vip_quota", ?, "paid", NOW())',
    [outTradeNo, req.user.id, 0, opt.quota_price, days]
  );

  res.json({
    message: 'VIP 开通成功',
    vip_expires_at: newExpiry.toISOString().slice(0, 19).replace('T', ' ')
  });
});

// POST /api/pay/buy-vip-with-balance — 使用余额购买VIP
router.post('/buy-vip-with-balance', auth, async (req, res) => {
  const { days } = req.body;
  const vipBalanceDurationStr = await getSettingCached('vip_duration_options', '[7,30,90,180,365]');
  const validBalanceDays = JSON.parse(vipBalanceDurationStr);
  if (!days || !validBalanceDays.includes(Number(days))) {
    return res.status(400).json({ message: '无效的天数' });
  }

  const vipOptionsStr = await getSetting('vip_recharge_options');
  const vipOptions = JSON.parse(vipOptionsStr || '[]');
  const opt = vipOptions.find(o => String(o.days) === String(days));
  if (!opt || !opt.alipay_price) {
    return res.status(400).json({ message: '该套餐不支持余额购买' });
  }

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    const [[user]] = await connection.query(
      'SELECT balance FROM user_quota WHERE user_id = ? FOR UPDATE',
      [req.user.id]
    );

    const currentBalance = user?.balance || 0;
    if (currentBalance < opt.alipay_price) {
      await connection.rollback();
      return res.status(400).json({
        message: '余额不足',
        required: opt.alipay_price,
        current: currentBalance
      });
    }

    const newBalance = currentBalance - opt.alipay_price;

    await connection.query(
      'UPDATE user_quota SET balance = ? WHERE user_id = ?',
      [newBalance, req.user.id]
    );

    const now = new Date();
    const [[q]] = await connection.query(
      'SELECT vip_expires_at FROM user_quota WHERE user_id = ?',
      [req.user.id]
    );
    const base = q?.vip_expires_at && new Date(q.vip_expires_at) > now
      ? new Date(q.vip_expires_at)
      : now;
    const newExpiry = new Date(base.getTime() + days * 86400000);
    await connection.query(
      'UPDATE user_quota SET vip_expires_at = ?, vip_tier = ? WHERE user_id = ?',
      [newExpiry, days, req.user.id]
    );

    await connection.query(
      'UPDATE user_quota SET extra_quota = extra_quota + ? WHERE user_id = ?',
      [opt.bonus_quota || 0, req.user.id]
    );

    const outTradeNo = makeTradeNo(req.user.id);
    await connection.query(
      'INSERT INTO balance_logs (user_id, amount, balance_before, balance_after, type, related_order_id, description) VALUES (?, ?, ?, ?, "buy_vip", ?, ?)',
      [req.user.id, -opt.alipay_price, currentBalance, newBalance, outTradeNo, `购买VIP ${days}天`]
    );

    await connection.query(
      'INSERT INTO recharge_orders (out_trade_no, user_id, amount, quota, order_type, vip_days, status, paid_at) VALUES (?, ?, ?, ?, "vip_balance", ?, "paid", NOW())',
      [outTradeNo, req.user.id, opt.alipay_price, opt.bonus_quota || 0, days]
    );

    await connection.commit();
    res.json({
      message: 'VIP 开通成功',
      vip_expires_at: newExpiry.toISOString().slice(0, 19).replace('T', ' '),
      balance: newBalance
    });
  } catch (error) {
    await connection.rollback();
    console.error('余额购买VIP失败:', error);
    res.status(500).json({ message: '服务器错误' });
  } finally {
    connection.release();
  }
});

// GET /api/pay/h5/:tradeNo — 手机端跳转支付宝（服务端直接响应HTML）
router.get('/h5/:tradeNo', async (req, res) => {
  const { tradeNo } = req.params;
  const [[order]] = await db.query('SELECT * FROM recharge_orders WHERE out_trade_no = ?', [tradeNo]);
  if (!order) return res.status(404).send('订单不存在');

  const appId = await getSetting('alipay_app_id');
  const privateKey = await getSetting('alipay_private_key');
  const alipayPublicKey = await getSetting('alipay_public_key');
  if (!appId || !privateKey || !alipayPublicKey) return res.status(500).send('支付宝配置未完成');

  const { AlipaySdk } = require('alipay-sdk');
  const alipaySdk = new AlipaySdk({
    appId,
    privateKey: formatPemKey(privateKey, 'private'),
    alipayPublicKey: formatPemKey(alipayPublicKey, 'public'),
    keyType: 'PKCS8',
    gateway: 'https://openapi.alipay.com/gateway.do',
  });

  const notifyUrl = await getSetting('alipay_notify_url') || '';
  const returnUrl = await getSetting('alipay_return_url') || '';
  const { amount: payAmount, subject } = getH5OrderMeta(order);
  const bizParams = {
    method: 'GET',
    bizContent: {
      outTradeNo: order.out_trade_no,
      productCode: 'QUICK_WAP_WAY',
      totalAmount: payAmount.toFixed(2),
      subject,
    },
  };
  if (notifyUrl) bizParams.notifyUrl = notifyUrl;
  if (returnUrl) bizParams.returnUrl = returnUrl;

  const rawResult = await alipaySdk.pageExecute('alipay.trade.wap.pay', bizParams);
  let html = rawResult;
  if (typeof rawResult === 'string' && !rawResult.includes('<form')) {
    html = `<!DOCTYPE html><html><body><script>location.href="${rawResult}"<\/script></body></html>`;
  } else {
    html = `<!DOCTYPE html><html><body>${rawResult}<script>document.forms[0].submit()<\/script></body></html>`;
  }
  res.send(html);
});


router.post('/notify', async (req, res) => {
  try {
    const appId = await getSetting('alipay_app_id');
    const privateKey = await getSetting('alipay_private_key');
    const alipayPublicKey = await getSetting('alipay_public_key');
    const { AlipaySdk } = require('alipay-sdk');
    const alipaySdk = new AlipaySdk({
      appId,
      privateKey: formatPemKey(privateKey, 'private'),
      alipayPublicKey: formatPemKey(alipayPublicKey, 'public'),
      keyType: 'PKCS8',
    });

    const ok = alipaySdk.checkNotifySign(req.body);
    if (!ok) return res.send('fail');

    const { out_trade_no, trade_status } = req.body;
    if (trade_status === 'TRADE_SUCCESS' || trade_status === 'TRADE_FINISHED') {
      const [[order]] = await db.query('SELECT * FROM recharge_orders WHERE out_trade_no = ?', [out_trade_no]);
      if (order && order.status === 'pending') {
        await db.query('UPDATE recharge_orders SET status = "paid", paid_at = NOW() WHERE out_trade_no = ?', [out_trade_no]);
        await db.query(
          'INSERT INTO user_quota (user_id, extra_quota) VALUES (?, ?) ON DUPLICATE KEY UPDATE extra_quota = extra_quota + ?',
          [order.user_id, order.quota, order.quota]
        );
        await addQuotaLog(order.user_id, order.quota, `支付宝充值 ¥${order.amount}`);

        // 如果是VIP订单，授予会员资格
        if (order.order_type === 'vip' && order.vip_days > 0) {
          const now = new Date();
          const [[q]] = await db.query('SELECT vip_expires_at FROM user_quota WHERE user_id = ?', [order.user_id]);
          const base = q?.vip_expires_at && new Date(q.vip_expires_at) > now ? new Date(q.vip_expires_at) : now;
          const newExpiry = new Date(base.getTime() + order.vip_days * 86400000);
          await db.query('UPDATE user_quota SET vip_expires_at = ?, vip_tier = ? WHERE user_id = ?', [newExpiry, order.vip_days, order.user_id]);
        }

        // 如果是余额充值订单，增加余额
        if (order.order_type === 'balance') {
          const [[user]] = await db.query('SELECT balance FROM user_quota WHERE user_id = ?', [order.user_id]);
          const oldBalance = user?.balance || 0;
          const newBalance = oldBalance + order.amount;

          await db.query(
            'INSERT INTO user_quota (user_id, balance) VALUES (?, ?) ON DUPLICATE KEY UPDATE balance = ?',
            [order.user_id, newBalance, newBalance]
          );

          await db.query(
            'INSERT INTO balance_logs (user_id, amount, balance_before, balance_after, type, related_order_id, description) VALUES (?, ?, ?, ?, "recharge", ?, ?)',
            [order.user_id, order.amount, oldBalance, newBalance, out_trade_no, `支付宝充值${order.amount}元`]
          );
        }

        sendPaymentBackup({ source: 'recharge', tradeNo: out_trade_no, amount: order.amount, userId: order.user_id }).catch(e => console.error('[PayBackup] 触发失败:', e.message));
      }
    }
    res.send('success');
  } catch (e) {
    console.error('Alipay notify error:', e);
    res.send('fail');
  }
});

// GET /api/pay/orders — 当前用户充值记录
router.get('/orders', auth, async (req, res) => {
  const [rows] = await db.query(
    'SELECT out_trade_no, amount, quota, status, created_at, paid_at FROM recharge_orders WHERE user_id = ? ORDER BY created_at DESC',
    [req.user.id]
  );
  res.json(rows);
});

module.exports = router;
