-- 添加 quota_price 到 VIP 套餐配置（存储在 settings 表的 JSON 中）
-- 注意：VIP 套餐配置存储在 settings 表的 vip_recharge_options 键中，格式为 JSON 数组

-- 更新 VIP 套餐配置，添加 quota_price 字段
UPDATE settings
SET value = '[
  {"amount":9.9,"days":7,"bonus_quota":50,"alipay_price":9.9,"quota_price":99},
  {"amount":19.9,"days":30,"bonus_quota":120,"alipay_price":19.9,"quota_price":199},
  {"amount":39.9,"days":90,"bonus_quota":240,"alipay_price":39.9,"quota_price":399},
  {"amount":59.9,"days":180,"bonus_quota":360,"alipay_price":59.9,"quota_price":599},
  {"amount":99.9,"days":365,"bonus_quota":580,"alipay_price":99.9,"quota_price":999}
]'
WHERE `key` = 'vip_recharge_options';

-- 验证更新
SELECT * FROM settings WHERE `key` = 'vip_recharge_options';
