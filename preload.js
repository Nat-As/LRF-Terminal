const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, fn) {
  ipcRenderer.on(channel, (_event, ...args) => fn(...args));
}

contextBridge.exposeInMainWorld('lrf', {
  platform: process.platform,
  onPortList: fn => subscribe('ports:list', fn),
  onPortAdded: fn => subscribe('ports:added', fn),
  onPortRemoved: fn => subscribe('ports:removed', fn),
  choosePort: portId => ipcRenderer.send('ports:choose', portId),
  onPasteRequest: fn => subscribe('term:paste', fn),
  readClipboard: () => ipcRenderer.invoke('clipboard:read'),
  writeClipboard: text => ipcRenderer.invoke('clipboard:write', text),
  saveLog: (text, defaultName) => ipcRenderer.invoke('log:save', text, defaultName),
});
