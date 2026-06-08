import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs/promises';
import FormData from 'form-data';
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

function extractBase64FromDataUrl(value) {
  const match = String(value || '').match(/data:image\/[a-zA-Z0-9.+-]+;base64,([A-Za-z0-9+/=\r\n]+)/);
  return match ? match[1].replace(/\s/g, '') : null;
}

function normalizeImageApiResponse(data) {
  if (data?.data?.[0]) return data;

  const content = data?.choices?.[0]?.message?.content;
  const b64 = extractBase64FromDataUrl(content);
  if (!b64) return data;

  return {
    ...data,
    data: [{ b64_json: b64 }],
    _normalized_from: 'chat.completions',
  };
}

function buildImageChatMessages(prompt, image) {
  if (!image) return [{ role: 'user', content: prompt }];

  return [{
    role: 'user',
    content: [
      { type: 'text', text: prompt },
      { type: 'image_url', image_url: { url: image } },
    ],
  }];
}

function buildImageChatBody(prompt, image) {
  return {
    model: 'gpt-image-2',
    messages: buildImageChatMessages(prompt, image),
    stream: false,
  };
}

// 启动时确保目录存在
for (const d of [OUTPUT_DIR]) {
  fs.mkdir(d, { recursive: true }).catch(() => {});
}

// ─── API 配置 ──────────────────────────────────────────────────────────────
// 图像生成：自定义反代 + gpt-image-2
const IMAGE_API_BASE = process.env.IMAGE_API_BASE || 'https://wzjself.org/v1';
const IMAGE_API_KEY  = process.env.IMAGE_API_KEY  || '';

// 文本生成：ChatGPT 5.5（向后兼容 DEEPSEEK 变量）
const TEXT_API_BASE = process.env.OPENAI_API_BASE || process.env.TEXT_API_BASE || 'https://api.openai.com/v1';
const TEXT_API_KEY  = process.env.OPENAI_API_KEY || process.env.DEEPSEEK_API_KEY || process.env.TEXT_API_KEY || '';
const TEXT_MODEL    = process.env.TEXT_MODEL || 'gpt-5.5';
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

function parseJsonFromPossiblyMislabelledText(rawText) {
  const trimmed = String(rawText || '').trim();
  if (!trimmed) throw new Error('empty response body');

  try {
    return JSON.parse(trimmed);
  } catch {
    // Some OpenAI-compatible proxies mark JSON responses as text/event-stream.
    // If the body is actual SSE, try parsing the latest data payload.
    const payloads = trimmed
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .filter((line) => line && line !== '[DONE]');

    for (let i = payloads.length - 1; i >= 0; i--) {
      try {
        return JSON.parse(payloads[i]);
      } catch {
        // Keep looking for a parseable payload.
      }
    }
  }

  throw new Error('response body is not JSON');
}

async function readJsonResponse(response, label) {
  const rawText = await response.text();
  try {
    return parseJsonFromPossiblyMislabelledText(rawText);
  } catch {
    const err = new Error(`${label} 返回了非 JSON 响应 (HTTP ${response.status})`);
    err.status = response.ok ? 502 : response.status;
    err.upstreamStatus = response.status;
    err.rawText = rawText;
    err.contentType = response.headers.get('content-type') || '';
    throw err;
  }
}

/**
 * 带主/备切换和重试的文本 API 调用
 * 先尝试 primary（1 次重试），失败后 fallback 到 secondary
 */
async function withTextProviderFallback(body, logPrefix) {
  if (TEXT_PROVIDERS.length === 0) {
    throw Object.assign(new Error('Server: OPENAI_API_KEY (or TEXT_API_KEY) not configured in .env'), { status: 500 });
  }

  let lastError = null;
  for (const provider of TEXT_PROVIDERS) {
    const MAX_RETRIES = 1;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await postTextCompletion(provider, body);
      } catch (err) {
        lastError = err;
        const status = err?.status || 500;
        const retryable = isRetryableTextResponse(status);

        if (provider.name === 'primary' && retryable && attempt < MAX_RETRIES) {
          console.warn(`${logPrefix} ${provider.name} ${status}, retrying (${attempt + 1}/${MAX_RETRIES})...`);
          await new Promise(r => setTimeout(r, 1500));
          continue;
        }

        if (provider.name === 'primary' && retryable && TEXT_PROVIDERS.length > 1) {
          console.warn(`${logPrefix} primary failed (${status}), falling back to ${TEXT_PROVIDERS[1].name}`);
          break;
        }

        // fallback provider 也失败，或不可重试
        console.error(`${logPrefix} ${provider.name} error:`, err?.data || err?.rawText || String(err));
        throw Object.assign(err, { provider: provider.name });
      }
    }
  }

  console.error(`${logPrefix} All retries exhausted`);
  throw lastError || new Error('All retries failed');
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

  const data = await readJsonResponse(response, '文本 API');
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

