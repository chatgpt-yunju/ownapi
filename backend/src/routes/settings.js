const router = require('express').Router();
const db = require('../config/db');
const { auth, requireAdmin } = require('../middleware/auth');
const upload = require('../middleware/upload');
const path = require('path');

// 运行时迁移：批量初始化默认设置值
const siteModulesDefault = JSON.stringify([
  {key:'feed',name:'素材广场',icon:'film',visible:true,order:1,route:'/feed',showInNav:true},
  {key:'claimed',name:'我的领取',icon:'download',visible:true,order:2,route:'/my-videos',showInNav:true},
  {key:'aitools',name:'AI工具',icon:'cpu',visible:true,order:3,route:'/aitools',showInNav:true},
  {key:'aiteam',name:'AI运营团队',icon:'users',visible:true,order:4,route:'/chat',showInNav:true},
  {key:'meeting',name:'AI会议',icon:'clipboard',visible:true,order:5,route:'/ai-meeting',showInNav:true},
  {key:'aiimage',name:'AI图片',icon:'image',visible:true,order:6,route:'/ai-image',showInNav:true},
  {key:'aivideo',name:'AI视频',icon:'video',visible:true,order:7,route:'/ai-video',showInNav:true},
  {key:'planet',name:'AI星球',icon:'globe',visible:true,order:8,route:'/planet',showInNav:true},
  {key:'vip',name:'会员中心',icon:'crown',visible:true,order:9,route:'/vip',showInNav:true},
  {key:'shop',name:'积分商城',icon:'shopping-cart',visible:true,order:10,route:'/shop',showInNav:false},
  {key:'checkin',name:'签到中心',icon:'calendar',visible:true,order:11,route:'/checkin',showInNav:false},
  {key:'requirements',name:'需求大厅',icon:'edit',visible:false,order:12,route:'/requirements',showInNav:false},
  {key:'benchmark',name:'对标投稿',icon:'target',visible:false,order:13,route:'/benchmark',showInNav:false},
  {key:'balance',name:'余额管理',icon:'dollar-sign',visible:true,order:14,route:'/balance',showInNav:false},
  {key:'profile',name:'个人中心',icon:'user',visible:true,order:15,route:'/profile',showInNav:false}
]);

