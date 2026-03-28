const router = require('express').Router();
const db = require('../config/db');
const { auth, requireAdmin } = require('../middleware/auth');
const { getSettingCached } = require('./quota');
const storage = require('../storage/local');
const fs = require('fs');
const path = require('path');
const https = require('https');

const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || 'uploads');
const AITOOLS_DIR = path.join(UPLOAD_DIR, 'aitools');

// AI配置
const arkRateLimiter = require('../utils/arkRateLimiter');
const DOUBAO_API_KEY = process.env.DOUBAO_API_KEY;
const DOUBAO_TEXT_MODEL = 'deepseek-v3-2-251201';

// 确保目录存在
fs.mkdirSync(AITOOLS_DIR, { recursive: true });

// 去水印服务 API Key
const WATERMARK_API_KEY = 'han1234';

// 初始化数据库表：存储已解析的链接
(async () => {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS watermark_cache (
        id INT AUTO_INCREMENT PRIMARY KEY,
        original_url VARCHAR(1024) NOT NULL,
        video_url VARCHAR(1024),
        page_text TEXT,
        success BOOLEAN DEFAULT FALSE,
        error_message TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_url (original_url(255))
      )
    `);
    console.log('[admin] watermark_cache table ready');
  } catch (err) {
    console.error('[admin] Failed to create watermark_cache table:', err.message);
  }
})();

// Cloudflare Worker 代理 URL（如果配置了，则使用代理下载）
const CLOUDFLARE_WORKER_URL = process.env.CLOUDFLARE_WORKER_URL || null;

// 从视频提取缩略图
function extractThumbnail(videoPath) {
  return new Promise((resolve) => {
    const imgDir = path.join(UPLOAD_DIR, 'images');
    fs.mkdirSync(imgDir, { recursive: true });
    const filename = `thumb-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`;
    const outputPath = path.join(imgDir, filename);

    // 使用系统 ffmpeg 命令
    const { exec } = require('child_process');
    exec(`/usr/bin/ffmpeg -i "${videoPath}" -ss 00:00:01 -vframes 1 -vf "scale='min(720,iw)':-1" "${outputPath}"`, (error, stdout, stderr) => {
      if (error) {
        console.error('ffmpeg error:', error);
        resolve(null);
        return;
      }
      resolve(path.join('images', filename).replace(/\\/g, '/'));
    });
  });
}

// 分析视频内容生成描述
async function analyzeVideoContent(videoPath) {
  return new Promise(async (resolve) => {
    try {
      if (!DOUBAO_API_KEY) {
        console.log('[analyzeVideo] DOUBAO_API_KEY not configured');
        resolve('');
        return;
      }

      const { exec } = require('child_process');
      const tempDir = path.join(UPLOAD_DIR, 'temp');
      fs.mkdirSync(tempDir, { recursive: true });

      // 提取3个关键帧（开头、中间、结尾）
      const frames = [];
      const timestamps = ['00:00:01', '00:00:03', '00:00:05'];

      for (let i = 0; i < timestamps.length; i++) {
        const framePath = path.join(tempDir, `frame-${Date.now()}-${i}.jpg`);

        await new Promise((resolveFrame) => {
          exec(`/usr/bin/ffmpeg -i "${videoPath}" -ss ${timestamps[i]} -vframes 1 -vf "scale=512:-1" "${framePath}" -y`,
            (error) => {
              if (!error && fs.existsSync(framePath)) {
                frames.push(framePath);
              }
              resolveFrame();
            }
          );
        });
      }

      if (frames.length === 0) {
        console.log('[analyzeVideo] No frames extracted');
        resolve('');
        return;
      }

      // 读取第一帧并转为base64
      const frameBuffer = fs.readFileSync(frames[0]);
      const base64Image = frameBuffer.toString('base64');

      // 调用AI分析图像
      const prompt = `请分析这个视频截图，用简洁的中文描述视频内容（50-100字）。要求：
1. 描述画面中的主要内容和场景
2. 如果有文字，提取关键信息
3. 语言自然流畅，适合作为短视频文案
4. 直接输出描述，不要加任何前缀`;

      const rlErr = await arkRateLimiter.consume();
      if (rlErr) return res.status(429).json({ message: rlErr.message, code: 'ARK_RATE_LIMITED', retryAfter: rlErr.retryAfter });
      const arkBaseUrl = await getSettingCached('ark_base_url', 'https://ark.cn-beijing.volces.com/api/v3');
      const response = await fetch(`${arkBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${DOUBAO_API_KEY}`
        },
        body: JSON.stringify({
          model: 'doubao-vision-pro-32k',
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64Image}` } }
            ]
          }]
        })
      });

      // 清理临时文件
      frames.forEach(f => {
        try { fs.unlinkSync(f); } catch (e) {}
      });

      if (!response.ok) {
        console.log('[analyzeVideo] AI API failed:', response.status);
        resolve('');
        return;
      }

      const data = await response.json();
      const description = data.choices?.[0]?.message?.content || '';

      console.log('[analyzeVideo] Generated description:', description.substring(0, 50) + '...');
      resolve(description);

    } catch (e) {
      console.error('[analyzeVideo] Error:', e.message);
      resolve('');
    }
  });
}

