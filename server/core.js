const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { encrypt, decrypt, getSecret } = require('./crypto');

const APP_VERSION = '1.1.0';

function createServer(DATA_DIR) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });

  const DB_PATH = path.join(DATA_DIR, 'vortex.json');

  let data = {
    admins: [],
    products: [],
    keys: [],
    settings: { site_url: '', site_name: 'VORTEX', access_code: '', product_version: '1.0.0' },
    clients: [],
    logs: []
  };

  function loadDB() {
    if (fs.existsSync(DB_PATH)) {
      try { data = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8')); } catch (e) {}
    }
  }

  function saveDB() {
    try { fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2)); } catch (e) {}
  }

  function addLog(action, detail, ip) {
    data.logs.unshift({
      id: nextId(data.logs),
      action,
      detail: detail || '',
      ip: ip || '',
      created_at: new Date().toISOString()
    });
    if (data.logs.length > 500) data.logs.length = 500;
    saveDB();
  }

  loadDB();
  if (data.admins.length === 0) {
    const hash = bcrypt.hashSync('admin', 10);
    data.admins.push({ id: 1, username: 'admin', password: hash, created_at: new Date().toISOString() });
    saveDB();
  }
  if (!data.clients) data.clients = [];
  if (!data.logs) data.logs = [];
  if (!data.settings.product_version) data.settings.product_version = '1.0.0';

  function nextId(arr) { return arr.length > 0 ? Math.max(...arr.map(x => x.id || 0)) + 1 : 1; }

  function getClientHWID(req) {
    const info = {};
    try {
      const os = require('os');
      info.hostname = os.hostname();
      info.username = os.userInfo().username;
      info.platform = os.platform();
      info.arch = os.arch();
      info.release = os.release();
      info.cpu = os.cpus()[0]?.model || 'unknown';
      info.totalMem = Math.round(os.totalmem() / 1024 / 1024 / 1024) + 'GB';
      try {
        const { execSync } = require('child_process');
        info.gpu = execSync('wmic path win32_VideoController get name', { encoding: 'utf8', timeout: 5000 }).split('\n')[1]?.trim() || 'unknown';
        info.disk = execSync('wmic diskdrive get serialnumber', { encoding: 'utf8', timeout: 5000 }).split('\n')[1]?.trim() || 'unknown';
      } catch (e) { info.gpu = 'unknown'; info.disk = 'unknown'; }
      const interfaces = os.networkInterfaces();
      info.mac = Object.values(interfaces).flat().find(i => i.mac && i.mac !== '00:00:00:00:00:00')?.mac || 'unknown';
    } catch (e) {}
    return info;
  }

  function logClient(hwid, productName, clientInfo) {
    const info = clientInfo || {};
    const existing = data.clients.find(c => c.hwid === hwid);
    if (existing) {
      existing.last_seen = new Date().toISOString();
      existing.product = productName || existing.product;
      existing.visits = (existing.visits || 1) + 1;
      Object.assign(existing, info);
    } else {
      data.clients.push({
        id: nextId(data.clients), hwid,
        hostname: info.hostname || 'unknown',
        username: info.username || 'unknown',
        platform: info.platform || 'unknown',
        arch: info.arch || 'unknown',
        release: info.release || 'unknown',
        cpu: info.cpu || 'unknown',
        totalMem: info.totalMem || 'unknown',
        mac: info.mac || 'unknown',
        gpu: info.gpu || 'unknown',
        disk: info.disk || 'unknown',
        product: productName || '',
        first_seen: new Date().toISOString(),
        last_seen: new Date().toISOString(),
        visits: 1,
        online: true
      });
    }
    saveDB();
  }

  const app = express();
  const JWT_SECRET = process.env.JWT_SECRET || ('vortex_secret_' + (data.settings.jwt_salt || (() => { const s = uuidv4().slice(0, 8); data.settings.jwt_salt = s; saveDB(); return s; })()));

  app.set('trust proxy', 1);
  app.use(express.json({ limit: '10mb' }));
  app.use(cookieParser());

  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, path.join(DATA_DIR, 'uploads')),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${file.originalname}`)
  });
  const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } });

  const downloadTokens = new Map();
  const onlineClients = new Map();

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
    for (const [hwid, info] of onlineClients) {
      if (now - info.lastHeartbeat > 60000) {
        onlineClients.delete(hwid);
        const client = data.clients.find(c => c.hwid === hwid);
        if (client) client.online = false;
      }
    }
  }, 10000);

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
    admins: {
      findByUsername(u) { return data.admins.find(a => a.username === u); },
      findById(id) { return data.admins.find(a => a.id === id); }
    },
    products: {
      findAll() { return [...data.products].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)); },
      findById(id) { return data.products.find(p => p.id === id); },
      create({ name, description, icon, version }) {
        const p = {
          id: nextId(data.products), name, description: description || '', icon: icon || '',
          version: version || '1.0.0', exe_filename: '', exe_path: '', exe_size: 0,
          status: 'active', created_at: new Date().toISOString()
        };
        data.products.push(p); saveDB(); return p;
      },
      update(id, fields) {
        const p = data.products.find(x => x.id === id);
        if (!p) return null;
        Object.assign(p, fields); saveDB(); return p;
      },
      remove(id) {
        const product = data.products.find(p => p.id === id);
        if (product && product.exe_path && fs.existsSync(product.exe_path)) {
          try { fs.unlinkSync(product.exe_path); } catch (e) {}
        }
        data.products = data.products.filter(p => p.id !== id);
        data.keys = data.keys.filter(k => k.product_id !== id);
        saveDB();
      }
    },
    keys: {
      findByProduct(pid) { return data.keys.filter(k => k.product_id === pid).sort((a, b) => new Date(b.created_at) - new Date(a.created_at)); },
      findByValue(v) { return data.keys.find(k => k.key_value === v); },
      findAll() { return [...data.keys].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)); },
      search(query) {
        const q = query.toLowerCase();
        return data.keys.filter(k => k.key_value.toLowerCase().includes(q)).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      },
      create(pid, kv, exp) {
        const k = {
          id: nextId(data.keys), key_value: kv, product_id: pid,
          is_used: false, used_by: '', hwid: '',
          expires_at: exp || null,
          created_at: new Date().toISOString()
        };
        data.keys.push(k); saveDB(); return k;
      },
      update(id, fields) {
        const k = data.keys.find(x => x.id === id);
        if (!k) return null;
        Object.assign(k, fields); saveDB(); return k;
      },
      markUsed(id, hwid) {
        const k = data.keys.find(x => x.id === id);
        if (k) { k.is_used = true; k.used_by = hwid; k.hwid = hwid; saveDB(); }
      },
      remove(id) { data.keys = data.keys.filter(k => k.id !== id); saveDB(); }
    },
    settings: {
      get(key) { return data.settings[key]; },
      set(key, value) { data.settings[key] = value; saveDB(); },
      getAll() { return { ...data.settings }; }
    }
  };

  // ==================== PUBLIC API ====================

  app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    const admin = db.admins.findByUsername(username);
    if (!admin || !bcrypt.compareSync(password, admin.password)) {
      addLog('login_failed', username, req.ip);
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    addLog('login', username, req.ip);
    res.json({ token: jwt.sign({ id: admin.id, username: admin.username }, JWT_SECRET, { expiresIn: '7d' }) });
  });

  app.get('/api/version', (req, res) => {
    res.json({ version: APP_VERSION, productVersion: data.settings.product_version || '1.0.0' });
  });

  app.get('/api/download-url', (req, res) => {
    const repo = data.settings.github_repo || 'dadamoayu2-coder/vortex';
    const tag = data.settings.launcher_version || 'v1.0.0';
    res.json({
      repo,
      tag,
      url: `https://github.com/${repo}/releases/download/${tag}/VORTEX.exe`
    });
  });

  app.post('/api/verify', (req, res) => {
    const { key, hwid, clientInfo } = req.body;
    if (!key) return res.status(400).json({ error: 'Key required' });
    if (!hwid) return res.status(400).json({ error: 'HWID required' });

    const kr = db.keys.findByValue(key.trim());
    if (!kr) {
      addLog('verify_failed', `Invalid key: ${key}`, req.ip);
      return res.status(404).json({ error: 'Invalid key' });
    }

    const product = db.products.findById(kr.product_id);
    if (!product) return res.status(404).json({ error: 'Product not found' });
    if (product.status !== 'active') return res.status(403).json({ error: 'Product disabled' });

    if (kr.is_used) {
      if (kr.hwid !== hwid) {
        addLog('verify_locked', `Key ${key} locked to ${kr.hwid}, got ${hwid}`, req.ip);
        return res.status(403).json({ error: 'Key is locked to another device' });
      }
    } else {
      db.keys.markUsed(kr.id, hwid);
      addLog('key_activated', `${key} on ${hwid}`, req.ip);
    }

    if (kr.expires_at && new Date(kr.expires_at) < new Date()) {
      return res.status(403).json({ error: 'Key has expired' });
    }

    logClient(hwid, product.name, clientInfo);
    const hasExe = product.exe_path && fs.existsSync(product.exe_path);
    let downloadToken = null;
    if (hasExe) downloadToken = createDownloadToken(product.id, hwid);

    addLog('verify_success', `${key} → ${product.name} (${hwid})`, req.ip);

    res.json({
      success: true,
      product: { name: product.name, icon: product.icon, version: product.version },
      downloadToken
    });
  });

  app.post('/api/heartbeat', (req, res) => {
    const { hwid, product } = req.body;
    if (!hwid) return res.status(400).json({ error: 'HWID required' });

    onlineClients.set(hwid, { lastHeartbeat: Date.now(), product: product || '' });
    const client = data.clients.find(c => c.hwid === hwid);
    if (client) {
      client.last_seen = new Date().toISOString();
      client.online = true;
      if (product) client.product = product;
      client.visits = (client.visits || 1) + 1;
      saveDB();
    }

    const latestVersion = data.settings.product_version || '1.0.0';
    res.json({ success: true, serverTime: Date.now(), productVersion: latestVersion });
  });

  app.post('/api/client-offline', (req, res) => {
    const { hwid } = req.body;
    if (hwid) {
      onlineClients.delete(hwid);
      const client = data.clients.find(c => c.hwid === hwid);
      if (client) client.online = false;
      saveDB();
    }
    res.json({ success: true });
  });

  app.get('/api/product-download/:token', (req, res) => {
    const entry = downloadTokens.get(req.params.token);
    if (!entry) return res.status(404).json({ error: 'Invalid or expired token' });
    if (entry.used) return res.status(403).json({ error: 'Token already used' });

    const product = db.products.findById(entry.productId);
    if (!product || !product.exe_path || !fs.existsSync(product.exe_path)) {
      return res.status(404).json({ error: 'Executable not found' });
    }

    entry.used = true;

    try {
      const rawBuffer = fs.readFileSync(product.exe_path);
      const encrypted = encrypt(rawBuffer, getSecret());

      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${product.exe_filename || 'product'}.vortex"`);
      res.setHeader('X-Product-Name', product.name);
      res.setHeader('X-Product-Version', product.version || '1.0.0');
      res.setHeader('X-Encrypted', 'aes-256-gcm');
      res.send(encrypted);

      addLog('product_downloaded', `${product.name} → ${entry.hwid}`, req.ip);
    } catch (e) {
      res.status(500).json({ error: 'Download failed' });
    }
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

  // ==================== ADMIN API ====================

  app.post('/api/change-password', authMiddleware, (req, res) => {
    const { currentPassword, password } = req.body;
    if (!password || password.length < 3) return res.status(400).json({ error: 'Password too short' });
    const admin = data.admins.find(a => a.id === req.admin.id);
    if (!admin) return res.status(404).json({ error: 'Admin not found' });
    if (currentPassword && !bcrypt.compareSync(currentPassword, admin.password)) {
      return res.status(403).json({ error: 'Current password incorrect' });
    }
    admin.password = bcrypt.hashSync(password, 10);
    saveDB();
    addLog('password_changed', admin.username, req.ip);
    res.json({ success: true });
  });

  app.get('/api/dashboard', authMiddleware, (req, res) => {
    const now = new Date();
    res.json({
      totalProducts: data.products.length,
      totalKeys: data.keys.length,
      activeKeys: data.keys.filter(k => k.is_used).length,
      unusedKeys: data.keys.filter(k => !k.is_used).length,
      expiredKeys: data.keys.filter(k => k.expires_at && new Date(k.expires_at) < now).length,
      totalClients: data.clients.length,
      onlineClients: onlineClients.size,
      recentLogs: data.logs.slice(0, 20)
    });
  });

  app.get('/api/products', authMiddleware, (req, res) => res.json(db.products.findAll()));

  app.post('/api/products', authMiddleware, (req, res) => {
    const { name, description, icon, version } = req.body;
    if (!name) return res.status(400).json({ error: 'Product name required' });
    const product = db.products.create({ name, description, icon, version });
    addLog('product_created', name, req.ip);
    res.json(product);
  });

  app.put('/api/products/:id', authMiddleware, (req, res) => {
    const p = db.products.update(parseInt(req.params.id), req.body);
    if (!p) return res.status(404).json({ error: 'Product not found' });
    addLog('product_updated', p.name, req.ip);
    res.json(p);
  });

  app.delete('/api/products/:id', authMiddleware, (req, res) => {
    const product = db.products.findById(parseInt(req.params.id));
    db.products.remove(parseInt(req.params.id));
    addLog('product_deleted', product ? product.name : req.params.id, req.ip);
    res.json({ success: true });
  });

  app.post('/api/products/:id/exe', authMiddleware, upload.single('exe'), (req, res) => {
    const product = db.products.findById(parseInt(req.params.id));
    if (!product) return res.status(404).json({ error: 'Product not found' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    if (product.exe_path && fs.existsSync(product.exe_path)) {
      try { fs.unlinkSync(product.exe_path); } catch (e) {}
    }

    db.products.update(product.id, {
      exe_path: req.file.path,
      exe_filename: req.file.originalname,
      exe_size: req.file.size
    });
    addLog('exe_uploaded', `${product.name}: ${req.file.originalname} (${(req.file.size / 1024 / 1024).toFixed(1)}MB)`, req.ip);
    res.json({ success: true, filename: req.file.originalname, size: req.file.size });
  });

  app.get('/api/keys', authMiddleware, (req, res) => {
    const { search, product_id, page = 1, limit = 50 } = req.query;
    let keys;
    if (search) {
      keys = db.keys.search(search);
    } else if (product_id) {
      keys = db.keys.findByProduct(parseInt(product_id));
    } else {
      keys = db.keys.findAll();
    }

    const total = keys.length;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const paged = keys.slice(offset, offset + parseInt(limit));

    res.json({ keys: paged, total, page: parseInt(page), limit: parseInt(limit), pages: Math.ceil(total / parseInt(limit)) });
  });

  app.get('/api/keys/:productId', authMiddleware, (req, res) => res.json(db.keys.findByProduct(parseInt(req.params.productId))));

  app.post('/api/keys/:productId', authMiddleware, (req, res) => {
    const { count, expires_at, prefix } = req.body;
    const n = Math.min(parseInt(count) || 1, 100);
    const pre = prefix || 'VX';
    const keys = [];
    for (let i = 0; i < n; i++) {
      const kv = pre + '-' + crypto.randomBytes(4).toString('hex').toUpperCase() + '-' + crypto.randomBytes(4).toString('hex').toUpperCase();
      keys.push(db.keys.create(parseInt(req.params.productId), kv, expires_at || null));
    }
    addLog('keys_generated', `${n} keys for product #${req.params.productId}`, req.ip);
    res.json(keys);
  });

  app.put('/api/keys/:id', authMiddleware, (req, res) => {
    const k = db.keys.update(parseInt(req.params.id), req.body);
    if (!k) return res.status(404).json({ error: 'Key not found' });
    res.json(k);
  });

  app.delete('/api/keys/:id', authMiddleware, (req, res) => {
    db.keys.remove(parseInt(req.params.id));
    res.json({ success: true });
  });

  app.post('/api/keys/:id/reset', authMiddleware, (req, res) => {
    const k = db.keys.update(parseInt(req.params.id), { is_used: false, used_by: '', hwid: '' });
    if (!k) return res.status(404).json({ error: 'Key not found' });
    addLog('key_reset', k.key_value, req.ip);
    res.json(k);
  });

  app.get('/api/clients', authMiddleware, (req, res) => {
    const clients = [...data.clients].sort((a, b) => new Date(b.last_seen) - new Date(a.last_seen));
    res.json(clients.map(c => ({
      ...c,
      online: onlineClients.has(c.hwid)
    })));
  });

  app.delete('/api/clients/:id', authMiddleware, (req, res) => {
    data.clients = data.clients.filter(c => c.id !== parseInt(req.params.id));
    saveDB();
    res.json({ success: true });
  });

  app.get('/api/logs', authMiddleware, (req, res) => {
    const { page = 1, limit = 50 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    res.json({
      logs: data.logs.slice(offset, offset + parseInt(limit)),
      total: data.logs.length,
      page: parseInt(page),
      pages: Math.ceil(data.logs.length / parseInt(limit))
    });
  });

  app.get('/api/settings', authMiddleware, (req, res) => res.json(db.settings.getAll()));

  app.put('/api/settings', authMiddleware, (req, res) => {
    const { key, value } = req.body;
    if (key) {
      db.settings.set(key, value);
      addLog('settings_changed', `${key} = ${value}`, req.ip);
    }
    res.json({ success: true });
  });

  return { app, authMiddleware, db, data, saveDB };
}

module.exports = createServer;
