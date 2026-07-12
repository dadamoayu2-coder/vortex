const crypto = require('crypto');
const ALGO = 'aes-256-gcm';
const KEY_LEN = 32, IV_LEN = 16, TAG_LEN = 16;

function key(secret) {
  return crypto.scryptSync(secret || process.env.VORTEX_SECRET || 'vortex-secret', 'vortex-salt', KEY_LEN);
}

function encrypt(buf, secret) {
  const iv = crypto.randomBytes(IV_LEN);
  const c = crypto.createCipheriv(ALGO, key(secret), iv, { authTagLength: TAG_LEN });
  return Buffer.concat([iv, c.getAuthTag(), c.update(buf), c.final()]);
}

function decrypt(buf, secret) {
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const d = crypto.createDecipheriv(ALGO, key(secret), iv, { authTagLength: TAG_LEN });
  d.setAuthTag(tag);
  return Buffer.concat([d.update(buf.subarray(IV_LEN + TAG_LEN)), d.final()]);
}

module.exports = { encrypt, decrypt };
