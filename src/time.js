// dayjs ตั้งค่า timezone ไทย + ภาษาไทย ใช้ร่วมกันทั้งโปรเจค (แพทเทิร์นเดียวกับ nailaoma)
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
require('dayjs/locale/th');

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.tz.setDefault('Asia/Bangkok');
dayjs.locale('th');

module.exports = dayjs;
