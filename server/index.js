import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import FormData from 'form-data';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const app = express();
const PORT = process.env.PORT || 3001;

// ─── 目录 ──────────────────────────────────────────────────────────────
const OUTPUT_DIR  = path.resolve(__dirname, '../output');
const IMAGE_DIR_PREFIX = 'img';
let allocationLock = Promise.resolve();
let activeImageDirName = null;

function sanitizeFrameName(name) {
  return String(name || '')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 120);
}

function extractFrameOrder(frameName) {
  const raw = String(frameName || '');
  const prefixedMatch = raw.match(/^(\d+)-/);
  if (prefixedMatch) return Number.parseInt(prefixedMatch[1], 10);

  const shotMatch = raw.match(/^shot-\d+-\d+-(\d+)$/);
  if (shotMatch) return Number.parseInt(shotMatch[1], 10) + 1;

  return null;
}

function buildOrderedFrameFileName(frameName, source = 'images') {
  const order = extractFrameOrder(frameName);
  if (order && Number.isFinite(order) && order > 0) {
    return `frame_${String(order).padStart(5, '0')}.png`;
  }

  const safeName = sanitizeFrameName(frameName) || `${source}-${Date.now()}`;
  return `${safeName}.png`;
}

async function getNextImageDirName() {
  const items = await fs.readdir(OUTPUT_DIR, { withFileTypes: true }).catch(() => []);
  let maxIndex = 0;

  for (const item of items) {
    if (!item.isDirectory()) continue;
    const match = item.name.match(/^img(\d+)$/);
    if (!match) continue;
    const idx = Number.parseInt(match[1], 10);
    if (Number.isFinite(idx) && idx > maxIndex) maxIndex = idx;
  }

  return `${IMAGE_DIR_PREFIX}${maxIndex + 1}`;
}

async function ensureActiveImageDir(frameOrder) {
  return new Promise((resolve, reject) => {
    allocationLock = allocationLock
      .then(async () => {
        if (!activeImageDirName) {
          activeImageDirName = await getNextImageDirName();
          await fs.mkdir(path.join(OUTPUT_DIR, activeImageDirName), { recursive: true });
          return activeImageDirName;
        }

        if (frameOrder === 1) {
          const firstFramePath = path.join(OUTPUT_DIR, activeImageDirName, 'frame_00001.png');
          const hasFirstFrame = await fs.access(firstFramePath).then(() => true).catch(() => false);
          if (hasFirstFrame) {
            activeImageDirName = await getNextImageDirName();
            await fs.mkdir(path.join(OUTPUT_DIR, activeImageDirName), { recursive: true });
          }
        }

        return activeImageDirName;
      })
      .then(resolve)
      .catch(reject);
  });
}

async function saveFrameBase64(b64, frameName, source = 'images') {
  if (!b64) return null;

  const frameOrder = extractFrameOrder(frameName);
  const dirName = await ensureActiveImageDir(frameOrder);
  const targetDir = path.join(OUTPUT_DIR, dirName);
  const fileName = buildOrderedFrameFileName(frameName, source);
  const filePath = path.join(targetDir, fileName);

  try {
    await fs.mkdir(targetDir, { recursive: true });
    // 同名帧会直接覆盖，确保“保留新图，替换旧图”
    await fs.writeFile(filePath, Buffer.from(b64, 'base64'));
    return `/output/${dirName}/${fileName}`;
  } catch (err) {
    console.warn('[saveFrameBase64] failed to save or cleanup frame:', err?.message || err);
    // 尝试回退：写入当前目录中的唯一文件名
    try {
      const safeName = sanitizeFrameName(frameName) || `${source}-${Date.now()}`;
      const fallbackName = `${safeName}-${Date.now()}.png`;
      await fs.writeFile(path.join(targetDir, fallbackName), Buffer.from(b64, 'base64'));
      return `/output/${dirName}/${fallbackName}`;
    } catch (err2) {
      console.error('[saveFrameBase64] fallback save failed:', err2?.message || err2);
      throw err2;
    }
  }
}

// 启动时确保目录存在
for (const d of [OUTPUT_DIR]) {
  fs.mkdir(d, { recursive: true }).catch(() => {});
}

