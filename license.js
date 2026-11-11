/**
 * 授权码：签名码 + 用量记录
 * ------------------------------------------------------------
 * 为什么这么做：
 *   云主机免费版每次重启会清空文件。如果码存在文件里，
 *   一重启客户手里的码就全废了。
 *   签名码把"可用次数"写进码本身并用密码签名，
 *   服务器重启、换机器、换平台，码都还有效。
 *
 * 码的样子：K7M2Q-9XAF3（10 位，去掉了 I O 0 1 这类易混字符）
 */

const crypto = require('crypto');

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const SECRET = process.env.LICENSE_SECRET || process.env.ADMIN_TOKEN || 'rd-default-secret-please-change';

function base32(buf){
  let bits = 0, value = 0, out = '';
  for (const b of buf){
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5){
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function unbase32(str){
  const out = [];
  let bits = 0, value = 0;
  for (const ch of str.toUpperCase()){
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) return null;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8){
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 生成一个码：quota = 可用次数（1~255） */
function makeCode(quota){
  quota = Math.max(1, Math.min(255, parseInt(quota || 1, 10)));
  const payload = Buffer.from([quota, crypto.randomInt(0, 256), crypto.randomInt(0, 256)]);
  const mac = crypto.createHmac('sha256', SECRET).update(payload).digest().subarray(0, 3);
  const s = base32(Buffer.concat([payload, mac])).slice(0, 10);
  return s.slice(0, 5) + '-' + s.slice(5);
}

/** 校验一个码：只验真假和次数上限，用量另外记 */
function checkCode(code){
  const clean = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (clean.length !== 10) return { ok: false, reason: '激活码格式不对，应该是 5 位-5 位' };
  const raw = unbase32(clean);
  if (!raw || raw.length < 6) return { ok: false, reason: '激活码格式不对' };
  const payload = raw.subarray(0, 3);
  const mac = raw.subarray(3, 6);
  const want = crypto.createHmac('sha256', SECRET).update(payload).digest().subarray(0, 3);
  if (!crypto.timingSafeEqual(mac, want)) return { ok: false, reason: '激活码无效' };
  return { ok: true, quota: payload[0] };
}

module.exports = { makeCode, checkCode };
