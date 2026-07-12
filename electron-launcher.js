const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const os = require('os');

let mainWindow;

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const TAG_LENGTH = 16;

function deriveKey(secret) {
  return crypto.scryptSync(secret, 'vortex-salt-v1', KEY_LENGTH);
}

function getSecret() {
  const configPath = path.join(app.getPath('userData'), 'config.json');
  if (fs.existsSync(configPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (cfg.secret) return cfg.secret;
    } catch (e) {}
  }
  return 'vortex-default-secret-change-me';
}

function decryptBuffer(encryptedBuffer) {
  const secret = getSecret();
  const key = deriveKey(secret);
  const iv = encryptedBuffer.subarray(0, IV_LENGTH);
  const tag = encryptedBuffer.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const encrypted = encryptedBuffer.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

function findFreePort() {
  const net = require('net');
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on('error', () => resolve(7777));
  });
}

async function createWindow() {
  const port = await findFreePort();
  const express = require('express');
  const srv = express();
  srv.use('/css', express.static(path.join(__dirname, 'public', 'css')));
  srv.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'launcher.html')));
  srv.listen(port, '127.0.0.1', () => {
    console.log(`VORTEX Launcher on port ${port}`);
  });

  mainWindow = new BrowserWindow({
    width: 520,
    height: 680,
    minWidth: 460,
    minHeight: 600,
    frame: false,
    backgroundColor: '#060610',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    autoHideMenuBar: true,
    title: 'VORTEX',
    resizable: true,
    transparent: false
  });

  mainWindow.loadURL(`http://127.0.0.1:${port}`);
  mainWindow.on('closed', () => { mainWindow = null; app.quit(); });
}

ipcMain.on('minimize-window', () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.on('close-window', () => {
  if (mainWindow) mainWindow.close();
});

ipcMain.handle('decrypt-and-run', async (event, encryptedArray, productName) => {
  try {
    const encryptedBuffer = Buffer.from(encryptedArray);
    const exeBuffer = decryptBuffer(encryptedBuffer);

    const header = exeBuffer.subarray(0, 2).toString('hex');
    if (header !== '4d5a') {
      return { success: false, error: 'Invalid executable (corrupted or wrong decryption key)' };
    }

    const tmpDir = os.tmpdir();
    const randomName = crypto.randomBytes(16).toString('hex') + '.exe';
    const tmpPath = path.join(tmpDir, randomName);

    fs.writeFileSync(tmpPath, exeBuffer);
    fs.chmodSync(tmpPath, 0o755);

    const child = spawn(tmpPath, [], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false
    });
    child.unref();

    setTimeout(() => {
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      } catch (e) {}
    }, 5000);

    setTimeout(() => {
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      } catch (e) {}
    }, 30000);

    child.on('error', () => {
      try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (e) {}
    });

    return { success: true, pid: child.pid };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { app.quit(); });