// ─── 共享工具函数 ─────────────────────────────────────────────────────────

const IMAGE_MAX_RETRIES = 3;
const IMAGE_TIMEOUT_MS = 360_000; // 6分钟

/** 检查是否为可重试的网络错误 */
function isSocketError(err) {
  return err?.cause?.code?.includes('SOCKET') ||
         err?.message?.includes('fetch failed') ||
         err?.code === 'UND_ERR_SOCKET';
}

/** 检查响应体是否为冷却/限流错误，返回 { shouldRetry, waitMs, isCooldown, resetSec } */
function parseCooldownError(errBody) {
  const errMsg = JSON.stringify(errBody).toLowerCase();
  if (errBody?.error?.code === 'model_cooldown') {
    const resetSec = errBody?.error?.reset_seconds || 'unknown';
    return { shouldRetry: false, isCooldown: true, resetSec };
  }
  if (errMsg.includes('cooling down') || errMsg.includes('rate_limit') || errMsg.includes('auth_unavailable')) {
    return { shouldRetry: true, isCooldown: false };
  }
  return null;
}

/** 将 API 返回的 URL 自动下载转为 base64（通过 /api/fetch-image 代理） */
async function convertUrlToBase64(item, logPrefix) {
  if (!item?.url || item.b64_json) return;
  try {
    console.log(`${logPrefix} Downloading image URL → base64: ${String(item.url).slice(0, 80)}...`);
    const proxyRes = await fetch(`http://localhost:${PORT}/api/fetch-image`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: item.url }),
      signal: AbortSignal.timeout(30_000),
    });
    if (proxyRes.ok) {
      const proxyData = await proxyRes.json();
      if (proxyData.base64) {
        // 从 data URL 中提取纯 base64
        const pure = proxyData.base64.replace(/^data:image\/\w+;base64,/, '');
        item.b64_json = pure;
        item._originalUrl = item.url;
        console.log(`${logPrefix} Converted to b64_json (${(pure.length * 0.75 / 1024).toFixed(0)}KB)`);
      }
    } else {
      console.warn(`${logPrefix} Failed to download image URL: HTTP ${proxyRes.status}`);
    }
  } catch (dlErr) {
    console.warn(`${logPrefix} Failed to download image URL: ${dlErr.message}`);
  }
}

