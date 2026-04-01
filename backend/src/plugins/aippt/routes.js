const express = require('express')
const multer = require('multer')
const path = require('path')
const fs = require('fs')

const { execSync, exec } = require('child_process')
const { v4: uuid } = require('uuid')
const https = require('https')


const { getChinaDateString } = require('../../utils/chinaTime')

const router = express.Router()

const UPLOAD_DIR = path.resolve('/home/ubuntu/aippt_yunjunet_cn/backend/uploads')
const OUTPUT_DIR = path.resolve('/home/ubuntu/aippt_yunjunet_cn/backend/output')
fs.mkdirSync(UPLOAD_DIR, { recursive: true })
fs.mkdirSync(OUTPUT_DIR, { recursive: true })

// In-memory project store
const projects = new Map()

// Available TTS voices
const VOICES = [
  { id: 'zh-CN-XiaoxiaoNeural', name: '晓晓', gender: 'female', desc: '温柔女声' },
  { id: 'zh-CN-XiaoyiNeural', name: '晓伊', gender: 'female', desc: '活泼女声' },
  { id: 'zh-CN-YunjianNeural', name: '云健', gender: 'male', desc: '沉稳男声' },
  { id: 'zh-CN-YunxiNeural', name: '云希', gender: 'male', desc: '温暖男声' },
  { id: 'zh-CN-YunyangNeural', name: '云扬', gender: 'male', desc: '专业男声' },
  { id: 'zh-CN-YunxiaNeural', name: '云夏', gender: 'male', desc: '少年音' }
]

// Avatar presets
const AVATARS = [
  { id: 'default', name: 'AI 讲师', hair: '#2c2c3a', skin: '#f5d6b8', suit: '#667eea' },
  { id: 'professional', name: '商务精英', hair: '#1a1a2a', skin: '#f0c8a0', suit: '#2c3e50' },
  { id: 'creative', name: '创意达人', hair: '#8e44ad', skin: '#fde3cf', suit: '#e74c3c' },
  { id: 'tech', name: '科技先锋', hair: '#2c3e50', skin: '#f5d6b8', suit: '#00b894' },
  { id: 'warm', name: '温暖导师', hair: '#6b4226', skin: '#f8d5b4', suit: '#fd9644' },
  { id: 'elegant', name: '优雅女士', hair: '#4a2c2a', skin: '#fce4d6', suit: '#e056a0' }
]

// Daily upload limit tracking (deviceId -> { date: 'YYYY-MM-DD', count: N })
const uploadLimits = new Map()
const DAILY_LIMIT = 5

function getDeviceKey(req) {
  return req.headers['x-device-id'] || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip
}

function checkDailyLimit(key) {
  const today = getChinaDateString()
  const record = uploadLimits.get(key)
  if (!record || record.date !== today) {
    return { allowed: true, remaining: DAILY_LIMIT }
  }
  return { allowed: record.count < DAILY_LIMIT, remaining: DAILY_LIMIT - record.count }
}

function recordUpload(key) {
  const today = getChinaDateString()
  const record = uploadLimits.get(key)
  if (!record || record.date !== today) {
    uploadLimits.set(key, { date: today, count: 1 })
  } else {
    record.count++
  }
}

// Multer config
const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname)
    cb(null, uuid() + ext)
  }
})
const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.ppt', '.pptx', '.pdf']
    const ext = path.extname(file.originalname).toLowerCase()
    cb(null, allowed.includes(ext))
  }
})

// Avatar photo upload
const AVATAR_PHOTO_DIR = path.join(__dirname, '../../uploads/avatars')
fs.mkdirSync(AVATAR_PHOTO_DIR, { recursive: true })

const photoStorage = multer.diskStorage({
  destination: AVATAR_PHOTO_DIR,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase()
    cb(null, uuid() + ext)
  }
})
const uploadPhoto = multer({
  storage: photoStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.webp']
    const ext = path.extname(file.originalname).toLowerCase()
    cb(null, allowed.includes(ext))
  }
})

// ============ API Routes ============

// Get available voices
router.get('/voices', (req, res) => {
  res.json(VOICES)
})

// Get available avatars
router.get('/avatars', (req, res) => {
  res.json(AVATARS)
})

// Check remaining uploads
router.get('/limit', (req, res) => {
  const key = getDeviceKey(req)
  const { remaining } = checkDailyLimit(key)
  res.json({ remaining, limit: DAILY_LIMIT })
})

