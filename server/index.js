const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const AdmZip = require('adm-zip');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const PORT = process.env.PORT || 8080;

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'products'), { recursive: true });

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
if (!db.jwt_secret) { db.jwt_secret = crypto.randomBytes(32).toString('hex'); save(); }
const JWT_SECRET = process.env.JWT_SECRET || db.jwt_secret;
if (!db.admins.length) {
  db.admins.push({ id: 1, username: 'admin', password: bcrypt.hashSync('admin', 10), created: new Date().toISOString() });
  save();
}
if (!db.clients) db.clients = [];
if (!db.logs) db.logs = [];
if (!db.settings) db.settings = {};
if (!db._tokens) db._tokens = {};

const app = express();
const upload = multer({ dest: path.join(DATA_DIR, 'uploads'), limits: { fileSize: 500 * 1024 * 1024 } });

app.set('trust proxy', 1);
app.use(express.json({ limit: '10mb' }));

function auth(req, res, next) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  try { req.admin = jwt.verify(h.slice(7), JWT_SECRET); next(); } catch { res.status(401).json({ error: 'Invalid token' }); }
}

// ========== LICENSE VERIFY ==========

app.post('/api/verify', (req, res) => {
  const { key, hwid } = req.body;
  if (!key || !hwid) return res.status(400).json({ error: 'Key and HWID required' });
  const k = db.keys.find(x => x.value === key.trim());
  if (!k) { log('verify_fail', key, req.ip); return res.status(404).json({ error: 'Invalid key' }); }
  const product = db.products.find(p => p.id === k.product_id);
  if (!product) return res.status(404).json({ error: 'Product not found' });
  if (product.status !== 'active') return res.status(403).json({ error: 'Product disabled' });
  if (k.expires_at && new Date(k.expires_at) < new Date()) return res.status(403).json({ error: 'Key expired' });
  if (k.used && k.hwid !== hwid) { log('verify_locked', `${key} locked to ${k.hwid}`, req.ip); return res.status(403).json({ error: 'Key locked to another device' }); }
  if (!k.used) { k.used = true; k.hwid = hwid; save(); log('key_activate', `${key} -> ${product.name} (${hwid})`, req.ip); }
  const hasProduct = product.files_dir && fs.existsSync(product.files_dir);
  const token = hasProduct ? crypto.randomBytes(32).toString('hex') : null;
  if (token) db._tokens[token] = { product_id: product.id, hwid, used: false, ts: Date.now() };
  log('verify_ok', `${key} on ${product.name}`, req.ip);
  const existing = db.clients.find(c => c.hwid === hwid);
  const info = { hwid, product: product.name, last_seen: new Date().toISOString() };
  if (existing) { Object.assign(existing, info); existing.visits = (existing.visits || 1) + 1; }
  else db.clients.push({ id: id(db.clients), ...info, first_seen: new Date().toISOString(), visits: 1 });
  save();
  res.json({ success: true, product: { name: product.name, icon: product.icon, version: product.version }, runToken: token });
});

// Product run - serves index.html (token protected)
app.get('/api/run/:token', (req, res) => {
  const t = db._tokens[req.params.token];
  if (!t) return res.status(404).send('Invalid or expired token');
  const product = db.products.find(p => p.id === t.product_id);
  if (!product || !product.files_dir || !fs.existsSync(product.files_dir)) return res.status(404).send('Product not found');
  const indexPath = path.join(product.files_dir, 'index.html');
  if (!fs.existsSync(indexPath)) return res.status(404).send('Product index.html not found');
  log('product_run', `${product.name} -> ${t.hwid}`, req.ip);
  res.sendFile(indexPath);
});

// Product static files (token protected)
app.get('/api/run/:token/*', (req, res) => {
  const t = db._tokens[req.params.token];
  if (!t) return res.status(404).send('Invalid or expired token');
  const product = db.products.find(p => p.id === t.product_id);
  if (!product || !product.files_dir || !fs.existsSync(product.files_dir)) return res.status(404).send('Product not found');
  const filePath = path.join(product.files_dir, req.params[0]);
  if (!filePath.startsWith(product.files_dir)) return res.status(403).send('Forbidden');
  if (!fs.existsSync(filePath)) return res.status(404).send('File not found');
  res.sendFile(filePath);
});

