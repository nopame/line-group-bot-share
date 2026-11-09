// ตัวรับ event จาก LINE — คุยแชทส่วนตัว (1:1) เท่านั้น
// แยกเป็น factory รับ client / db / ai / media จากข้างนอก เทสจะได้ส่งของปลอมเข้ามาได้โดยไม่ต้องต่อ LINE จริง
const { BOT, SELF, EMOJI, say } = require('./branding');
const { imageCommand, HELP: IMAGE_HELP } = require('./image-generation');

const MEDIA_TYPES = ['image', 'audio', 'video', 'file'];

// ข้อความที่ไม่ใช่ text → เก็บ placeholder ไว้ก่อน (สื่อจะถูกอ่านจริงแล้วเขียนทับ)
function placeholder(message) {
  switch (message.type) {
    case 'image':
      return '[รูป]';
    case 'sticker': {
      const kw = (message.keywords || []).slice(0, 3).join(' ');
      return kw ? `[สติกเกอร์: ${kw}]` : '[สติกเกอร์]';
    }
    case 'video':
      return '[วิดีโอ]';
    case 'audio':
      return '[เสียงพูด]';
    case 'file':
      return `[ไฟล์] ${message.fileName || ''}`.trim();
    case 'location':
      return `[ตำแหน่ง] ${[message.title, message.address].filter(Boolean).join(' ')}`.trim();
    default:
      return `[${message.type}]`;
  }
}

