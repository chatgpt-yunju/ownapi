/**
 * 支付路由
 * 支持支付宝支付购买套餐，余额优先抵扣
 */

const router = require('express').Router();
const db = require('../config/db');
const { formatPemKey, makeTradeNo, isMobile } = require('../utils/alipay');
const { generateApiKey, hashApiKey, maskApiKey } = require('../utils/crypto');

/**
 * 从 settings 表获取配置
 */
async function getSetting(key) {
  const [[row]] = await db.query('SELECT value FROM settings WHERE `key` = ?', [key]);
  return row?.value || '';
}

/**
 * POST /payment/create-package
 * 创建套餐购买订单
 * Body: { package_id: number }
 */
router.post('/create-package', async (req, res) => {
  const { package_id } = req.body;
  const userId = req.user.id;

  try {
    // 查询套餐
    const [[pkg]] = await db.query('SELECT * FROM openclaw_packages WHERE id = ?', [package_id]);
    if (!pkg) {
      return res.status(404).json({ error: '套餐不存在' });
    }

    // 查询用户余额
    const [[quota]] = await db.query('SELECT balance FROM user_quota WHERE user_id = ?', [userId]);
    const userBalance = Number(quota?.balance || 0);

    // 计算需支付金额
    const packagePrice = Number(pkg.price);
    const balanceUsed = Math.min(userBalance, packagePrice);
    const needPay = Math.max(0, packagePrice - balanceUsed);

    // 生成订单号
    const outTradeNo = makeTradeNo(userId);

    // 如果不需要支付（完全使用余额）
    if (needPay === 0) {
      const conn = await db.getConnection();
      try {
        await conn.beginTransaction();

        // 检查10密钥上限
        const [[{ cnt }]] = await conn.query(
          'SELECT COUNT(*) as cnt FROM openclaw_api_keys WHERE user_id = ?',
          [userId]
        );
        if (cnt >= 10) {
          await conn.rollback();
          return res.status(400).json({ error: '已达到10个密钥上限，请先删除旧密钥' });
        }

        // 获取当前余额
        const [[currentQuota]] = await conn.query('SELECT balance FROM user_quota WHERE user_id = ?', [userId]);
        const balanceBefore = Number(currentQuota.balance);
        const balanceAfter = balanceBefore - balanceUsed;

        // 扣除余额
        await conn.query('UPDATE user_quota SET balance = ? WHERE user_id = ?', [balanceAfter, userId]);

        // 记录余额日志
        await conn.query(
          'INSERT INTO balance_logs (user_id, amount, balance_before, balance_after, type, description) VALUES (?, ?, ?, ?, "buy_quota", ?)',
          [userId, -balanceUsed, balanceBefore, balanceAfter, `购买套餐: ${pkg.name}`]
        );

        // 创建订单
        await conn.query(
          'INSERT INTO recharge_orders (out_trade_no, user_id, amount, balance_used, actual_paid, package_id, status, order_type, paid_at) VALUES (?, ?, ?, ?, ?, ?, "paid", "package", NOW())',
          [outTradeNo, userId, packagePrice, balanceUsed, 0, package_id]
        );

        // 创建用户套餐
        const [pkgResult] = await conn.query(
          'INSERT INTO openclaw_user_packages (user_id, package_id, expires_at, status) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 30 DAY), "active")',
          [userId, package_id]
        );

        // 创建 API Key
        const key = generateApiKey();
        const keyHash = hashApiKey(key);
        const keyDisplay = maskApiKey(key);
        const keyPrefix = key.slice(0, 7);
        const keyName = `${pkg.name} - ${new Date().toISOString().split('T')[0]}`;

        await conn.query(
          'INSERT INTO openclaw_api_keys (user_id, package_id, key_prefix, key_hash, key_display, name) VALUES (?, ?, ?, ?, ?, ?)',
          [userId, pkgResult.insertId, keyPrefix, keyHash, keyDisplay, keyName]
        );

        await conn.commit();

        return res.json({
          success: true,
          paid_by_balance: true,
          api_key: key,
          key_display: keyDisplay,
          message: `已使用余额 ¥${balanceUsed} 购买 ${pkg.name} 套餐`
        });
      } catch (err) {
        await conn.rollback();
        throw err;
      } finally {
        conn.release();
      }
    }


    // 需要支付宝支付
    const appId = await getSetting('alipay_app_id');
    const privateKey = await getSetting('alipay_private_key');
    const alipayPublicKey = await getSetting('alipay_public_key');

    if (!appId || !privateKey || !alipayPublicKey) {
      return res.status(500).json({ error: '支付宝配置未完成，请联系管理员' });
    }

    // 创建待支付订单
    await db.query(
      'INSERT INTO recharge_orders (out_trade_no, user_id, amount, balance_used, actual_paid, package_id, status, order_type) VALUES (?, ?, ?, ?, ?, ?, "pending", "package")',
      [outTradeNo, userId, packagePrice, balanceUsed, needPay, package_id]
    );

    // 创建支付宝订单
    const { AlipaySdk } = require('alipay-sdk');
    const alipaySdk = new AlipaySdk({
      appId,
      privateKey: formatPemKey(privateKey, 'private'),
      alipayPublicKey: formatPemKey(alipayPublicKey, 'public'),
      keyType: 'PKCS8',
      gateway: 'https://openapi.alipay.com/gateway.do',
    });

    const notifyUrl = await getSetting('alipay_notify_url');
    const returnUrl = await getSetting('alipay_return_url');
    const mobile = isMobile(req);

    const bizParams = {
      method: 'GET',
      bizContent: {
        outTradeNo: outTradeNo,
        productCode: mobile ? 'QUICK_WAP_WAY' : 'FAST_INSTANT_TRADE_PAY',
        totalAmount: needPay.toFixed(2),
        subject: `OpenClaw AI - ${pkg.name} 套餐`,
        body: `购买 ${pkg.name} 套餐，使用余额 ¥${balanceUsed}，需支付 ¥${needPay}`,
      },
    };
    if (notifyUrl) bizParams.notifyUrl = notifyUrl;
    if (returnUrl) bizParams.returnUrl = returnUrl;

    const apiMethod = mobile ? 'alipay.trade.wap.pay' : 'alipay.trade.page.pay';
    const rawResult = await alipaySdk.pageExecute(apiMethod, bizParams);

    if (mobile) {
      return res.json({ mobile: true, tradeNo: outTradeNo });
    }

    // PC端：提取纯 URL
    let payUrl = rawResult;
    if (typeof rawResult === 'string' && rawResult.includes('<form')) {
      const match = rawResult.match(/action="([^"]+)"/);
      if (match) payUrl = match[1].replace(/&amp;/g, '&');
    }

    return res.json({
      success: true,
      paid_by_balance: false,
      payUrl,
      mobile: false,
      out_trade_no: outTradeNo,
      amount: packagePrice,
      balance_used: balanceUsed,
      need_pay: needPay
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '创建订单失败' });
  }
});

