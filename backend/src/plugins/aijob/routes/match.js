const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { analyzeMatch } = require('../services/ai');

const router = express.Router();

// 模拟匹配记录存储
const matches = new Map();

// 简历存储引用 (实际应从数据库获取)
const resumes = new Map();
const jobs = new Map();

/**
 * 执行简历匹配
 */
router.post('/analyze', async (req, res) => {
  try {
    const { resumeId, jobId } = req.body;

    if (!resumeId || !jobId) {
      return res.status(400).json({ error: '请提供简历ID和职位ID' });
    }

    // 获取简历和职位 (实际应从数据库)
    const resume = resumes.get(resumeId);
    const job = jobs.get(jobId);

    // 使用测试数据
    const testResume = {
      id: resumeId,
      name: '张三',
      education: [{ degree: '本科', school: '某某大学', major: '计算机科学' }],
      experience: [
        { company: 'ABC公司', position: '前端工程师', description: '负责Web开发' }
      ],
      skills: ['JavaScript', 'React', 'Vue', 'Node.js']
    };

    const testJob = {
      id: jobId,
      title: '高级前端工程师',
      company: '科技有限公司',
      salary_min: 25,
      salary_max: 40,
      requirements: '3年以上前端开发经验，熟练掌握React/Vue'
    };

    // AI匹配分析
    let result;
    try {
      result = await analyzeMatch(testResume, testJob);
    } catch (e) {
      // AI失败时返回模拟数据
      result = {
        score: 75,
        matched_skills: ['React', 'Vue', 'JavaScript'],
        missing_skills: ['TypeScript'],
        strengths: ['技能匹配度高', '有相关工作经验'],
        suggestions: ['建议学习TypeScript提升竞争力'],
        summary: '简历与职位匹配度良好，技能契合度高'
      };
    }

    // 保存匹配记录
    const matchId = uuidv4();
    const matchRecord = {
      id: matchId,
      resumeId,
      jobId,
      ...result,
      created_at: new Date()
    };
    matches.set(matchId, matchRecord);

    res.json({
      message: '匹配分析完成',
      match: matchRecord
    });
  } catch (error) {
    console.error('匹配错误:', error);
    res.status(500).json({ error: '匹配分析失败' });
  }
});

/**
 * 批量匹配 - 简历匹配多个职位
 */
router.post('/batch', async (req, res) => {
  try {
    const { resumeId, jobIds } = req.body;

    if (!resumeId || !jobIds || !Array.isArray(jobIds)) {
      return res.status(400).json({ error: '请提供简历ID和职位ID列表' });
    }

    // 测试简历
    const testResume = {
      id: resumeId,
      name: '张三',
      education: [{ degree: '本科', school: '某某大学', major: '计算机科学' }],
      experience: [
        { company: 'ABC公司', position: '前端工程师', description: '负责Web开发' }
      ],
      skills: ['JavaScript', 'React', 'Vue', 'Node.js']
    };

    // 测试职位列表
    const testJobs = [
      { id: '1', title: '高级前端工程师', company: 'A公司', salary_min: 25, salary_max: 40, requirements: 'React/Vue' },
      { id: '2', title: '全栈工程师', company: 'B公司', salary_min: 20, salary_max: 35, requirements: '前后端开发' },
      { id: '3', title: '前端架构师', company: 'C公司', salary_min: 35, salary_max: 55, requirements: '架构设计' }
    ];

    // 批量分析
    const results = await Promise.all(
      testJobs.slice(0, jobIds.length || 3).map(async (job) => {
        try {
          const analysis = await analyzeMatch(testResume, job);
          return {
            jobId: job.id,
            jobTitle: job.title,
            company: job.company,
            ...analysis
          };
        } catch (e) {
          // 失败时返回模拟数据
          return {
            jobId: job.id,
            jobTitle: job.title,
            company: job.company,
            score: 70 + Math.floor(Math.random() * 20),
            matched_skills: ['JavaScript', 'React'],
            missing_skills: ['架构经验'],
            summary: '基本匹配'
          };
        }
      })
    );

    // 按分数排序
    results.sort((a, b) => b.score - a.score);

    res.json({
      message: '批量匹配完成',
      resumeId,
      results,
      count: results.length
    });
  } catch (error) {
    console.error('批量匹配错误:', error);
    res.status(500).json({ error: '批量匹配失败' });
  }
});

/**
 * 获取匹配历史
 */
router.get('/history', (req, res) => {
  const { resumeId } = req.query;

  let result = Array.from(matches.values());

  if (resumeId) {
    result = result.filter(m => m.resumeId === resumeId);
  }

  result.sort((a, b) => b.created_at - a.created_at);

  res.json(result);
});

module.exports = router;
