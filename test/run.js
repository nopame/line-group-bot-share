// ชุดทดสอบแบบ offline — ไม่ต้องมี LINE token หรือ OpenRouter key (รันใน CI ได้เลย)
// ครอบคลุม: ชื่อบอทจาก .env, คำสั่งประจำตัว (brief.txt / BOT_BRIEF), ฐานข้อมูล, prompt + ความจำบทสนทนา,
//          การตอบแชทส่วนตัวครบทุกเส้นทาง (ทักทาย / ข้อความ / รูป / ออกจากกลุ่ม / unsend / เพดานต่อวัน / AI ล่ม)
const os = require('os');
const path = require('path');
const fs = require('fs');

// ใช้ DB ชั่วคราวแยกต่อการรัน 1 ครั้ง + ตั้งค่าเหมือนลูกค้าทำใน .env (ต้องตั้งก่อน require)
process.env.DB_PATH = path.join(os.tmpdir(), `chatbot-test-${process.pid}.db`);
process.env.BOT_NAME = 'น้องมะลิ';
process.env.BOT_BRIEF = 'คุณคือแอดมินร้านขนมบ้านมะลิ ขายคุกกี้กล่องละ 120 บาท';
for (const s of ['', '-shm', '-wal']) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch {} }

const dayjs = require('../src/time');
const db = require('../src/db');
const branding = require('../src/branding');
const brief = require('../src/brief');
const { buildMessages, systemPrompt } = require('../src/ai');
const { createBot, placeholder, dailyLimit, greeting } = require('../src/bot');

let pass = 0, fail = 0;
function check(name, cond) {
  cond ? pass++ : fail++;
  console.log(`${cond ? '✅' : '❌'} ${name}`);
}

// ---------- LINE ปลอม — จดว่าบอทเรียกอะไรบ้าง ----------
function fakeClient({ replyFails = false } = {}) {
  const calls = { reply: [], push: [], leave: [], loading: [] };
  return {
    calls,
    async replyMessage(req) { if (replyFails) throw new Error('Invalid reply token'); calls.reply.push(req); },
    async pushMessage(req) { calls.push.push(req); },
    async getProfile(id) { if (id === 'U-private') throw new Error('404'); return { displayName: 'พลอย' }; },
    async leaveGroup(id) { calls.leave.push(id); },
    async leaveRoom(id) { calls.leave.push(id); },
    async showLoadingAnimation(req) { calls.loading.push(req); },
  };
}
// AI ปลอม — คืนคำตอบตายตัว และจำว่าได้บทสนทนาอะไรไป
function fakeAI(answer = 'คุกกี้กล่องละ 120 บาทค่ะ', { fails = false } = {}) {
  const seen = [];
  return {
    seen,
    async chatReply(rows, opts) { seen.push({ rows, opts }); if (fails) throw new Error('timeout'); return answer; },
  };
}
const fakeMedia = { async readMedia(msg) { return msg.id === 'bad' ? null : '[รูป] สลิปโอน 240 บาท'; } };
const textEvent = (userId, text, id) => ({ type: 'message', replyToken: 'rt', source: { type: 'user', userId }, message: { type: 'text', id, text } });