// เพดานข้อความต่อคนต่อวัน (กันค่า AI บาน) — DAILY_LIMIT=0 คือไม่จำกัด
function dailyLimit(env = process.env) {
  const n = parseInt(env.DAILY_LIMIT ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : 100;
}

function greeting(env = process.env) {
  return (
    String(env.BOT_GREETING || '').trim() ||
    `สวัสดีค่ะ ${BOT}ยินดีที่ได้รู้จักนะคะ ${EMOJI}\nพิมพ์ถาม ส่งรูป หรือส่งข้อความเสียงมาได้เลยค่ะ`
  );
}

function createBot({ client, db = require('./db'), ai = require('./ai'), media = require('./media'), env = process.env, images }) {
  images ??= require('./image-generation').createImageService({ env, db });
  const textMsg = (t) => ({ type: 'text', text: say(t).slice(0, 4900) });

  // ตอบด้วย replyToken (ฟรี) — หมดอายุ/ใช้ไม่ได้ ค่อยถอยไป push (กินโควต้าฟรี 300/เดือน) จะได้ไม่เงียบหาย
  async function send(replyToken, to, t) {
    try {
      await client.replyMessage({ replyToken, messages: Array.isArray(t) ? t : [textMsg(t)] });
      return 'reply';
    } catch (e) {
      console.error('[reply]', e.message);
      if (!to) return 'fail';
      try {
        await client.pushMessage({ to, messages: Array.isArray(t) ? t : [textMsg(t)] });
        return 'push';
      } catch (e2) {
        console.error('[push]', e2.message);
        return 'fail';
      }
    }
  }

  // จำชื่อคนคุย — ยังไม่รู้ชื่อค่อยยิง API (ได้เฉพาะคนที่แอดบอทเป็นเพื่อน)
  async function rememberUser(userId) {
    if (db.userName(userId)) return;
    let name = null;
    try {
      name = (await client.getProfile(userId))?.displayName || null;
    } catch {
      /* โปรไฟล์ไม่เปิด — ข้าม */
    }
    db.upsertUser(userId, name);
  }

  async function leave(src) {
    try {
      if (src.type === 'room') await client.leaveRoom(src.roomId);
      else await client.leaveGroup(src.groupId);
    } catch (e) {
      console.error('[leave]', e.message);
    }
  }

  async function handleEvent(event) {
    const src = event.source || {};

    // --- กลุ่ม / ห้องรวม: บอทนี้คุยส่วนตัวเท่านั้น บอกสั้นๆ แล้วออก ---
    if (src.type === 'group' || src.type === 'room') {
      if (event.type === 'join') {
        await client
          .replyMessage({
            replyToken: event.replyToken,
            messages: [textMsg(`${BOT}คุยได้เฉพาะแชทส่วนตัวนะคะ แอดเพื่อนแล้วทักมาได้เลยค่ะ ${EMOJI}`)],
          })
          .catch(() => {});
      }
      if (event.type === 'join' || event.type === 'message') {
        console.log(`[group] ไม่รับงานในกลุ่ม — ออกจาก ${src.groupId || src.roomId}`);
        await leave(src);
        return 'left';
      }
      return 'ignored';
    }

    const userId = src.userId;
    if (!userId) return 'ignored';

    // --- แอดเพื่อน (หรือปลดบล็อก) → ทักทาย ---
    if (event.type === 'follow') {
      await rememberUser(userId);
      const hi = greeting(env);
      db.logMessage(userId, 'bot', null, 'text', say(hi));
      await send(event.replyToken, null, hi);
      return 'greeted';
    }

    // --- คนกด unsend → ลบตาม ---
    if (event.type === 'unsend' && event.unsend?.messageId) {
      db.deleteByLineMsgId(event.unsend.messageId);
      return 'unsent';
    }

    if (event.type !== 'message') return 'ignored';
    const msg = event.message;
    const imagePrompt = msg.type === 'text' ? imageCommand(msg.text) : null;
    await rememberUser(userId);

    // --- เพดานต่อวัน: ครบแล้วตอบสั้นๆ ไม่เรียก AI ---
    const limit = dailyLimit(env);
    if (limit && db.userMessagesToday(userId) >= limit) {
      await send(event.replyToken, null, `วันนี้คุยกับ${SELF}ครบ ${limit} ข้อความแล้วค่ะ พรุ่งนี้ทักมาใหม่ได้เลยนะคะ 🙏`);
      return 'limit';
    }

    // จุดกำลังพิมพ์... ให้คนรู้ว่าบอทรับเรื่องแล้ว (สื่อใช้เวลานานกว่า)
    await Promise.resolve(
      client.showLoadingAnimation?.({ chatId: userId, loadingSeconds: MEDIA_TYPES.includes(msg.type) || imagePrompt !== null ? 60 : 20 }),
    ).catch(() => {});

    // --- เก็บข้อความ (สื่อ = อ่านก่อนแล้วเขียนทับ placeholder) ---
    if (msg.type === 'text') {
      db.logMessage(userId, 'user', msg.id, 'text', msg.text);
    } else {
      const rowId = db.logMessage(userId, 'user', msg.id, msg.type, placeholder(msg));
      if (MEDIA_TYPES.includes(msg.type)) {
        const read = await media.readMedia(msg);
        if (read) db.updateMessageText(rowId, read);
      }
    }

    if (imagePrompt !== null) {
      if (!imagePrompt) {
        await send(event.replyToken, userId, IMAGE_HELP);
        return 'image_help';
      }
      try {
        const result = await images.generate(imagePrompt, { userId, messageId: msg.id });
        if (result.status === 'duplicate') return 'ignored';
        if (result.status !== 'generated') {
          const answers = {
            limit: 'วันนี้ถึงจำนวนครั้งสร้างภาพที่กำหนดแล้วครับ ลองใหม่พรุ่งนี้ได้ครับ',
            busy: 'กำลังสร้างภาพก่อนหน้าให้คุณอยู่ครับ รอภาพนั้นเสร็จก่อนนะครับ',
            too_long: 'กรุณาย่อรายละเอียดภาพให้ไม่เกิน 2,000 ตัวอักษรครับ',
            disabled: 'ขณะนี้ปิดบริการสร้างภาพชั่วคราวครับ',
          };
          await send(event.replyToken, userId, answers[result.status] || 'ยังสร้างภาพไม่ได้ครับ ลองใหม่ภายหลังครับ');
          return `image_${result.status}`;
        }
        const delivered = await send(event.replyToken, userId, [textMsg('สร้างภาพให้แล้วครับ ภาพนี้สร้างโดย AI เป็นภาพจำลอง ไม่ใช่ภาพยืนยันสินค้าจริงครับ'), result.message]);
        if (delivered === 'fail') return 'image_delivery_error';
        db.logMessage(userId, 'bot', null, 'generated_image', `[ภาพที่สร้างโดย AI] ${imagePrompt}`);
        return 'image_generated';
      } catch (e) {
        console.error('[image]', e.message);
        await send(event.replyToken, userId, 'ขอโทษครับ สร้างภาพครั้งนี้ไม่สำเร็จ อาจเกิดจากบริการไม่พร้อม เครดิตไม่พอ หรือคำขอไม่ผ่านเงื่อนไข กรุณาลองใหม่ภายหลังครับ');
        return 'image_error';
      }
    }

    // --- ให้ AI ตอบจากคำสั่งประจำตัว + บทสนทนาที่ผ่านมา ---
    let answer;
    try {
      answer = await ai.chatReply(db.recentMessages(userId), { name: db.userName(userId) });
    } catch (e) {
      console.error('[ai]', e.message);
      await send(event.replyToken, userId, `ขอโทษนะคะ ระบบ${SELF}สะดุดนิดหน่อย ลองพิมพ์ใหม่อีกทีได้เลยค่ะ 🙏`);
      return 'error';
    }
    if (!answer) answer = `ขอโทษค่ะ ${SELF}ยังตอบเรื่องนี้ไม่ได้ ลองพิมพ์อีกแบบดูนะคะ`;
    const out = say(answer).slice(0, 4900);
    db.logMessage(userId, 'bot', null, 'text', out);
    await send(event.replyToken, userId, out);
    return 'answered';
  }

  return { handleEvent };
}

module.exports = { createBot, placeholder, dailyLimit, greeting };
