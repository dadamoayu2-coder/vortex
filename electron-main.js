const { app, BrowserWindow } = require('electron');
const path = require('path');
const express = require('express');

let mainWindow;

function findFreePort() {
  const net = require('net');
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on('error', reject);
  });
}

async function createWindow() {
  const port = await findFreePort();
  const srv = express();

  srv.use('/css', express.static(path.join(__dirname, 'public', 'css')));
  srv.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'license.html')));

  srv.listen(port, '127.0.0.1', () => {
    console.log(`VORTEX License on port ${port}`);
  });

  mainWindow = new BrowserWindow({
    width: 900,
    height: 650,
    minWidth: 700,
    minHeight: 500,
    frame: false,
    backgroundColor: '#060610',
    webPreferences: { nodeIntegration: false, contextIsolation: true },
    autoHideMenuBar: true,
    title: 'VORTEX'
  });

  mainWindow.loadURL(`http://127.0.0.1:${port}`);
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { app.quit(); });