// Upload PPT/PDF
router.post('/upload', upload.single('file'), async (req, res) => {
  const key = getDeviceKey(req)
  const { allowed, remaining } = checkDailyLimit(key)
  if (!allowed) {
    // Clean up uploaded file
    if (req.file) fs.unlinkSync(req.file.path)
    return res.status(429).json({ error: `每日上传限制${DAILY_LIMIT}次，今日已用完。明天再来吧！` })
  }
  if (!req.file) return res.status(400).json({ error: '请上传 PPT 或 PDF 文件' })

  const id = uuid().slice(0, 8)
  const ext = path.extname(req.file.originalname).toLowerCase()
  const projectDir = path.join(OUTPUT_DIR, id)
  fs.mkdirSync(projectDir, { recursive: true })

  const project = {
    id,
    filename: req.file.originalname,
    filePath: req.file.path,
    ext,
    dir: projectDir,
    status: 'converting',
    message: '正在转换文件...',
    progress: 5,
    slides: [],
    texts: [],
    createdAt: Date.now(),
    deviceId: key
  }
  projects.set(id, project)
  recordUpload(key)

  const afterLimit = checkDailyLimit(key)
  res.json({ id, remaining: afterLimit.remaining })

  // Process async
  processFile(project).catch(err => {
    console.error('[Process Error]', err)
    project.status = 'error'
    project.message = '处理失败: ' + err.message
  })
})

// Get status
router.get('/:id/status', (req, res) => {
  const p = projects.get(req.params.id)
  if (!p) return res.status(404).json({ error: '项目不存在' })
  res.json({ status: p.status, message: p.message, progress: p.progress })
})

// Get slides data
router.get('/:id/slides', (req, res) => {
  const p = projects.get(req.params.id)
  if (!p) return res.status(404).json({ error: '项目不存在' })
  res.json(p.slides)
})

// List projects
router.get('/list', (req, res) => {
  const key = getDeviceKey(req)
  const list = []
  for (const [id, p] of projects) {
    if (p.status === 'done' && p.deviceId === key) {
      list.push({
        id,
        filename: p.filename,
        totalSlides: p.slides.length,
        thumbnail: p.slides[0]?.image || null
      })
    }
  }
  res.json(list.reverse())
})

// Chat with current slide
router.post('/:id/chat', async (req, res) => {
  const p = projects.get(req.params.id)
  if (!p) return res.status(404).json({ error: '项目不存在' })

  const { question, slideIndex } = req.body
  const slideText = p.texts[slideIndex] || '(无内容)'
  const slideScript = p.slides[slideIndex]?.script || ''

  const prompt = `你是一个PPT讲解助手。用户正在查看一页PPT，内容如下：

PPT文字内容：${slideText}

讲解词：${slideScript}

用户提问：${question}

请简洁地回答用户的问题（2-3句话），要专业且有帮助。`

  try {
    const answer = await callAI(prompt)
    res.json({ answer })
  } catch (err) {
    res.status(500).json({ answer: '回答失败，请重试。' })
  }
})

// Save edited script for a slide
router.put('/:id/slides/:index/script', express.json(), async (req, res) => {
  const p = projects.get(req.params.id)
  if (!p) return res.status(404).json({ error: '项目不存在' })

  const index = parseInt(req.params.index)
  if (isNaN(index) || index < 0 || index >= p.slides.length) {
    return res.status(400).json({ error: '无效的页码' })
  }

  const { script } = req.body
  if (typeof script !== 'string') {
    return res.status(400).json({ error: '讲稿内容无效' })
  }

  p.slides[index].script = script

  // Regenerate audio for this slide
  try {
    const audioFile = path.join(p.dir, `audio_${index}.mp3`)
    const voice = p.voice || 'zh-CN-XiaoxiaoNeural'
    await textToSpeech(script, audioFile, voice)
    res.json({ success: true, audio: `/output/${p.id}/audio_${index}.mp3?t=${Date.now()}` })
  } catch (err) {
    res.json({ success: true, audio: p.slides[index].audio })
  }
})