async function main() {
  // ===== ชื่อบอท ตั้งเองจาก .env =====
  check('ชื่อบอทมาจาก BOT_NAME', branding.BOT === 'น้องมะลิ');
  check('เดาคำแทนตัวจากชื่อ: น้องมะลิ → น้อง', branding.SELF === 'น้อง');
  check('ไม่ตั้งอะไรเลย = น้องฟ้าใส', branding.resolve({}).BOT === 'น้องฟ้าใส');
  check('ชื่อขึ้นต้น พี่ → เรียกตัวเองว่า พี่', branding.guessSelf('พี่หมี') === 'พี่');
  check('ชื่อฝรั่ง → เรียกชื่อตัวเองเต็ม', branding.guessSelf('MayBot') === 'MayBot');
  check('BOT_SELF สั่งทับได้', branding.resolve({ BOT_NAME: 'น้องมะลิ', BOT_SELF: 'มะลิ' }).SELF === 'มะลิ');
  check('BOT_EMOJI ตั้งเองได้', branding.resolve({ BOT_EMOJI: '🌼' }).EMOJI === '🌼');
  check('BOT_POLITE=ชาย → ลงท้ายครับ', branding.toMale('สวัสดีค่ะ ฝากตัวด้วยนะคะ') === 'สวัสดีครับ ฝากตัวด้วยนะครับ');
  check('BOT_POLITE=ชาย ไม่ทำคำว่าคะแนนพัง', branding.toMale('ได้ 5 คะแนนค่ะ') === 'ได้ 5 คะแนนครับ');
  check('ค่าเริ่มต้น (หญิง) ไม่แตะข้อความ', branding.resolve({}).say('สวัสดีค่ะ') === 'สวัสดีค่ะ');

  // ===== คำสั่งประจำตัว — เจ้าของสั่งว่าบอททำหน้าที่อะไร =====
  check('คำสั่งมาจาก BOT_BRIEF', brief.SOURCE === 'env' && brief.TEXT.includes('ร้านขนมบ้านมะลิ'));
  check('ไม่ตั้งอะไรเลย = ไม่มีคำสั่ง ไม่แตะ prompt', (() => { const b = brief.resolve({}, { readFile: () => '' }); return b.SOURCE === 'none' && b.block() === ''; })());
  check('อ่านจากไฟล์ได้ + ข้ามบรรทัด #', (() => { const b = brief.resolve({}, { readFile: () => '# หมายเหตุ\nเป็นเลขาส่วนตัว\n\n\n- เตือนนัด\n' }); return b.SOURCE === 'file' && b.TEXT === 'เป็นเลขาส่วนตัว\n\n- เตือนนัด'; })());
  check('.env ชนะไฟล์', brief.resolve({ BOT_BRIEF: 'จาก env' }, { readFile: () => 'จากไฟล์' }).TEXT === 'จาก env');
  check('BOT_BRIEF_FILE ชี้ไฟล์อื่นได้', (() => { let seen = null; brief.resolve({ BOT_BRIEF_FILE: './x.txt' }, { readFile: (f) => { seen = f; return 'ok'; } }); return seen === './x.txt'; })());
  check('ไม่ชี้ไฟล์ = อ่าน brief.txt ข้าง package.json', (() => { let seen = null; brief.resolve({}, { readFile: (f) => { seen = f; return ''; } }); return seen === brief.DEFAULT_FILE; })());
  check('คำสั่งยาวเกินถูกตัด', (() => { const b = brief.resolve({ BOT_BRIEF: 'ก'.repeat(brief.MAX_CHARS + 50) }); return b.TRUNCATED && b.TEXT.length === brief.MAX_CHARS; })());

  // ===== prompt =====
  const sys = systemPrompt({ name: 'พลอย' });
  check('prompt ใช้ชื่อบอทที่ตั้ง', sys.includes('"น้องมะลิ"') && sys.includes('"น้อง"'));
  check('prompt รู้ว่ากำลังคุยกับใคร', sys.includes('คุณพลอย'));
  check('prompt มีคำสั่งประจำตัวต่อท้าย', sys.includes('ร้านขนมบ้านมะลิ') && sys.includes('คำสั่งจากเจ้าของ'));
  check('prompt บอกวันที่ปัจจุบันเป็น พ.ศ.', sys.includes(String(dayjs().tz().year() + 543)));
  check('prompt สั่งห้ามเดาข้อมูล', sys.includes('ห้ามเดา'));
  check('ไม่มีคำสั่ง = ไม่มีก้อนคำสั่งจากเจ้าของ', !systemPrompt({}, '').includes('ยึดตามนี้เสมอ'));

  // ===== ความจำบทสนทนา → messages ของ AI =====
  const ts = '2026-11-09 03:00:00'; // = 10:00 เวลาไทย
  const msgs = buildMessages([
    { role: 'bot', type: 'text', text: 'สวัสดีค่ะ', ts },
    { role: 'user', type: 'text', text: 'คุกกี้ราคาเท่าไหร่', ts },
    { role: 'bot', type: 'text', text: '120 บาทค่ะ', ts },
    { role: 'user', type: 'image', text: null, ts },
  ], { name: 'พลอย' });
  check('ข้อความแรกเป็น system', msgs[0].role === 'system');
  check('ตัดข้อความบอทที่ขึ้นก่อนผู้ใช้ทิ้ง (เริ่มด้วย user)', msgs[1].role === 'user');
  check('บอท = assistant · คน = user', msgs.map((m) => m.role).join(',') === 'system,user,assistant,user');
  check('ข้อความคนมีเวลาไทยกำกับ', msgs[1].content === '[9/11 10:00] คุกกี้ราคาเท่าไหร่');
  check('ข้อความบอทไม่มีเวลากำกับ', msgs[2].content === '120 บาทค่ะ');
  check('สื่อที่ยังไม่มีข้อความ → [ชนิด]', msgs[3].content.endsWith('[image]'));
  const long = Array.from({ length: 50 }, (_, i) => ({ role: i % 2 ? 'bot' : 'user', type: 'text', text: `ข้อความที่ ${i} ` + 'ก'.repeat(200), ts }));
  const trimmed = buildMessages(long, { maxChars: 2000 });
  check('ประวัติยาวเกิน → ตัดของเก่าทิ้ง เก็บของใหม่', trimmed.length < 15 && trimmed[trimmed.length - 1].content.includes('ข้อความที่ 49'));
  check('ข้อความล่าสุดยาวเกินงบก็ยังส่งไป', buildMessages([{ role: 'user', type: 'text', text: 'ก'.repeat(9000), ts }], { maxChars: 100 }).length === 2);

  // ===== ฐานข้อมูล =====
  db.upsertUser('U1', 'พลอย');
  db.upsertUser('U1', null);
  check('จำชื่อคนคุย และไม่ถูกลบด้วยค่าว่าง', db.userName('U1') === 'พลอย');
  check('คนไม่รู้จัก = ชื่อว่าง', db.userName('Ux') === '');
  const r1 = db.logMessage('U1', 'user', 'lm1', 'text', 'สวัสดี');
  db.logMessage('U1', 'bot', null, 'text', 'สวัสดีค่ะ');
  db.logMessage('U2', 'user', 'lm2', 'text', 'ของคนอื่น');
  check('บทสนทนาแยกรายคน', db.recentMessages('U1').length === 2 && db.recentMessages('U2').length === 1);
  check('เรียงเก่า → ใหม่', db.recentMessages('U1')[0].id === r1);
  check('นับข้อความวันนี้เฉพาะฝั่งคน', db.userMessagesToday('U1') === 1);
  check('อัพเดตข้อความ (สื่อ)', (db.updateMessageText(r1, 'แก้แล้ว'), db.recentMessages('U1')[0].text === 'แก้แล้ว'));
  check('unsend ลบตาม', db.deleteByLineMsgId('lm1') === true && db.recentMessages('U1').length === 1);
  check('unsend id มั่ว = false', db.deleteByLineMsgId('nope') === false);

  // ===== ตัวช่วยเล็กๆ =====
  check('placeholder สติกเกอร์มีอารมณ์', placeholder({ type: 'sticker', keywords: ['happy', 'love'] }) === '[สติกเกอร์: happy love]');
  check('placeholder ตำแหน่ง', placeholder({ type: 'location', title: 'ร้าน', address: 'ถนนสุขุมวิท' }) === '[ตำแหน่ง] ร้าน ถนนสุขุมวิท');
  check('เพดานต่อวัน ค่าเริ่มต้น 100', dailyLimit({}) === 100);
  check('DAILY_LIMIT=0 = ไม่จำกัด', dailyLimit({ DAILY_LIMIT: '0' }) === 0);
  check('DAILY_LIMIT มั่ว → 100', dailyLimit({ DAILY_LIMIT: 'abc' }) === 100);
  check('คำทักทายใช้ชื่อบอท', greeting({}).includes('น้องมะลิ'));
  check('BOT_GREETING ตั้งเองได้', greeting({ BOT_GREETING: 'ยินดีต้อนรับสู่ร้านมะลิ' }) === 'ยินดีต้อนรับสู่ร้านมะลิ');

  // ===== ตอบแชทส่วนตัว (LINE + AI ปลอม) =====
  {
    const client = fakeClient(), ai = fakeAI();
    const bot = createBot({ client, ai, media: fakeMedia, env: {} });
    check('แอดเพื่อน → ทักทาย', (await bot.handleEvent({ type: 'follow', replyToken: 'rt', source: { type: 'user', userId: 'U3' } })) === 'greeted');
    check('ทักทายด้วยคำทักทายของบอท', client.calls.reply[0].messages[0].text.includes('น้องมะลิ'));
    check('แอดเพื่อน → จำชื่อจากโปรไฟล์', db.userName('U3') === 'พลอย');

    check('ข้อความ → AI ตอบ', (await bot.handleEvent(textEvent('U3', 'คุกกี้ราคาเท่าไหร่', 'm1'))) === 'answered');
    check('ตอบกลับด้วยคำตอบของ AI', client.calls.reply[1].messages[0].text === 'คุกกี้กล่องละ 120 บาทค่ะ');
    check('ขึ้นจุดกำลังพิมพ์ก่อนตอบ', client.calls.loading[0]?.chatId === 'U3');
    check('AI เห็นบทสนทนาก่อนหน้า (คำทักทาย + คำถาม)', ai.seen[0].rows.length === 2 && ai.seen[0].rows[1].text === 'คุกกี้ราคาเท่าไหร่');
    check('AI รู้ชื่อคนคุย', ai.seen[0].opts.name === 'พลอย');
    check('เก็บคำตอบบอทไว้ในความจำ', db.recentMessages('U3').slice(-1)[0].role === 'bot');

    const img = { type: 'message', replyToken: 'rt', source: { type: 'user', userId: 'U3' }, message: { type: 'image', id: 'img1' } };
    await bot.handleEvent(img);
    check('ส่งรูป → อ่านรูปก่อนแล้ว AI ตอบต่อจากที่อ่าน', ai.seen[1].rows.slice(-1)[0].text === '[รูป] สลิปโอน 240 บาท');
    check('สื่อขึ้นจุดกำลังพิมพ์นานขึ้น', client.calls.loading[1]?.loadingSeconds === 60);
    await bot.handleEvent({ ...img, message: { type: 'image', id: 'bad' } });
    check('อ่านรูปไม่ออก → AI เห็นแค่ [รูป]', ai.seen[2].rows.slice(-1)[0].text === '[รูป]');

    check('unsend → ลบจากความจำ', (await bot.handleEvent({ type: 'unsend', source: { type: 'user', userId: 'U3' }, unsend: { messageId: 'm1' } })) === 'unsent' && !db.recentMessages('U3').some((m) => m.line_msg_id === 'm1'));
  }
  {
    const client = fakeClient(), ai = fakeAI();
    const bot = createBot({ client, ai, media: fakeMedia, env: {} });
    const join = { type: 'join', replyToken: 'rt', source: { type: 'group', groupId: 'G1' } };
    check('ถูกเชิญเข้ากลุ่ม → ออกเอง', (await bot.handleEvent(join)) === 'left' && client.calls.leave[0] === 'G1');
    check('บอกในกลุ่มก่อนออกว่าคุยได้เฉพาะแชทส่วนตัว', client.calls.reply[0].messages[0].text.includes('แชทส่วนตัว'));
    await bot.handleEvent({ type: 'message', replyToken: 'rt', source: { type: 'room', roomId: 'R1', userId: 'U9' }, message: { type: 'text', id: 'x', text: 'สวัสดี' } });
    check('ข้อความในห้องรวม → ออก ไม่เรียก AI', client.calls.leave[1] === 'R1' && ai.seen.length === 0);
  }
  {
    const client = fakeClient(), ai = fakeAI();
    const bot = createBot({ client, ai, media: fakeMedia, env: { DAILY_LIMIT: '1' } });
    await bot.handleEvent(textEvent('U4', 'ข้อแรก', 'a1'));
    check('ครบเพดานต่อวัน → ตอบสั้น ไม่เรียก AI', (await bot.handleEvent(textEvent('U4', 'ข้อสอง', 'a2'))) === 'limit' && ai.seen.length === 1);
    check('ข้อความที่เกินเพดานไม่ถูกเก็บ', db.recentMessages('U4').filter((m) => m.role === 'user').length === 1);
  }
  {
    const client = fakeClient(), ai = fakeAI('', { fails: true });
    const bot = createBot({ client, ai, media: fakeMedia, env: {} });
    check('AI ล่ม → ขอโทษ ไม่เงียบ', (await bot.handleEvent(textEvent('U5', 'สวัสดี', 'e1'))) === 'error' && client.calls.reply[0].messages[0].text.includes('ขอโทษ'));
  }
  {
    const client = fakeClient({ replyFails: true }), ai = fakeAI();
    const bot = createBot({ client, ai, media: fakeMedia, env: {} });
    await bot.handleEvent(textEvent('U6', 'สวัสดี', 'p1'));
    check('replyToken หมดอายุ → ส่งแบบ push แทน', client.calls.push[0]?.to === 'U6');
  }
  {
    const client = fakeClient(), ai = fakeAI('');
    const bot = createBot({ client, ai, media: fakeMedia, env: {} });
    await bot.handleEvent(textEvent('U-private', 'สวัสดี', 'n1'));
    check('AI คืนคำตอบว่าง → มีข้อความสำรอง', client.calls.reply[0].messages[0].text.includes('ขอโทษ'));
    check('โปรไฟล์ไม่เปิด → ยังคุยได้ ชื่อว่าง', db.userName('U-private') === '' && ai.seen[0].opts.name === '');
  }

  console.log(`\n${pass} ผ่าน / ${fail} พัง`);
  for (const s of ['', '-shm', '-wal']) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch {} }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('❌ เทสล้ม:', e.stack); process.exit(1); });
