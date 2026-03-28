const https = require('https');
const db = require('../config/db');

// 火山引擎方舟API配置（复用AI员工的配置）
const ARK_API_KEY = process.env.DOUBAO_API_KEY;
const ARK_BASE_URL = 'ark.cn-beijing.volces.com';

// 从数据库获取设置
async function getSetting(key) {
  const [[row]] = await db.query('SELECT `value` FROM settings WHERE `key` = ?', [key]);
  return row ? row.value : null;
}

// 获取模型endpoint配置（优先从数据库读取，其次环境变量，最后默认值）
async function getModelEndpoints() {
  const [kimi, deepseek, glm, qwen] = await Promise.all([
    getSetting('ark_kimi_endpoint'),
    getSetting('ark_deepseek_endpoint'),
    getSetting('ark_glm_endpoint'),
    getSetting('ark_qwen_endpoint')
  ]);

  return {
    kimi: kimi || process.env.ARK_KIMI_ENDPOINT || 'moonshot-v1-8k',
    deepseek: deepseek || process.env.ARK_DEEPSEEK_ENDPOINT || 'deepseek-v3-2-251201',
    glm: glm || process.env.ARK_GLM_ENDPOINT || 'glm-4',
    qwen: qwen || process.env.ARK_QWEN_ENDPOINT || 'qwen3-32b-20250429'
  };
}

let rotationIndex = 0;

/**
 * 通过火山引擎方舟调用AI模型重写内容
 */
async function callArkModel(content, modelName, endpoint) {
  if (!ARK_API_KEY) {
    throw new Error('ARK_API_KEY未配置');
  }

  if (!endpoint) {
    throw new Error(`${modelName}模型的endpoint未配置`);
  }

  const prompt = `请将以下内容进行深度改写，要求：
1. 90%以上的内容表达方式要完全不同（改变句式、词汇、段落结构）
2. 保持原文的核心主旨和关键信息
3. 字数与原文接近（误差不超过30%）
4. 使用更丰富的表达方式和修辞手法
5. 确保内容完全原创，避免与原文雷同
6. 直接输出重写后的内容，不要添加任何说明或标注

原文：
${content}`;

  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      model: endpoint,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7
    });

    const options = {
      hostname: ARK_BASE_URL,
      path: '/api/v3/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ARK_API_KEY}`,
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.choices?.[0]?.message?.content) {
            resolve(result.choices[0].message.content.trim());
          } else {
            reject(new Error(`${modelName} API返回格式错误: ${data}`));
          }
        } catch (e) {
          reject(new Error(`解析${modelName}响应失败: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

/**
 * 根据模型选择重写内容
 * @returns {Promise<{content: string, model: string}>} 返回改写后的内容和使用的模型
 */
async function rewriteContent(content, model) {
  try {
    const MODEL_ENDPOINTS = await getModelEndpoints();

    if (model === 'rotation') {
      const models = ['deepseek', 'glm', 'kimi'];
      const errors = [];

      // 尝试所有模型，直到有一个成功
      for (const m of models) {
        try {
          const rewrittenContent = await callArkModel(content, m, MODEL_ENDPOINTS[m]);
          rotationIndex++;

          // 添加模型标注
          const modelNames = {
            deepseek: 'DeepSeek',
            glm: 'GLM',
            kimi: 'Kimi',
            qwen: 'Qwen'
          };
          const finalContent = `${rewrittenContent}\n\n---\n*由${modelNames[m]}提供技术支持*`;

          return { content: finalContent, model: m };
        } catch (error) {
          errors.push(`${m}: ${error.message}`);
          console.log(`[aiRewrite] ${m}失败，尝试下一个模型`);
        }
      }

      // 所有模型都失败
      throw new Error(`所有模型都失败: ${errors.join('; ')}`);
    }

    const endpoint = MODEL_ENDPOINTS[model];
    if (!endpoint) {
      throw new Error(`模型 ${model} 的 endpoint 未配置`);
    }

    const rewrittenContent = await callArkModel(content, model, endpoint);

    // 添加模型标注
    const modelNames = {
      deepseek: 'DeepSeek',
      glm: 'GLM',
      kimi: 'Kimi',
      qwen: 'Qwen'
    };
    const finalContent = `${rewrittenContent}\n\n---\n*由${modelNames[model]}提供技术支持*`;

    return { content: finalContent, model };
  } catch (error) {
    console.error(`[aiRewrite] 重写失败 (${model}):`, error.message);
    throw error;
  }
}

/**
 * 根据内容生成标题
 */
async function generateTitle(content) {
  try {
    const MODEL_ENDPOINTS = await getModelEndpoints();

    // 使用deepseek生成标题
    const endpoint = MODEL_ENDPOINTS.deepseek;
    if (!endpoint) {
      throw new Error('DeepSeek endpoint 未配置');
    }

    // 移除可能的模型标注
    const cleanContent = content.replace(/\n\n---\n\*由.+提供技术支持\*$/, '');

    const prompt = `${cleanContent.substring(0, 200)}

请为上面的文章生成一个10-20字的标题。`;

    const title = await callArkModel(prompt, 'deepseek', endpoint);

    // 提取实际标题：取最后一个非空行（通常AI会在最后输出标题）
    const lines = title.split('\n').map(l => l.trim()).filter(l => l);
    let cleanTitle = lines[lines.length - 1];  // 取最后一行

    // 如果最后一行看起来像是说明文字，尝试倒数第二行
    if (cleanTitle.includes('标题') || cleanTitle.includes('为') || cleanTitle.length > 30) {
      cleanTitle = lines[lines.length - 2] || cleanTitle;
    }

    // 清理格式
    cleanTitle = cleanTitle.replace(/\*\*/g, '')  // 移除markdown加粗
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
