// อ่านคอนเทนต์ที่ไม่ใช่ข้อความ — โหลดไฟล์จาก LINE แล้วให้ AI อ่าน/ถอดความ
// คืนเป็นข้อความ เช่น "[รูป] สลิปโอน 500 บาท" → บอทเอาไปคุยต่อได้เหมือนข้อความที่พิมพ์มา
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const OpenAI = require('openai');

// client แยกจาก ai.js — ไฟล์ใหญ่ใช้เวลานานกว่า แต่ต้องเหลือเวลาให้ตอบทันอายุ replyToken
let _client = null;
function client() {
  _client ??= new OpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: process.env.OPENROUTER_API_KEY,
    timeout: 40000,
    maxRetries: 0,
  });
  return _client;
}
const VISION_MODEL = () => process.env.VISION_MODEL || 'google/gemini-2.5-flash';

const MAX_BYTES = 15 * 1024 * 1024; // เกิน 15MB ไม่โหลด (กันไฟล์ยักษ์)

// โหลดตัวไฟล์จาก LINE (คนละโดเมนกับ api ปกติ — api-data.line.me)
async function downloadContent(messageId) {
  const res = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
    headers: { Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` },
  });
  if (!res.ok) throw new Error(`โหลดคอนเทนต์ไม่ได้ (${res.status})`);
  const len = parseInt(res.headers.get('content-length') || '0', 10);
  if (len > MAX_BYTES) throw new Error(`ไฟล์ใหญ่เกิน (${(len / 1e6).toFixed(1)}MB)`);
  return Buffer.from(await res.arrayBuffer());
}

// ---------- รูป ----------
async function describeImage(buf) {
  const mime = buf[0] === 0x89 ? 'image/png' : 'image/jpeg';
  const res = await client().chat.completions.create({
    model: VISION_MODEL(),
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'อ่านรูปนี้แล้วตอบเป็นภาษาไทย: รูปทั่วไปอธิบายกระชับ 1-3 ประโยค แต่ถ้ามีข้อความในรูป (สลิปโอนเงิน เอกสาร แชท ตาราง รายการสั่งของ ฉลากสินค้า) ให้ถอดออกมาให้ครบพร้อมตัวเลขสำคัญ (ยอดเงิน วันที่เวลา ชื่อ เลขที่) ตรงไหนอ่านไม่ชัดใส่ (?) ตอบเฉพาะเนื้อหา ไม่ต้องเกริ่น',
          },
          { type: 'image_url', image_url: { url: `data:${mime};base64,${buf.toString('base64')}` } },
        ],
      },
    ],
  });
  return res.choices[0]?.message?.content?.trim().slice(0, 3000) || '';
}

// ---------- เสียง / วิดีโอ (ต้องมี ffmpeg — บน Railway ตั้ง RAILPACK_DEPLOY_APT_PACKAGES=ffmpeg) ----------
function ffmpeg(args) {
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { stdio: ['ignore', 'ignore', 'inherit'] });
}
function tmpFile(name) {
  return path.join(os.tmpdir(), `chatbot-${process.pid}-${name}`);
}

async function transcribeAudio(buf, messageId) {
  const inFile = tmpFile(`${messageId}.m4a`);
  const outFile = tmpFile(`${messageId}.mp3`);
  try {
    fs.writeFileSync(inFile, buf);
    ffmpeg(['-i', inFile, outFile]); // m4a → mp3 (OpenRouter รับ wav/mp3)
    const b64 = fs.readFileSync(outFile).toString('base64');
    const res = await client().chat.completions.create({
      model: VISION_MODEL(),
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'ถอดเสียงพูดในไฟล์นี้เป็นข้อความตรงตามที่พูด (ภาษาไทยหรือภาษาที่พูดจริง) ตอบเฉพาะข้อความที่ถอดได้ ไม่ต้องเกริ่น' },
            { type: 'input_audio', input_audio: { data: b64, format: 'mp3' } },
          ],
        },
      ],
    });
    return res.choices[0]?.message?.content?.trim().slice(0, 3000) || '';
  } finally {
    for (const f of [inFile, outFile]) fs.rmSync(f, { force: true });
  }
}

async function describeVideo(buf, messageId) {
  const inFile = tmpFile(`${messageId}.mp4`);
  const frameFile = tmpFile(`${messageId}.jpg`);
  try {
    fs.writeFileSync(inFile, buf);
    ffmpeg(['-ss', '1', '-i', inFile, '-frames:v', '1', frameFile]); // ดึงเฟรมวินาทีที่ 1
    return await describeImage(fs.readFileSync(frameFile));
  } finally {
    for (const f of [inFile, frameFile]) fs.rmSync(f, { force: true });
  }
}

// ---------- ไฟล์เอกสาร ----------
const TEXT_EXTS = new Set(['txt', 'csv', 'json', 'md', 'log', 'tsv']);
async function readFileContent(fileName, buf) {
  const ext = (fileName.split('.').pop() || '').toLowerCase();
  if (TEXT_EXTS.has(ext)) return buf.toString('utf8').slice(0, 2000);
  if (ext === 'pdf') {
    const pdfParse = require('pdf-parse');
    const parsed = await pdfParse(buf);
    return (parsed.text || '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 2000);
  }
  return null; // นามสกุลอื่น — เก็บแค่ชื่อไฟล์พอ
}

// ---------- จุดเข้า: อ่านแล้วคืนข้อความ (null = อ่านไม่ได้ ให้ใช้ placeholder เดิม) ----------
async function readMedia(msg) {
  try {
    if (msg.type === 'image') return `[รูป] ${await describeImage(await downloadContent(msg.id))}`;
    if (msg.type === 'audio') return `[เสียงพูด] ${await transcribeAudio(await downloadContent(msg.id), msg.id)}`;
    if (msg.type === 'video') return `[วิดีโอ] ${await describeVideo(await downloadContent(msg.id), msg.id)}`;
    if (msg.type === 'file') {
      const body = await readFileContent(msg.fileName || '', await downloadContent(msg.id));
      return body ? `[ไฟล์ ${msg.fileName}] ${body}` : null;
    }
  } catch (e) {
    console.error(`[media] ${msg.type} ${msg.id}:`, e.message);
  }
  return null;
}

module.exports = { readMedia };
