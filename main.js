const { app, BrowserWindow, Menu, clipboard, dialog, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');

let win = null;
let portCallback = null;   // pending navigator.serial.requestPort() answer

function portInfo(p) {
  return {
    portId: p.portId,
    portName: p.portName || '',
    displayName: p.displayName || '',
    vendorId: p.vendorId || '',
    productId: p.productId || '',
    serialNumber: p.serialNumber || '',
  };
}

function answerPortRequest(portId) {
  if (portCallback) {
    portCallback(portId || '');
    portCallback = null;
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 760,
    minHeight: 480,
    title: 'LRF Terminal',
    backgroundColor: '#0b0e12',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  const ses = win.webContents.session;

  ses.setPermissionCheckHandler((_wc, permission) => permission === 'serial');
  ses.setDevicePermissionHandler(details => details.deviceType === 'serial');

  // Electron has no built-in port chooser; the renderer shows its own.
  ses.on('select-serial-port', (event, portList, webContents, callback) => {
    event.preventDefault();
    answerPortRequest('');
    portCallback = callback;
    webContents.send('ports:list', portList.map(portInfo));
  });
  ses.on('serial-port-added', (_event, port) => win?.webContents.send('ports:added', portInfo(port)));
  ses.on('serial-port-removed', (_event, port) => win?.webContents.send('ports:removed', portInfo(port)));

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());

  win.on('closed', () => { win = null; answerPortRequest(''); });
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
}

function buildMenu() {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
    return;
  }
  // macOS needs a menu for the standard Cmd shortcuts.
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    {
      label: 'Edit',
      submenu: [
        { role: 'copy' },
        { label: 'Paste to Port', accelerator: 'Cmd+V', click: () => win?.webContents.send('term:paste') },
        { role: 'selectAll' },
      ],
    },
    { role: 'windowMenu' },
  ]));
}

ipcMain.on('ports:choose', (_event, portId) => answerPortRequest(portId));
ipcMain.handle('clipboard:read', () => clipboard.readText());
ipcMain.handle('clipboard:write', (_event, text) => clipboard.writeText(String(text)));

ipcMain.handle('log:save', async (_event, text, defaultName) => {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Save terminal log',
    defaultPath: path.join(app.getPath('documents'), defaultName),
    filters: [{ name: 'Text files', extensions: ['txt'] }, { name: 'All files', extensions: ['*'] }],
  });
  if (canceled || !filePath) return null;
  await fs.writeFile(filePath, text, 'utf8');
  return filePath;
});

app.whenReady().then(() => {
  buildMenu();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => app.quit());