// ─── API 配置 ──────────────────────────────────────────────────────────────
// 图像生成：自定义反代 + gpt-image-2
const IMAGE_API_BASE = process.env.IMAGE_API_BASE || 'https://wzjself.org/v1';
const IMAGE_API_KEY  = process.env.IMAGE_API_KEY  || '';

// 文本生成：ChatGPT 5.4（向后兼容 DEEPSEEK 变量）
const TEXT_API_BASE = process.env.OPENAI_API_BASE || process.env.TEXT_API_BASE || 'https://api.openai.com/v1';
const TEXT_API_KEY  = process.env.OPENAI_API_KEY || process.env.DEEPSEEK_API_KEY || process.env.TEXT_API_KEY || '';
const TEXT_MODEL    = process.env.TEXT_MODEL || 'gpt-5.4';
const TEXT_API_BASE_FALLBACK = process.env.TEXT_API_BASE_FALLBACK || 'https://api.deepseek.com/v1';
const TEXT_API_KEY_FALLBACK = process.env.TEXT_API_KEY_FALLBACK || process.env.DEEPSEEK_API_KEY_FALLBACK || process.env.DEEPSEEK_API_KEY || '';
const TEXT_MODEL_FALLBACK = process.env.TEXT_MODEL_FALLBACK || 'deepseek-v4-flash';

const TEXT_PROVIDERS = [
  {
    name: 'primary',
    base: TEXT_API_BASE,
    key: TEXT_API_KEY,
    model: TEXT_MODEL,
  },
  {
    name: 'fallback',
    base: TEXT_API_BASE_FALLBACK,
    key: TEXT_API_KEY_FALLBACK,
    model: TEXT_MODEL_FALLBACK,
  },
].filter((provider, index) => provider.key && provider.base && provider.model && (index === 0 || provider.base !== TEXT_API_BASE || provider.model !== TEXT_MODEL));

function isRetryableTextResponse(status) {
  return status === 524 || status === 502 || status === 503 || status >= 500;
}

async function postTextCompletion(provider, body) {
  const requestBody = { ...body, model: provider.model };
  const response = await fetch(`${provider.base}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${provider.key}`,
    },
    body: JSON.stringify(requestBody),
  });

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    const rawText = await response.text();
    const err = new Error(`文本 API 返回了非 JSON 响应 (HTTP ${response.status})`);
    err.status = response.status;
    err.rawText = rawText;
    err.provider = provider.name;
    throw err;
  }

  const data = await response.json();
  if (!response.ok) {
    const err = new Error(`文本 API 请求失败 (HTTP ${response.status})`);
    err.status = response.status;
    err.data = data;
    err.provider = provider.name;
    throw err;
  }

  return data;
}

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// 静态文件（生产模式下托管前端 dist）
// 带 hash 的资源（assets/）长期缓存，index.html 不缓存
app.use('/assets', express.static(path.resolve(__dirname, '../dist/assets'), {
  maxAge: '365d',
  immutable: true,
}));
app.use(express.static(path.resolve(__dirname, '../dist'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('index.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  },
}));

// 输出文件静态服务（用于下载视频、查看帧图片）
app.use('/output', express.static(OUTPUT_DIR));

// ─── 代理：Chat Completions → DeepSeek ────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  if (TEXT_PROVIDERS.length === 0) {
    return res.status(500).json({ error: 'Server: OPENAI_API_KEY (or TEXT_API_KEY) not configured in .env' });
  }

  const body = { ...req.body };

  let lastError = null;

  for (const provider of TEXT_PROVIDERS) {
    const MAX_RETRIES = 1;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const data = await postTextCompletion(provider, body);
        return res.json(data);
      } catch (err) {
        lastError = err;
        const status = err?.status || 500;
        const rawText = err?.rawText || '';
        const retryable = isRetryableTextResponse(status);

        if (provider.name === 'primary' && retryable && attempt < MAX_RETRIES) {
          console.warn(`[/api/chat] ${provider.name} ${status}, retrying (${attempt + 1}/${MAX_RETRIES})...`);
          await new Promise(r => setTimeout(r, 1500));
          continue;
        }

        if (provider.name === 'primary' && retryable && TEXT_PROVIDERS.length > 1) {
          console.warn(`[/api/chat] primary failed (${status}), falling back to ${TEXT_PROVIDERS[1].name}`);
          break;
        }

        if (provider.name !== 'primary') {
          console.error(`[/api/chat] ${provider.name} error:`, err?.data || rawText || String(err));
          return res.status(status || 500).json({
            error: {
              message: err?.message || String(err),
              provider: provider.name,
              code: status,
            },
          });
        }

        console.error(`[/api/chat] error:`, err?.data || rawText || String(err));
        return res.status(status || 500).json({
          error: {
            message: err?.message || String(err),
            provider: provider.name,
            code: status,
          },
        });
      }
    }
  }

  // 所有重试都失败
  console.error('[/api/chat] All retries exhausted');
  return res.status(500).json(lastError || { error: 'All retries failed' });
});