// 下载视频（自动替换为可访问的镜像域名）
async function downloadVideo(url, filename) {
  const filePath = path.join(AITOOLS_DIR, filename);

  try {
    console.log('[downloadVideo] Starting download:', url);

    // 将 videos.openai.com 替换为 videos-us3.ss2.life（镜像服务，绕过 IP 限制）
    const downloadUrl = url.replace('videos.openai.com', 'videos-us3.ss2.life');
    console.log('[downloadVideo] Using mirror URL:', downloadUrl);

    let response;

    // 如果配置了 Cloudflare Worker，使用代理下载
    if (CLOUDFLARE_WORKER_URL) {
      console.log('[downloadVideo] Using Cloudflare Worker proxy:', CLOUDFLARE_WORKER_URL);
      response = await fetch(CLOUDFLARE_WORKER_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ video_url: downloadUrl })
      });
    } else {
      // 直接下载镜像 URL
      response = await fetch(downloadUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      });
    }

    if (!response.ok) {
      throw new Error(`Download failed: ${response.status} ${response.statusText}`);
    }

    // 获取视频数据
    const buffer = await response.arrayBuffer();

    if (!buffer || buffer.byteLength === 0) {
      throw new Error('Empty video data received');
    }

    // 写入文件
    fs.writeFileSync(filePath, Buffer.from(buffer));
    console.log('[downloadVideo] File saved:', filePath, buffer.byteLength, 'bytes');

    // 返回相对路径
    return path.relative(UPLOAD_DIR, filePath).replace(/\\/g, '/');

  } catch (err) {
    console.error('[downloadVideo] Download error:', err);
    throw err;
  }
}

