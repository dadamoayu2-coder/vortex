const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { encrypt } = require('./crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const GITHUB_REPO = process.env.GITHUB_REPO || 'dadamoayu2-coder/vortex';
const PORT = process.env.PORT || 8080;

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'db.json');
let db = { admins: [], products: [], keys: [], clients: [], logs: [], settings: {} };

function load() {
  if (fs.existsSync(DB_PATH)) try { db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); } catch {}
}
function save() { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2)); }
function id(arr) { return arr.length ? Math.max(...arr.map(x => x.id)) + 1 : 1; }
function log(action, detail, ip) {
  db.logs.unshift({ id: id(db.logs), action, detail: detail || '', ip: ip || '', at: new Date().toISOString() });
  if (db.logs.length > 500) db.logs.length = 500;
  save();
}

load();
if (!db.admins.length) {
  db.admins.push({ id: 1, username: 'admin', password: bcrypt.hashSync('admin', 10), created: new Date().toISOString() });
  save();
}
if (!db.clients) db.clients = [];
if (!db.logs) db.logs = [];
if (!db.settings) db.settings = {};

const app = express();
const upload = multer({ dest: path.join(DATA_DIR, 'uploads'), limits: { fileSize: 500 * 1024 * 1024 } });

app.set('trust proxy', 1);
app.use(express.json({ limit: '10mb' }));

function auth(req, res, next) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  try { req.admin = jwt.verify(h.slice(7), JWT_SECRET); next(); } catch { res.status(401).json({ error: 'Invalid token' }); }
}

// ========== DOWNLOAD LAUNCHER ==========

app.get('/api/download', (req, res) => {
  const tag = db.settings.launcher_version || 'v1.0.0';
  const repo = db.settings.github_repo || GITHUB_REPO;
  res.redirect(`https://github.com/${repo}/releases/download/${tag}/VORTEX.exe`);
});

// ========== LICENSE VERIFY (for launcher) ==========

app.post('/api/verify', (req, res) => {
  const { key, hwid } = req.body;
  if (!key || !hwid) return res.status(400).json({ error: 'Key and HWID required' });

  const k = db.keys.find(x => x.value === key.trim());
  if (!k) { log('verify_fail', key, req.ip); return res.status(404).json({ error: 'Invalid key' }); }

  const product = db.products.find(p => p.id === k.product_id);
  if (!product) return res.status(404).json({ error: 'Product not found' });
  if (product.status !== 'active') return res.status(403).json({ error: 'Product disabled' });
  if (k.expires_at && new Date(k.expires_at) < new Date()) return res.status(403).json({ error: 'Key expired' });

  if (k.used && k.hwid !== hwid) {
    log('verify_locked', `${key} locked to ${k.hwid}`, req.ip);
    return res.status(403).json({ error: 'Key locked to another device' });
  }

  if (!k.used) {
    k.used = true;
    k.hwid = hwid;
    save();
    log('key_activate', `${key} → ${product.name} (${hwid})`, req.ip);
  }

  const hasExe = product.exe_path && fs.existsSync(product.exe_path);
  const token = hasExe ? crypto.randomBytes(32).toString('hex') : null;
  if (token) db._tokens = db._tokens || {};
  if (token) db._tokens[token] = { product_id: product.id, hwid, used: false, ts: Date.now() };

  log('verify_ok', `${key} on ${product.name}`, req.ip);

  // Update client
  const existing = db.clients.find(c => c.hwid === hwid);
  const info = { hwid, product: product.name, last_seen: new Date().toISOString() };
  if (existing) { Object.assign(existing, info); existing.visits = (existing.visits || 1) + 1; }
  else db.clients.push({ id: id(db.clients), ...info, first_seen: new Date().toISOString(), visits: 1 });
  save();

  res.json({ success: true, product: { name: product.name, icon: product.icon, version: product.version }, downloadToken: token });
});

