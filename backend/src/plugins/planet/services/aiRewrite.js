const { callAI } = require('../utils/aiGateway');

/**
 * 通过 AI 网关改写内容
 * @returns {Promise<{content: string, model: string}>}
 */
async function rewriteContent(content, model) {
  try {
    const prompt = `请将以下内容进行深度改写，要求：
1. 90%以上的内容表达方式要完全不同（改变句式、词汇、段落结构）
2. 保持原文的核心主旨和关键信息
3. 字数与原文接近（误差不超过30%）
4. 使用更丰富的表达方式和修辞手法
5. 确保内容完全原创，避免与原文雷同
6. 直接输出重写后的内容，不要添加任何说明或标注

原文：
${content}`;

    const rewritten = await callAI(prompt, { userId: 1 });
    return { content: `${rewritten}\n\n---\n*由AI提供技术支持*`, model: model || 'gateway' };
  } catch (error) {
    console.error(`[aiRewrite] 重写失败:`, error.message);
    throw error;
  }
}

/**
 * 根据内容生成标题
 */
async function generateTitle(content) {
  try {
    const cleanContent = content.replace(/\n\n---\n\*由.+提供技术支持\*$/, '');
    const prompt = `${cleanContent.substring(0, 200)}

请为上面的文章生成一个10-20字的标题。`;

    const title = await callAI(prompt, { userId: 1 });

    const lines = title.split('\n').map(l => l.trim()).filter(l => l);
    let cleanTitle = lines[lines.length - 1];

    if (cleanTitle.includes('标题') || cleanTitle.includes('为') || cleanTitle.length > 30) {
      cleanTitle = lines[lines.length - 2] || cleanTitle;
    }

    cleanTitle = cleanTitle.replace(/\*\*/g, '')
                           .replace(/^["'「『【《]|["'」』】》]$/g, '')
                           .replace(/^标题[:：]\s*/g, '')
                           .replace(/^为.+[：:]\s*/, '')
                           .trim()
                           .substring(0, 50);

    return cleanTitle;
  } catch (error) {
    console.error('[aiRewrite] 生成标题失败:', error.message);
    throw error;
  }
}

module.exports = { rewriteContent, generateTitle };