// 去水印并投稿到素材广场
router.post(
  '/watermark/publish',
  auth,
  requireAdmin,
  async (req, res) => {
    const { url, title, category, pageText } = req.body;

    if (!url || !url.trim()) {
      return res.status(400).json({ message: '请输入视频链接' });
    }

    let watermarkData = null;
    let localVideoPath = null;

    try {
      const trimmedUrl = url.trim();

      // 1. 检查缓存
      const [cached] = await db.query(
        'SELECT * FROM watermark_cache WHERE original_url = ? ORDER BY created_at DESC LIMIT 1',
        [trimmedUrl]
      );

      let videoUrl, extractedPageText;

      if (cached.length > 0 && cached[0].success) {
        console.log('[watermark/publish] Cache hit:', trimmedUrl);
        videoUrl = cached[0].video_url;
        extractedPageText = cached[0].page_text || '';
      } else {
        console.log('[watermark/publish] Cache miss, calling API:', trimmedUrl);

        // 调用去水印接口
        const watermarkApiKey = await getSettingCached('watermark_api_key', 'han1234');
        const watermarkRes = await fetch('https://s2mw.opensora2.cn/api/parse-video', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${watermarkApiKey}`
          },
          body: JSON.stringify({ url: trimmedUrl })
        });

        if (!watermarkRes.ok) {
          const errData = await watermarkRes.json().catch(() => ({}));
          const errorMsg = errData.message || `请求失败: ${watermarkRes.status}`;

          // 记录失败到缓存
          await db.query(
            'INSERT INTO watermark_cache (original_url, success, error_message) VALUES (?, FALSE, ?)',
            [trimmedUrl, errorMsg]
          );

          throw new Error(errorMsg);
        }

        watermarkData = await watermarkRes.json();

        videoUrl = watermarkData.video_url || watermarkData.download_link;
        if (!watermarkData.success || !videoUrl) {
          const errorMsg = watermarkData.message || '解析失败';

          // 记录失败到缓存
          await db.query(
            'INSERT INTO watermark_cache (original_url, success, error_message) VALUES (?, FALSE, ?)',
            [trimmedUrl, errorMsg]
          );

          throw new Error(errorMsg);
        }

        extractedPageText = watermarkData.pageText || '';

        // 记录成功到缓存
        await db.query(
          'INSERT INTO watermark_cache (original_url, video_url, page_text, success) VALUES (?, ?, ?, TRUE)',
          [trimmedUrl, videoUrl, extractedPageText]
        );

        console.log('[watermark/publish] Cached new result');
      }

      console.log('[watermark/publish] Video URL:', videoUrl);

      // 2. 使用用户提供的内容或缓存的文案
      let finalPageText = pageText || extractedPageText || '';

      // 3. 下载视频到本地
      const filename = `watermark-${Date.now()}-${Math.random().toString(36).substring(2, 8)}.mp4`;
      localVideoPath = await downloadVideo(videoUrl, filename);
      console.log('[watermark/publish] Video downloaded:', localVideoPath);

      // 3.5. 如果没有文案，分析视频内容生成描述
      if (!finalPageText || finalPageText.trim().length === 0) {
        console.log('[watermark/publish] No text found, analyzing video content...');
        const videoFullPath = path.join(UPLOAD_DIR, localVideoPath);
        const aiDescription = await analyzeVideoContent(videoFullPath);
        if (aiDescription) {
          finalPageText = aiDescription;
          console.log('[watermark/publish] AI generated description:', aiDescription.substring(0, 50) + '...');
        }
      }

      // 4. 提取封面
      let imagePath = null;
      try {
        // 使用系统命令提取封面
        const { exec } = require('child_process');
        const imgDir = path.join(UPLOAD_DIR, 'images');
        fs.mkdirSync(imgDir, { recursive: true });
        const thumbFilename = `thumb-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`;
        const outputPath = path.join(imgDir, thumbFilename);

        await new Promise((resolve, reject) => {
          exec(`/usr/bin/ffmpeg -i "${path.join(UPLOAD_DIR, localVideoPath)}" -ss 00:00:01 -vframes 1 -vf "scale='min(720,iw)':-1" "${outputPath}"`, (error, stdout, stderr) => {
            if (error) {
              console.error('ffmpeg error:', error);
              reject(error);
              return;
            }
            resolve(path.join('images', thumbFilename).replace(/\\/g, '/'));
          });
        }).then(thumbPath => {
          imagePath = thumbPath;
          console.log('[watermark/publish] Thumbnail extracted:', imagePath);
        }).catch(e => {
          console.log('Failed to extract thumbnail:', e.message);
        });
      } catch (e) {
        console.log('Failed to extract thumbnail:', e.message);
      }

      // 5. 投稿到素材广场
      const resolvedTitle = title?.trim() || (finalPageText ? finalPageText.trim().split('\n')[0] : '');
      if (!resolvedTitle) {
        throw new Error('标题不能为空，或请填写文案以自动提取标题');
      }

      // 重复检测
      const [titleCheck] = await db.query('SELECT id FROM content WHERE title = ?', [resolvedTitle]);
      if (titleCheck.length) {
        throw new Error(`标题「${resolvedTitle}」已存在（ID: ${titleCheck[0].id}）`);
      }

      if (finalPageText?.trim()) {
        const [copyCheck] = await db.query('SELECT id FROM content WHERE copy = ?', [finalPageText.trim()]);
        if (copyCheck.length) {
          throw new Error(`文案内容与「${copyCheck[0].title}」（ID: ${copyCheck[0].id}）重复`);
        }
      }

      // 检查分类是否开启审核
      let reviewStatus = 'approved';
      const validStatuses = ['approved', 'pending', 'rejected'];
      if (req.body.review_status && validStatuses.includes(req.body.review_status)) {
        reviewStatus = req.body.review_status;
      } else if (category) {
        const [[cat]] = await db.query('SELECT review_enabled FROM categories WHERE name = ?', [category]);
        if (cat?.review_enabled) reviewStatus = 'pending';
      }

      const [result] = await db.query(
        'INSERT INTO content (title, category, copy, image_path, video_path, created_by, review_status, source_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [resolvedTitle, category || null, finalPageText || null, imagePath, localVideoPath, req.user.id, reviewStatus, url]
      );

      res.json({
        success: true,
        message: '投稿成功',
        content_id: result.insertId,
        title: resolvedTitle,
        review_status: reviewStatus
      });

    } catch (e) {
      console.error('[watermark/publish] Error:', e);

      // 如果下载了视频但投稿失败，删除文件
      if (localVideoPath) {
        try {
          storage.delete(localVideoPath);
        } catch (deleteError) {
          console.error('Failed to delete downloaded video:', deleteError);
        }
      }

      res.status(500).json({ message: e.message || '投稿失败' });
    }
  }
);

// 批量去水印并投稿到素材广场
router.post(
  '/watermark/batch-publish',
  auth,
  requireAdmin,
  async (req, res) => {
    const { urls, category } = req.body;

    if (!urls || !urls.trim()) {
      return res.status(400).json({ message: '请输入视频链接' });
    }

    try {
      // 解析链接列表（一行一个）
      const urlList = urls.split('\n')
        .map(u => u.trim())
        .filter(u => u.length > 0);

      if (urlList.length === 0) {
        return res.status(400).json({ message: '没有有效的链接' });
      }

      if (urlList.length > 50) {
        return res.status(400).json({ message: '单次最多处理50个链接' });
      }

      const results = [];
      let successCount = 0;
      let skipCount = 0;
      let failCount = 0;

      for (const url of urlList) {
        try {
          const trimmedUrl = url.trim();
          console.log(`[batch-publish] Processing ${results.length + 1}/${urlList.length}:`, trimmedUrl);

          // 1. 检查缓存
          const [cached] = await db.query(
            'SELECT * FROM watermark_cache WHERE original_url = ? ORDER BY created_at DESC LIMIT 1',
            [trimmedUrl]
          );

          let videoUrl, extractedPageText = '';
          let fromCache = false;

          if (cached.length > 0 && cached[0].success) {
            console.log('[batch-publish] Cache hit:', trimmedUrl);
            videoUrl = cached[0].video_url;
            extractedPageText = cached[0].page_text || '';
            fromCache = true;
          } else {
            console.log('[batch-publish] Cache miss, calling API:', trimmedUrl);

            // 调用去水印接口
            const batchWatermarkApiKey = await getSettingCached('watermark_api_key', 'han1234');
            const watermarkRes = await fetch('https://s2mw.opensora2.cn/api/parse-video', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${batchWatermarkApiKey}`
              },
              body: JSON.stringify({ url: trimmedUrl })
            });

            if (!watermarkRes.ok) {
              const errData = await watermarkRes.json().catch(() => ({}));
              const errorMsg = errData.message || `请求失败: ${watermarkRes.status}`;

              // 记录失败到缓存
              await db.query(
                'INSERT INTO watermark_cache (original_url, success, error_message) VALUES (?, FALSE, ?)',
                [trimmedUrl, errorMsg]
              );

              throw new Error(errorMsg);
            }

            const watermarkData = await watermarkRes.json();
            videoUrl = watermarkData.video_url || watermarkData.download_link;

            if (!watermarkData.success || !videoUrl) {
              const errorMsg = watermarkData.message || '解析失败';

              // 记录失败到缓存
              await db.query(
                'INSERT INTO watermark_cache (original_url, success, error_message) VALUES (?, FALSE, ?)',
                [trimmedUrl, errorMsg]
              );

              throw new Error(errorMsg);
            }

            extractedPageText = watermarkData.pageText || '';

            // 记录成功到缓存
            await db.query(
              'INSERT INTO watermark_cache (original_url, video_url, page_text, success) VALUES (?, ?, ?, TRUE)',
              [trimmedUrl, videoUrl, extractedPageText]
            );
          }

          // 2. 下载视频
          const filename = `watermark-${Date.now()}-${Math.random().toString(36).substring(2, 8)}.mp4`;
          const localVideoPath = await downloadVideo(videoUrl, filename);

          // 3. 如果没有文案，分析视频内容
          let finalPageText = extractedPageText;
          if (!finalPageText || finalPageText.trim().length === 0) {
            const videoFullPath = path.join(UPLOAD_DIR, localVideoPath);
            const aiDescription = await analyzeVideoContent(videoFullPath);
            if (aiDescription) {
              finalPageText = aiDescription;
            }
          }

          // 4. 提取封面
          let imagePath = null;
          try {
            const { exec } = require('child_process');
            const imgDir = path.join(UPLOAD_DIR, 'images');
            fs.mkdirSync(imgDir, { recursive: true });
            const thumbFilename = `thumb-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`;
            const outputPath = path.join(imgDir, thumbFilename);

            await new Promise((resolve, reject) => {
              exec(`/usr/bin/ffmpeg -i "${path.join(UPLOAD_DIR, localVideoPath)}" -ss 00:00:01 -vframes 1 -vf "scale='min(720,iw)':-1" "${outputPath}"`, (error) => {
                if (error) {
                  reject(error);
                  return;
                }
                resolve(path.join('images', thumbFilename).replace(/\\\\/g, '/'));
              });
            }).then(thumbPath => {
              imagePath = thumbPath;
            }).catch(() => {});
          } catch (e) {}

          // 5. 生成标题并检查重复
          const resolvedTitle = finalPageText ? finalPageText.trim().split('\n')[0] : `视频-${Date.now()}`;

          // 检查标题是否已存在
          const [titleCheck] = await db.query('SELECT id, title FROM content WHERE title = ?', [resolvedTitle]);
          if (titleCheck.length) {
            results.push({
              url: trimmedUrl,
              success: false,
              skipped: true,
              message: `标题「${resolvedTitle}」已存在（ID: ${titleCheck[0].id}）`,
              from_cache: fromCache
            });
            skipCount++;
            continue;
          }

          // 6. 检查分类审核状态
          let reviewStatus = 'approved';
          if (category) {
            const [[cat]] = await db.query('SELECT review_enabled FROM categories WHERE name = ?', [category]);
            if (cat?.review_enabled) reviewStatus = 'pending';
          }

          // 7. 插入数据库
          const [result] = await db.query(
            'INSERT INTO content (title, category, copy, image_path, video_path, created_by, review_status, source_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [resolvedTitle, category || null, finalPageText || null, imagePath, localVideoPath, req.user.id, reviewStatus, trimmedUrl]
          );

          results.push({
            url: trimmedUrl,
            success: true,
            content_id: result.insertId,
            title: resolvedTitle,
            from_cache: fromCache
          });
          successCount++;

        } catch (e) {
          console.error('[batch-publish] Error processing URL:', url, e.message);
          results.push({
            url: url,
            success: false,
            message: e.message || '处理失败'
          });
          failCount++;
        }
      }

      res.json({
        success: true,
        total: urlList.length,
        success_count: successCount,
        skip_count: skipCount,
        fail_count: failCount,
        results: results
      });

    } catch (e) {
      console.error('[batch-publish] Error:', e);
      res.status(500).json({ message: e.message || '批量投稿失败' });
    }
  }
);

