const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('ice', Object.freeze({
  request: (method, params = {}) => ipcRenderer.invoke('ice:request', method, params),
  importImage: (jobId, figureNo) => ipcRenderer.invoke('ice:import-image', jobId, figureNo),
  saveKey: (provider, key) => ipcRenderer.invoke('ice:save-key', provider, key),
  openFolder: jobId => ipcRenderer.invoke('ice:open-folder', jobId),
  openTapNow: () => ipcRenderer.invoke('ice:tapnow'),
  captureWindow: () => ipcRenderer.invoke('ice:capture-window'),
  importPublication: () => ipcRenderer.invoke('ice:import-publication'),
  exportPublication: () => ipcRenderer.invoke('ice:export-publication'),
  importResource: () => ipcRenderer.invoke('ice:import-resource'),
  importDraft: () => ipcRenderer.invoke('ice:import-draft'),
  exportDraft: draftId => ipcRenderer.invoke('ice:export-draft', draftId),
  onEngineExit: callback => { const listener = () => callback(); ipcRenderer.on('ice:engine-exit', listener); return () => ipcRenderer.removeListener('ice:engine-exit', listener); }
}));