// ─── 代理：Images Generations → gpt-image-2 via 反代 ──────────────────────
app.post('/api/images', async (req, res) => {
  if (!IMAGE_API_KEY) {
    return res.status(500).json({ error: 'Server: IMAGE_API_KEY not configured in .env' });
  }

  const hasRefImage = !!req.body.image;
  // 使用前端传来的尺寸（默认 1024x1024）
  const FORCED_SIZE = req.body.size || '1024x1024';
  console.log(`[/api/images] request — hasRefImage=${hasRefImage}, size=${FORCED_SIZE}, prompt=${String(req.body.prompt || '').slice(0, 80)}`);

  // 构建请求体：强制使用 gpt-image-2，强制固定 size
  const body = {
    model: 'gpt-image-2',
    prompt: req.body.prompt,
    n: 1,
    size: FORCED_SIZE,  // 强制固定，忽略前端传来的值
  };

  // 如果请求中带有 image 字段（参考图 base64），附加到请求中
  if (req.body.image) {
    body.image = req.body.image;
    console.log(`[/api/images] reference image attached: ${String(req.body.image).slice(0, 50)}...`);
  }

  try {
    // 带重试的请求（网络错误 / 524 / 502 / 冷却 时自动重试，最多 3 次）
    let response;
    const MAX_RETRIES = 3;

    for (let attempts = 0; attempts <= MAX_RETRIES; attempts++) {
      try {
        response = await fetch(`${IMAGE_API_BASE}/images/generations`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${IMAGE_API_KEY}`,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(360_000), // 6分钟超时（图片生成需1-5分钟）
        });

        // 524（Cloudflare 超时）或 502（网关错误）时重试
        if ((response.status === 524 || response.status === 502) && attempts < MAX_RETRIES) {
          console.warn(`[/api/images] HTTP ${response.status}, retrying (${attempts + 1}/${MAX_RETRIES})...`);
          await new Promise(r => setTimeout(r, 5000));
          continue;
        }

        // 检查响应体是否包含冷却（rate limit / cooldown）错误
        // model_cooldown = 凭证池完全耗尽，恢复需数小时，重试无意义
        if (!response.ok) {
          try {
            const errClone = response.clone();
            const errBody = await errClone.json();
            const errMsg = JSON.stringify(errBody).toLowerCase();
            if (errBody?.error?.code === 'model_cooldown') {
              const resetSec = errBody?.error?.reset_seconds || 'unknown';
              console.error(`[/api/images] Model cooldown — all credentials exhausted. Reset in ~${resetSec}s. Do NOT retry.`);
              return res.status(429).json({ error: `图片生成凭证池完全耗尽，预计 ${Math.round(resetSec / 60)} 分钟后恢复。请等待冷却结束后重试。`, resetSeconds: resetSec });
            }
            if (errMsg.includes('cooling down') || errMsg.includes('rate_limit') || errMsg.includes('auth_unavailable')) {
              const waitSec = (attempts + 1) * 10;
              console.warn(`[/api/images] Rate-limited, waiting ${waitSec}s then retrying (${attempts + 1}/${MAX_RETRIES})...`);
              await new Promise(r => setTimeout(r, waitSec * 1000));
              continue;
            }
          } catch {
            // clone 失败，继续正常流程
          }
        }

        break;
      } catch (fetchErr) {
        // 网络错误（SocketError, connection reset 等）时重试
        const isSocketError = fetchErr?.cause?.code?.includes('SOCKET') ||
                              fetchErr?.message?.includes('fetch failed') ||
                              fetchErr?.code === 'UND_ERR_SOCKET';
        if (isSocketError && attempts < MAX_RETRIES) {
          console.warn(`[/api/images] Network error: ${fetchErr.message}, retrying (${attempts + 1}/${MAX_RETRIES})...`);
          await new Promise(r => setTimeout(r, 3000));
          continue;
        }
        throw fetchErr;
      }
    }

    // 安全解析响应体（上游可能返回 HTML/纯文本而非 JSON）
    let data;
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      data = await response.json();
    } else {
      // 非 JSON 响应（如 HTML 错误页），读取文本以便日志排查
      const rawText = await response.text();
      console.error(`[/api/images] Non-JSON response (status ${response.status}, type ${contentType}): ${rawText.slice(0, 500)}`);
      return res.status(502).json({
        error: {
          message: `图像 API 返回了非 JSON 响应 (HTTP ${response.status})，请检查 IMAGE_API_BASE 和 IMAGE_API_KEY 是否正确。原始响应前 200 字符: ${rawText.slice(0, 200)}`,
          type: 'upstream_error',
          code: response.status,
        }
      });
    }

    if (!response.ok) {
      console.error('[/api/images] Image API error:', JSON.stringify(data).slice(0, 300));
      return res.status(response.status).json(data);
    }

    // 打印返回结构（方便调试）
    const item = data.data?.[0];
    console.log(`[/api/images] response keys: ${Object.keys(data)}, item keys: ${item ? Object.keys(item) : 'none'}`);

    // ── URL → base64 自动转换 ──
    // 如果 API 返回了外部 URL（如 cdn.openai.com），立即下载并转为 b64_json
    // 这避免了前端加载外部 URL 时可能出现的 CORS/过期/混合内容问题
    if (item && item.url && !item.b64_json) {
      try {
        console.log(`[/api/images] Downloading image URL → base64: ${String(item.url).slice(0, 80)}...`);
        const imgRes = await fetch(item.url, { signal: AbortSignal.timeout(30_000) });
        if (imgRes.ok) {
          const contentType = imgRes.headers.get('content-type') || 'image/png';
          const buf = Buffer.from(await imgRes.arrayBuffer());
          item.b64_json = buf.toString('base64');
          // 保留原始 URL 作为参考，但前端优先使用 b64_json
          item._originalUrl = item.url;
          delete item.url;
          console.log(`[/api/images] Converted to b64_json (${(buf.length / 1024).toFixed(0)}KB, ${contentType})`);
        } else {
          console.warn(`[/api/images] Failed to download image URL: HTTP ${imgRes.status}`);
        }
      } catch (dlErr) {
        console.warn(`[/api/images] Failed to download image URL: ${dlErr.message}`);
      }
    }

    // 自动落盘：把生成结果保存到 output/frames
    try {
      const framePath = await saveFrameBase64(item?.b64_json, req.body.frameName, 'image');
      if (framePath && item) item.saved_path = framePath;
    } catch (saveErr) {
      console.warn(`[/api/images] Failed to save frame: ${saveErr.message}`);
    }

    return res.json(data);
  } catch (err) {
    console.error('[/api/images] error:', err);
    return res.status(500).json({ error: String(err) });
  }
});

// ─── 代理：Inpaint（蒙版重绘） → gpt-image-1 edits endpoint ──────────────
// 接收 JSON body: { backgroundImageBase64, maskBase64, prompt, model? }
// 将 base64 转为 buffer，组装 multipart/form-data 调用 /images/edits
app.post('/api/inpaint', async (req, res) => {
  if (!IMAGE_API_KEY) {
    return res.status(500).json({ error: 'Server: IMAGE_API_KEY not configured in .env' });
  }

  const { backgroundImageBase64, maskBase64, prompt, model = 'gpt-image-2', size = '1024x1024' } = req.body;

  if (!backgroundImageBase64 || !maskBase64 || !prompt) {
    return res.status(400).json({ error: 'backgroundImageBase64, maskBase64 and prompt are required' });
  }

  console.log(`[/api/inpaint] model=${model}, prompt="${prompt.slice(0, 80)}..."`);

  try {
    // 将 base64 解码为 Buffer
    const bgData   = backgroundImageBase64.replace(/^data:image\/\w+;base64,/, '');
    const maskData = maskBase64.replace(/^data:image\/\w+;base64,/, '');
    const bgBuf   = Buffer.from(bgData, 'base64');
    const maskBuf = Buffer.from(maskData, 'base64');

    // 组装 multipart/form-data
    const form = new FormData();
    form.append('model', model);
    form.append('prompt', prompt);
    form.append('n', '1');
    form.append('size', size);
    form.append('image', bgBuf, { filename: 'background.png', contentType: 'image/png' });
    form.append('mask',  maskBuf, { filename: 'mask.png',       contentType: 'image/png' });

    // 带重试的请求（网络错误 / 524 / 502 / 冷却 时自动重试，最多 3 次）
    let response;
    const MAX_RETRIES = 3;

    for (let attempts = 0; attempts <= MAX_RETRIES; attempts++) {
      try {
        response = await fetch(`${IMAGE_API_BASE}/images/edits`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${IMAGE_API_KEY}`,
            ...form.getHeaders(),
          },
          body: form.getBuffer(),
          signal: AbortSignal.timeout(360_000), // 6分钟超时
        });

        if ((response.status === 524 || response.status === 502) && attempts < MAX_RETRIES) {
          console.warn(`[/api/inpaint] HTTP ${response.status}, retrying (${attempts + 1}/${MAX_RETRIES})...`);
          await new Promise(r => setTimeout(r, 5000));
          continue;
        }

        // 检查响应体是否包含冷却错误
        // model_cooldown = 凭证池完全耗尽，恢复需数小时，重试无意义
        if (!response.ok) {
          try {
            const errClone = response.clone();
            const errBody = await errClone.json();
            const errMsg = JSON.stringify(errBody).toLowerCase();
            if (errBody?.error?.code === 'model_cooldown') {
              const resetSec = errBody?.error?.reset_seconds || 'unknown';
              console.error(`[/api/inpaint] Model cooldown — all credentials exhausted. Reset in ~${resetSec}s. Do NOT retry.`);
              return res.status(429).json({ error: `图片生成凭证池完全耗尽，预计 ${Math.round(resetSec / 60)} 分钟后恢复。请等待冷却结束后重试。`, resetSeconds: resetSec });
            }
            if (errMsg.includes('cooling down') || errMsg.includes('rate_limit') || errMsg.includes('auth_unavailable')) {
              const waitSec = (attempts + 1) * 10;
              console.warn(`[/api/inpaint] Rate-limited, waiting ${waitSec}s then retrying (${attempts + 1}/${MAX_RETRIES})...`);
              await new Promise(r => setTimeout(r, waitSec * 1000));
              continue;
            }
          } catch {
            // clone 失败，继续正常流程
          }
        }

        break;
      } catch (fetchErr) {
        const isSocketError = fetchErr?.cause?.code?.includes('SOCKET') ||
                              fetchErr?.message?.includes('fetch failed') ||
                              fetchErr?.code === 'UND_ERR_SOCKET';
        if (isSocketError && attempts < MAX_RETRIES) {
          console.warn(`[/api/inpaint] Network error: ${fetchErr.message}, retrying (${attempts + 1}/${MAX_RETRIES})...`);
          await new Promise(r => setTimeout(r, 3000));
          continue;
        }
        throw fetchErr;
      }
    }

    const contentType = response.headers.get('content-type') || '';
    let data;
    if (contentType.includes('application/json')) {
      data = await response.json();
    } else {
      const rawText = await response.text();
      console.error(`[/api/inpaint] Non-JSON response (status ${response.status}): ${rawText.slice(0, 500)}`);
      return res.status(502).json({
        error: { message: `Inpaint API 返回了非 JSON 响应 (HTTP ${response.status}): ${rawText.slice(0, 200)}` }
      });
    }

    if (!response.ok) {
      console.error('[/api/inpaint] API error:', JSON.stringify(data).slice(0, 300));
      // 如果 model 是 gpt-image-2 但 edits 不支持，自动降级提示
      if (response.status === 400 || response.status === 404) {
        console.warn('[/api/inpaint] Inpaint may not be supported by this model, returning error for fallback');
      }
      return res.status(response.status).json(data);
    }

    const item = data?.data?.[0];
    console.log(`[/api/inpaint] success, item keys: ${item ? Object.keys(item) : 'none'}`);

    // ── URL → base64 自动转换 ──
    if (item && item.url && !item.b64_json) {
      try {
        console.log(`[/api/inpaint] Downloading image URL → base64: ${String(item.url).slice(0, 80)}...`);
        const imgRes = await fetch(item.url, { signal: AbortSignal.timeout(30_000) });
        if (imgRes.ok) {
          const buf = Buffer.from(await imgRes.arrayBuffer());
          item.b64_json = buf.toString('base64');
          item._originalUrl = item.url;
          delete item.url;
          console.log(`[/api/inpaint] Converted to b64_json (${(buf.length / 1024).toFixed(0)}KB)`);
        } else {
          console.warn(`[/api/inpaint] Failed to download image URL: HTTP ${imgRes.status}`);
        }
      } catch (dlErr) {
        console.warn(`[/api/inpaint] Failed to download image URL: ${dlErr.message}`);
      }
    }

    // 自动落盘：把重绘结果保存到 output/frames
    try {
      const framePath = await saveFrameBase64(item?.b64_json, req.body.frameName, 'inpaint');
      if (framePath && item) item.saved_path = framePath;
    } catch (saveErr) {
      console.warn(`[/api/inpaint] Failed to save frame: ${saveErr.message}`);
    }

    return res.json(data);
  } catch (err) {
    console.error('[/api/inpaint] error:', err);
    return res.status(500).json({ error: String(err) });
  }
});

