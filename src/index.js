require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const path = require('path');
const dayjs = require('./time');
const { db } = require('./db');
const { createBot } = require('./bot');
const { BOT } = require('./branding');
const brief = require('./brief');
const { imageHandler, imageDirectory, cleanImages } = require('./image-generation');

// เตือนค่าที่ยังไม่ได้ตั้ง แต่ไม่ปิดเซิร์ฟเวอร์ (ลองบูตในเครื่องก่อนผูก LINE ได้)
const missing = ['LINE_CHANNEL_ACCESS_TOKEN', 'LINE_CHANNEL_SECRET', 'OPENROUTER_API_KEY'].filter((k) => !process.env[k]);
if (missing.length) {
  console.warn(`⚠️  ยังไม่ได้ตั้งค่า: ${missing.join(', ')} — บอทจะยังตอบแชทไม่ได้จนกว่าจะตั้งครบ ดูวิธีใน INSTALL.md`);
}

const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || '',
});
const bot = createBot({ client });

const app = express();

// ---------- webhook ----------
if (process.env.LINE_CHANNEL_SECRET) {
  app.post('/webhook', line.middleware({ channelSecret: process.env.LINE_CHANNEL_SECRET }), (req, res) => {
    res.sendStatus(200); // ตอบ LINE ก่อน ค่อยประมวลผล (กัน timeout)
    for (const event of req.body.events || []) {
      bot.handleEvent(event).catch((e) => console.error('[event]', e.message));
    }
  });
} else {
  app.post('/webhook', (_req, res) => res.status(503).send('LINE ยังไม่ได้ตั้งค่า — ดู INSTALL.md'));
}

// ลายเซ็นไม่ตรง = ไม่ได้มาจาก LINE (หรือ LINE_CHANNEL_SECRET ผิด) → ตอบ 401 สั้นๆ ไม่พ่น stack ยาวลง log
app.use((err, _req, res, next) => {
  if (err instanceof line.SignatureValidationFailed) {
    console.warn('[webhook] ลายเซ็นไม่ตรง — เช็ค LINE_CHANNEL_SECRET');
    return res.status(401).send('bad signature');
  }
  next(err);
});

app.get('/health', (_req, res) => res.json({ ok: true }));
// Random bearer URLs let LINE fetch pictures; files expire after 24 hours.
app.get('/generated/:file', imageHandler());
const imageCleanup = setInterval(() => {
  try { cleanImages(imageDirectory()); } catch (e) { console.error('[image-cleanup]', e.code || 'failed'); }
}, 60 * 60 * 1000);
imageCleanup.unref();

// ดาวน์โหลดไฟล์ฐานข้อมูลไว้สำรอง (bin/backup-db.sh เรียกทุกคืน) — ต้องมี ADMIN_KEY
app.get('/admin/backup', (req, res) => {
  if (!process.env.ADMIN_KEY || req.query.key !== process.env.ADMIN_KEY) return res.status(403).send('forbidden');
  const file = process.env.DB_PATH || path.join(__dirname, '..', 'chatbot.db');
  db.pragma('wal_checkpoint(TRUNCATE)');
  res.download(file, `chatbot-${dayjs().format('YYYY-MM-DD')}.db`);
});

// ---------- start ----------
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`${BOT} (line-chatbot) ฟังอยู่ที่พอร์ต ${port}`);
  console.log(
    brief.SOURCE === 'none'
      ? '[brief] ยังไม่มีคำสั่งประจำตัว (brief.txt) — บอทจะเป็นผู้ช่วยทั่วไป'
      : `[brief] ใช้คำสั่งประจำตัวจาก ${brief.SOURCE === 'env' ? 'BOT_BRIEF ใน .env' : 'ไฟล์ brief.txt'} (${brief.TEXT.length} ตัวอักษร)`,
  );
});
