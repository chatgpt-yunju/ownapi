const express = require('express');
const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const { parseResumeText } = require('../services/ai');

const router = express.Router();

// 配置文件上传
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, '../../uploads/resumes');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['.pdf', '.doc', '.docx', '.txt'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedTypes.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('不支持的文件格式，仅支持 PDF/Word/TXT'));
    }
  }
});

// 模拟简历存储
const resumes = new Map();

/**
 * 上传简历
 */
router.post('/upload', upload.single('resume'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: '请上传简历文件' });
    }

    const userId = req.body.userId || 'test-user';
    const resumeId = uuidv4();

    // TODO: 实际解析文件内容
    // 这里简化处理，实际需要用 pdf-parse, mammoth 等库解析
    let rawText = '示例简历内容';
    try {
      if (req.file.path.endsWith('.txt')) {
        rawText = fs.readFileSync(req.file.path, 'utf-8');
      }
    } catch (e) {
      console.log('读取文件失败，使用默认内容');
    }

    // AI解析简历
    let structured = null;
    try {
      structured = await parseResumeText(rawText);
    } catch (e) {
      console.log('AI解析失败，使用默认结构');
      structured = {
        name: '未知',
        phone: '',
        email: '',
        education: [],
        experience: [],
        skills: [],
        projects: []
      };
    }

    // 存储简历
    const resume = {
      id: resumeId,
      userId,
      filePath: req.file.path,
      originalName: req.file.originalname,
      ...structured,
      source: 'upload',
      created_at: new Date(),
      updated_at: new Date()
    };

    resumes.set(resumeId, resume);

    res.json({
      message: '简历上传成功',
      resume: {
        id: resumeId,
        name: structured.name,
        originalName: req.file.originalname,
        ...structured
      }
    });
  } catch (error) {
    console.error('上传错误:', error);
    res.status(500).json({ error: error.message || '上传失败' });
  }
});

/**
 * 获取简历列表
 */
router.get('/list', (req, res) => {
  const userId = req.query.userId || 'test-user';
  const userResumes = Array.from(resumes.values())
    .filter(r => r.userId === userId)
    .sort((a, b) => b.created_at - a.created_at);

  res.json(userResumes);
});

/**
 * 获取简历详情
 */
router.get('/:id', (req, res) => {
  const resume = resumes.get(req.params.id);
  if (!resume) {
    return res.status(404).json({ error: '简历不存在' });
  }
  res.json(resume);
});

/**
 * 更新简历
 */
router.put('/:id', (req, res) => {
  const resume = resumes.get(req.params.id);
  if (!resume) {
    return res.status(404).json({ error: '简历不存在' });
  }

  const updates = req.body;
  Object.assign(resume, updates, { updated_at: new Date() });
  resumes.set(req.params.id, resume);

  res.json({ message: '更新成功', resume });
});

module.exports = router;