const defaultSettings = [
  // SSO
  ['sso_sub_sites', '[]'],
  ['sso_main_domain', 'https://opensora2.cn'],
  // AI 模型
  ['doubao_text_model', 'glm-4-7-251222'],
  ['doubao_image_model', 'doubao-seedream-5-0-260128'],
  ['doubao_video_model', 'doubao-seedance-1-0-lite-t2v-250428'],
  ['ark_base_url', 'https://ark.cn-beijing.volces.com/api/v3'],
  ['ark_api_rate_limit', '60'],
  // 安全
  ['login_max_failures', '5'],
  ['login_lock_minutes', '15'],
  ['jwt_expiry', '7d'],
  ['watermark_api_key', 'han1234'],
  // 积分费用
  ['balance_conversion_rate', '10'],
  ['cost_image_generate', '1'],
  ['cost_video_generate', '5'],
  ['cost_3d_generate', '25'],
  ['cost_requirement_post', '1'],
  ['cost_requirement_unlock', '2'],
  ['cost_feed_lock', '10'],
  // 日限制
  ['daily_bid_limit', '10'],
  ['daily_lock_limit', '3'],
  ['daily_preview_limit', '10'],
  ['daily_claim_limit', '3'],
  ['meeting_limit_registered', '5'],
  ['meeting_limit_guest', '3'],
  // 已有设置补充默认值
  ['preview_daily_limit', '10'],
  ['vip_preview_daily_limit', '30'],
  ['vip_claim_daily_limit', '10'],
  ['invite_new_user_reward', '3'],
  // 联系信息
  ['contact_wechat', '19966519194'],
  ['contact_email', '2743319061@qq.com'],
  ['feedback_email', 'zy123456789_0211@qq.com'],
  // VIP
  ['vip_duration_options', '[7,30,90,180,365]'],
  ['vip_benefits', '[{"label":"每日搜索次数","weekly":"10 次","yearly":"100 次"}]'],
  ['permanent_vip_benefits', '永久会员专属特权：免费安装部署Openclaw、Openclaw相关技术知识永久免费答疑、Openclaw专属会员群。将订单截图发到微信19966519194即享以上会员权益'],
  // 后台导航
  ['admin_nav_items', '[{"key":"planet","name":"星球管理","visible":true},{"key":"content","name":"内容列表","visible":true},{"key":"batch-upload","name":"批量上传","visible":true},{"key":"stats","name":"数据分析","visible":true},{"key":"categories","name":"分类管理","visible":true},{"key":"cardkeys","name":"卡密管理","visible":true},{"key":"users","name":"用户管理","visible":true},{"key":"shop","name":"积分商城","visible":true},{"key":"requirements","name":"需求管理","visible":true},{"key":"benchmark","name":"对标投稿","visible":true},{"key":"batch-watermark","name":"批量去水印","visible":true},{"key":"ai-employees","name":"AI员工","visible":true},{"key":"settings","name":"系统设置","visible":true}]'],
  // QQ 登录
  ['qq_app_id', ''],
  ['qq_app_key', ''],
  ['qq_login_enabled', 'false'],
  ['login_relay_domain', 'https://login.opensora2.cn'],
  // 模块显示
  ['site_modules', siteModulesDefault],
  // 星球导航显示
  ['nav_visibility', '{"home":true,"tools":true,"image":true,"video":true,"meeting":true}'],
  // 品牌
  ['site_brand', 'All In AI'],
  // SEO
  ['seo_site_name', 'All In AI'],
  ['seo_home_title', 'All In AI - 优质短视频素材'],
  ['seo_login_title', '登录 - All In AI'],
  ['seo_register_title', '注册 - All In AI'],
  ['seo_description', 'All In AI，提供海量优质AI短视频素材，助力短视频创作者'],
  ['seo_keywords', 'AI短视频,素材,视频号,短视频创作'],
  // 搜索设置
  ['search_modes', '["ai","material","planet"]'],
  ['search_default_mode', 'ai'],
  ['search_placeholder', '搜索openclaw、小龙虾或问问AI'],
  ['search_tips', '["AI短视频素材","AI变现技巧","AI图片生成","AI视频制作","短视频运营"]'],
  // 登录页品牌
  ['login_heading', 'All In AI'],
  ['login_subtitle', '登录后开启AI变现之旅'],
  ['register_heading', 'All In AI'],
  ['register_subtitle', '注册后开启AI变现之旅'],
  ['search_ai_prompt', '你是一位AI变现精品内容推荐官，专注于帮助用户通过AI实现副业变现与商业增长。当用户输入关键词时，请：1）结合AI变现视角简明解读该关键词的变现机会与落地路径；2）从下方星球社区精选帖子中挑选最能帮助用户赚钱的内容，以「见星球帖子[序号]」格式推荐；3）给出1-2条可立即行动的AI变现建议。回答聚焦实操，突出赚钱逻辑，避免空洞理论。'],
  ['ai_search_quota_message', '今日免费体验次数已用完，开通VIP无限次搜索'],
  // 弹窗公告
  ['popup_config', JSON.stringify({
    enabled: false,
    text: '小龙虾系统一键部署，专业技术支持，微信：19966519194',
    image_url: '',
    frequency: 'once_per_day'
  })],
  // 请求排队配置
  ['queue_max_concurrent',  '10'],
  ['queue_max_size',        '100'],
  ['queue_wait_timeout_ms', '30000'],
  ['gateway_global_max_inflight', '120'],
  ['gateway_model_max_inflight_default', '30'],
  ['gateway_endpoint_max_inflight_default', '10'],
  ['gateway_queue_max_size', '3000'],
  ['gateway_queue_wait_timeout_ms', '45000'],
  ['gateway_log_detail_sample_rate', '0.05'],
];

(async () => {
  for (const [key, value] of defaultSettings) {
    await db.query('INSERT IGNORE INTO settings (`key`, `value`) VALUES (?, ?)', [key, value]).catch(() => {});
  }
})();

// 公开配置键（无需认证即可读取，不含敏感信息）
const publicAllowedKeys = new Set([
  'contact_wechat', 'contact_email', 'feedback_email',
  'balance_conversion_rate',
  'cost_image_generate', 'cost_video_generate', 'cost_3d_generate',
  'cost_requirement_post', 'cost_requirement_unlock', 'cost_feed_lock',
  'daily_bid_limit', 'daily_lock_limit', 'daily_preview_limit', 'daily_claim_limit',
  'meeting_limit_registered', 'meeting_limit_guest',
  'site_modules', 'qq_login_enabled', 'login_relay_domain', 'nav_visibility',
  'checkin_reward', 'invite_reward', 'invite_new_user_reward',
  'vip_duration_options', 'vip_recharge_options', 'vip_cost_per_day',
  'recharge_options',
  'preview_daily_limit', 'vip_preview_daily_limit', 'vip_claim_daily_limit',
  'site_brand', 'login_heading', 'login_subtitle', 'register_heading', 'register_subtitle',
  'seo_site_name', 'seo_home_title', 'seo_login_title', 'seo_register_title',
  'seo_description', 'seo_keywords',
  'search_modes', 'search_default_mode', 'search_placeholder', 'search_tips', 'ai_search_quota_message',
  'popup_config',
  'vip_benefits',
  'permanent_vip_benefits',
  'admin_nav_items',
]);

// GET /api/settings/public — 公开配置（无需认证）
router.get('/public', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT `key`, `value` FROM settings');
    const result = {};
    rows.forEach(r => {
      if (publicAllowedKeys.has(r.key)) result[r.key] = r.value;
    });
    res.json(result);
  } catch (error) {
    console.error('获取公开配置失败:', error);
    res.status(500).json({ message: '服务器错误' });
  }
});

