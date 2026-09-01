const { contextBridge, ipcRenderer, webFrame } = require('electron');

// The canvas implements its own zoom (a CSS transform). Chromium's built-in
// pinch "visual zoom" would scale the entire window — toolbar and all — on
// top of that, so pin it to 1x and leave zooming entirely to the app.
webFrame.setVisualZoomLevelLimits(1, 1);

contextBridge.exposeInMainWorld('terminalApi', {
  create: (id, cols, rows, cwd) => ipcRenderer.invoke('terminal:create', { id, cols, rows, cwd }),
  input: (id, data) => ipcRenderer.send('terminal:input', { id, data }),
  resize: (id, cols, rows) => ipcRenderer.send('terminal:resize', { id, cols, rows }),
  close: (id) => ipcRenderer.send('terminal:close', { id }),
  gitBranch: (dir) => ipcRenderer.invoke('git:branch', dir),

  // What could come next on the line being typed. Asked per keystroke, so
  // the filtering and the caching both live on the other side.
  candidates: (request) => ipcRenderer.invoke('completion:candidates', request),
  // The shape of one command, read from disk the first time it is typed.
  commandSchema: (command) => ipcRenderer.invoke('completion:schema', command),
  // A command that was just run, so the next prompt can offer it. Fire and
  // forget: nothing waits on it and nothing breaks if it is lost.
  rememberCommand: (command) => ipcRenderer.send('completion:remember', command),

  // The session travels as text in both directions. Structured clone would
  // work, but text is what lands on disk, so sending anything else would mean
  // two places deciding what a session is.
  loadSession: () => ipcRenderer.invoke('session:load'),
  saveSession: (payload) => ipcRenderer.send('session:save', payload),
  // For a file that was read but could not be understood: keep it rather than
  // let the next save overwrite it.
  archiveSession: () => ipcRenderer.invoke('session:archive'),
  // Used once, on the way out. The renderer is about to stop existing, so a
  // fire-and-forget send has no one left to finish it: this blocks until the
  // file is written.
  saveSessionSync: (payload) => ipcRenderer.sendSync('session:save-sync', payload),

  // What the app remembers about the person rather than about their work, in
  // its own file for its own reasons (src/flags.mjs). Text in both directions,
  // like the session, so only one side decides what a flags file is.
  loadFlags: () => ipcRenderer.invoke('flags:load'),
  saveFlags: (payload) => ipcRenderer.send('flags:save', payload),

  // Every application on this Mac, unfiltered — which of them is an editor is
  // decided in src/editors.mjs, where it can be tested.
  listApplications: () => ipcRenderer.invoke('editor:list'),
  openInEditor: (app, dir) => ipcRenderer.invoke('editor:open', { app, dir }),
  // The system's application picker, for an editor the known list has never
  // heard of. Resolves to a bundle name, or null if it was dismissed.
  chooseApplication: () => ipcRenderer.invoke('editor:choose'),
  // A shortcut that was typed inside a browser pane and belongs to the app.
  onGuestShortcut: (callback) => {
    const listener = (event, init) => callback(init);
    ipcRenderer.on('guest:shortcut', listener);
    return () => ipcRenderer.removeListener('guest:shortcut', listener);
  },
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