// ─── 代理：下载图片转 base64（解决前端 CORS 限制） ───────────────────────
app.post('/api/fetch-image', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });

  try {
    const imgRes = await fetch(url);
    if (!imgRes.ok) return res.status(502).json({ error: `Failed to fetch image: ${imgRes.status}` });

    const contentType = imgRes.headers.get('content-type') || 'image/png';
    const buf = Buffer.from(await imgRes.arrayBuffer());
    const b64 = buf.toString('base64');
    return res.json({ base64: `data:${contentType};base64,${b64}` });
  } catch (err) {
    console.error('[/api/fetch-image] error:', err);
    return res.status(500).json({ error: String(err) });
  }
});

  // ─── 代理：故事展开 + 按秒拆分段落 → ChatGPT 5.4 / OpenAI ───────────────
app.post('/api/story-expansion', async (req, res) => {
  if (TEXT_PROVIDERS.length === 0) {
    return res.status(500).json({ error: 'Server: OPENAI_API_KEY (or TEXT_API_KEY) not configured in .env' });
  }

  const { synopsis, durationSeconds = 6 } = req.body;
  if (!synopsis?.trim()) {
    return res.status(400).json({ error: 'synopsis is required' });
  }

  const systemPrompt = `你是一位专业的编剧和故事导演。用户会给你一段故事梗概，你需要将其展开为一个完整的、有画面感的故事，并按时间拆分为 ${durationSeconds} 个段落（每个段落对应视频中的 1 秒）。

要求：
1. 保留原梗概的核心冲突和情感
2. 添加场景细节、角色互动、氛围描述
3. 描述要有画面感，便于后续转化为分镜
4. 故事结构完整：开端、发展、高潮、结局
5. 每个段落大约 50-80 字，描述这 1 秒内发生的关键画面
6. 段落之间要有连贯性和递进感
7. 你必须以 JSON 格式输出，不要输出其他任何文本`;

  const userPrompt = `请将以下故事梗概展开为 ${durationSeconds} 个故事段落，每个段落对应视频中的 1 秒，总时长 ${durationSeconds} 秒：

"${synopsis}"

请严格以以下 JSON 格式输出：
{
  "fullStory": "完整的故事文本（200-400字）",
  "segments": [
    {
      "index": 0,
      "timeRange": "0s-1s",
      "description": "第1秒的画面故事描述，50-80字，要有画面感"
    },
    {
      "index": 1,
      "timeRange": "1s-2s",
      "description": "第2秒的画面故事描述"
    }
  ]
}

确保 segments 数量恰好为 ${durationSeconds} 个。`;

  const body = {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.85,
    max_tokens: 4096,
  };

  let lastError = null;

  for (const provider of TEXT_PROVIDERS) {
    const MAX_RETRIES = 1;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        console.log(`[/api/story-expansion] synopsis="${String(synopsis).slice(0, 60)}...", duration=${durationSeconds}s, provider=${provider.name}`);
        const data = await postTextCompletion(provider, body);
        const content = data.choices?.[0]?.message?.content || '';
        console.log(`[/api/story-expansion] response length: ${content.length}`);

        // 解析 JSON，提取 fullStory 和 segments
        let parsed;
        try {
          parsed = JSON.parse(content);
        } catch {
          // 降级：如果 JSON 解析失败，把整段文本当作 fullStory
          console.warn('[/api/story-expansion] JSON parse failed, using raw text as fullStory');
          return res.json({
            fullStory: content,
            segments: Array.from({ length: durationSeconds }, (_, i) => ({
              index: i,
              timeRange: `${i}s-${i + 1}s`,
              description: '',
            })),
            raw: data,
            provider: provider.name,
          });
        }

        const fullStory = (typeof parsed.fullStory === 'string' && parsed.fullStory.trim()) ? parsed.fullStory : content;
        const segments = Array.isArray(parsed.segments) && parsed.segments.length > 0 ? parsed.segments : Array.from({ length: durationSeconds }, (_, i) => ({
          index: i,
          timeRange: `${i}s-${i + 1}s`,
          description: '',
        }));

        console.log(`[/api/story-expansion] story: ${fullStory.length} chars, segments: ${segments.length}`);
        return res.json({ fullStory, segments, raw: data, provider: provider.name });
      } catch (err) {
        lastError = err;
        const status = err?.status || 500;
        const retryable = isRetryableTextResponse(status);

        if (provider.name === 'primary' && retryable && attempt < MAX_RETRIES) {
          console.warn(`[/api/story-expansion] ${provider.name} ${status}, retrying (${attempt + 1}/${MAX_RETRIES}):`, err.message);
          await new Promise(r => setTimeout(r, 1500));
          continue;
        }

        if (provider.name === 'primary' && retryable && TEXT_PROVIDERS.length > 1) {
          console.warn(`[/api/story-expansion] primary failed (${status}), falling back to ${TEXT_PROVIDERS[1].name}`);
          break;
        }

        if (provider.name !== 'primary') {
          console.error('[/api/story-expansion] error:', err?.data || err?.rawText || err);
          return res.status(status || 500).json({ error: String(err?.message || err), provider: provider.name });
        }

        console.error('[/api/story-expansion] error:', err?.data || err?.rawText || err);
        return res.status(status || 500).json({ error: String(err?.message || err), provider: provider.name });
      }
    }
  }

  console.error('[/api/story-expansion] All retries exhausted');
  return res.status(500).json(lastError || { error: 'All retries failed' });
});