/** 带重试的图片 API 请求（通用） */
async function fetchImageWithRetry(endpoint, body, logPrefix) {
  let response;
  for (let attempts = 0; attempts <= IMAGE_MAX_RETRIES; attempts++) {
    try {
      response = await fetch(`${IMAGE_API_BASE}${endpoint}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${IMAGE_API_KEY}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
      });

      if ((response.status === 524 || response.status === 502) && attempts < IMAGE_MAX_RETRIES) {
        console.warn(`${logPrefix} HTTP ${response.status}, retrying (${attempts + 1}/${IMAGE_MAX_RETRIES})...`);
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }

      if (!response.ok) {
        try {
          const errClone = response.clone();
          const errBody = await errClone.json();
          const cd = parseCooldownError(errBody);
          if (cd?.isCooldown) {
            console.error(`${logPrefix} Model cooldown — reset in ~${cd.resetSec}s. Do NOT retry.`);
            return { error: true, status: 429, body: { error: `图片生成凭证池完全耗尽，预计 ${Math.round(cd.resetSec / 60)} 分钟后恢复。请等待冷却结束后重试。`, resetSeconds: cd.resetSec } };
          }
          if (cd?.shouldRetry) {
            const waitSec = (attempts + 1) * 10;
            console.warn(`${logPrefix} Rate-limited, waiting ${waitSec}s then retrying (${attempts + 1}/${IMAGE_MAX_RETRIES})...`);
            await new Promise(r => setTimeout(r, waitSec * 1000));
            continue;
          }
        } catch { /* clone failed, continue */ }
      }

      break;
    } catch (fetchErr) {
      if (isSocketError(fetchErr) && attempts < IMAGE_MAX_RETRIES) {
        console.warn(`${logPrefix} Network error: ${fetchErr.message}, retrying (${attempts + 1}/${IMAGE_MAX_RETRIES})...`);
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }
      throw fetchErr;
    }
  }

  return { error: false, response };
}

/** 解析图片 API 响应并自动转 base64、自动落盘 */
async function parseImageResponse(response, logPrefix, frameName, source) {
  const contentType = response.headers.get('content-type') || '';
  let data;
  if (contentType.includes('application/json')) {
    data = await response.json();
  } else {
    const rawText = await response.text();
    console.error(`${logPrefix} Non-JSON response (status ${response.status}): ${rawText.slice(0, 500)}`);
    return { error: true, status: 502, body: { error: { message: `图像 API 返回了非 JSON 响应 (HTTP ${response.status}): ${rawText.slice(0, 200)}` } } };
  }

  if (!response.ok) {
    console.error(`${logPrefix} API error:`, JSON.stringify(data).slice(0, 300));
    return { error: true, status: response.status, body: data };
  }

  data = normalizeImageApiResponse(data);
  const item = data?.data?.[0];
  console.log(`${logPrefix} response keys: ${Object.keys(data)}, item keys: ${item ? Object.keys(item) : 'none'}`);

  // URL → base64 自动转换
  await convertUrlToBase64(item, logPrefix);

  // 自动落盘
  try {
    const framePath = await saveFrameBase64(item?.b64_json, frameName, source);
    if (framePath && item) item.saved_path = framePath;
  } catch (saveErr) {
    console.warn(`${logPrefix} Failed to save frame: ${saveErr.message}`);
  }

  return { error: false, data };
}

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

// ─── 代理：Chat Completions ──────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  try {
    const data = await withTextProviderFallback({ ...req.body }, '[/api/chat]');
    return res.json(data);
  } catch (err) {
    const status = err?.status || 500;
    return res.status(status).json({
      error: {
        message: err?.message || String(err),
        provider: err?.provider,
        code: status,
      },
    });
  }
});

// ─── 代理：Images Generations → gpt-image-2 via 反代 ──────────────────────
app.post('/api/images', async (req, res) => {
  if (!IMAGE_API_KEY) {
    return res.status(500).json({ error: 'Server: IMAGE_API_KEY not configured in .env' });
  }

  const hasRefImage = !!req.body.image;
  const FORCED_SIZE = req.body.size || '1024x1024';
  console.log(`[/api/images] request — hasRefImage=${hasRefImage}, size=${FORCED_SIZE}, prompt=${String(req.body.prompt || '').slice(0, 80)}`);

  const body = {
    model: 'gpt-image-2',
    prompt: req.body.prompt,
    n: 1,
    size: FORCED_SIZE,
  };

  if (req.body.image) {
    body.image = req.body.image;
    console.log(`[/api/images] reference image attached: ${String(req.body.image).slice(0, 50)}...`);
  }

  try {
    let endpoint = '/images/generations';
    let result = await fetchImageWithRetry(endpoint, body, '[/api/images]');
    if (
      result.error ||
      (result.response && !result.response.ok && endpoint === '/images/generations')
    ) {
      console.warn('[/api/images] /images/generations failed, falling back to /chat/completions');
      endpoint = '/chat/completions';
      result = await fetchImageWithRetry(endpoint, buildImageChatBody(req.body.prompt, req.body.image), '[/api/images]');
    }
    if (result.error) return res.status(result.status).json(result.body);

    const parsed = await parseImageResponse(result.response, '[/api/images]', req.body.frameName, 'image');
    if (parsed.error) return res.status(parsed.status).json(parsed.body);

    return res.json(parsed.data);
  } catch (err) {
    console.error('[/api/images] error:', err);
    return res.status(500).json({ error: String(err) });
  }
});

// ─── 代理：Inpaint（蒙版重绘） → gpt-image-2 edits endpoint ──────────────
app.post('/api/inpaint', async (req, res) => {
  if (!IMAGE_API_KEY) {
    return res.status(500).json({ error: 'Server: IMAGE_API_KEY not configured in .env' });
  }

  const { backgroundImageBase64, maskBase64, characterReferenceImageBase64, prompt, model = 'gpt-image-2', size = '1024x1024' } = req.body;

  if (!backgroundImageBase64 || !maskBase64 || !prompt) {
    return res.status(400).json({ error: 'backgroundImageBase64, maskBase64 and prompt are required' });
  }

  console.log(`[/api/inpaint] model=${model}, prompt="${prompt.slice(0, 80)}..."`);

  try {
    const bgData   = backgroundImageBase64.replace(/^data:image\/\w+;base64,/, '');
    const maskData = maskBase64.replace(/^data:image\/\w+;base64,/, '');
    const bgBuf   = Buffer.from(bgData, 'base64');
    const maskBuf = Buffer.from(maskData, 'base64');

    const form = new FormData();
    form.append('model', model);
    form.append('prompt', prompt);
    form.append('n', '1');
    form.append('size', size);
    form.append('image', bgBuf, { filename: 'background.png', contentType: 'image/png' });
    form.append('mask',  maskBuf, { filename: 'mask.png',       contentType: 'image/png' });
    if (characterReferenceImageBase64) {
      const refData = String(characterReferenceImageBase64).replace(/^data:image\/\w+;base64,/, '');
      const refBuf = Buffer.from(refData, 'base64');
      form.append('image', refBuf, { filename: 'character-turnaround.png', contentType: 'image/png' });
      console.log(`[/api/inpaint] character reference attached (${Math.round(refBuf.length / 1024)}KB)`);
    }

    // Inpaint 使用 multipart/form-data，不能用 fetchImageWithRetry（需要自定义 headers/body）
    let response;
    for (let attempts = 0; attempts <= IMAGE_MAX_RETRIES; attempts++) {
      try {
        response = await fetch(`${IMAGE_API_BASE}/images/edits`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${IMAGE_API_KEY}`,
            ...form.getHeaders(),
          },
          body: form.getBuffer(),
          signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
        });

        if ((response.status === 524 || response.status === 502) && attempts < IMAGE_MAX_RETRIES) {
          console.warn(`[/api/inpaint] HTTP ${response.status}, retrying (${attempts + 1}/${IMAGE_MAX_RETRIES})...`);
          await new Promise(r => setTimeout(r, 5000));
          continue;
        }

        if (!response.ok) {
          try {
            const errClone = response.clone();
            const errBody = await errClone.json();
            const cd = parseCooldownError(errBody);
            if (cd?.isCooldown) {
              console.error(`[/api/inpaint] Model cooldown — reset in ~${cd.resetSec}s. Do NOT retry.`);
              return res.status(429).json({ error: `图片生成凭证池完全耗尽，预计 ${Math.round(cd.resetSec / 60)} 分钟后恢复。请等待冷却结束后重试。`, resetSeconds: cd.resetSec });
            }
            if (cd?.shouldRetry) {
              const waitSec = (attempts + 1) * 10;
              console.warn(`[/api/inpaint] Rate-limited, waiting ${waitSec}s...`);
              await new Promise(r => setTimeout(r, waitSec * 1000));
              continue;
            }
          } catch { /* clone failed */ }
        }

        break;
      } catch (fetchErr) {
        if (isSocketError(fetchErr) && attempts < IMAGE_MAX_RETRIES) {
          console.warn(`[/api/inpaint] Network error, retrying (${attempts + 1}/${IMAGE_MAX_RETRIES})...`);
          await new Promise(r => setTimeout(r, 3000));
          continue;
        }
        throw fetchErr;
      }
    }

    const parsed = await parseImageResponse(response, '[/api/inpaint]', req.body.frameName, 'inpaint');
    if (parsed.error) return res.status(parsed.status).json(parsed.body);

    return res.json(parsed.data);
  } catch (err) {
    console.error('[/api/inpaint] error:', err);
    return res.status(500).json({ error: String(err) });
  }
});

