const router = require('express').Router();
const db = require('../config/db');
const { auth, optionalAuth, requireAdmin } = require('../middleware/auth');
const https = require('https');
const { getSettingCached } = require('./quota');
const arkRateLimiter = require('../utils/arkRateLimiter');

// 火山引擎方舟API配置
const ARK_API_KEY = process.env.DOUBAO_API_KEY;
const ARK_BASE_URL = 'ark.cn-beijing.volces.com'; // kept as fallback default

// Helper: extract hostname from ark_base_url setting (which stores full URL like 'https://host/api/v3')
async function getArkHostname() {
  const baseUrl = await getSettingCached('ark_base_url', 'https://ark.cn-beijing.volces.com/api/v3');
  try { return new URL(baseUrl).hostname; } catch { return ARK_BASE_URL; }
}

// 从数据库获取设置
async function getSetting(key) {
  const [[row]] = await db.query('SELECT `value` FROM settings WHERE `key` = ?', [key]);
  return row ? row.value : null;
}

// 获取今天的日期（CST时区）
function todayCST() {
  return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
}

// 检查并记录会议使用次数
async function checkAndRecordMeetingUsage(userId, ipAddress) {
  const today = todayCST();
  const registeredLimit = parseInt(await getSettingCached('meeting_limit_registered', '5')) || 5; // hardcoded default: 5
  const guestLimit = parseInt(await getSettingCached('meeting_limit_guest', '3')) || 3; // hardcoded default: 3

  if (userId) {
    // 注册用户：检查每日会议次数限制
    const [[usage]] = await db.query(
      'SELECT meeting_count FROM ai_meeting_usage WHERE user_id = ? AND meeting_date = ?',
      [userId, today]
    );

    if (usage) {
      if (usage.meeting_count >= registeredLimit) {
        return { allowed: false, remaining: 0, limit: registeredLimit, message: `今日会议次数已用完（${registeredLimit}次/天）` };
      }
      // 增加计数
      await db.query(
        'UPDATE ai_meeting_usage SET meeting_count = meeting_count + 1 WHERE user_id = ? AND meeting_date = ?',
        [userId, today]
      );
      return { allowed: true, remaining: registeredLimit - usage.meeting_count - 1, limit: registeredLimit };
    } else {
      // 首次使用，创建记录
      await db.query(
        'INSERT INTO ai_meeting_usage (user_id, meeting_date, meeting_count) VALUES (?, ?, 1)',
        [userId, today]
      );
      return { allowed: true, remaining: registeredLimit - 1, limit: registeredLimit };
    }
  } else {
    // 游客：检查每日会议次数限制
    const [[usage]] = await db.query(
      'SELECT meeting_count FROM ai_meeting_usage WHERE ip_address = ? AND meeting_date = ?',
      [ipAddress, today]
    );

    if (usage) {
      if (usage.meeting_count >= guestLimit) {
        return { allowed: false, remaining: 0, limit: guestLimit, message: `今日会议次数已用完（${guestLimit}次/天），请登录以获得更多次数` };
      }
      // 增加计数
      await db.query(
        'UPDATE ai_meeting_usage SET meeting_count = meeting_count + 1 WHERE ip_address = ? AND meeting_date = ?',
        [ipAddress, today]
      );
      return { allowed: true, remaining: guestLimit - usage.meeting_count - 1, limit: guestLimit };
    } else {
      // 首次使用，创建记录
      await db.query(
        'INSERT INTO ai_meeting_usage (ip_address, meeting_date, meeting_count) VALUES (?, ?, 1)',
        [ipAddress, today]
      );
      return { allowed: true, remaining: guestLimit - 1, limit: guestLimit };
    }
  }
}

// 获取会议使用情况
async function getMeetingUsage(userId, ipAddress) {
  const today = todayCST();
  const registeredLimit = parseInt(await getSettingCached('meeting_limit_registered', '5')) || 5; // hardcoded default: 5
  const guestLimit = parseInt(await getSettingCached('meeting_limit_guest', '3')) || 3; // hardcoded default: 3

  if (userId) {
    const [[usage]] = await db.query(
      'SELECT meeting_count FROM ai_meeting_usage WHERE user_id = ? AND meeting_date = ?',
      [userId, today]
    );
    const used = usage ? usage.meeting_count : 0;
    return { used, remaining: Math.max(0, registeredLimit - used), limit: registeredLimit };
  } else {
    const [[usage]] = await db.query(
      'SELECT meeting_count FROM ai_meeting_usage WHERE ip_address = ? AND meeting_date = ?',
      [ipAddress, today]
    );
    const used = usage ? usage.meeting_count : 0;
    return { used, remaining: Math.max(0, guestLimit - used), limit: guestLimit };
  }
}

