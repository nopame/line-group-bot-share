const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'line-images-test-'));
process.env.DB_PATH = path.join(dir, 'test.db');
const db = require('../src/db');
const sharp = require('sharp');
const { imageCommand, createImageService, imageHandler, cleanImages, TTL } = require('../src/image-generation');
const env = { APP_URL: 'https://example.com', OPENROUTER_API_KEY: 'test', IMAGE_DIR: path.join(dir, 'images') };
after(() => { db.db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('only explicit image commands invoke generation; capability questions show help', () => {
  assert.equal(imageCommand('ช่วยสร้างรูปภาพ ผ้าสีฟ้า'), 'ผ้าสีฟ้า');
  assert.equal(imageCommand('/image blue fabric'), 'blue fabric');
  assert.equal(imageCommand('generate an image of blue fabric'), 'of blue fabric');
  assert.equal(imageCommand('สร้างภาพได้ไหม'), '');
  assert.equal(imageCommand('ผ้ารุ่นนี้ราคาเท่าไร'), null);
  assert.equal(imageCommand('อย่าสร้างภาพ'), null);
});

test('quota reservations survive another service instance and duplicate delivery costs nothing', () => {
  assert.equal(db.reserveImageRequest('quota-user', 'q1', 1, 30), 'reserved');
  assert.equal(db.reserveImageRequest('quota-user', 'q1', 1, 30), 'duplicate');
  assert.equal(db.reserveImageRequest('quota-user', 'q2', 1, 30), 'limit');
  assert.equal(db.reserveImageRequest('other-user', 'q3', 3, 1), 'limit');
});

test('API result becomes JPEG + small preview with unguessable HTTPS URLs', async () => {
  const png = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#123456' } }).png().toBuffer();
  let calls = 0;
  const service = createImageService({ env, db, fetchImpl: async (_url, options) => {
    calls++;
    const body = JSON.parse(options.body);
    assert.equal(body.n, 1);
    assert.equal(body.prompt, 'blue fabric');
    return new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }));
  } });
  const context = { userId: 'generation-user', messageId: 'i1' };
  const result = await service.generate('blue fabric', context);
  assert.equal(result.status, 'generated');
  assert.match(result.message.originalContentUrl, /^https:\/\/example.com\/generated\/[a-f0-9]{48}\.jpg$/);
  for (const url of [result.message.originalContentUrl, result.message.previewImageUrl]) {
    const file = path.join(env.IMAGE_DIR, path.basename(url));
    assert.equal((await sharp(file).metadata()).format, 'jpeg');
    assert.ok(fs.statSync(file).size < 1024 * 1024);
  }
  assert.equal((await service.generate('blue fabric', context)).status, 'duplicate');
  assert.equal(calls, 1);
});

test('disabled, long prompts, and concurrent requests do not call the paid API', async () => {
  let release;
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const service = createImageService({ env, db, fetchImpl: async () => { started(); await gate; return new Response('{}'); } });
  const first = service.generate('blue fabric', { userId: 'busy-user', messageId: 'b1' });
  await ready;
  assert.equal((await service.generate('blue fabric', { userId: 'busy-user', messageId: 'b2' })).status, 'busy');
  release();
  await assert.rejects(first, /image_missing/);
  assert.equal((await service.generate('x'.repeat(2001), { userId: 'long-user', messageId: 'l1' })).status, 'too_long');
  const disabled = createImageService({ env: { IMAGE_GENERATION_ENABLED: 'false' }, db });
  assert.equal((await disabled.generate('blue fabric', {})).status, 'disabled');
});

test('upstream failure and non-image payload are rejected', async () => {
  const failed = createImageService({ env, db, fetchImpl: async () => new Response('{}', { status: 402 }) });
  await assert.rejects(failed.generate('fabric', { userId: 'failed-user', messageId: 'f1' }), /image_api_http_402/);
  const invalid = createImageService({ env, db, fetchImpl: async () => new Response(JSON.stringify({ data: [{ b64_json: Buffer.from('<svg>bad</svg>').toString('base64') }] })) });
  await assert.rejects(invalid.generate('fabric', { userId: 'invalid-user', messageId: 'f2' }));
});

test('image route blocks traversal and expired files, cleanup preserves unrelated files', () => {
  const expired = `${'a'.repeat(48)}.jpg`;
  const file = path.join(env.IMAGE_DIR, expired);
  fs.writeFileSync(file, 'old');
  const old = new Date(Date.now() - TTL - 1000);
  fs.utimesSync(file, old, old);
  let code;
  const res = { sendStatus: n => { code = n; } };
  imageHandler(env)({ params: { file: '../.env' } }, res);
  assert.equal(code, 404);
  imageHandler(env)({ params: { file: expired } }, res);
  assert.equal(code, 404);
  fs.writeFileSync(path.join(env.IMAGE_DIR, 'keep.txt'), 'keep');
  cleanImages(env.IMAGE_DIR);
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.existsSync(path.join(env.IMAGE_DIR, 'keep.txt')), true);
});

test('bot delivers images, falls back to push after token expiry, handles provider failure', async () => {
  const { createBot } = require('../src/bot');
  let replies = 0, pushes = 0;
  const client = {
    getProfile: async () => ({ displayName: 'Test' }),
    replyMessage: async () => { replies++; throw new Error('expired'); },
    pushMessage: async ({ messages }) => { pushes++; assert.equal(messages[1].type, 'image'); },
  };
  const image = { type: 'image', originalContentUrl: 'https://example.com/a.jpg', previewImageUrl: 'https://example.com/b.jpg' };
  const bot = createBot({ client, db, env, ai: {}, media: {}, images: { generate: async () => ({ status: 'generated', message: image }) } });
  const event = { type: 'message', replyToken: 'test', source: { type: 'user', userId: 'bot-user' }, message: { type: 'text', id: 'bot1', text: 'สร้างภาพ ผ้าสีฟ้า' } };
  assert.equal(await bot.handleEvent(event), 'image_generated');
  assert.equal(replies, 1); assert.equal(pushes, 1);
  assert.equal(db.recentMessages('bot-user').at(-1).type, 'generated_image');
  const failedBot = createBot({ client: { ...client, replyMessage: async ({ messages }) => { assert.match(messages[0].text, /ไม่สำเร็จ/); } }, db, env, ai: {}, media: {}, images: { generate: async () => { throw new Error('provider offline'); } } });
  assert.equal(await failedBot.handleEvent({ ...event, message: { ...event.message, id: 'bot2' } }), 'image_error');
});
