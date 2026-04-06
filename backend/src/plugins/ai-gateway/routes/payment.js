/**
 * 支付路由
 * 支持支付宝支付购买套餐，余额优先抵扣
 */

const router = require('express').Router();
const db = require('../../../config/db');
const { formatPemKey, makeTradeNo, isMobile } = require('../utils/alipay');
const { generateApiKey, hashApiKey, maskApiKey } = require('../utils/crypto');
const { adjustBalance } = require('../utils/billing');
const { getChinaDateString } = require('../../../utils/chinaTime');
const { grantFirstPaidInviteReward } = require('../utils/inviteRewards');

/**
 * 从 settings 表获取配置
 */
async function getSetting(key) {
  const [[row]] = await db.query('SELECT value FROM settings WHERE `key` = ?', [key]);
  return row?.value || '';
}

function getInviteEligiblePaidAmount(order) {
  if (!order) return 0;
  if (order.order_type === 'recharge') {
    const actualPaid = Number(order.actual_paid || 0);
    if (actualPaid > 0) return actualPaid;
    return Math.max(0, Number(order.amount || 0) - Number(order.bonus_quota || 0));
  }
  return Number(order.actual_paid || order.amount || 0);
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

    // 计算需支付金额（API 配额余额不作为支付抵扣，配额与付款钱包分离）
    const packagePrice = Number(pkg.price);
    const balanceUsed = 0;
    const needPay = packagePrice;

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

        if (balanceUsed > 0) {
          const walletResult = await adjustBalance(
            userId,
            'wallet',
            -balanceUsed,
            'buy_package',
            `购买套餐: ${pkg.name}`,
            { source: 'payment', package_id: pkg.id },
            conn
          );
          if (!walletResult.success) {
            await conn.rollback();
            return res.status(400).json({ error: '钱包余额不足' });
          }
        }

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

        // 充值月度配额
        const monthlyQuota = Number(pkg.monthly_quota);
        if (monthlyQuota > 0) {
          await adjustBalance(
            userId,
            'quota',
            monthlyQuota,
            'recharge',
            `购买${pkg.name}套餐，获得月度配额 $${monthlyQuota}`,
            { source: 'payment', package_id: pkg.id },
            conn
          );
        }

        // 创建 API Key
        const key = generateApiKey();
        const keyHash = hashApiKey(key);
        const keyDisplay = maskApiKey(key);
        const keyPrefix = key.slice(0, 7);
        const keyName = `${pkg.name} - ${getChinaDateString()}`;

        await conn.query(
          'INSERT INTO openclaw_api_keys (user_id, package_id, key_prefix, key_hash, key_display, name) VALUES (?, ?, ?, ?, ?, ?)',
          [userId, pkgResult.insertId, keyPrefix, keyHash, keyDisplay, keyName]
        );

        await grantFirstPaidInviteReward({
          conn,
          inviteeUserId: userId,
          outTradeNo: out_trade_no,
          paidAmount: getInviteEligiblePaidAmount(order),
        });

        await conn.commit();

        return res.json({
          success: true,
          paid_by_balance: true,
          api_key: key,
          key_display: keyDisplay,
          message: `已使用余额 ¥${balanceUsed} 购买 ${pkg.name} 套餐，获得月度配额 $${monthlyQuota}`
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
      'INSERT INTO recharge_orders (out_trade_no, user_id, amount, quota, balance_used, actual_paid, package_id, status, order_type) VALUES (?, ?, ?, 0, ?, ?, ?, "pending", "package")',
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
      return res.json({ mobile: true, tradeNo: outTradeNo, payUrl: rawResult.includes('<form') ? rawResult.match(/action="([^"]+)"/)[1].replace(/&amp;/g, '&') : rawResult, out_trade_no: outTradeNo, amount: packagePrice, need_pay: needPay });
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

        // 更新订单状态
        await conn.query(
          'UPDATE recharge_orders SET status = "paid", alipay_trade_no = ?, paid_at = NOW() WHERE out_trade_no = ?',
          [trade_no, out_trade_no]
        );

        // 扣除余额（如有）
        if (order.balance_used > 0) {
          const walletResult = await adjustBalance(
            order.user_id,
            'wallet',
            -Number(order.balance_used),
            'buy_package',
            `购买套餐使用钱包余额: ${out_trade_no}`,
            { source: 'alipay_notify', order_type: 'package', out_trade_no },
            conn
          );
          if (!walletResult.success) {
            await conn.rollback();
            return res.send('fail');
          }
        }

        if (order.order_type === 'package' && order.package_id) {
          // 检查10密钥上限
          const [[{ cnt }]] = await conn.query(
            'SELECT COUNT(*) as cnt FROM openclaw_api_keys WHERE user_id = ?',
            [order.user_id]
          );
          if (cnt >= 10) {
            await conn.rollback();
            return res.send('fail');
          }
        }

        if (order.order_type === 'package' && order.package_id) {
          // 创建用户套餐
          const [[pkg]] = await conn.query('SELECT * FROM openclaw_packages WHERE id = ?', [order.package_id]);
          const [pkgResult] = await conn.query(
            'INSERT INTO openclaw_user_packages (user_id, package_id, expires_at, status) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 30 DAY), "active")',
            [order.user_id, order.package_id]
          );

          // 充值月度配额
          const monthlyQuota = Number(pkg.monthly_quota);
          if (monthlyQuota > 0) {
            await adjustBalance(
              order.user_id,
              'quota',
              monthlyQuota,
              'recharge',
              `购买${pkg.name}套餐，获得月度配额 $${monthlyQuota}`,
              { source: 'alipay_notify', order_type: 'package', package_id: pkg.id, out_trade_no },
              conn
            );
          }

          // 创建 API Key
          const key = generateApiKey();
          const keyHash = hashApiKey(key);
          const keyDisplay = maskApiKey(key);
          const keyPrefix = key.slice(0, 7);
          const keyName = `${pkg.name} - ${getChinaDateString()}`;

          await conn.query(
            'INSERT INTO openclaw_api_keys (user_id, package_id, key_prefix, key_hash, key_display, name) VALUES (?, ?, ?, ?, ?, ?)',
            [order.user_id, pkgResult.insertId, keyPrefix, keyHash, keyDisplay, keyName]
          );
        } else if (order.order_type === 'recharge') {
          const totalQuota = Number(order.amount || 0);
          if (totalQuota > 0) {
            await adjustBalance(
              order.user_id,
              'quota',
              totalQuota,
              'booster',
              `加油包充值成功，获得 $${totalQuota}`,
              { source: 'alipay_notify', order_type: 'recharge', out_trade_no },
              conn
            );
          }
        }

        await grantFirstPaidInviteReward({
          conn,
          inviteeUserId: order.user_id,
          outTradeNo: out_trade_no,
          paidAmount: getInviteEligiblePaidAmount(order),
        });

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
 * GET /payment/my-orders
 * 获取当前用户的订单列表
 */
router.get('/my-orders', async (req, res) => {
  const userId = req.user.id;
  const status = req.query.status || '';
  try {
    let sql = `SELECT id, out_trade_no, user_id, amount, balance_used, actual_paid, status, order_type, package_id, created_at, paid_at, bonus_quota
               FROM recharge_orders WHERE user_id = ?`;
    const params = [userId];
    if (status) {
      sql += ' AND status = ?';
      params.push(status);
    }
    sql += ' ORDER BY created_at DESC LIMIT 50';
    const [orders] = await db.query(sql, params);

    // 获取套餐名称
    const packageIds = [...new Set(orders.filter(o => o.package_id).map(o => o.package_id))];
    const packageNames = {};
    if (packageIds.length) {
      const [pkgs] = await db.query('SELECT id, name FROM openclaw_packages WHERE id IN (?)', [packageIds]);
      pkgs.forEach(p => packageNames[p.id] = p.name);
    }

    const result = orders.map(o => ({
      ...o,
      package_name: o.package_id ? (packageNames[o.package_id] || '未知套餐') : null
    }));

    res.json({ orders: result });
  } catch (err) {
    console.error('获取订单列表失败:', err);
    res.status(500).json({ error: '获取订单列表失败' });
  }
});

/**
 * POST /payment/verify/:out_trade_no
 * 手动验证并完成订单（用户主动调用）
 */
router.post('/verify/:out_trade_no', async (req, res) => {
  const { out_trade_no } = req.params;
  const userId = req.user.id;

  try {
    // 查询订单
    const [[order]] = await db.query('SELECT * FROM recharge_orders WHERE out_trade_no = ? AND user_id = ?', [out_trade_no, userId]);
    if (!order) {
      return res.status(404).json({ error: '订单不存在' });
    }
    if (order.status === 'paid') {
      return res.json({ success: true, message: '订单已完成', already_paid: true });
    }
    if (order.status !== 'pending') {
      return res.status(400).json({ error: '订单状态异常' });
    }

    // 调用支付宝查询接口
    const appId = await getSetting('alipay_app_id');
    const privateKey = formatPemKey(await getSetting('alipay_private_key'), 'private');
    const alipayPublicKey = formatPemKey(await getSetting('alipay_public_key'), 'public');

    const { AlipaySdk } = require('alipay-sdk');
    const alipaySdk = new AlipaySdk({
      appId,
      privateKey,
      alipayPublicKey,
      keyType: 'PKCS8',
    });

    // 查询支付宝订单状态
    const queryResult = await alipaySdk.exec('alipay.trade.query', {
      bizContent: { outTradeNo: out_trade_no }
    });

    console.log(`[Payment Verify] Order ${out_trade_no} query result:`, JSON.stringify(queryResult));

    // 检查支付状态
    const tradeStatus = queryResult?.tradeStatus || queryResult?.alipay_trade_query_response?.trade_status;
    if (tradeStatus !== 'TRADE_SUCCESS' && tradeStatus !== 'TRADE_FINISHED') {
      return res.json({
        success: false,
        status: tradeStatus || 'UNKNOWN',
        message: tradeStatus === 'WAIT_BUYER_PAY' ? '订单待支付，请先完成支付' : '订单未支付成功'
      });
    }

    // 支付成功，执行完成订单逻辑
    const trade_no = queryResult?.tradeNo || queryResult?.alipay_trade_query_response?.trade_no;

    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();

      // 再次检查订单状态（防止并发）
      const [[orderCheck]] = await conn.query('SELECT status FROM recharge_orders WHERE out_trade_no = ?', [out_trade_no]);
      if (orderCheck.status === 'paid') {
        await conn.rollback();
        return res.json({ success: true, message: '订单已完成', already_paid: true });
      }

      // 更新订单状态
      await conn.query(
        'UPDATE recharge_orders SET status = "paid", alipay_trade_no = ?, paid_at = NOW() WHERE out_trade_no = ?',
        [trade_no, out_trade_no]
      );

      // 套餐订单处理
      if (order.order_type === 'package' && order.package_id) {
        // 检查10密钥上限
        const [[{ cnt }]] = await conn.query(
          'SELECT COUNT(*) as cnt FROM openclaw_api_keys WHERE user_id = ?',
          [userId]
        );
        if (cnt >= 10) {
          await conn.rollback();
          return res.status(400).json({ error: '已达到10个密钥上限，请先删除旧密钥' });
        }

        // 扣除余额（如有）
        if (order.balance_used > 0) {
          const walletResult = await adjustBalance(
            userId,
            'wallet',
            -Number(order.balance_used),
            'buy_package',
            `购买套餐使用钱包余额: ${out_trade_no}`,
            { source: 'payment_verify', order_type: 'package', out_trade_no },
            conn
          );
          if (!walletResult.success) {
            await conn.rollback();
            return res.status(400).json({ error: '钱包余额不足' });
          }
        }

        // 创建用户套餐
        const [[pkg]] = await conn.query('SELECT * FROM openclaw_packages WHERE id = ?', [order.package_id]);
        const [pkgResult] = await conn.query(
          'INSERT INTO openclaw_user_packages (user_id, package_id, expires_at, status) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 30 DAY), "active")',
          [userId, order.package_id]
        );

        // 充值月度配额
        const monthlyQuota = Number(pkg.monthly_quota);
        if (monthlyQuota > 0) {
          await adjustBalance(
            userId,
            'quota',
            monthlyQuota,
            'recharge',
            `购买${pkg.name}套餐，获得月度配额 $${monthlyQuota}`,
            { source: 'payment_verify', order_type: 'package', package_id: pkg.id, out_trade_no },
            conn
          );
        }

        // 创建 API Key
        const key = generateApiKey();
        const keyHash = hashApiKey(key);
        const keyDisplay = maskApiKey(key);
        const keyPrefix = key.slice(0, 7);
        const keyName = `${pkg.name} - ${getChinaDateString()}`;

        await conn.query(
          'INSERT INTO openclaw_api_keys (user_id, package_id, key_prefix, key_hash, key_display, name) VALUES (?, ?, ?, ?, ?, ?)',
          [userId, pkgResult.insertId, keyPrefix, keyHash, keyDisplay, keyName]
        );

        await conn.commit();

        return res.json({
          success: true,
          message: `订单验证成功！已激活 ${pkg.name} 套餐`,
          package_name: pkg.name,
          api_key: key,
          key_display: keyDisplay,
          monthly_quota: monthlyQuota
        });
      }

      // 加油包订单处理
      if (order.order_type === 'recharge') {
        const totalQuota = Number(order.amount); // amount 已含 bonus_quota，不重复相加

        await adjustBalance(
          userId,
          'quota',
          totalQuota,
          'booster',
          `加油包充值成功，获得 $${totalQuota}`,
          { source: 'payment_verify', order_type: 'recharge', out_trade_no },
          conn
        );

        await grantFirstPaidInviteReward({
          conn,
          inviteeUserId: userId,
          outTradeNo: out_trade_no,
          paidAmount: getInviteEligiblePaidAmount(order),
        });

        await conn.commit();

        return res.json({
          success: true,
          message: `加油包充值成功！已到账 $${totalQuota}`,
          amount: totalQuota
        });
      }

      await grantFirstPaidInviteReward({
        conn,
        inviteeUserId: userId,
        outTradeNo: out_trade_no,
        paidAmount: getInviteEligiblePaidAmount(order),
      });

      await conn.commit();
      return res.json({ success: true, message: '订单验证成功' });

    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

  } catch (err) {
    console.error('验证订单失败:', err);
    res.status(500).json({ error: '验证订单失败，请稍后重试' });
  }
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
    // 加油包配置：支付金额(¥) -> 获得额度($)
    const rechargePackages = {
      10: 10,    // 基础加油包：¥10 → $10
      20: 20,    // 标准加油包：¥20 → $20
      45: 50     // 超值加油包：¥45 → $50
    };

    const payAmount = Number(amount);
    if (!payAmount || payAmount < 1 || payAmount > 10000 || !Number.isFinite(payAmount)) {
      return res.status(400).json({ error: '充值金额必须在 ¥1 ~ ¥10000 之间' });
    }

    // 固定套餐用预设额度，自定义金额按阶梯折扣
    let creditAmount = rechargePackages[payAmount];
    if (!creditAmount) {
      // 阶梯折扣：金额越大折扣越多
      const DISCOUNT_TIERS = [
        { min: 5001, rate: 0.60 }, // 六折
        { min: 1001, rate: 0.70 }, // 七折
        { min: 100,  rate: 0.80 }, // 八折
        { min: 50,   rate: 0.85 }, // 八五折
      ];
      const tier = DISCOUNT_TIERS.find(t => payAmount >= t.min);
      creditAmount = tier ? Math.round(payAmount / tier.rate * 100) / 100 : payAmount;
    }
    const totalAmount = creditAmount;
    const bonusAmount = Math.round((creditAmount - payAmount) * 100) / 100;

    // 生成订单号
    const outTradeNo = makeTradeNo(userId);

    // 创建订单
    await db.query(
      `INSERT INTO recharge_orders (out_trade_no, user_id, amount, quota, status, order_type, bonus_quota)
       VALUES (?, ?, ?, 0, 'pending', 'recharge', ?)`,
      [outTradeNo, userId, totalAmount, bonusAmount]
    );

    // 获取支付宝配置
    const { AlipaySdk } = require('alipay-sdk');

    const appId = await getSetting('alipay_app_id');
    const privateKey = formatPemKey(await getSetting('alipay_private_key'), 'private');
    const alipayPublicKey = formatPemKey(await getSetting('alipay_public_key'), 'public');
    const notifyUrl = await getSetting('alipay_notify_url');
    const returnUrl = await getSetting('alipay_return_url');

    const alipaySdk = new AlipaySdk({
      appId,
      privateKey,
      alipayPublicKey,
      keyType: 'PKCS8',
      gateway: 'https://openapi.alipay.com/gateway.do'
    });

    const mobile = isMobile(req);
    const bizParams = {
      method: 'GET',
      bizContent: {
        outTradeNo: outTradeNo,
        productCode: mobile ? 'QUICK_WAP_WAY' : 'FAST_INSTANT_TRADE_PAY',
        totalAmount: payAmount.toFixed(2),
        subject: `OpenClaw AI 加油包充值`,
        body: `支付 ¥${payAmount}，获得 $${creditAmount} API 额度`
      }
    };
    if (notifyUrl) bizParams.notifyUrl = notifyUrl;
    if (returnUrl) bizParams.returnUrl = returnUrl;

    const apiMethod = mobile ? 'alipay.trade.wap.pay' : 'alipay.trade.page.pay';
    const rawResult = await alipaySdk.pageExecute(apiMethod, bizParams);

    if (mobile) {
      return res.json({ mobile: true, tradeNo: outTradeNo, payUrl: rawResult.includes('<form') ? rawResult.match(/action="([^"]+)"/)[1].replace(/&amp;/g, '&') : rawResult, out_trade_no: outTradeNo, amount: payAmount, need_pay: payAmount });
    }

    // PC端：提取纯 URL
    let payUrl = rawResult;
    if (typeof rawResult === 'string' && rawResult.includes('<form')) {
      const match = rawResult.match(/action="([^"]+)"/);
      if (match) payUrl = match[1].replace(/&amp;/g, '&');
    }

    res.json({
      out_trade_no: outTradeNo,
      amount: totalAmount,
      bonus: bonusAmount,
      pay_url: payUrl
    });
  } catch (err) {
    console.error('创建加油包订单失败:', err);
    res.status(500).json({ error: '创建订单失败，请稍后重试' });
  }
});

module.exports = router;
