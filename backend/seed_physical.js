const db = require('./src/config/db');
db.query(
  'INSERT INTO shop_items (name, description, category, type, value, quota_price, alipay_price, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ['定制周边T恤', '视频号素材官方周边，纯棉材质，多色可选，下单备注尺码', 'physical', 'goods', 1, null, 39.90, 1]
).then(([r]) => {
  console.log('OK', r.insertId);
  process.exit(0);
}).catch(e => {
  console.error(e.message);
  process.exit(1);
});
