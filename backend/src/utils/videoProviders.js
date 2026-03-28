/**
 * 视频生成供应商调用函数
 * 供 aitools.js 和 ai-video 插件共用
 */

const arkRateLimiter = require('./arkRateLimiter');
const { getSettingCached } = require('../routes/quota');

const DOUBAO_VIDEO_MODEL = 'doubao-seedance-1-0-lite-t2v-250428';

async function getArkBaseUrl() {
  return await getSettingCached('ark_base_url', 'https://ark.cn-beijing.volces.com/api/v3');
}

async function getVideoModel() {
  return await getSettingCached('doubao_video_model', DOUBAO_VIDEO_MODEL);
}

// 豆包视频生成
async function callDoubaoVideo(prompt, duration, apiKey) {
  const rateLimitErr = await arkRateLimiter.consume();
  if (rateLimitErr) throw rateLimitErr;

  const arkBaseUrl = await getArkBaseUrl();
  const videoModel = await getVideoModel();
  const createRes = await fetch(`${arkBaseUrl}/contents/generations/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model: videoModel, content: [{ type: 'text', text: `${prompt} --duration ${duration} --camerafixed false` }] }),
  });
  if (!createRes.ok) throw new Error(`豆包API错误(${createRes.status}): ${await createRes.text()}`);
  const task = await createRes.json();

  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const pollRes = await fetch(`${arkBaseUrl}/contents/generations/tasks/${task.id}`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    const pollData = await pollRes.json();
    if (pollData.status === 'succeeded') return pollData.content?.video_url;
    if (pollData.status === 'failed') throw new Error(`视频生成失败: ${pollData.error?.message || ''}`);
  }
  throw new Error('视频生成超时');
}

// 快手可灵视频生成
async function callKlingVideo(prompt, duration, accessKey, secretKey) {
  const crypto = require('crypto');
  const timestamp = Date.now();
  const sign = crypto.createHmac('sha256', secretKey).update(`${accessKey}${timestamp}`).digest('hex');

  const createRes = await fetch('https://api.klingai.com/v1/videos/text2video', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Access-Key': accessKey, 'X-Timestamp': timestamp.toString(), 'X-Signature': sign },
    body: JSON.stringify({ prompt, duration: duration === 10 ? 'standard' : 'fast', aspect_ratio: '16:9' }),
  });
  if (!createRes.ok) throw new Error(`可灵API错误(${createRes.status}): ${await createRes.text()}`);
  const task = await createRes.json();

  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const pollRes = await fetch(`https://api.klingai.com/v1/videos/${task.data.task_id}`, {
      headers: {
        'X-Access-Key': accessKey,
        'X-Timestamp': Date.now().toString(),
        'X-Signature': crypto.createHmac('sha256', secretKey).update(`${accessKey}${Date.now()}`).digest('hex'),
      },
    });
    const pollData = await pollRes.json();
    if (pollData.data.status === 'succeed') return pollData.data.works[0]?.resource.resource;
    if (pollData.data.status === 'failed') throw new Error('可灵视频生成失败');
  }
  throw new Error('可灵视频生成超时');
}

// 智谱CogVideoX视频生成
async function callZhipuVideo(prompt, apiKey) {
  const createRes = await fetch('https://open.bigmodel.cn/api/paas/v4/videos/generations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model: 'cogvideox', prompt }),
  });
  if (!createRes.ok) throw new Error(`智谱API错误(${createRes.status}): ${await createRes.text()}`);
  const task = await createRes.json();

  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const pollRes = await fetch(`https://open.bigmodel.cn/api/paas/v4/async-result/${task.id}`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    const pollData = await pollRes.json();
    if (pollData.task_status === 'SUCCESS') return pollData.video_result[0]?.url;
    if (pollData.task_status === 'FAIL') throw new Error('智谱视频生成失败');
  }
  throw new Error('智谱视频生成超时');
}

// 阿里通义万象视频生成
async function callWanxVideo(prompt, apiKey) {
  const createRes = await fetch('https://dashscope.aliyuncs.com/api/v1/services/aigc/text2video/task', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}`, 'X-DashScope-Async': 'enable' },
    body: JSON.stringify({ model: 'wanx-v2.1-t2v', input: { prompt } }),
  });
  if (!createRes.ok) throw new Error(`通义API错误(${createRes.status}): ${await createRes.text()}`);
  const task = await createRes.json();

  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const pollRes = await fetch(`https://dashscope.aliyuncs.com/api/v1/tasks/${task.output.task_id}`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    const pollData = await pollRes.json();
    if (pollData.output.task_status === 'SUCCEEDED') return pollData.output.results[0]?.url;
    if (pollData.output.task_status === 'FAILED') throw new Error('通义视频生成失败');
  }
  throw new Error('通义视频生成超时');
}

