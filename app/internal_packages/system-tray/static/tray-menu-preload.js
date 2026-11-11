const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('trayMenu', {
  onData(callback) {
    ipcRenderer.on('tray-menu-data', (_event, data) => callback(data));
  },
  act(action) {
    ipcRenderer.send('tray-menu-action', action);
  },
});