/**
 * POST /payment/alipay/notify
 * 支付宝异步回调
 */
router.post('/alipay/notify', async (req, res) => {
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

    // 验证签名
    const ok = alipaySdk.checkNotifySign(req.body);
    if (!ok) return res.send('fail');

    const { out_trade_no, trade_no, trade_status } = req.body;

    if (trade_status === 'TRADE_SUCCESS' || trade_status === 'TRADE_FINISHED') {
      // 查询订单
      const [[order]] = await db.query('SELECT * FROM recharge_orders WHERE out_trade_no = ?', [out_trade_no]);
      if (!order || order.status === 'paid') {
        return res.send('success');
      }

      const conn = await db.getConnection();
      try {
        await conn.beginTransaction();

        // 检查10密钥上限
        const [[{ cnt }]] = await conn.query(
          'SELECT COUNT(*) as cnt FROM openclaw_api_keys WHERE user_id = ?',
          [order.user_id]
        );
        if (cnt >= 10) {
          await conn.rollback();
          return res.send('fail');
        }

        // 更新订单状态
        await conn.query(
          'UPDATE recharge_orders SET status = "paid", alipay_trade_no = ?, paid_at = NOW() WHERE out_trade_no = ?',
          [trade_no, out_trade_no]
        );

        // 扣除余额（如有）
        if (order.balance_used > 0) {
          const [[quota]] = await conn.query('SELECT balance FROM user_quota WHERE user_id = ?', [order.user_id]);
          const balanceBefore = Number(quota?.balance || 0);
          const balanceAfter = balanceBefore - Number(order.balance_used);

          await conn.query('UPDATE user_quota SET balance = ? WHERE user_id = ?', [balanceAfter, order.user_id]);

          await conn.query(
            'INSERT INTO balance_logs (user_id, amount, balance_before, balance_after, type, description) VALUES (?, ?, ?, ?, "buy_quota", ?)',
            [order.user_id, -order.balance_used, balanceBefore, balanceAfter, `购买套餐使用余额: ${out_trade_no}`]
          );
        }

        // 创建用户套餐
        const [[pkg]] = await conn.query('SELECT * FROM openclaw_packages WHERE id = ?', [order.package_id]);
        const [pkgResult] = await conn.query(
          'INSERT INTO openclaw_user_packages (user_id, package_id, expires_at, status) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 30 DAY), "active")',
          [order.user_id, order.package_id]
        );

        // 创建 API Key
        const key = generateApiKey();
        const keyHash = hashApiKey(key);
        const keyDisplay = maskApiKey(key);
        const keyPrefix = key.slice(0, 7);
        const keyName = `${pkg.name} - ${new Date().toISOString().split('T')[0]}`;

        await conn.query(
          'INSERT INTO openclaw_api_keys (user_id, package_id, key_prefix, key_hash, key_display, name) VALUES (?, ?, ?, ?, ?, ?)',
          [order.user_id, pkgResult.insertId, keyPrefix, keyHash, keyDisplay, keyName]
        );

        await conn.commit();
      } catch (err) {
        await conn.rollback();
        throw err;
      } finally {
        conn.release();
      }
    }

    res.send('success');
  } catch (err) {
    console.error(err);
    res.send('fail');
  }
});

