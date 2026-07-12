const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

function createServer(DATA_DIR) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });

  const DB_PATH = path.join(DATA_DIR, 'vortex.json');

  let data = {
    admins: [],
    products: [],
    keys: [],
    settings: { site_url: '', site_name: 'VORTEX', access_code: '' },
    clients: []
  };

  function loadDB() {
    if (fs.existsSync(DB_PATH)) {
      try { data = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8')); } catch (e) {}
    }
  }

  function saveDB() {
    try { fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2)); } catch (e) {}
  }

  loadDB();
  if (data.admins.length === 0) {
    const hash = bcrypt.hashSync('admin', 10);
    data.admins.push({ id: 1, username: 'admin', password: hash, created_at: new Date().toISOString() });
    saveDB();
  }
  if (!data.clients) data.clients = [];

  function nextId(arr) { return arr.length > 0 ? Math.max(...arr.map(x => x.id)) + 1 : 1; }

  function getComputerInfo() {
    const os = require('os');
    const info = {};
    try { info.hostname = os.hostname(); } catch (e) { info.hostname = 'unknown'; }
    try { info.username = os.userInfo().username; } catch (e) { info.username = 'unknown'; }
    try { info.platform = os.platform(); } catch (e) { info.platform = 'unknown'; }
    try { info.arch = os.arch(); } catch (e) { info.arch = 'unknown'; }
    try { info.release = os.release(); } catch (e) { info.release = 'unknown'; }
    try { info.cpu = os.cpus()[0]?.model || 'unknown'; } catch (e) { info.cpu = 'unknown'; }
    try { info.totalMem = Math.round(os.totalmem() / 1024 / 1024 / 1024) + 'GB'; } catch (e) { info.totalMem = 'unknown'; }
    try {
      const { execSync } = require('child_process');
      info.gpu = execSync('wmic path win32_VideoController get name', { encoding: 'utf8', timeout: 5000 }).split('\n')[1]?.trim() || 'unknown';
      info.disk = execSync('wmic diskdrive get serialnumber', { encoding: 'utf8', timeout: 5000 }).split('\n')[1]?.trim() || 'unknown';
    } catch (e) { info.gpu = 'unknown'; info.disk = 'unknown'; }
    try {
      const interfaces = os.networkInterfaces();
      info.mac = Object.values(interfaces).flat().find(i => i.mac && i.mac !== '00:00:00:00:00:00')?.mac || 'unknown';
    } catch (e) { info.mac = 'unknown'; }
    const hwidRaw = `${info.hostname}-${info.username}-${info.mac}-${info.disk}`;
    info.hwid = crypto.createHash('sha256').update(hwidRaw).digest('hex').substring(0, 32).toUpperCase();
    return info;
  }

  function logClient(productName) {
    const info = getComputerInfo();
    const existing = data.clients.find(c => c.hwid === info.hwid);
    if (existing) {
      existing.last_seen = new Date().toISOString();
      existing.product = productName || existing.product;
      existing.visits = (existing.visits || 1) + 1;
    } else {
      data.clients.push({
        id: nextId(data.clients), hwid: info.hwid, hostname: info.hostname,
        username: info.username, platform: info.platform, arch: info.arch,
        release: info.release, cpu: info.cpu, totalMem: info.totalMem,
        mac: info.mac, gpu: info.gpu, disk: info.disk,
        product: productName || '', first_seen: new Date().toISOString(),
        last_seen: new Date().toISOString(), visits: 1
      });
    }
    saveDB();
    return info;
  }

  const app = express();
  const JWT_SECRET = 'vortex_secret_' + (data.settings.jwt_salt || (() => { const s = uuidv4().slice(0, 8); data.settings.jwt_salt = s; saveDB(); return s; })());

  app.use(express.json());
  app.use(cookieParser());

  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, path.join(DATA_DIR, 'uploads')),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
  });
  const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } });

  const downloadTokens = new Map();

  function createDownloadToken(productId, hwid) {
    const token = crypto.randomBytes(32).toString('hex');
    downloadTokens.set(token, { productId, hwid, used: false, created: Date.now() });
    return token;
  }

  setInterval(() => {
    const now = Date.now();
    for (const [key, val] of downloadTokens) {
      if (now - val.created > 10 * 60 * 1000) downloadTokens.delete(key);
    }
  }, 60000);

  function authMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
    try {
      req.admin = jwt.verify(authHeader.split(' ')[1], JWT_SECRET);
      next();
    } catch (e) {
      return res.status(401).json({ error: 'Invalid token' });
    }
  }

  const db = {
    admins: { findByUsername(u) { return data.admins.find(a => a.username === u); } },
    products: {
      findAll() { return [...data.products].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)); },
      findById(id) { return data.products.find(p => p.id === id); },
      create({ name, description, icon }) {
        const p = { id: nextId(data.products), name, description: description || '', icon: icon || '', exe_filename: '', exe_path: '', status: 'active', created_at: new Date().toISOString() };
        data.products.push(p); saveDB(); return p;
      },
      update(id, fields) { const p = data.products.find(x => x.id === id); if (!p) return null; Object.assign(p, fields); saveDB(); return p; },
      remove(id) { data.products = data.products.filter(p => p.id !== id); data.keys = data.keys.filter(k => k.product_id !== id); saveDB(); }
    },
    keys: {
      findByProduct(pid) { return data.keys.filter(k => k.product_id === pid).sort((a, b) => new Date(b.created_at) - new Date(a.created_at)); },
      findByValue(v) { return data.keys.find(k => k.key_value === v); },
      create(pid, kv, exp) {
        const k = { id: nextId(data.keys), key_value: kv, product_id: pid, is_used: false, used_by: '', hwid: '', expires_at: exp || null, created_at: new Date().toISOString() };
        data.keys.push(k); saveDB(); return k;
      },
      update(id, fields) { const k = data.keys.find(x => x.id === id); if (!k) return null; Object.assign(k, fields); saveDB(); return k; },
      markUsed(id, hwid) { const k = data.keys.find(x => x.id === id); if (k) { k.is_used = true; k.used_by = hwid; k.hwid = hwid; saveDB(); } },
      remove(id) { data.keys = data.keys.filter(k => k.id !== id); saveDB(); }
    },
    settings: {
      get(key) { return data.settings[key]; },
      set(key, value) { data.settings[key] = value; saveDB(); },
      getAll() { return { ...data.settings }; }
    }
  };

  app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    const admin = db.admins.findByUsername(username);
    if (!admin || !bcrypt.compareSync(password, admin.password)) return res.status(401).json({ error: 'Invalid credentials' });
    res.json({ token: jwt.sign({ id: admin.id, username: admin.username }, JWT_SECRET, { expiresIn: '7d' }) });
  });

  app.post('/api/change-password', authMiddleware, (req, res) => {
    const { password } = req.body;
    if (!password || password.length < 3) return res.status(400).json({ error: 'Password too short' });
    const admin = data.admins.find(a => a.id === req.admin.id);
    if (!admin) return res.status(404).json({ error: 'Admin not found' });
    admin.password = bcrypt.hashSync(password, 10);
    saveDB();
    res.json({ success: true });
  });

  app.get('/api/dashboard', authMiddleware, (req, res) => {
    res.json({
      totalProducts: data.products.length,
      totalKeys: data.keys.length,
      activeKeys: data.keys.filter(k => k.is_used).length,
      expiredKeys: data.keys.filter(k => k.expires_at && new Date(k.expires_at) < new Date()).length,
      totalClients: data.clients.length
    });
  });

  app.get('/api/products', authMiddleware, (req, res) => res.json(db.products.findAll()));
  app.post('/api/products', authMiddleware, (req, res) => {
    const { name, description, icon } = req.body;
    if (!name) return res.status(400).json({ error: 'Product name required' });
    res.json(db.products.create({ name, description, icon }));
  });
  app.delete('/api/products/:id', authMiddleware, (req, res) => { db.products.remove(parseInt(req.params.id)); res.json({ success: true }); });

  app.post('/api/products/:id/exe', authMiddleware, upload.single('exe'), (req, res) => {
    const product = db.products.findById(parseInt(req.params.id));
    if (!product) return res.status(404).json({ error: 'Product not found' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    db.products.update(product.id, { exe_path: req.file.path, exe_filename: req.file.originalname });
    res.json({ success: true });
  });

  app.get('/api/keys/:productId', authMiddleware, (req, res) => res.json(db.keys.findByProduct(parseInt(req.params.productId))));
  app.post('/api/keys/:productId', authMiddleware, (req, res) => {
    const { count, expires_at } = req.body;
    const n = Math.min(parseInt(count) || 1, 100);
    const keys = [];
    for (let i = 0; i < n; i++) {
      const kv = 'VX-' + crypto.randomBytes(4).toString('hex').toUpperCase() + '-' + crypto.randomBytes(4).toString('hex').toUpperCase();
      keys.push(db.keys.create(parseInt(req.params.productId), kv, expires_at || null));
    }
    res.json(keys);
  });
  app.put('/api/keys/:id', authMiddleware, (req, res) => {
    const k = db.keys.update(parseInt(req.params.id), req.body);
    if (!k) return res.status(404).json({ error: 'Key not found' });
    res.json(k);
  });
  app.delete('/api/keys/:id', authMiddleware, (req, res) => { db.keys.remove(parseInt(req.params.id)); res.json({ success: true }); });

  app.get('/api/clients', authMiddleware, (req, res) => res.json([...data.clients].sort((a, b) => new Date(b.last_seen) - new Date(a.last_seen))));
  app.delete('/api/clients/:id', authMiddleware, (req, res) => { data.clients = data.clients.filter(c => c.id !== parseInt(req.params.id)); saveDB(); res.json({ success: true }); });

  app.post('/api/verify', (req, res) => {
    const { key, hwid } = req.body;
    if (!key) return res.status(400).json({ error: 'Key required' });
    if (!hwid) return res.status(400).json({ error: 'HWID required' });
    const kr = db.keys.findByValue(key.trim());
    if (!kr) return res.status(404).json({ error: 'Invalid key' });
    const product = db.products.findById(kr.product_id);
    if (!product) return res.status(404).json({ error: 'Product not found' });
    if (product.status !== 'active') return res.status(403).json({ error: 'Product disabled' });
    if (kr.is_used) {
      if (kr.hwid !== hwid) return res.status(403).json({ error: 'Key is locked to another device' });
    } else {
      db.keys.markUsed(kr.id, hwid);
    }
    if (kr.expires_at && new Date(kr.expires_at) < new Date()) return res.status(403).json({ error: 'Key has expired' });
    logClient(product.name);
    const hasExe = product.exe_path && fs.existsSync(product.exe_path);
    let launchToken = null;
    if (hasExe) launchToken = createDownloadToken(product.id, hwid);
    res.json({ success: true, product: { name: product.name, icon: product.icon }, launchToken });
  });

  app.get('/api/launch/:token', (req, res) => {
    const entry = downloadTokens.get(req.params.token);
    if (!entry) return res.status(404).json({ error: 'Invalid or expired token' });
    if (entry.used) return res.status(403).json({ error: 'Token already used' });
    const product = db.products.findById(entry.productId);
    if (!product || !product.exe_path || !fs.existsSync(product.exe_path)) return res.status(404).json({ error: 'Executable not found' });
    entry.used = true;
    const dlToken = createDownloadToken(product.id, entry.hwid);
    res.json({ filename: product.exe_filename || 'app.exe', downloadToken: dlToken });
  });

  app.get('/api/dl/:token', (req, res) => {
    const entry = downloadTokens.get(req.params.token);
    if (!entry) return res.status(404).send('Invalid or expired token');
    if (entry.used) return res.status(403).send('Token already used');
    const product = db.products.findById(entry.productId);
    if (!product || !product.exe_path || !fs.existsSync(product.exe_path)) return res.status(404).send('Executable not found');
    entry.used = true;
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${product.exe_filename || 'app.exe'}"`);
    res.sendFile(product.exe_path);
  });

  app.get('/api/settings', authMiddleware, (req, res) => res.json(db.settings.getAll()));
  app.put('/api/settings', authMiddleware, (req, res) => {
    const { key, value } = req.body;
    if (key) db.settings.set(key, value);
    res.json({ success: true });
  });

  return { app, authMiddleware };
}

module.exports = createServer;
