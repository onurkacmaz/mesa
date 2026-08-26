const { contextBridge, ipcRenderer, webFrame } = require('electron');

// The canvas implements its own zoom (a CSS transform). Chromium's built-in
// pinch "visual zoom" would scale the entire window — toolbar and all — on
// top of that, so pin it to 1x and leave zooming entirely to the app.
webFrame.setVisualZoomLevelLimits(1, 1);

contextBridge.exposeInMainWorld('terminalApi', {
  create: (id, cols, rows) => ipcRenderer.invoke('terminal:create', { id, cols, rows }),
  input: (id, data) => ipcRenderer.send('terminal:input', { id, data }),
  resize: (id, cols, rows) => ipcRenderer.send('terminal:resize', { id, cols, rows }),
  close: (id) => ipcRenderer.send('terminal:close', { id }),
  gitBranch: (dir) => ipcRenderer.invoke('git:branch', dir),
  onFullScreenChange: (callback) => {
    const listener = (event, isFullScreen) => callback(isFullScreen);
    ipcRenderer.on('window:fullscreen', listener);
    return () => ipcRenderer.removeListener('window:fullscreen', listener);
  },
  onData: (id, callback) => {
    const channel = `terminal:data:${id}`;
    const listener = (event, data) => callback(data);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  onExit: (id, callback) => {
    const channel = `terminal:exit:${id}`;
    const listener = () => callback();
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  }
});