app.get('/api/product-dl/:token', (req, res) => {
  const t = (db._tokens || {})[req.params.token];
  if (!t || t.used) return res.status(404).json({ error: 'Invalid token' });
  const product = db.products.find(p => p.id === t.product_id);
  if (!product || !product.exe_path || !fs.existsSync(product.exe_path)) return res.status(404).json({ error: 'File not found' });
  t.used = true; save();

  const raw = fs.readFileSync(product.exe_path);
  const encrypted = encrypt(raw);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${product.name}.vortex"`);
  res.send(encrypted);
  log('product_dl', `${product.name} → ${t.hwid}`, req.ip);
});

// ========== HEARTBEAT ==========

app.post('/api/heartbeat', (req, res) => {
  const { hwid, product } = req.body;
  if (!hwid) return res.status(400).json({ error: 'HWID required' });
  const c = db.clients.find(x => x.hwid === hwid);
  if (c) { c.last_seen = new Date().toISOString(); c.online = true; if (product) c.product = product; save(); }
  res.json({ ok: true, version: db.settings.product_version || '1.0.0' });
});

app.post('/api/offline', (req, res) => {
  const c = db.clients.find(x => x.hwid === req.body.hwid);
  if (c) { c.online = false; save(); }
  res.json({ ok: true });
});

// ========== ADMIN API ==========

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const a = db.admins.find(x => x.username === username);
  if (!a || !bcrypt.compareSync(password, a.password)) { log('login_fail', username, req.ip); return res.status(401).json({ error: 'Invalid credentials' }); }
  log('login', username, req.ip);
  res.json({ token: jwt.sign({ id: a.id, username: a.username }, JWT_SECRET, { expiresIn: '7d' }) });
});

app.get('/api/me', auth, (req, res) => res.json({ ok: true }));

app.get('/api/dashboard', auth, (req, res) => {
  res.json({
    products: db.products.length,
    keys: db.keys.length,
    usedKeys: db.keys.filter(k => k.used).length,
    unusedKeys: db.keys.filter(k => !k.used).length,
    clients: db.clients.length,
    online: db.clients.filter(c => c.online).length,
    logs: db.logs.slice(0, 15)
  });
});