// ─── 代理：下载图片转 base64（解决前端 CORS 限制） ───────────────────────
const ALLOWED_IMAGE_HOSTS = new Set([
  'oaidalleapiprodscus.blob.core.windows.net',
  'cdn.openai.com',
  'cdn.oaistatic.com',
  'wzjself.org',
  'img.openai.com',
]);

function isAllowedImageUrl(urlStr) {
  try {
    const parsed = new URL(urlStr);
    if (parsed.protocol !== 'https:') return false;
    if (ALLOWED_IMAGE_HOSTS.has(parsed.hostname)) return true;
    // 允许 *.openai.com 和 *.wzjself.org 子域
    if (parsed.hostname.endsWith('.openai.com') || parsed.hostname.endsWith('.wzjself.org')) return true;
    return false;
  } catch {
    return false;
  }
}

app.post('/api/fetch-image', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });

  if (!isAllowedImageUrl(url)) {
    console.warn(`[/api/fetch-image] Blocked disallowed URL: ${String(url).slice(0, 100)}`);
    return res.status(403).json({ error: 'URL domain not in allowlist. Only known image CDN hosts are permitted.' });
  }

  try {
    const imgRes = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!imgRes.ok) return res.status(502).json({ error: `Failed to fetch image: ${imgRes.status}` });

    const contentType = imgRes.headers.get('content-type') || 'image/png';
    if (!contentType.startsWith('image/')) {
      return res.status(400).json({ error: 'URL did not return an image' });
    }
    const buf = Buffer.from(await imgRes.arrayBuffer());
    if (buf.length > 20 * 1024 * 1024) {
      return res.status(400).json({ error: 'Image too large (max 20MB)' });
    }
    const b64 = buf.toString('base64');
    return res.json({ base64: `data:${contentType};base64,${b64}` });
  } catch (err) {
    console.error('[/api/fetch-image] error:', err);
    return res.status(500).json({ error: String(err) });
  }
});

