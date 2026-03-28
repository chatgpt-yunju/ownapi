const axios = require('axios');

// AI配置
const AI_CONFIG = {
  baseURL: process.env.AI_BASE_URL || 'https://api.yunjunet.cn/v1',
  apiKey: process.env.AI_API_KEY,
  model: process.env.AI_MODEL || 'gpt-3.5-turbo'
};

/**
 * 调用AI API (兼容OpenAI格式)
 * @param {string} prompt - 用户提示
 * @param {object} options - 可选参数
 */
async function callAI(prompt, options = {}) {
  try {
    const response = await axios.post(
      `${AI_CONFIG.baseURL}/chat/completions`,
      {
        model: options.model || AI_CONFIG.model,
        messages: [
          {
            role: 'system',
            content: '你是一个专业的招聘匹配助手，帮助分析简历与职位的匹配度。请始终返回有效的JSON格式。'
          },
          { role: 'user', content: prompt }
        ],
        temperature: options.temperature || 0.7,
        max_tokens: options.maxTokens || 2000
      },
      {
        headers: {
          'Authorization': `Bearer ${AI_CONFIG.apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 60000
      }
    );

    const content = response.data.choices[0].message.content;
    return extractJSON(content);
  } catch (error) {
    console.error('AI API Error:', error.message);
    throw new Error(`AI调用失败: ${error.message}`);
  }
}

/**
 * 从文本中提取JSON
 */
function extractJSON(text) {
  try {
    // 尝试直接解析
    return JSON.parse(text);
  } catch {
    // 尝试提取JSON块
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    return {};
  }
}

/**
 * 解析简历文本为结构化数据
 * @param {string} resumeText - 简历原始文本
 */
async function parseResumeText(resumeText) {
  const prompt = `请从以下简历文本中提取结构化信息，返回JSON格式：

{
  "name": "姓名",
  "phone": "手机号",
  "email": "邮箱",
  "education": [
    {
      "school": "学校名称",
      "major": "专业",
      "degree": "学历",
      "startDate": "开始时间",
      "endDate": "结束时间"
    }
  ],
  "experience": [
    {
      "company": "公司名称",
      "position": "职位",
      "startDate": "开始时间",
      "endDate": "结束时间",
      "description": "工作职责描述"
    }
  ],
  "skills": ["技能1", "技能2"],
  "projects": [
    {
      "name": "项目名称",
      "role": "角色",
      "description": "项目描述"
    }
  ],
  "summary": "个人简介"
}

简历内容:
${resumeText}`;

  return await callAI(prompt, { maxTokens: 3000 });
}

/**
 * 分析简历与职位的匹配度
 * @param {object} resume - 结构化简历
 * @param {object} job - 职位信息
 */
async function analyzeMatch(resume, job) {
  const prompt = `你是一个专业的HR匹配专家。请分析以下简历与职位的匹配度：

【简历摘要】
姓名: ${resume.name || '未知'}
学历: ${resume.education?.[0]?.degree || '未知'}
工作年限: ${calculateWorkYears(resume.experience)}年
技能: ${(resume.skills || []).join(', ')}

【职位要求】
标题: ${job.title}
公司: ${job.company}
薪资: ${job.salary_min}-${job.salary_max}K
要求: ${job.requirements}

请返回JSON格式的匹配分析：
{
  "score": 85,
  "matched_skills": ["技能1", "技能2"],
  "missing_skills": ["技能3"],
  "strengths": ["优势1", "优势2"],
  "suggestions": ["改进建议1"],
  "summary": "一句话匹配总结"
}`;

  return await callAI(prompt);
}

/**
 * 计算工作年限
 */
function calculateWorkYears(experience) {
  if (!experience || experience.length === 0) return 0;
  // 简化计算：按经历条数估算
  return Math.min(experience.length * 2, 15);
}

module.exports = {
  callAI,
  parseResumeText,
  analyzeMatch
};