// 消耗用户积分 — 已废弃，AI 调用费用由 api.yunjunet.cn USD 余额承担
async function consumeQuota(userId, amount, reason) {
  // 不再扣积分，直接返回成功
  return { success: true };
}

// 获取模型endpoint配置
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

// 调用单个AI员工（通过 api.yunjunet.cn 内部网关）
async function callEmployeeAI(employee, userMessage, history = [], userId) {
  const { callGateway } = require('yunjunet-common/backend-core/ai/doubao');

  const messages = [
    { role: 'system', content: employee.description },
    ...history.map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content: userMessage }
  ];

  const data = await callGateway({
    userId: userId || 1,
    messages,
    tier: 'medium',
    temperature: 0.7,
  });

  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error(`${employee.name}响应格式错误`);

  return {
    employeeId: employee.id,
    employeeName: employee.name,
    model: 'gateway',
    content,
  };
}

// 流式调用AI员工（通过 api.yunjunet.cn 内部网关，支持SSE）
async function callEmployeeAIStream(employee, userMessage, history = [], onChunk, userId) {
  const GW_URL = process.env.AI_GATEWAY_URL || 'http://localhost:3021';
  const GW_SECRET = process.env.INTERNAL_API_SECRET || '';
  const { pickModel } = require('yunjunet-common/backend-core/ai/model-router');
  const picked = await pickModel('medium');

  const messages = [
    { role: 'system', content: employee.description },
    ...history.map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content: userMessage }
  ];

  const response = await fetch(`${GW_URL}/v1/internal/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Secret': GW_SECRET,
      'X-User-Id': String(userId || 1),
    },
    body: JSON.stringify({ model: picked.model, messages, temperature: 0.7, stream: true }),
  });

  if (!response.ok) throw new Error(`AI 网关返回 ${response.status}`);

  return new Promise((resolve, reject) => {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    function pump() {
      reader.read().then(({ done, value }) => {
        if (done) { resolve(); return; }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim();
            if (data === '[DONE]') continue;
            try {
              const parsed = JSON.parse(data);
              const content = parsed.choices?.[0]?.delta?.content;
              if (content) onChunk(content);
            } catch {}
          }
        }
        pump();
      }).catch(reject);
    }
    pump();
  });
}

// 数据库迁移：创建ai_employees表
(async () => {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS ai_employees (
        id INT PRIMARY KEY AUTO_INCREMENT,
        name VARCHAR(100) NOT NULL UNIQUE COMMENT '员工名称',
        category VARCHAR(50) NOT NULL DEFAULT 'general' COMMENT '员工分类',
        description TEXT NOT NULL COMMENT '描述词/提示词',
        model ENUM('deepseek', 'kimi', 'glm', 'qwen', 'rotation') NOT NULL DEFAULT 'rotation' COMMENT '使用的模型',
        is_active TINYINT(1) DEFAULT 1 COMMENT '是否启用',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='AI员工配置表'
    `);
    console.log('✓ ai_employees table ready');

    // 添加category字段（如果表已存在但没有该字段）
    await db.query(`
      ALTER TABLE ai_employees
      ADD COLUMN IF NOT EXISTS category VARCHAR(50) NOT NULL DEFAULT 'general' COMMENT '员工分类'
      AFTER name
    `).catch(() => {});

    // 检查是否已有预设数据
    const [existing] = await db.query('SELECT COUNT(*) as count FROM ai_employees');
    if (existing[0].count === 0) {
      // 插入预设AI员工
      const presetEmployees = [
        // 内容创作类
        { name: '文案策划师', category: 'content', description: '你是一位资深的文案策划师，擅长创作吸引人的标题、文案和营销内容。你的文案简洁有力，能够精准把握用户心理，善于运用情感共鸣和痛点营销。', model: 'deepseek' },
        { name: '短视频编剧', category: 'content', description: '你是一位专业的短视频编剧，擅长创作15-60秒的短视频脚本。你深谙短视频的节奏把控，能够在开头3秒抓住观众注意力，善于设置悬念和反转。', model: 'kimi' },
        { name: 'SEO优化专家', category: 'content', description: '你是一位SEO优化专家，精通搜索引擎算法和关键词策略。你能够优化内容结构，提升搜索排名，同时保持内容的可读性和价值。', model: 'glm' },

        // 技术开发类
        { name: '全栈工程师', category: 'tech', description: '你是一位经验丰富的全栈工程师，精通前端（Vue/React）和后端（Node.js/Python）开发。你能够设计系统架构，编写高质量代码，并提供技术方案建议。', model: 'deepseek' },
        { name: '产品经理', category: 'tech', description: '你是一位资深产品经理，擅长需求分析、产品规划和用户体验设计。你能够从用户角度思考问题，平衡商业价值和技术实现。', model: 'qwen' },
        { name: '测试工程师', category: 'tech', description: '你是一位细致的测试工程师，擅长发现系统漏洞和边界情况。你能够设计测试用例，进行性能测试，确保产品质量。', model: 'glm' },

        // 商业分析类
        { name: '数据分析师', category: 'business', description: '你是一位专业的数据分析师，擅长从数据中挖掘洞察。你能够进行数据清洗、统计分析和可视化，为决策提供数据支持。', model: 'deepseek' },
        { name: '市场营销专家', category: 'business', description: '你是一位市场营销专家，精通品牌策划、用户增长和营销推广。你能够制定营销策略，分析市场趋势，提升品牌影响力。', model: 'kimi' },
        { name: '商业顾问', category: 'business', description: '你是一位资深商业顾问，擅长商业模式分析、战略规划和竞争分析。你能够提供专业的商业建议，帮助企业做出正确决策。', model: 'qwen' },

        // 设计创意类
        { name: 'UI/UX设计师', category: 'design', description: '你是一位优秀的UI/UX设计师，精通用户界面设计和用户体验优化。你能够提供设计建议，优化交互流程，提升产品美感和易用性。', model: 'glm' },
        { name: '品牌设计师', category: 'design', description: '你是一位创意品牌设计师，擅长品牌视觉设计、Logo设计和VI系统。你能够把握品牌调性，创作独特的视觉形象。', model: 'kimi' },

        // 教育培训类
        { name: '培训讲师', category: 'education', description: '你是一位经验丰富的培训讲师，擅长知识传授和课程设计。你能够将复杂概念简单化，用生动的案例帮助学员理解和掌握知识。', model: 'deepseek' },
        { name: '职业规划师', category: 'education', description: '你是一位专业的职业规划师，擅长职业发展咨询和能力评估。你能够帮助个人明确职业目标，制定成长路径。', model: 'qwen' }
      ];

      for (const emp of presetEmployees) {
        await db.query(
          'INSERT INTO ai_employees (name, category, description, model) VALUES (?, ?, ?, ?)',
          [emp.name, emp.category, emp.description, emp.model]
        ).catch(() => {}); // 忽略重复插入错误
      }
      console.log('✓ Preset AI employees created');
    }
  } catch (err) {
    if (!err.message.includes('already exists')) {
      console.error('ai_employees migration error:', err.message);
    }
  }
})();

