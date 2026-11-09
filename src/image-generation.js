const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');

const TTL = 24 * 60 * 60 * 1000;
const MAX_BYTES = 8 * 1024 * 1024;
const FILE = /^[a-f0-9]{48}(?:-preview)?\.jpg$/;
const HELP = 'สั่งสร้างภาพได้ครับ เช่น “สร้างภาพ ผ้าม้วนสีฟ้าบนชั้นวาง” หรือ /image ตามด้วยรายละเอียดภาพ';

function imageCommand(text) {
  const match = String(text).trim().match(/^(?:ช่วย\s*|กรุณา\s*)?(?:\/image\b|สร้าง(?:รูปภาพ|รูป|ภาพ)|วาด(?:รูปภาพ|รูป|ภาพ)|generate\s+(?:an?\s+)?image|create\s+(?:an?\s+)?image)(?:\s*[:：]\s*|\s*)/i);
  if (!match) return null;
  const prompt = String(text).trim().slice(match[0].length).trim();
  if (!prompt || /^(?:ได้(?:ไหม|มั้ย|หรือ)|เป็นไหม|ยังไง|อย่างไร|ไหม|มั้ย|ได้หรือไม่)/.test(prompt)) return '';
  return prompt;
}

function positive(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function imageDirectory(env = process.env) {
  return env.IMAGE_DIR || path.join(env.DB_PATH ? path.dirname(env.DB_PATH) : path.join(__dirname, '..'), 'generated-images');
}

function cleanImages(dir, now = Date.now()) {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    if (!FILE.test(name)) continue;
    const file = path.join(dir, name);
    if (now - fs.statSync(file).mtimeMs >= TTL) fs.unlinkSync(file);
  }
}

function imageHandler(env = process.env) {
  return (req, res) => {
    if (!FILE.test(req.params.file || '')) return res.sendStatus(404);
    const file = path.resolve(imageDirectory(env), req.params.file);
    try {
      if (Date.now() - fs.statSync(file).mtimeMs >= TTL) return res.sendStatus(404);
    } catch { return res.sendStatus(404); }
    res.set({ 'Cache-Control': 'private, max-age=300', 'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex' });
    res.sendFile(file);
  };
}

async function readResponse(response) {
  if (Number(response.headers.get('content-length')) > 24 * 1024 * 1024) throw new Error('image_response_too_large');
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 24 * 1024 * 1024) throw new Error('image_response_too_large');
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function createImageService({ env = process.env, db = require('./db'), fetchImpl = fetch } = {}) {
  const pending = new Set();
  return {
    async generate(prompt, { userId, messageId }) {
      if (env.IMAGE_GENERATION_ENABLED === 'false') return { status: 'disabled' };
      if (pending.has(userId)) return { status: 'busy' };
      if (prompt.length > 2000) return { status: 'too_long' };
      // Railway supplies its HTTPS domain automatically; APP_URL can override it.
      const base = new URL(env.APP_URL || `https://${env.RAILWAY_PUBLIC_DOMAIN || ''}`);
      if (base.protocol !== 'https:' || !base.hostname) throw new Error('image_base_url_missing');
      if (!env.OPENROUTER_API_KEY) throw new Error('image_api_key_missing');
      pending.add(userId);
      try {
        const reservation = db.reserveImageRequest(userId, messageId,
          positive(env.IMAGE_DAILY_LIMIT, 3), positive(env.IMAGE_GLOBAL_DAILY_LIMIT, 30));
        if (reservation !== 'reserved') return { status: reservation };
        const response = await fetchImpl('https://openrouter.ai/api/v1/images', {
          method: 'POST',
          headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: env.IMAGE_MODEL || 'google/gemini-3.1-flash-lite-image',
            prompt, n: 1, aspect_ratio: '1:1',
          }),
          signal: AbortSignal.timeout(120000),
        });
        if (!response.ok) { await response.body?.cancel(); throw new Error(`image_api_http_${response.status}`); }
        const data = await readResponse(response);
        const encoded = data.data?.[0]?.b64_json;
        if (typeof encoded !== 'string' || encoded.length > Math.ceil(MAX_BYTES * 4 / 3) + 4) throw new Error('image_missing_or_too_large');
        const input = Buffer.from(encoded, 'base64');
        const options = { limitInputPixels: 16 * 1024 * 1024 };
        const original = await sharp(input, options).rotate().resize(1536, 1536, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
        const preview = await sharp(original).resize(512, 512, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 75 }).toBuffer();
        const dir = imageDirectory(env);
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        cleanImages(dir);
        const id = crypto.randomBytes(24).toString('hex');
        fs.writeFileSync(path.join(dir, `${id}.jpg`), original, { flag: 'wx', mode: 0o600 });
        fs.writeFileSync(path.join(dir, `${id}-preview.jpg`), preview, { flag: 'wx', mode: 0o600 });
        return { status: 'generated', message: {
          type: 'image', originalContentUrl: new URL(`/generated/${id}.jpg`, base).href,
          previewImageUrl: new URL(`/generated/${id}-preview.jpg`, base).href,
        } };
      } finally { pending.delete(userId); }
    },
  };
}

module.exports = { imageCommand, createImageService, imageHandler, imageDirectory, cleanImages, HELP, TTL };