// GET all settings (admin only)
router.get('/', auth, requireAdmin, async (req, res) => {
  const [rows] = await db.query('SELECT `key`, `value` FROM settings');
  const result = {};
  rows.forEach(r => result[r.key] = r.value);
  res.json(result);
});

// PUT update settings (admin only)
router.put('/', auth, requireAdmin, async (req, res) => {
  const allowed = [
    // 原有
    'daily_free_quota', 'checkin_reward', 'invite_reward', 'invite_new_user_reward',
    'recharge_options', 'vip_recharge_options', 'vip_cost_per_day',
    'alipay_app_id', 'alipay_private_key', 'alipay_public_key', 'alipay_notify_url', 'alipay_return_url',
    'smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass',
    'ai_video_model', 'ai_video_cost',
    'doubao_video_api_key', 'kling_access_key', 'kling_secret_key',
    'zhipu_api_key', 'dashscope_api_key', 'tencent_secret_id', 'tencent_secret_key',
    'sora2_api_key', 'veo3_api_key',
    'ark_kimi_endpoint', 'ark_deepseek_endpoint', 'ark_glm_endpoint', 'ark_qwen_endpoint',
    // SSO
    'sso_sub_sites', 'sso_main_domain',
    // AI 模型
    'doubao_text_model', 'doubao_image_model', 'doubao_video_model', 'ark_base_url', 'ark_api_rate_limit',
    // 安全
    'login_max_failures', 'login_lock_minutes', 'jwt_expiry', 'watermark_api_key',
    // 积分费用
    'balance_conversion_rate',
    'cost_image_generate', 'cost_video_generate', 'cost_3d_generate',
    'cost_requirement_post', 'cost_requirement_unlock', 'cost_feed_lock',
    // 日限制
    'daily_bid_limit', 'daily_lock_limit', 'daily_preview_limit', 'daily_claim_limit',
    'meeting_limit_registered', 'meeting_limit_guest',
    'preview_daily_limit', 'vip_preview_daily_limit', 'vip_claim_daily_limit',
    // 联系信息
    'contact_wechat', 'contact_email', 'feedback_email',
    // VIP
    'vip_duration_options',
    // QQ 登录
    'qq_app_id', 'qq_app_key', 'qq_login_enabled', 'login_relay_domain',
    // 模块显示
    'site_modules',
    // 星球导航显示
    'nav_visibility',
    // 品牌
    'site_brand', 'login_heading', 'login_subtitle', 'register_heading', 'register_subtitle',
    // SEO
    'seo_site_name', 'seo_home_title', 'seo_login_title', 'seo_register_title',
    'seo_description', 'seo_keywords',
    // 搜索设置
    'search_modes', 'search_default_mode', 'search_placeholder', 'search_ai_prompt', 'search_tips', 'ai_search_quota_message',
    // 弹窗公告
    'popup_config',
    // VIP权益
    'vip_benefits',
    // 永久会员特权
    'permanent_vip_benefits',
    // 后台导航菜单
    'admin_nav_items',
    // 请求队列
    'queue_max_concurrent', 'queue_max_size', 'queue_wait_timeout_ms',
    'gateway_global_max_inflight', 'gateway_model_max_inflight_default',
    'gateway_endpoint_max_inflight_default',
    'gateway_queue_max_size', 'gateway_queue_wait_timeout_ms',
    'gateway_log_detail_sample_rate',
  ];
  const protectedKeys = [
    'alipay_private_key', 'alipay_public_key', 'alipay_app_id',
    'smtp_pass',
    'doubao_video_api_key', 'kling_access_key', 'kling_secret_key',
    'zhipu_api_key', 'dashscope_api_key', 'tencent_secret_id', 'tencent_secret_key',
    'sora2_api_key', 'veo3_api_key',
    'ark_kimi_endpoint', 'ark_deepseek_endpoint', 'ark_glm_endpoint', 'ark_qwen_endpoint',
    'qq_app_key', 'watermark_api_key',
  ];
  for (const key of allowed) {
    const val = req.body[key];
    if (val === undefined) continue;
    // 关键字段为空时跳过，保留原值
    if (protectedKeys.includes(key) && !String(val).trim()) continue;
    await db.query('INSERT INTO settings (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = ?', [key, val, val]);
  }
  res.json({ message: 'Saved' });
});

// POST upload popup image (admin only)
router.post('/upload-popup-image', auth, requireAdmin, upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ message: '未上传文件' });
  const relativePath = `/uploads/images/${path.basename(req.file.path)}`;
  // 返回完整URL，子站可直接使用主站图片
  const fullUrl = `https://opensora2.cn${relativePath}`;
  res.json({ url: fullUrl });
});

module.exports = router;