// ========== AUTH ==========

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const a = db.admins.find(x => x.username === username);
  if (!a || !bcrypt.compareSync(password, a.password)) { log('login_fail', username, req.ip); return res.status(401).json({ error: 'Invalid credentials' }); }
  log('login', username, req.ip);
  res.json({ token: jwt.sign({ id: a.id, username: a.username }, JWT_SECRET, { expiresIn: '7d' }) });
});

app.get('/api/me', auth, (req, res) => res.json({ ok: true }));

// ========== DASHBOARD ==========

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

// ========== PRODUCTS ==========

app.get('/api/products', auth, (req, res) => res.json(db.products.sort((a, b) => b.id - a.id)));
app.post('/api/products', auth, (req, res) => {
  const p = { id: id(db.products), name: req.body.name, description: req.body.description || '', icon: req.body.icon || '', version: req.body.version || '1.0.0', status: 'active', files_dir: '', files_name: '', files_size: 0, created: new Date().toISOString() };
  db.products.push(p); save(); log('product_add', p.name, req.ip); res.json(p);
});
app.put('/api/products/:id', auth, (req, res) => {
  const p = db.products.find(x => x.id === +req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  Object.assign(p, req.body); save(); res.json(p);
});
app.delete('/api/products/:id', auth, (req, res) => {
  const pid = +req.params.id;
  const p = db.products.find(x => x.id === pid);
  if (p && p.files_dir && fs.existsSync(p.files_dir)) try { fs.rmSync(p.files_dir, { recursive: true }); } catch {}
  db.products = db.products.filter(x => x.id !== pid);
  db.keys = db.keys.filter(k => k.product_id !== pid);
  save(); log('product_delete', `#${pid}`, req.ip); res.json({ ok: true });
});

// Upload product files (zip containing web app)
app.post('/api/products/:id/files', auth, upload.single('file'), (req, res) => {
  const p = db.products.find(x => x.id === +req.params.id);
  if (!p || !req.file) return res.status(404).json({ error: 'Not found' });
  try {
    if (p.files_dir && fs.existsSync(p.files_dir)) fs.rmSync(p.files_dir, { recursive: true });
    const extractDir = path.join(DATA_DIR, 'products', String(p.id));
    fs.mkdirSync(extractDir, { recursive: true });
    const zip = new AdmZip(req.file.path);
    zip.extractAllTo(extractDir, true);
    try { fs.unlinkSync(req.file.path); } catch {}
    p.files_dir = extractDir;
    p.files_name = req.file.originalname;
    p.files_size = req.file.size;
    save(); log('files_upload', `${p.name}: ${req.file.originalname}`, req.ip); res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: 'Invalid zip file: ' + err.message }); }
});

// ========== KEYS ==========

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

// ========== CLIENTS ==========

app.get('/api/clients', auth, (req, res) => res.json(db.clients.sort((a, b) => new Date(b.last_seen) - new Date(a.last_seen))));
app.delete('/api/clients/:id', auth, (req, res) => {
  db.clients = db.clients.filter(c => c.id !== +req.params.id); save(); res.json({ ok: true });
});

// ========== LOGS ==========

app.get('/api/logs', auth, (req, res) => {
  const page = +req.query.page || 1, limit = +req.query.limit || 50;
  res.json({ logs: db.logs.slice((page - 1) * limit, page * limit), total: db.logs.length, page, pages: Math.ceil(db.logs.length / limit) });
});

// ========== SETTINGS ==========

app.get('/api/settings', auth, (req, res) => res.json(db.settings));
app.put('/api/settings', auth, (req, res) => {
  const { key, value } = req.body;
  if (key) { db.settings[key] = value; save(); }
  res.json({ ok: true });
});
app.post('/api/password', auth, (req, res) => {
  const { current, password } = req.body;
  if (!password || password.length < 3) return res.status(400).json({ error: 'Too short' });
  const a = db.admins.find(x => x.id === req.admin.id);
  if (!a) return res.status(404).json({ error: 'Not found' });
  if (current && !bcrypt.compareSync(current, a.password)) return res.status(403).json({ error: 'Wrong current password' });
  a.password = bcrypt.hashSync(password, 10); save(); log('password_change', a.username, req.ip); res.json({ ok: true });
});

// Cleanup tokens
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of Object.entries(db._tokens)) { if (now - v.ts > 600000) delete db._tokens[k]; }
}, 60000);

// ========== STATIC ==========

app.get('/', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'admin.html')));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.listen(PORT, '0.0.0.0', () => console.log(`VORTEX Panel on :${PORT}`));
