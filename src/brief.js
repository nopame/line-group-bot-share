// คำสั่งประจำตัวบอท — เจ้าของเขียนเองว่าบอททำหน้าที่อะไร รู้ข้อมูลอะไร ห้ามทำอะไร
//
//   ไฟล์ brief.txt (ข้างๆ package.json) — ทางหลัก เขียนยาวหลายบรรทัดได้ บรรทัดขึ้นต้น # = หมายเหตุ ไม่ส่งให้ AI
//   BOT_BRIEF=...               — คำสั่งสั้นบรรทัดเดียวใน .env (ตั้งไว้ = ชนะไฟล์)
//   BOT_BRIEF_FILE=./brief-shop.txt — ชี้ไฟล์อื่นแทน brief.txt
//
// ไม่ตั้งอะไรเลย = เป็นผู้ช่วยทั่วไป คุยได้ทุกเรื่อง แต่ไม่รู้ข้อมูลเฉพาะของเจ้าของ
const fs = require('fs');
const path = require('path');

// กันคำสั่งยาวจนกิน prompt — ทุกข้อความที่บอทตอบต้องส่งคำสั่งนี้ไปด้วย ยาว = แพงขึ้นทุกครั้ง
const MAX_CHARS = 8000;
const DEFAULT_FILE = path.join(__dirname, '..', 'brief.txt');

function readBriefFile(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return ''; // ไม่มีไฟล์ = ไม่มีคำสั่ง
  }
}

// ตัดบรรทัดหมายเหตุ (#) กับบรรทัดว่างเกิน — จดโน้ตไว้ในไฟล์ได้โดยไม่ส่งให้ AI
function clean(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ฟังก์ชันบริสุทธิ์ (รับ env + ตัวอ่านไฟล์) ให้เทสเรียกได้โดยไม่ยุ่ง process.env / ดิสก์จริง
function resolve(env = {}, { readFile = readBriefFile } = {}) {
  let source = 'none';
  let text = clean(env.BOT_BRIEF);
  if (text) source = 'env';
  else {
    const file = String(env.BOT_BRIEF_FILE || '').trim() || DEFAULT_FILE;
    text = clean(readFile(file));
    if (text) source = 'file';
  }
  let truncated = false;
  if (text.length > MAX_CHARS) {
    text = text.slice(0, MAX_CHARS).trim();
    truncated = true;
  }
  return {
    TEXT: text,
    SOURCE: source, // 'env' | 'file' | 'none'
    TRUNCATED: truncated,
    // ก้อนข้อความต่อท้าย system prompt — ไม่มีคำสั่ง = สตริงว่าง
    block: () =>
      text
        ? `\n\nคำสั่งจากเจ้าของ — หน้าที่ ข้อมูล และกติกาของคุณ ยึดตามนี้เสมอ:\n${text}`
        : '',
  };
}

const current = resolve(process.env);
if (current.TRUNCATED) console.warn(`⚠️  คำสั่งประจำตัวยาวเกิน ${MAX_CHARS} ตัวอักษร — ตัดส่วนท้ายทิ้ง`);

module.exports = { ...current, resolve, clean, MAX_CHARS, DEFAULT_FILE };
