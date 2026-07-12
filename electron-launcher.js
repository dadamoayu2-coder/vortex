const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow;

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

ipcMain.handle('save-file', async (event, bufferArray, defaultName) => {
  try {
    const { filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Save Product',
      defaultPath: defaultName,
      filters: [
        { name: 'Vortex Package', extensions: ['vortex'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });
    if (!filePath) return { success: false, error: 'Cancelled' };
    fs.writeFileSync(filePath, Buffer.from(bufferArray));
    return { success: true, path: filePath };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { app.quit(); });
