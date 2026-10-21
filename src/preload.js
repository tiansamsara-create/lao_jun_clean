const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('qingpan', {
  getSystemInfo: () => ipcRenderer.invoke('system:info'),
  scan: () => ipcRenderer.invoke('scan:start'),
  clean: (ids) => ipcRenderer.invoke('clean:start', ids),
  cancelClean: () => ipcRenderer.invoke('clean:cancel'),
  scanApps: (root) => ipcRenderer.invoke('apps:scan', root),
  listDrives: () => ipcRenderer.invoke('disk:drives'),
  scanDisk: (root, minMB) => ipcRenderer.invoke('disk:scan', root, minMB),
  cancelDisk: () => ipcRenderer.invoke('disk:cancel'),
  trashFiles: (ids) => ipcRenderer.invoke('disk:trash', ids),
  systemCleanup: (action) => ipcRenderer.invoke('system:cleanup', action),
  analyzeSystem: () => ipcRenderer.invoke('system:analyze'),
  onDiskProgress: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('disk:progress', listener);
    return () => ipcRenderer.removeListener('disk:progress', listener);
  },
  uninstallApp: (id) => ipcRenderer.invoke('apps:uninstall', id),
  showPath: (target) => ipcRenderer.invoke('path:show', target),
  showAudit: () => ipcRenderer.invoke('audit:show'),
  onScanProgress: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('scan:progress', listener);
    return () => ipcRenderer.removeListener('scan:progress', listener);
  },
  onCleanProgress: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('clean:progress', listener);
    return () => ipcRenderer.removeListener('clean:progress', listener);
  },
  onAppsProgress: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('apps:progress', listener);
    return () => ipcRenderer.removeListener('apps:progress', listener);
  }
});