// 添加creator_id和is_editable字段
(async () => {
  try {
    await db.query(`
      ALTER TABLE ai_employees
      ADD COLUMN creator_id INT DEFAULT NULL COMMENT '创建者用户ID',
      ADD COLUMN is_editable TINYINT(1) DEFAULT 1 COMMENT '是否可编辑'
    `);
    console.log('✓ Added creator_id and is_editable columns');

    // 将现有员工标记为系统员工（不可编辑）
    await db.query(`UPDATE ai_employees SET is_editable = 0 WHERE creator_id IS NULL`);
    console.log('✓ Marked existing employees as system employees');
  } catch (err) {
    if (!err.message.includes('Duplicate column')) {
      console.error('ai_employees field migration error:', err.message);
    }
  }
})();

// 创建会议使用记录表
(async () => {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS ai_meeting_usage (
        id INT PRIMARY KEY AUTO_INCREMENT,
        user_id INT DEFAULT NULL COMMENT '用户ID，NULL表示游客',
        ip_address VARCHAR(45) DEFAULT NULL COMMENT '游客IP地址',
        meeting_date DATE NOT NULL COMMENT '会议日期',
        meeting_count INT DEFAULT 1 COMMENT '当天会议次数',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY unique_user_date (user_id, meeting_date),
        UNIQUE KEY unique_ip_date (ip_address, meeting_date),
        INDEX idx_user_date (user_id, meeting_date),
        INDEX idx_ip_date (ip_address, meeting_date)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='AI会议使用记录表'
    `);
    console.log('✓ ai_meeting_usage table ready');
  } catch (err) {
    if (!err.message.includes('already exists')) {
      console.error('ai_meeting_usage migration error:', err.message);
    }
  }
})();

// GET /api/ai-employees - 获取所有AI员工列表（公开接口）
router.get('/', async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT id, name, category, description, model, is_active, creator_id, is_editable, created_at, updated_at FROM ai_employees WHERE is_active = 1 ORDER BY category, id'
    );
    res.json(rows);
  } catch (err) {
    console.error('Get AI employees error:', err);
    res.status(500).json({ message: '获取AI员工列表失败' });
  }
});

// GET /api/ai-employees/meeting-usage - 获取会议使用情况（必须在/:id之前定义）
router.get('/meeting-usage', optionalAuth, async (req, res) => {
  try {
    const userId = req.user?.id || null;
    const ipAddress = req.ip || req.connection.remoteAddress;

    const usage = await getMeetingUsage(userId, ipAddress);

    // 获取用户当前积分（如果是登录用户）
    let currentQuota = null;
    if (userId) {
      const [[quota]] = await db.query('SELECT extra_quota FROM user_quota WHERE user_id = ?', [userId]);
      currentQuota = quota ? quota.extra_quota : 0;
    }

    res.json({
      used: usage.used,
      remainingMeetings: usage.remaining,
      limit: usage.limit,
      currentQuota,
      isGuest: !userId,
      maxRounds: userId ? null : (parseInt(await getSettingCached('meeting_limit_guest', '3')) || 3) // was hardcoded: 3
    });
  } catch (err) {
    console.error('Get meeting usage error:', err);
    res.status(500).json({ message: '获取使用情况失败' });
  }
});

// GET /api/ai-employees/:id - 获取单个AI员工详情
router.get('/:id', auth, requireAdmin, async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT id, name, description, model, is_active, created_at, updated_at FROM ai_employees WHERE id = ?',
      [req.params.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ message: 'AI员工不存在' });
    }
    res.json(rows[0]);
  } catch (err) {
    console.error('Get AI employee error:', err);
    res.status(500).json({ message: '获取AI员工详情失败' });
  }
});

// POST /api/ai-employees - 创建新AI员工（普通用户可创建）
router.post('/', auth, async (req, res) => {
  try {
    const { name, category, description, model, is_active } = req.body;

    if (!name || !description || !model) {
      return res.status(400).json({ message: '员工名称、描述词和模型为必填项' });
    }

    // 长度限制
    if (name.length > 100) {
      return res.status(400).json({ message: '员工名称不能超过100字符' });
    }
    if (category && category.length > 50) {
      return res.status(400).json({ message: '分类名称不能超过50字符' });
    }
    if (description.length > 2000) {
      return res.status(400).json({ message: '描述词不能超过2000字符' });
    }

    const validModels = ['deepseek', 'kimi', 'glm', 'qwen', 'rotation'];
    if (!validModels.includes(model)) {
      return res.status(400).json({ message: '无效的模型选择' });
    }

    const [result] = await db.query(
      'INSERT INTO ai_employees (name, category, description, model, is_active, creator_id, is_editable) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [name, category || 'general', description, model, is_active !== undefined ? is_active : 1, req.user.id, 1]
    );

    res.json({
      message: 'AI员工创建成功',
      id: result.insertId
    });
  } catch (err) {
    console.error('Create AI employee error:', err);
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ message: '员工名称已存在' });
    }
    res.status(500).json({ message: '创建AI员工失败' });
  }
});

// PUT /api/ai-employees/:id - 更新AI员工（创建者可编辑）
router.put('/:id', auth, async (req, res) => {
  try {
    const { name, category, description, model, is_active } = req.body;

    if (!name || !description || !model) {
      return res.status(400).json({ message: '员工名称、描述词和模型为必填项' });
    }

    // 长度限制
    if (name.length > 100) {
      return res.status(400).json({ message: '员工名称不能超过100字符' });
    }
    if (category && category.length > 50) {
      return res.status(400).json({ message: '分类名称不能超过50字符' });
    }
    if (description.length > 2000) {
      return res.status(400).json({ message: '描述词不能超过2000字符' });
    }

    // 查询员工信息以检查权限
    const [employee] = await db.query(
      'SELECT creator_id, is_editable FROM ai_employees WHERE id = ?',
      [req.params.id]
    );

    if (employee.length === 0) {
      return res.status(404).json({ message: 'AI员工不存在' });
    }

    // 权限检查
    if (req.user.role !== 'admin') {
      // 非管理员只能编辑自己创建的员工
      if (employee[0].creator_id !== req.user.id) {
        return res.status(403).json({ message: '无权编辑此员工' });
      }
      // 不可编辑的员工（系统员工）只有管理员可编辑
      if (employee[0].is_editable === 0) {
        return res.status(403).json({ message: '系统员工仅管理员可编辑' });
      }
    }

    const validModels = ['deepseek', 'kimi', 'glm', 'qwen', 'rotation'];
    if (!validModels.includes(model)) {
      return res.status(400).json({ message: '无效的模型选择' });
    }

    const [result] = await db.query(
      'UPDATE ai_employees SET name = ?, category = ?, description = ?, model = ?, is_active = ? WHERE id = ?',
      [name, category || 'general', description, model, is_active !== undefined ? is_active : 1, req.params.id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'AI员工不存在' });
    }

    res.json({ message: 'AI员工更新成功' });
  } catch (err) {
    console.error('Update AI employee error:', err);
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ message: '员工名称已存在' });
    }
    res.status(500).json({ message: '更新AI员工失败' });
  }
});

// DELETE /api/ai-employees/:id - 禁止删除员工（遵循数据只做加法原则）
router.delete('/:id', auth, async (req, res) => {
  return res.status(403).json({
    message: '不支持删除员工，如需停用请联系管理员'
  });
});

// POST /api/ai-employees/meeting - AI员工会议（多员工对话）
router.post('/meeting', optionalAuth, async (req, res) => {
  try {
    const { employeeIds, message, history } = req.body;
    const userId = req.user?.id || null;
    const ipAddress = req.ip || req.connection.remoteAddress;

    if (!employeeIds || !Array.isArray(employeeIds) || employeeIds.length === 0) {
      return res.status(400).json({ message: '请至少选择一个AI员工' });
    }

    if (!message || !message.trim()) {
      return res.status(400).json({ message: '消息内容不能为空' });
    }

    // 检查会议轮数限制（游客最多N轮，可配置）
    const guestRoundLimit = parseInt(await getSettingCached('meeting_limit_guest', '3')) || 3; // was hardcoded: 3
    const currentRound = (history?.length || 0) / 2 + 1; // 每轮包含用户消息和AI回复
    if (!userId && currentRound > guestRoundLimit) {
      return res.status(403).json({ message: `游客每次会议最多${guestRoundLimit}轮对话，请登录以继续` });
    }

    // 检查会议次数限制（首轮才检查和记录）
    if (currentRound === 1) {
      const usageCheck = await checkAndRecordMeetingUsage(userId, ipAddress);
      if (!usageCheck.allowed) {
        return res.status(403).json({ message: usageCheck.message });
      }
    }

    // 注册用户：每轮对话消耗积分（每个员工1积分）
    if (userId && currentRound > 0) {
      const quotaCost = employeeIds.length; // 每个员工消耗1积分
      const quotaResult = await consumeQuota(userId, quotaCost, `AI会议-第${currentRound}轮-${employeeIds.length}个员工`);
      if (!quotaResult.success) {
        return res.status(403).json({ message: quotaResult.message || '积分不足，无法继续对话' });
      }
    }

    // 获取选中的员工信息
    const placeholders = employeeIds.map(() => '?').join(',');
    const [employees] = await db.query(
      `SELECT id, name, description, model FROM ai_employees WHERE id IN (${placeholders}) AND is_active = 1`,
      employeeIds
    );

    if (employees.length === 0) {
      return res.status(404).json({ message: '未找到有效的AI员工' });
    }

    // 设置SSE响应头
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // 依次调用每个员工的AI服务，流式返回
    for (const emp of employees) {
      try {
        const response = await callEmployeeAIStream(emp, message, history, (chunk) => {
          // 发送流式数据
          res.write(`data: ${JSON.stringify({
            employeeId: emp.id,
            employeeName: emp.name,
            chunk: chunk,
            done: false
          })}\n\n`);
        });

        // 发送完成标记
        res.write(`data: ${JSON.stringify({
          employeeId: emp.id,
          employeeName: emp.name,
          done: true
        })}\n\n`);
      } catch (err) {
        res.write(`data: ${JSON.stringify({
          employeeId: emp.id,
          employeeName: emp.name,
          error: err.message,
          done: true
        })}\n\n`);
      }
    }

    res.end();
  } catch (err) {
    console.error('AI meeting error:', err);
    res.status(500).json({ message: 'AI会议调用失败', error: err.message });
  }
});

// POST /api/ai-employees/smart-match - 智能匹配适合会议主题的员工
router.post('/smart-match', optionalAuth, async (req, res) => {
  try {
    const { topic } = req.body;

    if (!topic || topic.trim().length === 0) {
      return res.status(400).json({ message: '请输入会议主题' });
    }

    // 获取所有活跃员工
    const [employees] = await db.query(
      'SELECT id, name, category, description FROM ai_employees WHERE is_active = 1'
    );

    if (employees.length === 0) {
      return res.json({ employeeIds: [], reason: '暂无可用员工' });
    }

    // 构建员工列表描述
    const employeeList = employees.map(emp =>
      `ID:${emp.id} 姓名:${emp.name} 分类:${emp.category} 描述:${emp.description}`
    ).join('\n');

    const prompt = `会议主题：${topic}

可选员工列表：
${employeeList}

请分析会议主题，从上述员工中选择3-5位最适合参与此会议的员工。
要求：
1. 根据员工的分类和描述，选择与会议主题最相关的员工
2. 确保选择的员工能够从不同角度为会议提供价值
3. 只返回JSON格式：{"employeeIds": [员工ID数组], "reason": "选择理由"}
4. 不要添加任何其他说明文字`;

    // 调用AI进行智能匹配
    const endpoint = await getSetting('ark_deepseek_endpoint') || 'deepseek-v3-2-251201';
    const aiResponse = await callArkAPI(prompt, endpoint);

    // 解析AI返回的JSON
    const match = aiResponse.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new Error('AI返回格式错误');
    }

    const result = JSON.parse(match[0]);

    // 验证返回的员工ID是否有效
    const validIds = employees.map(e => e.id);
    result.employeeIds = result.employeeIds.filter(id => validIds.includes(id));

    res.json(result);
  } catch (err) {
    console.error('Smart match error:', err);
    res.status(500).json({ message: '智能匹配失败', error: err.message });
  }
});

// POST /api/ai-employees/generate - AI生成员工属性
router.post('/generate', auth, async (req, res) => {
  try {
    const { field, context } = req.body;

    if (!field || !['name', 'category', 'description'].includes(field)) {
      return res.status(400).json({ message: '无效的字段类型' });
    }

    let prompt = '';
    if (field === 'name') {
      prompt = `请为一个AI员工生成一个专业、有创意的中文名称。${context ? `参考信息：${context}` : ''}
要求：
1. 名称应该简洁（2-4个字）
2. 体现专业性和职业特点
3. 只返回名称本身，不要任何解释`;
    } else if (field === 'category') {
      prompt = `请为一个AI员工生成一个合适的分类名称。${context ? `参考信息：${context}` : ''}
要求：
1. 分类应该简洁（2-6个字）
2. 体现专业领域
3. 只返回分类名称，不要任何解释`;
    } else if (field === 'description') {
      prompt = `请为一个AI员工生成详细的描述词。${context ? `参考信息：${context}` : ''}
要求：
1. 描述应该详细说明该员工的专业能力、工作风格、擅长领域
2. 长度在50-200字之间
3. 只返回描述内容，不要任何解释`;
    }

    // 调用AI生成
    const endpoint = await getSetting('ark_deepseek_endpoint') || 'deepseek-v3-2-251201';
    const result = await callArkAPI(prompt, endpoint);

    res.json({ content: result });
  } catch (err) {
    console.error('AI generation error:', err);
    res.status(500).json({ message: 'AI生成失败', error: err.message });
  }
});

// 调用AI网关辅助函数（通过 api.yunjunet.cn 内部端点）
async function callArkAPI(prompt, endpoint, userId) {
  const { callGateway } = require('yunjunet-common/backend-core/ai/doubao');
  const data = await callGateway({
    userId: userId || 1,
    messages: [{ role: 'user', content: prompt }],
    tier: 'medium',
    temperature: 0.7,
  });
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('AI 响应格式错误');
  return content.trim();
}

module.exports = router;
