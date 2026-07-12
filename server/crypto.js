const crypto = require('crypto');
const ALGO = 'aes-256-gcm';
const KEY = crypto.scryptSync(process.env.VORTEX_SECRET || 'vortex-default-key-change-me', 'vortex-salt', 32);

function encrypt(buffer) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGO, KEY, iv);
  const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]);
}

function decrypt(buffer) {
  const iv = buffer.subarray(0, 16);
  const tag = buffer.subarray(16, 32);
  const data = buffer.subarray(32);
  const decipher = crypto.createDecipheriv(ALGO, KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

module.exports = { encrypt, decrypt };