// 视频合成功能已移除；如果需要可单独实现为离线工具。
app.post('/api/compose-video', async (_req, res) => {
  res.status(410).json({ error: 'Video composition has been disabled in this build.' });
});

// ─── 健康检查 ──────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    imageApi: IMAGE_API_KEY ? '✅ gpt-image-2 已配置' : '❌ 未配置 IMAGE_API_KEY',
    textApi:  TEXT_API_KEY  ? `✅ ${TEXT_MODEL} 已配置`  : '❌ 未配置 OPENAI_API_KEY',
  });
});

// ─── SPA fallback（生产模式）──────────────────────────────────────────────
app.use((_req, res, next) => {
  const indexPath = path.resolve(__dirname, '../dist/index.html');
  res.sendFile(indexPath, (err) => {
    if (err) next();
  });
});

app.listen(PORT, () => {
  console.log(`\n🎬 AI 分镜工作室后端代理已启动`);
  console.log(`   本地访问:   http://localhost:${PORT}`);
  console.log(`   图像接口:   ${IMAGE_API_BASE} → gpt-image-2  ${IMAGE_API_KEY ? '✅' : '❌'}`);
  console.log(`   文本接口:   ${TEXT_API_BASE} → ${TEXT_MODEL}  ${TEXT_API_KEY  ? '✅' : '❌'}\n`);
});
