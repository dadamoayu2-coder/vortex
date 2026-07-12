const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const DB_PATH = process.env.DATA_DIR
  ? path.join(process.env.DATA_DIR, 'vortex.json')
  : fs.existsSync('/data')
    ? path.join('/data', 'vortex.json')
    : path.join(__dirname, '..', 'vortex.json');
const isVercel = false;

let data = {
  admins: [],
  products: [],
  keys: [],
  settings: {
    site_url: '',
    site_name: 'VORTEX',
    access_code: ''
  }
};

function load() {
  if (!isVercel) {
    if (fs.existsSync(DB_PATH)) {
      try { data = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8')); } catch (e) {}
    }
  }
}

function save() {
  if (!isVercel) {
    try { fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2)); } catch (e) {}
  }
}

load();

if (data.admins.length === 0) {
  const hash = bcrypt.hashSync('admin', 10);
  data.admins.push({ id: 1, username: 'admin', password: hash, created_at: new Date().toISOString() });
  save();
}

function nextId(arr) {
  return arr.length > 0 ? Math.max(...arr.map(x => x.id)) + 1 : 1;
}

const db = {
  admins: {
    findByUsername(username) { return data.admins.find(a => a.username === username); }
  },
  products: {
    findAll() { return [...data.products].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)); },
    findById(id) { return data.products.find(p => p.id === id); },
    create({ name, description, icon }) {
      const product = { id: nextId(data.products), name, description: description || '', icon: icon || '', exe_filename: '', exe_path: '', status: 'active', created_at: new Date().toISOString() };
      data.products.push(product); save(); return product;
    },
    update(id, fields) {
      const p = data.products.find(x => x.id === id);
      if (!p) return null;
      Object.assign(p, fields); save(); return p;
    },
    remove(id) {
      data.products = data.products.filter(p => p.id !== id);
      data.keys = data.keys.filter(k => k.product_id !== id);
      save();
    }
  },
  keys: {
    findByProduct(productId) { return data.keys.filter(k => k.product_id === productId).sort((a, b) => new Date(b.created_at) - new Date(a.created_at)); },
    findByValue(keyValue) { return data.keys.find(k => k.key_value === keyValue); },
    create(productId, keyValue, expiresAt) {
      const key = { id: nextId(data.keys), key_value: keyValue, product_id: productId, is_used: false, used_by: '', hwid: '', expires_at: expiresAt || null, created_at: new Date().toISOString() };
      data.keys.push(key); save(); return key;
    },
    update(id, fields) {
      const k = data.keys.find(x => x.id === id);
      if (!k) return null;
      Object.assign(k, fields); save(); return k;
    },
    markUsed(id, hwid) {
      const k = data.keys.find(x => x.id === id);
      if (k) { k.is_used = true; k.hwid = hwid || 'web'; k.used_by = hwid || 'web'; save(); }
    },
    remove(id) { data.keys = data.keys.filter(k => k.id !== id); save(); }
  },
  settings: {
    get(key) { return data.settings[key]; },
    set(key, value) { data.settings[key] = value; save(); },
    getAll() { return { ...data.settings }; }
  },
  save
};

module.exports = db;