// Change voice for entire project and regenerate all audio
router.put('/:id/voice', express.json(), async (req, res) => {
  const p = projects.get(req.params.id)
  if (!p) return res.status(404).json({ error: '项目不存在' })

  const { voice } = req.body
  if (!VOICES.find(v => v.id === voice)) {
    return res.status(400).json({ error: '不支持的音色' })
  }

  p.voice = voice
  p.voiceStatus = 'generating'
  res.json({ success: true, message: '正在重新生成语音...' })

  // Regenerate all audio in background
  try {
    for (let i = 0; i < p.slides.length; i++) {
      const audioFile = path.join(p.dir, `audio_${i}.mp3`)
      await textToSpeech(p.slides[i].script, audioFile, voice)
      p.slides[i].audio = `/output/${p.id}/audio_${i}.mp3?t=${Date.now()}`
    }
    p.voiceStatus = 'done'
  } catch (err) {
    console.error('[Voice Change Error]', err.message)
    p.voiceStatus = 'error'
  }
})

// Get voice regeneration status
router.get('/:id/voice-status', (req, res) => {
  const p = projects.get(req.params.id)
  if (!p) return res.status(404).json({ error: '项目不存在' })
  res.json({ status: p.voiceStatus || 'done', voice: p.voice || 'zh-CN-XiaoxiaoNeural' })
})

// Upload avatar photo (global, not project-specific)
router.post('/avatar-photo', uploadPhoto.single('photo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请上传图片文件（jpg/png/webp，最大5MB）' })
  res.json({ url: `/uploads/avatars/${req.file.filename}` })
})

// Update avatar for project
router.put('/:id/avatar', express.json(), (req, res) => {
  const p = projects.get(req.params.id)
  if (!p) return res.status(404).json({ error: '项目不存在' })

  const { avatarId } = req.body
  const avatar = AVATARS.find(a => a.id === avatarId)
  if (!avatar) return res.status(400).json({ error: '不支持的数字人' })

  p.avatar = avatarId
  res.json({ success: true, avatar })
})

// ============ Processing Pipeline ============

async function processFile(project) {
  const { ext, filePath, dir } = project

  // Step 1: Convert to PDF if PPT
  let pdfPath = filePath
  if (ext !== '.pdf') {
    project.message = '正在将PPT转换为PDF...'
    project.progress = 10
    pdfPath = await convertToPdf(filePath, dir)
  }

  // Step 2: PDF to images
  project.message = '正在生成幻灯片图片...'
  project.progress = 25
  const images = await pdfToImages(pdfPath, dir)
  project.slides = images.map((img, i) => ({
    image: `/output/${project.id}/${path.basename(img)}`,
    script: '',
    audio: ''
  }))

  // Step 3: Extract text
  project.message = '正在提取文字内容...'
  project.progress = 35
  project.texts = await extractTexts(pdfPath, images.length)

  // Step 4: Generate scripts with AI
  project.message = '正在用AI生成讲解词...'
  project.progress = 45
  for (let i = 0; i < project.texts.length; i++) {
    project.progress = 45 + Math.floor((i / project.texts.length) * 25)
    project.message = `正在生成第 ${i + 1}/${project.texts.length} 页讲解词...`
    const script = await generateScript(project.texts[i], i + 1, project.texts.length)
    project.slides[i].script = script
  }

  // Step 5: TTS
  project.message = '正在合成语音...'
  project.progress = 75
  for (let i = 0; i < project.slides.length; i++) {
    project.progress = 75 + Math.floor((i / project.slides.length) * 20)
    project.message = `正在合成第 ${i + 1}/${project.slides.length} 页语音...`
    const audioFile = path.join(dir, `audio_${i}.mp3`)
    await textToSpeech(project.slides[i].script, audioFile)
    project.slides[i].audio = `/output/${project.id}/audio_${i}.mp3`
  }

  project.status = 'done'
  project.message = '处理完成'
  project.progress = 100
  console.log(`[AIPPT] Project ${project.id} done: ${project.slides.length} slides`)
}

// Convert PPT to PDF using LibreOffice
function convertToPdf(inputPath, outputDir) {
  return new Promise((resolve, reject) => {
    const cmd = `libreoffice --headless --convert-to pdf --outdir "${outputDir}" "${inputPath}"`
    exec(cmd, { timeout: 120000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error('PPT转PDF失败: ' + (stderr || err.message)))
      // Find output PDF
      const basename = path.basename(inputPath, path.extname(inputPath))
      const pdfPath = path.join(outputDir, basename + '.pdf')
      if (fs.existsSync(pdfPath)) resolve(pdfPath)
      else reject(new Error('转换后的PDF文件未找到'))
    })
  })
}