// 腾讯混元视频生成
async function callHunyuanVideo(prompt, secretId, secretKey) {
  const crypto = require('crypto');
  const timestamp = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify({ Prompt: prompt });
  const canonicalRequest = `POST\n/\n\ncontent-type:application/json\nhost:hunyuan.tencentcloudapi.com\n\ncontent-type;host\n${crypto.createHash('sha256').update(payload).digest('hex')}`;
  const stringToSign = `TC3-HMAC-SHA256\n${timestamp}\n${crypto.createHash('sha256').update(canonicalRequest).digest('hex')}`;
  const signature = crypto.createHmac('sha256', `TC3${secretKey}`).update(stringToSign).digest('hex');

  const createRes = await fetch('https://hunyuan.tencentcloudapi.com', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `TC3-HMAC-SHA256 Credential=${secretId}/${new Date().toISOString().split('T')[0]}/hunyuan/tc3_request, SignedHeaders=content-type;host, Signature=${signature}`,
      'X-TC-Action': 'SubmitVideoGenerationJob',
      'X-TC-Timestamp': timestamp.toString(),
      'X-TC-Version': '2023-09-01',
    },
    body: payload,
  });
  if (!createRes.ok) throw new Error(`混元API错误(${createRes.status}): ${await createRes.text()}`);
  const task = await createRes.json();

  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const pollRes = await fetch('https://hunyuan.tencentcloudapi.com', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-TC-Action': 'DescribeVideoGenerationJob',
        'X-TC-Timestamp': Math.floor(Date.now() / 1000).toString(),
      },
      body: JSON.stringify({ JobId: task.Response.JobId }),
    });
    const pollData = await pollRes.json();
    if (pollData.Response.Status === 'Success') return pollData.Response.VideoUrl;
    if (pollData.Response.Status === 'Failed') throw new Error('混元视频生成失败');
  }
  throw new Error('混元视频生成超时');
}

// Sora2 视频生成（GrsAI第三方API）
async function callSora2Video(prompt, duration, apiKey) {
  const createRes = await fetch('https://grsai.dakka.com.cn/v1/video/sora-video', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model: 'sora-2', prompt, duration, aspectRatio: '16:9', webHook: '-1' }),
  });
  if (!createRes.ok) throw new Error(`Sora2 API错误(${createRes.status}): ${await createRes.text()}`);
  const task = await createRes.json();
  const taskId = task.data?.id || task.id;

  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 10000));
    const pollRes = await fetch('https://grsai.dakka.com.cn/v1/draw/result', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ id: taskId }),
    });
    if (!pollRes.ok) continue;
    const pollData = await pollRes.json();
    console.log(`[sora2] poll ${i + 1}: status=${pollData.data?.status}`);
    if (pollData.data?.status === 'succeeded') return pollData.data?.results?.[0]?.url || pollData.data?.result_url;
    if (pollData.data?.status === 'failed') throw new Error(`Sora2视频生成失败: ${pollData.data?.error || ''}`);
  }
  throw new Error('Sora2视频生成超时');
}

// Veo3.1 视频生成（GrsAI）
async function callVeo3Video(prompt, apiKey) {
  const createRes = await fetch('https://api.grsai.com/v1/video/sora-video', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model: 'veo-3.1', prompt, webhook: '-1' }),
  });
  if (!createRes.ok) throw new Error(`Veo3.1 API错误(${createRes.status}): ${await createRes.text()}`);
  const task = await createRes.json();
  const taskId = task.task_id || task.id;

  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 10000));
    const pollRes = await fetch(`https://api.grsai.com/v1/video/sora-video/${taskId}`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    if (!pollRes.ok) continue;
    const pollData = await pollRes.json();
    console.log(`[veo3] poll ${i + 1}: status=${pollData.status}`);
    if (pollData.status === 'completed' || pollData.status === 'succeeded') return pollData.video_url || pollData.url || pollData.output?.url;
    if (pollData.status === 'failed' || pollData.status === 'error') throw new Error(`Veo3.1视频生成失败: ${pollData.error || pollData.message || ''}`);
  }
  throw new Error('Veo3.1视频生成超时');
}

module.exports = {
  callDoubaoVideo,
  callKlingVideo,
  callZhipuVideo,
  callWanxVideo,
  callHunyuanVideo,
  callSora2Video,
  callVeo3Video,
  getArkBaseUrl,
  getVideoModel,
};
