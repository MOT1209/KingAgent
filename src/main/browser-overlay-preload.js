const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('kingagentOverlay', {
  onRender: cb => ipcRenderer.on('overlay:render', (_event, data) => cb(data)),
  input: data => ipcRenderer.send('overlay:input', data),
});
