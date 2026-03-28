const router = require('express').Router();
const db = require('../config/db');
const { auth } = require('../middleware/auth');
const { getSettingCached } = require('./quota');
const arkRateLimiter = require('../utils/arkRateLimiter');

const DOUBAO_API_KEY = process.env.DOUBAO_API_KEY;
const DOUBAO_MODEL = 'deepseek-v3-2-251201'; // fallback default, overridden by getSettingCached('doubao_text_model')

// GET /api/analyze/:contentId — 获取视频流量表现 AI 评估
router.get('/:contentId', auth, async (req, res) => {
  const { contentId } = req.params;

  const [[content]] = await db.query(
    'SELECT id, title, category, copy, created_at FROM content WHERE id = ?',
    [contentId]
  );
  if (!content) return res.status(404).json({ message: '视频不存在' });

  const [[ratingRow]] = await db.query(
    'SELECT ROUND(AVG(score),1) as avg_score, COUNT(*) as rating_count FROM ratings WHERE content_id = ?',
    [contentId]
  );

  const [[claimRow]] = await db.query(
    'SELECT COUNT(*) as claim_count FROM claims WHERE content_id = ?',
    [contentId]
  );

  const [[statsRow]] = await db.query(
    `SELECT COUNT(*) as submit_count,
      ROUND(AVG(likes),0) as avg_likes,
      ROUND(AVG(comments),0) as avg_comments,
      ROUND(AVG(favorites),0) as avg_favorites,
      ROUND(AVG(completion_rate),1) as avg_completion,
      ROUND(AVG(rate_3s),1) as avg_rate_3s
     FROM publish_stats WHERE content_id = ?`,
    [contentId]
  );

  const hasStats = statsRow.submit_count > 0;

  const baseInfo = `视频信息：
- 标题：${content.title}
- 分类：${content.category || '未分类'}
- 文案：${content.copy || '无'}
- 上架时间：${content.created_at?.toISOString?.()?.slice(0, 10) || '未知'}
- 用户评分：${ratingRow.avg_score || '暂无'}（共 ${ratingRow.rating_count} 人评价）
- 领取次数：${claimRow.claim_count} 次`;

  let prompt;

  if (hasStats) {
    prompt = `你是一位专业的短视频运营分析师，请根据以下视频的真实发布数据，对其流量表现进行诊断分析并提出改进建议。

${baseInfo}

真实发布数据（${statsRow.submit_count} 位用户回填均值）：
- 点赞数：${statsRow.avg_likes}
- 评论数：${statsRow.avg_comments}
- 收藏数：${statsRow.avg_favorites}
- 完播率：${statsRow.avg_completion}%
- 3秒完播率：${statsRow.avg_rate_3s}%

请从以下维度进行诊断分析（每项2-3句话，语言简洁专业）：
1. 整体流量表现诊断（结合各项数据综合评价）
2. 用户留存与互动问题分析（完播率、3秒完播率、评论/点赞比）
3. 内容质量与选题评估
4. 具体改进建议（至少3条可落地的优化方向）

直接输出分析内容，用序号分点输出，不要加额外说明。`;
  } else {
    prompt = `你是一位专业的短视频运营分析师，请根据以下视频的内容特征，预测其未来的流量表现潜力。

${baseInfo}

注意：该视频暂无用户回填的发布数据，请基于内容本身进行预测分析。

请从以下维度进行预测分析（每项2-3句话，语言简洁专业）：
1. 内容选题潜力评估（话题热度、受众范围）
2. 文案与标题吸引力分析
3. 预测流量表现（完播率、互动率的大致预期）
4. 发布建议（发布时机、标签、目标人群等）

直接输出分析内容，用序号分点输出，不要加额外说明。`;
  }

  try {
    const { callAI: analyzeCallAI } = require('../utils/aiGateway');
    const result = await analyzeCallAI(prompt, { userId: req.user.id, tier: 'medium' }) || '';
    res.json({
      result,
      has_stats: hasStats,
      metrics: {
        avg_score: ratingRow.avg_score,
        rating_count: ratingRow.rating_count,
        claim_count: claimRow.claim_count,
        submit_count: statsRow.submit_count,
        ...(hasStats ? {
          avg_likes: statsRow.avg_likes,
          avg_comments: statsRow.avg_comments,
          avg_favorites: statsRow.avg_favorites,
          avg_completion: statsRow.avg_completion,
          avg_rate_3s: statsRow.avg_rate_3s,
        } : {}),
      }
    });
  } catch (e) {
    console.error('Analyze error:', e);
    res.status(500).json({ message: '服务异常，请稍后重试' });
  }
});

module.exports = router;
