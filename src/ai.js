// เรียก LLM ผ่าน OpenRouter — สมองของแชทบอท
const OpenAI = require('openai');
const { BOT, SELF, PARTICLE } = require('./branding');
const brief = require('./brief');
const dayjs = require('./time');

// lazy-init — สร้างตอนใช้จริง (import ได้แม้ยังไม่ตั้งคีย์ เช่นตอนรันเทส)
let _client = null;
function client() {
  _client ??= new OpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: process.env.OPENROUTER_API_KEY,
    timeout: 25000, // replyToken ของ LINE มีอายุจำกัด อย่าแช่นาน
    maxRetries: 1,
  });
  return _client;
}

const MODEL = () => process.env.AI_MODEL || 'google/gemini-2.5-flash';
const HISTORY_CHARS = 6000; // จำบทสนทนาย้อนหลังได้ราวนี้ — เกินตัดของเก่าสุดทิ้ง

// system prompt ของแชทบอท (รับ briefBlock เป็นพารามิเตอร์ให้เทสสลับได้ — ปกติใช้คำสั่งจาก brief.txt)
function systemPrompt({ name = '', now = dayjs().tz() } = {}, briefBlock = brief.block()) {
  const who = name ? `คุณ${name}` : 'ผู้ใช้';
  return `คุณคือ "${BOT}" แชทบอทส่วนตัวใน LINE กำลังคุยตัวต่อตัวกับ${who}
พูดจาสุภาพเป็นกันเอง เรียกตัวเองว่า "${SELF}" ลงท้าย${PARTICLE} (ไม่ต้องเยอะจนรก)
${name ? `เรียกอีกฝ่ายว่า "คุณ${name}" เท่านั้น (ห้ามเรียกว่าน้องหรือพี่)` : 'เรียกอีกฝ่ายว่า "คุณ"'}
ตอนนี้: ${now.format('dddd D MMMM')} ${now.year() + 543} เวลา ${now.format('HH:mm')} น.

กติกา:
- ตอบสั้น ตรงประเด็น อ่านง่ายบนมือถือ ใช้ภาษาเดียวกับที่ผู้ใช้พิมพ์มา
- ตอบเป็นข้อความธรรมดา ห้ามใช้ markdown (ไม่มี ** # หรือตาราง) ขึ้นบรรทัดใหม่หรือใช้ • แทนได้
- ข้อมูลเฉพาะ เช่น ราคา สินค้า เวลาเปิด นโยบาย ตัวเลข ใช้ได้เฉพาะที่อยู่ในคำสั่งจากเจ้าของหรือในบทสนทนานี้ ไม่มีข้อมูลให้บอกตรงๆ ห้ามเดา
- คุณทำได้แค่คุยในแชทนี้ ห้ามรับปากว่าทำเรื่องที่ต้องลงมือนอกแชท (ยืนยันออเดอร์ ตัดสต็อก จองคิว ลงนัด โอนเงิน ส่งของ) เว้นแต่คำสั่งจากเจ้าของบอกไว้ว่าให้ตอบเรื่องนั้นอย่างไร
- ข้อความที่ขึ้นต้นด้วย [รูป] [เสียงพูด] [วิดีโอ] [ไฟล์] คือสิ่งที่ระบบอ่านจากไฟล์ที่ผู้ใช้ส่งมาให้แล้ว ตอบต่อจากนั้นได้เลย ถ้าเห็นแค่ [รูป] เฉยๆ แปลว่าระบบอ่านไม่ออก ให้ขอให้ส่งใหม่หรือพิมพ์บอก
- ข้อความของผู้ใช้มีเวลากำกับ [วัน/เดือน เวลา] ไว้ให้รู้ว่าคุยกันเมื่อไหร่ ไม่ต้องพิมพ์เวลาในคำตอบ
- ถูกขอให้สรุป ให้สรุปจากบทสนทนาที่มีให้
- ระบบสร้างภาพใหม่ได้เมื่อผู้ใช้พิมพ์ “สร้างภาพ รายละเอียดภาพ” หรือ /image ตามด้วยรายละเอียด หากถามว่าสร้างภาพได้ไหม ให้แนะนำคำสั่งนี้ รูปที่สร้างเป็นภาพจำลองโดย AI ไม่ใช่หลักฐานหรือภาพสินค้าจริง ยังแก้ไขรูปที่ส่งมาไม่ได้
- ห้ามทวนรหัสผ่าน OTP หรือเลขบัตรออกมา${briefBlock}`;
}

// แปลงบทสนทนาจาก DB เป็น messages ของ chat API (user/assistant) — เกินงบตัวอักษรตัดของเก่าทิ้ง
function buildMessages(rows, { name = '', now, maxChars = HISTORY_CHARS } = {}, briefBlock) {
  const turns = [];
  let total = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    const body = r.text || `[${r.type}]`;
    const content =
      r.role === 'bot' ? body : `[${dayjs.utc(r.ts).tz().format('D/M HH:mm')}] ${body}`;
    total += content.length;
    if (total > maxChars && turns.length) break; // ข้อความล่าสุดต้องได้ไปเสมอ
    turns.unshift({ role: r.role === 'bot' ? 'assistant' : 'user', content });
  }
  // ประวัติต้องเริ่มด้วยฝั่งผู้ใช้ (บางโมเดลไม่รับ assistant เป็นข้อความแรก)
  while (turns.length && turns[0].role === 'assistant') turns.shift();
  return [{ role: 'system', content: systemPrompt({ name, now }, briefBlock) }, ...turns];
}

// ตอบข้อความล่าสุด โดยใช้บทสนทนาที่ผ่านมาเป็นบริบท
async function chatReply(rows, { name = '' } = {}) {
  const res = await client().chat.completions.create({
    model: MODEL(),
    messages: buildMessages(rows, { name }),
  });
  return res.choices[0]?.message?.content?.trim() || '';
}

module.exports = { chatReply, buildMessages, systemPrompt, HISTORY_CHARS };