// Products
app.get('/api/products', auth, (req, res) => res.json(db.products.sort((a, b) => b.id - a.id)));
app.post('/api/products', auth, (req, res) => {
  const p = { id: id(db.products), name: req.body.name, description: req.body.description || '', icon: req.body.icon || '', version: req.body.version || '1.0.0', status: 'active', exe: '', exe_name: '', exe_size: 0, created: new Date().toISOString() };
  db.products.push(p); save(); log('product_add', p.name, req.ip); res.json(p);
});
app.put('/api/products/:id', auth, (req, res) => {
  const p = db.products.find(x => x.id === +req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  Object.assign(p, req.body); save(); res.json(p);
});
app.delete('/api/products/:id', auth, (req, res) => {
  const pid = +req.params.id;
  db.products = db.products.filter(p => p.id !== pid);
  db.keys = db.keys.filter(k => k.product_id !== pid);
  save(); log('product_delete', `#${pid}`, req.ip); res.json({ ok: true });
});
app.post('/api/products/:id/exe', auth, upload.single('exe'), (req, res) => {
  const p = db.products.find(x => x.id === +req.params.id);
  if (!p || !req.file) return res.status(404).json({ error: 'Not found' });
  if (p.exe && fs.existsSync(p.exe)) try { fs.unlinkSync(p.exe); } catch {}
  db.products.find(x => x.id === +req.params.id).exe = req.file.path;
  db.products.find(x => x.id === +req.params.id).exe_name = req.file.originalname;
  db.products.find(x => x.id === +req.params.id).exe_size = req.file.size;
  save(); log('exe_upload', `${p.name}: ${req.file.originalname}`, req.ip); res.json({ ok: true });
});

// Keys
app.get('/api/keys', auth, (req, res) => {
  let keys = [...db.keys].sort((a, b) => b.id - a.id);
  if (req.query.search) { const q = req.query.search.toLowerCase(); keys = keys.filter(k => k.value.toLowerCase().includes(q)); }
  if (req.query.product_id) keys = keys.filter(k => k.product_id === +req.query.product_id);
  const page = +req.query.page || 1, limit = +req.query.limit || 50;
  res.json({ keys: keys.slice((page - 1) * limit, page * limit), total: keys.length, page, pages: Math.ceil(keys.length / limit) });
});
app.post('/api/keys', auth, (req, res) => {
  const { product_id, count, prefix, expires_at } = req.body;
  const n = Math.min(+count || 1, 100), pre = prefix || 'VX';
  const newKeys = [];
  for (let i = 0; i < n; i++) {
    const v = `${pre}-${crypto.randomBytes(4).toString('hex').toUpperCase()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    const k = { id: id(db.keys), value: v, product_id: +product_id, used: false, hwid: '', expires_at: expires_at || null, created: new Date().toISOString() };
    db.keys.push(k); newKeys.push(k);
  }
  save(); log('keys_gen', `${n} keys for #${product_id}`, req.ip); res.json(newKeys);
});
app.put('/api/keys/:id', auth, (req, res) => {
  const k = db.keys.find(x => x.id === +req.params.id);
  if (!k) return res.status(404).json({ error: 'Not found' });
  Object.assign(k, req.body); save(); res.json(k);
});
app.delete('/api/keys/:id', auth, (req, res) => {
  db.keys = db.keys.filter(k => k.id !== +req.params.id); save(); res.json({ ok: true });
});
app.post('/api/keys/:id/reset', auth, (req, res) => {
  const k = db.keys.find(x => x.id === +req.params.id);
  if (!k) return res.status(404).json({ error: 'Not found' });
  k.used = false; k.hwid = ''; save(); log('key_reset', k.value, req.ip); res.json(k);
});

// Clients
app.get('/api/clients', auth, (req, res) => res.json(db.clients.sort((a, b) => new Date(b.last_seen) - new Date(a.last_seen))));
app.delete('/api/clients/:id', auth, (req, res) => {
  db.clients = db.clients.filter(c => c.id !== +req.params.id); save(); res.json({ ok: true });
});

// Logs
app.get('/api/logs', auth, (req, res) => {
  const page = +req.query.page || 1, limit = +req.query.limit || 50;
  res.json({ logs: db.logs.slice((page - 1) * limit, page * limit), total: db.logs.length, page, pages: Math.ceil(db.logs.length / limit) });
});

// Settings
app.get('/api/settings', auth, (req, res) => res.json(db.settings));
app.put('/api/settings', auth, (req, res) => {
  const { key, value } = req.body;
  if (key) { db.settings[key] = value; save(); }
  res.json({ ok: true });
});

// Password
app.post('/api/password', auth, (req, res) => {
  const { current, password } = req.body;
  if (!password || password.length < 3) return res.status(400).json({ error: 'Too short' });
  const a = db.admins.find(x => x.id === req.admin.id);
  if (!a) return res.status(404).json({ error: 'Not found' });
  if (current && !bcrypt.compareSync(current, a.password)) return res.status(403).json({ error: 'Wrong current password' });
  a.password = bcrypt.hashSync(password, 10); save(); log('password_change', a.username, req.ip); res.json({ ok: true });
});

// ========== STATIC ==========

app.get('/', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'verify.html')));
app.get('/panel', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'admin.html')));
app.use(express.static(path.join(__dirname, '..', 'public')));

// Cleanup tokens
setInterval(() => {
  if (!db._tokens) return;
  const now = Date.now();
  for (const [k, v] of Object.entries(db._tokens)) { if (now - v.ts > 600000) delete db._tokens[k]; }
}, 60000);

app.listen(PORT, '0.0.0.0', () => console.log(`VORTEX on :${PORT} | /panel = admin | / = verify`));