// ─── 代理：故事展开 + 按秒拆分段落 ──────────────────────────────────────
app.post('/api/story-expansion', async (req, res) => {
  const { synopsis, durationSeconds = 6 } = req.body;
  if (!synopsis?.trim()) {
    return res.status(400).json({ error: 'synopsis is required' });
  }
  if (synopsis.length > 5000) {
    return res.status(400).json({ error: 'synopsis too long (max 5000 chars)' });
  }
  if (durationSeconds < 1 || durationSeconds > 30) {
    return res.status(400).json({ error: 'durationSeconds must be between 1 and 30' });
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

  try {
    console.log(`[/api/story-expansion] synopsis="${String(synopsis).slice(0, 60)}...", duration=${durationSeconds}s`);
    const data = await withTextProviderFallback(body, '[/api/story-expansion]');
    const content = data.choices?.[0]?.message?.content || '';
    console.log(`[/api/story-expansion] response length: ${content.length}`);
    if (!content.trim()) {
      console.error('[/api/story-expansion] empty text response:', JSON.stringify(data).slice(0, 500));
      return res.status(502).json({
        error: `文本模型 ${TEXT_MODEL} 返回了空内容，请检查 OPENAI_API_BASE / OPENAI_API_KEY / TEXT_MODEL 配置或供应商响应格式。`,
        raw: data,
      });
    }

    const defaultSegments = Array.from({ length: durationSeconds }, (_, i) => ({
      index: i,
      timeRange: `${i}s-${i + 1}s`,
      description: '',
    }));

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      console.warn('[/api/story-expansion] JSON parse failed, using raw text as fullStory');
      return res.json({ fullStory: content, segments: defaultSegments, raw: data });
    }

    const fullStory = (typeof parsed.fullStory === 'string' && parsed.fullStory.trim()) ? parsed.fullStory : content;
    const segments = Array.isArray(parsed.segments) && parsed.segments.length > 0 ? parsed.segments : defaultSegments;

    console.log(`[/api/story-expansion] story: ${fullStory.length} chars, segments: ${segments.length}`);
    return res.json({ fullStory, segments, raw: data });
  } catch (err) {
    const status = err?.status || 500;
    return res.status(status).json({ error: String(err?.message || err) });
  }
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