// PDF to PNG images using pdftoppm
function pdfToImages(pdfPath, outputDir) {
  return new Promise((resolve, reject) => {
    const prefix = path.join(outputDir, 'slide')
    const cmd = `pdftoppm -png -r 200 "${pdfPath}" "${prefix}"`
    exec(cmd, { timeout: 120000 }, (err, stdout, stderr) => {
      if (err) {
        console.error('[PDF转图片失败]', stderr || err.message)
        return reject(new Error(`PDF转图片失败: ${stderr || err.message}`))
      }
      // Collect generated images - match both slide-1.png and slide-01.png formats
      const files = fs.readdirSync(outputDir)
        .filter(f => f.startsWith('slide') && f.endsWith('.png'))
        .sort()
        .map(f => path.join(outputDir, f))
      if (files.length === 0) return reject(new Error('未生成任何图片'))
      resolve(files)
    })
  })
}

// Extract text from PDF
async function extractTexts(pdfPath, numPages) {
  try {
    // Dynamic import for CommonJS module
    const pdfParse = require('pdf-parse')
    const buffer = fs.readFileSync(pdfPath)
    const data = await pdfParse(buffer)
    const fullText = data.text || ''

    // Simple split: divide text evenly by page count
    // This is approximate since pdf-parse doesn't give per-page text easily
    if (numPages <= 1) return [fullText]

    const lines = fullText.split('\n').filter(l => l.trim())
    const perPage = Math.ceil(lines.length / numPages)
    const pages = []
    for (let i = 0; i < numPages; i++) {
      const start = i * perPage
      const pageLines = lines.slice(start, start + perPage)
      pages.push(pageLines.join('\n') || `第${i + 1}页`)
    }
    return pages
  } catch (err) {
    console.error('[PDF Parse Error]', err.message)
    return Array.from({ length: numPages }, (_, i) => `第${i + 1}页`)
  }
}

// Generate narration script with AI
async function generateScript(text, pageNum, totalPages) {
  const prompt = `你是一位专业的PPT讲师，正在做一个${totalPages}页的演讲。
现在是第${pageNum}页，这页的文字内容是：

${text || '(此页无文字)'}

请为这一页写一段自然、专业的口语化讲解词（100-200字），像真人在讲课一样。
要求：
- 不要说"这页PPT"、"我们可以看到"等机械用语
- 直接讲解内容要点
- 语气自然流畅，适合朗读
- 如果是第一页，开头可以打招呼
- 如果是最后一页，结尾可以做总结
只输出讲解词，不需要其他格式。`

  try {
    return await callAI(prompt)
  } catch (err) {
    console.error(`[AI Error] Page ${pageNum}:`, err.message)
    return text || `这是第${pageNum}页的内容。`
  }
}

// Call AI via api.yunjunet.cn 内部网关
async function callAI(prompt, userId = 1) {
  const GATEWAY_URL = process.env.AI_GATEWAY_URL || 'http://localhost:3021'
  const INTERNAL_SECRET = process.env.INTERNAL_API_SECRET || ''
  const response = await fetch(`${GATEWAY_URL}/v1/internal/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Secret': INTERNAL_SECRET,
      'X-User-Id': String(userId),
    },
    body: JSON.stringify({
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
    }),
  })
  if (!response.ok) {
    const err = await response.text().catch(() => '')
    throw new Error(`AI网关返回 ${response.status}: ${err.slice(0, 100)}`)
  }
  const json = await response.json()
  const content = json.choices?.[0]?.message?.content
  if (!content) throw new Error('AI返回格式异常')
  return content.trim()
}

// Text to speech using edge-tts
function textToSpeech(text, outputPath, voice = 'zh-CN-XiaoxiaoNeural') {
  return new Promise((resolve, reject) => {
    // Escape text for shell
    const safeText = text.replace(/'/g, "'\\''").replace(/\n/g, ' ')
    const cmd = `edge-tts --voice ${voice} --text '${safeText}' --write-media "${outputPath}"`
    exec(cmd, { timeout: 60000 }, (err) => {
      if (err) {
        console.error('[TTS Error]', err.message)
        // Create empty file so playback doesn't break
        fs.writeFileSync(outputPath, '')
        resolve()
      } else {
        resolve()
      }
    })
  })
}

module.exports = router
