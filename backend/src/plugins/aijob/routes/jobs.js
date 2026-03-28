const express = require('express');
const { v4: uuidv4 } = require('uuid');

const router = express.Router();

// 模拟职位存储
const jobs = new Map();

// 初始化一些测试职位
const testJobs = [
  {
    id: uuidv4(),
    title: '高级前端工程师',
    company: '科技有限公司',
    location: '北京',
    salary_min: 25,
    salary_max: 40,
    requirements: '3年以上前端开发经验，熟练掌握React/Vue，熟悉TypeScript，有大型项目经验优先',
    tags: ['React', 'TypeScript', '前端'],
    source: 'test',
    status: 'active',
    created_at: new Date()
  },
  {
    id: uuidv4(),
    title: 'Python后端开发',
    company: '数据科技公司',
    location: '上海',
    salary_min: 20,
    salary_max: 35,
    requirements: '熟练掌握Python，熟悉Django/Flask，了解数据库优化，有数据处理经验',
    tags: ['Python', 'Django', '后端'],
    source: 'test',
    status: 'active',
    created_at: new Date()
  },
  {
    id: uuidv4(),
    title: 'AI算法工程师',
    company: 'AI创新公司',
    location: '深圳',
    salary_min: 30,
    salary_max: 50,
    requirements: '熟悉深度学习框架，有NLP/CV项目经验，熟练Python/C++，硕士及以上学历',
    tags: ['AI', '深度学习', 'Python'],
    source: 'test',
    status: 'active',
    created_at: new Date()
  }
];

testJobs.forEach(job => jobs.set(job.id, job));

/**
 * 获取职位列表
 */
router.get('/list', (req, res) => {
  const { keyword, location, salary_min, salary_max } = req.query;

  let result = Array.from(jobs.values()).filter(j => j.status === 'active');

  // 关键词搜索
  if (keyword) {
    const kw = keyword.toLowerCase();
    result = result.filter(j =>
      j.title.toLowerCase().includes(kw) ||
      j.company.toLowerCase().includes(kw) ||
      j.requirements.toLowerCase().includes(kw)
    );
  }

  // 地点筛选
  if (location) {
    result = result.filter(j => j.location.includes(location));
  }

  // 薪资筛选
  if (salary_min) {
    result = result.filter(j => j.salary_max >= parseInt(salary_min));
  }
  if (salary_max) {
    result = result.filter(j => j.salary_min <= parseInt(salary_max));
  }

  res.json(result);
});

/**
 * 获取职位详情
 */
router.get('/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    return res.status(404).json({ error: '职位不存在' });
  }
  res.json(job);
});

/**
 * 添加职位 (爬虫或手动)
 */
router.post('/', (req, res) => {
  const job = {
    id: uuidv4(),
    ...req.body,
    status: 'active',
    created_at: new Date()
  };
  jobs.set(job.id, job);
  res.json({ message: '添加成功', job });
});

/**
 * 批量导入职位
 */
router.post('/batch', (req, res) => {
  const { jobs: jobList } = req.body;
  const results = [];

  for (const jobData of jobList) {
    const job = {
      id: uuidv4(),
      ...jobData,
      status: 'active',
      created_at: new Date()
    };
    jobs.set(job.id, job);
    results.push(job);
  }

  res.json({ message: `成功导入 ${results.length} 个职位`, count: results.length });
});

module.exports = router;