/**
 * GET /payment/order/:out_trade_no
 * 查询订单状态
 */
router.get('/order/:out_trade_no', async (req, res) => {
  const { out_trade_no } = req.params;
  const [[order]] = await db.query('SELECT * FROM recharge_orders WHERE out_trade_no = ?', [out_trade_no]);
  if (!order) return res.status(404).json({ error: '订单不存在' });
  res.json(order);
});

/**
 * POST /payment/create-recharge
 * 创建加油包充值订单
 * Body: { amount: number }
 */
router.post('/create-recharge', async (req, res) => {
  const { amount } = req.body;
  const userId = req.user.id;

  try {
    // 验证充值金额
    const validAmounts = [50, 100, 500, 1000];
    if (!validAmounts.includes(Number(amount))) {
      return res.status(400).json({ error: '无效的充值金额' });
    }

    // 计算赠送金额
    let bonusAmount = 0;
    if (amount >= 1000) {
      bonusAmount = 150;
    } else if (amount >= 500) {
      bonusAmount = 50;
    }

    const totalAmount = Number(amount) + bonusAmount;

    // 生成订单号
    const outTradeNo = makeTradeNo(userId);

    // 创建订单
    await db.query(
      `INSERT INTO recharge_orders (out_trade_no, user_id, amount, quota, status, order_type, bonus_quota)
       VALUES (?, ?, ?, 0, 'pending', 'recharge', ?)`,
      [outTradeNo, userId, totalAmount, bonusAmount]
    );

    // 获取支付宝配置
    const AlipaySdk = require('alipay-sdk').default;
    const AlipayFormData = require('alipay-sdk/lib/form').default;

    const appId = await getSetting('alipay_app_id');
    const privateKey = formatPemKey(await getSetting('alipay_private_key'), 'PRIVATE');
    const alipayPublicKey = formatPemKey(await getSetting('alipay_public_key'), 'PUBLIC');
    const notifyUrl = await getSetting('alipay_notify_url');
    const returnUrl = await getSetting('alipay_return_url');

    const alipaySdk = new AlipaySdk({
      appId,
      privateKey,
      alipayPublicKey,
      gateway: 'https://openapi.alipay.com/gateway.do'
    });

    const formData = new AlipayFormData();
    formData.setMethod('get');

    const bizContent = {
      out_trade_no: outTradeNo,
      product_code: 'FAST_INSTANT_TRADE_PAY',
      total_amount: amount.toFixed(2),
      subject: `OpenClaw AI 加油包充值 ¥${amount}`,
      body: bonusAmount > 0 ? `充值 ¥${amount}，赠送 ¥${bonusAmount}` : `充值 ¥${amount}`
    };

    formData.addField('bizContent', bizContent);
    formData.addField('notifyUrl', notifyUrl);
    formData.addField('returnUrl', returnUrl);

    const payUrl = await alipaySdk.exec(
      'alipay.trade.page.pay',
      {},
      { formData }
    );

    res.json({
      out_trade_no: outTradeNo,
      amount: totalAmount,
      bonus: bonusAmount,
      payUrl
    });

  } catch (err) {
    console.error('创建充值订单失败:', err);
    res.status(500).json({ error: '创建充值订单失败' });
  }
});

module.exports = router;
