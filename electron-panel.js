const { app, BrowserWindow } = require('electron');
const path = require('path');
const net = require('net');
const os = require('os');
const express = require('express');
const createServer = require('./server/core');

const DATA_DIR = path.join(app.getPath('userData'), 'data');
const PORT = 7777;

let mainWindow;
let serverInfo = { ip: '', port: PORT, url: '', tunnelUrl: '' };

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

function tryListen(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(port, '0.0.0.0', () => { s.close(() => resolve(true)); });
    s.on('error', () => resolve(false));
  });
}

async function findPort() {
  if (await tryListen(PORT)) return PORT;
  for (let p = 7778; p < 8000; p++) {
    if (await tryListen(p)) return p;
  }
  return PORT;
}

async function startTunnel(port) {
  try {
    const localtunnel = require('localtunnel');
    const tunnel = await localtunnel({ port, host: 'https://localtunnel.me' });
    console.log(`Tunnel: ${tunnel.url}`);
    tunnel.on('close', () => {
      console.log('Tunnel closed, restarting...');
      serverInfo.tunnelUrl = '';
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('server-info', serverInfo);
      }
      setTimeout(() => startTunnel(port), 3000);
    });
    return tunnel.url;
  } catch (e) {
    console.log('Tunnel failed:', e.message);
    return '';
  }
}

async function createWindow() {
  const port = await findPort();
  const ip = getLocalIP();
  serverInfo = { ip, port, url: `http://${ip}:${port}`, tunnelUrl: '' };

  const { app: srv } = createServer(DATA_DIR);

  srv.use('/css', express.static(path.join(__dirname, 'public', 'css')));
  srv.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'panel.html')));
  srv.get('/api/server-info', (req, res) => res.json(serverInfo));

  srv.listen(port, '0.0.0.0', async () => {
    console.log(`VORTEX Panel: ${serverInfo.url}`);
    serverInfo.tunnelUrl = await startTunnel(port);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('server-info', serverInfo);
    }
  });

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    frame: false,
    backgroundColor: '#060610',
    webPreferences: { nodeIntegration: false, contextIsolation: true },
    autoHideMenuBar: true,
    title: 'VORTEX Panel'
  });

  mainWindow.loadURL(`http://127.0.0.1:${port}`);
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.send('server-info', serverInfo);
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { app.quit(); });