// 批量去水印解析（不投稿，只返回解析结果）
router.post(
  '/watermark/batch-parse',
  auth,
  requireAdmin,
  async (req, res) => {
    const { urls } = req.body;

    if (!urls || !urls.trim()) {
      return res.status(400).json({ message: '请输入视频链接' });
    }

    try {
      // 解析链接列表
      const urlList = urls.split('\n')
        .map(u => u.trim())
        .filter(u => u.length > 0);

      if (urlList.length === 0) {
        return res.status(400).json({ message: '没有有效的链接' });
      }

      if (urlList.length > 50) {
        return res.status(400).json({ message: '单次最多处理50个链接' });
      }

      // 并行处理所有链接
      const parsePromises = urlList.map(async (url, index) => {
        try {
          const trimmedUrl = url.trim();
          console.log(`[batch-parse] Processing ${index + 1}/${urlList.length}:`, trimmedUrl);

          // 1. 先检查数据库是否已存在该链接
          const [existingContent] = await db.query(
            'SELECT id, title FROM content WHERE source_url = ?',
            [trimmedUrl]
          );

          if (existingContent.length > 0) {
            console.log('[batch-parse] URL already exists in database, skipping:', trimmedUrl);
            throw new Error(`该链接已投稿（ID: ${existingContent[0].id}，标题: ${existingContent[0].title}），跳过解析`);
          }

          // 2. 检查缓存
          const [cached] = await db.query(
            'SELECT * FROM watermark_cache WHERE original_url = ? ORDER BY created_at DESC LIMIT 1',
            [trimmedUrl]
          );

          let videoUrl, extractedPageText = '';
          let fromCache = false;

          if (cached.length > 0 && cached[0].success) {
            console.log('[batch-parse] Cache hit:', trimmedUrl);
            videoUrl = cached[0].video_url;
            extractedPageText = cached[0].page_text || '';
            fromCache = true;
          } else {
            console.log('[batch-parse] Cache miss, calling API:', trimmedUrl);

            // 调用去水印接口
            const watermarkRes = await fetch('https://s2mw.opensora2.cn/api/parse-video', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${await getSettingCached('watermark_api_key', 'han1234')}`
              },
              body: JSON.stringify({ url: trimmedUrl })
            });

            if (!watermarkRes.ok) {
              const errData = await watermarkRes.json().catch(() => ({}));
              const errorMsg = errData.message || `请求失败: ${watermarkRes.status}`;

              await db.query(
                'INSERT INTO watermark_cache (original_url, success, error_message) VALUES (?, FALSE, ?)',
                [trimmedUrl, errorMsg]
              );

              throw new Error(errorMsg);
            }

            const watermarkData = await watermarkRes.json();
            videoUrl = watermarkData.video_url || watermarkData.download_link;

            if (!watermarkData.success || !videoUrl) {
              const errorMsg = watermarkData.message || '解析失败';

              await db.query(
                'INSERT INTO watermark_cache (original_url, success, error_message) VALUES (?, FALSE, ?)',
                [trimmedUrl, errorMsg]
              );

              throw new Error(errorMsg);
            }

            extractedPageText = watermarkData.pageText || '';

            // 移除提前检查标题重复的逻辑（已通过链接检查）

            await db.query(
              'INSERT INTO watermark_cache (original_url, video_url, page_text, success) VALUES (?, ?, ?, TRUE)',
              [trimmedUrl, videoUrl, extractedPageText]
            );
          }

          // 3. 下载视频（使用psh参数作为文件名）
          let pshValue = '';
          try {
            const urlObj = new URL(trimmedUrl);
            pshValue = urlObj.searchParams.get('psh') || '';
          } catch (e) {}

          const filename = pshValue ? `${pshValue}.mp4` : `watermark-${Date.now()}-${Math.random().toString(36).substring(2, 8)}.mp4`;
          const localVideoPath = await downloadVideo(videoUrl, filename);

          // 3. 如果没有文案，分析视频内容
          let finalPageText = extractedPageText;
          if (!finalPageText || finalPageText.trim().length === 0) {
            const videoFullPath = path.join(UPLOAD_DIR, localVideoPath);
            const aiDescription = await analyzeVideoContent(videoFullPath);
            if (aiDescription) {
              finalPageText = aiDescription;
            }
          }

          // 4. 提取封面
          let imagePath = null;
          try {
            const { exec } = require('child_process');
            const imgDir = path.join(UPLOAD_DIR, 'images');
            fs.mkdirSync(imgDir, { recursive: true });
            const thumbFilename = `thumb-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`;
            const outputPath = path.join(imgDir, thumbFilename);

            await new Promise((resolve, reject) => {
              exec(`/usr/bin/ffmpeg -i "${path.join(UPLOAD_DIR, localVideoPath)}" -ss 00:00:01 -vframes 1 -vf "scale='min(720,iw)':-1" "${outputPath}"`, (error) => {
                if (error) {
                  reject(error);
                  return;
                }
                resolve(path.join('images', thumbFilename).replace(/\\\\/g, '/'));
              });
            }).then(thumbPath => {
              imagePath = thumbPath;
            }).catch(() => {});
          } catch (e) {}

          // 5. 标题强制为空（投稿时再从内容第一行提取）
          const resolvedTitle = '';

          // 提取纯净的psh值（去除文件扩展名和前缀）
          let cleanPsh = pshValue;
          if (!cleanPsh) {
            const basename = path.basename(localVideoPath, '.mp4');
            // 如果是watermark-开头的，不使用它作为psh
            if (!basename.startsWith('watermark-')) {
              cleanPsh = basename;
            }
          }

          return {
            url: trimmedUrl,
            success: true,
            video_url: videoUrl,
            local_video_path: localVideoPath,
            image_path: imagePath,
            title: resolvedTitle,
            copy: finalPageText || '',
            from_cache: fromCache,
            psh: cleanPsh || ''
          };

        } catch (e) {
          console.error('[batch-parse] Error processing URL:', url, e.message);
          return {
            url: url,
            success: false,
            message: e.message || '处理失败'
          };
        }
      });

      // 等待所有解析完成
      const results = await Promise.all(parsePromises);

      res.json({
        success: true,
        total: urlList.length,
        results: results
      });

    } catch (e) {
      console.error('[batch-parse] Error:', e);
      res.status(500).json({ message: e.message || '批量解析失败' });
    }
  }
);

// 批量投稿（接收已解析的数据）
router.post(
  '/watermark/batch-submit',
  auth,
  requireAdmin,
  async (req, res) => {
    const { items, category, review_status } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: '没有要投稿的内容' });
    }

    try {
      const results = [];
      let successCount = 0;
      let failCount = 0;

      // 使用传入的审核状态，默认为 approved
      const finalReviewStatus = review_status || 'approved';

      for (const item of items) {
        try {
          let { url, title, copy, local_video_path, image_path, psh } = item;

          // 如果标题为空，强制从内容第一行提取
          if (!title || !title.trim()) {
            if (copy && copy.trim()) {
              title = copy.trim().split('\n')[0];
            } else {
              throw new Error('标题和内容均为空，无法投稿');
            }
          }

          title = title.trim();

          // 检查链接是否已存在
          const [urlCheck] = await db.query('SELECT id FROM content WHERE source_url = ?', [url]);
          if (urlCheck.length) {
            throw new Error(`该链接已投稿（ID: ${urlCheck[0].id}）`);
          }

          // 检查标题重复
          const [titleCheck] = await db.query('SELECT id FROM content WHERE title = ?', [title]);
          if (titleCheck.length) {
            throw new Error(`标题「${title}」已存在（ID: ${titleCheck[0].id}）`);
          }

          // 检查内容重复
          if (copy && copy.trim()) {
            const [copyCheck] = await db.query('SELECT id, title FROM content WHERE copy = ?', [copy.trim()]);
            if (copyCheck.length) {
              throw new Error(`内容重复，已存在相同内容（ID: ${copyCheck[0].id}，标题: ${copyCheck[0].title}）`);
            }
          }

          // 检查视频文件名重复（通过psh或文件名）
          const videoFilename = psh || path.basename(local_video_path, '.mp4');
          const [videoCheck] = await db.query(
            'SELECT id, title FROM content WHERE video_path LIKE ?',
            [`%${videoFilename}%`]
          );
          if (videoCheck.length) {
            throw new Error(`视频文件已存在（ID: ${videoCheck[0].id}，标题: ${videoCheck[0].title}）`);
          }

          // 插入数据库（使用传入的审核状态）
          const [result] = await db.query(
            'INSERT INTO content (title, category, copy, image_path, video_path, created_by, review_status, source_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [title, category || null, copy || null, image_path, local_video_path, req.user.id, finalReviewStatus, url]
          );

          results.push({
            url: url,
            success: true,
            content_id: result.insertId,
            title: title
          });
          successCount++;

        } catch (e) {
          console.error('[batch-submit] Error:', e.message);
          results.push({
            url: item.url,
            success: false,
            message: e.message || '投稿失败'
          });
          failCount++;
        }
      }

      res.json({
        success: true,
        total: items.length,
        success_count: successCount,
        fail_count: failCount,
        results: results
      });

    } catch (e) {
      console.error('[batch-submit] Error:', e);
      res.status(500).json({ message: e.message || '批量投稿失败' });
    }
  }
);

// 下载视频到服务器并返回 URL
router.post(
  '/watermark/download',
  auth,
  requireAdmin,
  async (req, res) => {
    const { video_url } = req.body;

    if (!video_url || !video_url.trim()) {
      return res.status(400).json({ message: '请提供视频链接' });
    }

    try {
      console.log('[watermark/download] Starting download:', video_url);

      // 使用 yt-dlp 下载视频到本地
      const filename = `watermark-${Date.now()}-${Math.random().toString(36).substring(2, 8)}.mp4`;
      const localVideoPath = await downloadVideo(video_url.trim(), filename);
      console.log('[watermark/download] Video downloaded:', localVideoPath);

      // 返回视频 URL
      const videoUrl = `/uploads/${localVideoPath}`;

      res.json({
        success: true,
        message: '视频下载成功',
        video_path: localVideoPath,
        video_url: videoUrl
      });

    } catch (e) {
      console.error('[watermark/download] Error:', e);
      res.status(500).json({ message: e.message || '下载失败' });
    }
  }
);

module.exports = router;