const https = require('https');
const fs = require('fs');
const path = require('path');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO = process.env.GITHUB_REPO || 'dadamoayu2-coder/vortex';
const DB_PATH_IN_REPO = 'data/db.json';
const DB_LOCAL = path.join(__dirname, '..', 'data', 'db.json');

let db = null;
let sha = null;
let saving = false;
let saveQueue = [];

function githubRequest(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'api.github.com',
      path: `/repos/${GITHUB_REPO}/${urlPath}`,
      method,
      headers: {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'User-Agent': 'VORTEX-Panel',
        'Accept': 'application/vnd.github.v3+json'
      }
    };
    const req = https.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString()) }); }
        catch { resolve({ status: res.statusCode, data: null }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function loadFromGitHub() {
  if (!GITHUB_TOKEN) {
    console.log('No GITHUB_TOKEN, using local file only');
    return loadLocal();
  }
  try {
    console.log('Loading DB from GitHub...');
    const r = await githubRequest('GET', `contents/${DB_PATH_IN_REPO}`);
    if (r.status === 200 && r.data && r.data.content) {
      const content = Buffer.from(r.data.content, 'base64').toString('utf8');
      db = JSON.parse(content);
      sha = r.data.sha;
      console.log('DB loaded from GitHub');
      saveLocal();
      return;
    }
    console.log('No DB on GitHub yet, creating...');
    db = defaultDB();
    sha = null;
    await pushToGitHub();
  } catch (err) {
    console.log('GitHub load failed:', err.message);
    loadLocal();
  }
}

function loadLocal() {
  try {
    if (fs.existsSync(DB_LOCAL)) {
      db = JSON.parse(fs.readFileSync(DB_LOCAL, 'utf8'));
      console.log('DB loaded from local file');
    } else {
      db = defaultDB();
    }
  } catch { db = defaultDB(); }
}

function saveLocal() {
  try {
    fs.mkdirSync(path.dirname(DB_LOCAL), { recursive: true });
    fs.writeFileSync(DB_LOCAL, JSON.stringify(db, null, 2));
  } catch {}
}

function defaultDB() {
  return { admins: [], products: [], keys: [], clients: [], logs: [], settings: {} };
}

async function pushToGitHub() {
  if (!GITHUB_TOKEN) { saveLocal(); return; }
  if (saving) { return new Promise(r => saveQueue.push(r)); }
  saving = true;
  try {
    const content = Buffer.from(JSON.stringify(db, null, 2)).toString('base64');
    const body = { message: 'VORTEX DB update', content, branch: 'main' };
    if (sha) body.sha = sha;
    const r = await githubRequest('PUT', `contents/${DB_PATH_IN_REPO}`, body);
    if (r.status === 200 || r.status === 201) {
      sha = r.data.sha;
      console.log('DB saved to GitHub');
    } else {
      console.log('GitHub save failed:', r.status, JSON.stringify(r.data).slice(0, 200));
    }
  } catch (err) {
    console.log('GitHub push error:', err.message);
  }
  saveLocal();
  saving = false;
  while (saveQueue.length) saveQueue.shift()();
}

function getDB() { return db; }
function saveDB() { pushToGitHub(); }

module.exports = { loadFromGitHub, getDB, saveDB };
