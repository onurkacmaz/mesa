const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

let pty;
try {
  pty = require('node-pty');
} catch (err) {
  console.error('node-pty yuklenemedi, terminaller calismayacak:', err.message);
}

const terminals = new Map();

function createWindow() {
  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 860,
    minHeight: 560,
    center: true,
    backgroundColor: '#0a0a0c',
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 20, y: 19 } }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true // for browser panes
    }
  });

  // A browser pane loads arbitrary URLs into a guest that lives in the same
  // process tree as the pty bridge. The guest must never be handed a path to
  // it, so every webview is stripped of the things that could provide one
  // before it is created — this is the documented hook, and it holds even if
  // the renderer is ever tricked into asking for a preload.
  win.webContents.on('will-attach-webview', (event, webPreferences) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
  });

  // target="_blank" in a guest opens a new window by default, and there is no
  // window for this app to open: the link would simply count as dead. It opens
  // in the same pane instead, because the canvas is already the tab model.
  // Schemes other than http(s) (mailto:, a custom protocol) are refused
  // silently.
  win.webContents.on('did-attach-webview', (event, guest) => {
    guest.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) {
        setImmediate(() => {
          if (!guest.isDestroyed()) guest.loadURL(url);
        });
      }
      return { action: 'deny' };
    });
  });

  const devUrl = process.env.ELECTRON_START_URL;
  if (devUrl) {
    win.loadURL(devUrl);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  // macOS hides the traffic lights in fullscreen, so the space the titlebar
  // reserves for them becomes an empty gap. Tell the renderer when that
  // happens so it can close the gap up.
  const sendFullScreen = () => {
    if (!win.isDestroyed()) win.webContents.send('window:fullscreen', win.isFullScreen());
  };
  win.on('enter-full-screen', sendFullScreen);
  win.on('leave-full-screen', sendFullScreen);
  win.webContents.on('did-finish-load', sendFullScreen);

  win.on('closed', () => {
    for (const [id, term] of terminals) {
      killTerminal(term);
      terminals.delete(id);
    }
  });

  return win;
}

// The stock Window menu binds Cmd+W to "Close Window", which quit the whole
// workspace out from under a stray keystroke. The app owns that shortcut now
// (it closes the selected session), so the menu is rebuilt without it —
// swallowing the key in the renderer alone would not stop a menu accelerator.
function buildApplicationMenu() {
  const isMac = process.platform === 'darwin';
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(isMac ? [{ role: 'appMenu' }] : []),
      { role: 'editMenu' },
      {
        label: 'View',
        submenu: [
          { role: 'reload' },
          { role: 'toggleDevTools' },
          { type: 'separator' },
          { role: 'togglefullscreen' }
        ]
      },
      { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }] }
    ])
  );
}

function safeUserShell() {
  try {
    // Throws when the uid has no passwd entry (a container, a deleted account).
    return os.userInfo().shell;
  } catch {
    return null;
  }
}

// SHELL is what the launching process happened to be using, so it is the most
// faithful answer when it exists. It usually does not: launchd sets no SHELL,
// so a packaged app opened from Finder would hand every user /bin/zsh no
// matter what they actually run, while the same build started from a terminal
// picks up their real shell -- correct in dev, silently wrong once shipped.
// os.userInfo() reads the account's shell out of the password database
// instead, which is right in both cases.
function shellForPlatform() {
  if (process.platform === 'win32') return 'powershell.exe';
  // Either source can name a shell that is no longer installed (an uninstalled
  // fish still sitting in passwd). pty.spawn throws on a missing binary and
  // the pane would just sit dead, so each candidate is checked before use.
  for (const candidate of [process.env.SHELL, safeUserShell()]) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return '/bin/zsh';
}

// Spawn the shell as a LOGIN shell. Without this the pty gets a non-login
// zsh, which reads only .zshenv/.zshrc and skips /etc/zprofile, ~/.zprofile
// and ~/.zlogin entirely. On macOS that is where PATH is actually built:
// /etc/zprofile runs path_helper (which adds /usr/local/bin from /etc/paths)
// and the user's own .zprofile runs `brew shellenv`. Miss them and anything
// living outside launchd's minimal /usr/bin:/bin:/usr/sbin:/sbin is simply
// "command not found" -- docker, brew, rvm -- even though the exact same
// command works in Terminal.app, which does open a login shell. Every serious
// terminal (VS Code, iTerm2, Warp) spawns login shells for this reason.
//
// -l is a POSIX-shell flag (zsh, bash, fish all take it); powershell does not.
function shellArgs() {
  return process.platform === 'win32' ? [] : ['-l'];
}

// For zsh, points ZDOTDIR at our bootstrap dir so the shell sources a hook
// that emits OSC 133 prompt markers (used to draw command-block dividers).
// The hook restores the user's real ZDOTDIR for their own dotfiles before
// their .zshrc etc. loads, so this is transparent to their setup.
// zsh stat()s ZDOTDIR through a real syscall, and nothing inside app.asar
// exists on disk as far as any process other than Electron is concerned. The
// hook dir is listed under asarUnpack, so in a packaged app the real copy sits
// in app.asar.unpacked; in dev __dirname has no .asar segment and this is a
// no-op. Without it the shell silently falls back to the user's own dotfiles
// and the OSC 133 prompt markers (block dividers) never arrive.
function shellHooksDir(shell) {
  return path
    .join(__dirname, 'shell-hooks', shell)
    .replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
}

function shellEnv(shellPath) {
  // Colour is off by default in most of these tools, which is why a fresh
  // terminal looks so grey. Turning it on is the single biggest difference to
  // how much colour actually shows up in day-to-day output. The LSCOLORS map
  // is tuned to the pane palette (amber directories, green executables)
  // instead of the stock blue-on-black.
  const colourEnv = {
    CLICOLOR: '1',
    // Truecolor (24-bit) signalling. OpenCode, Claude Code and friends degrade
    // their palette to 256-color when this is missing, which is exactly the
    // "colours look off compared to Warp" complaint — Warp advertises it, we
    // have to too. TERM_PROGRAM is the same story for the tools that switch on
    // the host's identity rather than just TERM.
    COLORTERM: 'truecolor',
    TERM_PROGRAM: 'mesa',
    TERM_PROGRAM_VERSION: '1.2.0',
    LSCOLORS: 'DxGxcxdxCxegedabagacad',
    LS_COLORS: 'di=1;33:ln=1;36:so=32:pi=33:ex=32:bd=34;46:cd=34;43:su=30;41:sg=30;46:tw=30;42:ow=30;43',
    GREP_COLORS: 'mt=1;33'
  };

  if (path.basename(shellPath) !== 'zsh') return { ...process.env, ...colourEnv };
  return {
    ...process.env,
    ...colourEnv,
    ZDOTDIR: shellHooksDir('zsh'),
    WFTERM_REAL_ZDOTDIR: process.env.ZDOTDIR || os.homedir()
  };
}

// The directory a new session should start in. The renderer asks for the
// folder the last used terminal is sitting in, and that folder can be gone by
// the time it is asked for -- deleted from another pane, an unmounted volume,
// a worktree that was pruned. pty.spawn throws on a cwd that does not exist
// and the pane would simply sit dead, so the path is checked here and home
// stands in when it does not survive. Same guard the git:branch handler makes
// on a path crossing IPC.
function resolveCwd(requested) {
  if (typeof requested === 'string' && requested.startsWith('/')) {
    try {
      if (fs.statSync(requested).isDirectory()) return requested;
    } catch {
      // gone; fall through to home
    }
  }
  return os.homedir();
}

// Kills the whole process group the pty spawned (the shell AND anything it
// launched, e.g. a dev server), not just the shell itself. A plain
// term.kill() only signals the shell; child processes survive as orphans.
function killTerminal(term) {
  const pid = term.pid;
  try {
    process.kill(-pid, 'SIGHUP');
  } catch {
    try {
      term.kill();
    } catch {
      // already gone
    }
  }
  setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // process group already dead
    }
  }, 400);
}

// On macOS BrowserWindow's `icon` option is ignored, and an unpackaged run
// shows the generic Electron icon in the Dock. A packaged app takes its icon
// from its own bundle; this is only for `npm run dev`.
function setDevDockIcon() {
  if (process.platform !== 'darwin' || app.isPackaged) return;
  const icon = path.join(__dirname, '..', 'build', 'icon.png');
  if (!fs.existsSync(icon)) return;
  app.dock?.setIcon(icon);
}

// Reads which git branch a directory is on. Deliberately does not run `git`:
// that would mean spawning a child process on every prompt. .git/HEAD is a
// one-line file and already names the branch.
//
// `.git` can be a file rather than a directory (that is how submodules and
// worktrees work): in that case it holds a single `gitdir:` line pointing at
// the real git directory.
function gitBranchAt(dir) {
  let current = dir;
  for (let depth = 0; depth < 64; depth += 1) {
    const dotGit = path.join(current, '.git');
    let stat;
    try {
      stat = fs.statSync(dotGit);
    } catch {
      stat = null;
    }

    if (stat) {
      let gitDir = dotGit;
      if (stat.isFile()) {
        const pointer = fs.readFileSync(dotGit, 'utf8').match(/^gitdir:\s*(.+)$/m);
        if (!pointer) return null;
        gitDir = path.resolve(current, pointer[1].trim());
      }
      let head;
      try {
        head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
      } catch {
        return null;
      }
      const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
      // A detached HEAD has no name; the short sha is the only readable
      // thing.
      return ref ? ref[1] : head.slice(0, 7) || null;
    }

    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

app.whenReady().then(() => {
  setDevDockIcon();
  buildApplicationMenu();
  const win = createWindow();

  ipcMain.handle('terminal:create', (event, { id, cols, rows, cwd }) => {
    if (!pty) return false;
    if (terminals.has(id)) return true;

    const shellPath = shellForPlatform();
    let term;
    try {
      term = pty.spawn(shellPath, shellArgs(), {
        name: 'xterm-256color',
        cols: cols || 80,
        rows: rows || 24,
        cwd: resolveCwd(cwd),
        env: shellEnv(shellPath)
      });
    } catch (err) {
      console.error('shell spawn failed:', err.message);
      return false;
    }

    term.onData((data) => {
      if (!win.isDestroyed()) {
        win.webContents.send(`terminal:data:${id}`, data);
      }
    });

    term.onExit(() => {
      terminals.delete(id);
      if (!win.isDestroyed()) {
        win.webContents.send(`terminal:exit:${id}`);
      }
    });

    terminals.set(id, term);
    return true;
  });

  ipcMain.on('terminal:input', (event, { id, data }) => {
    const term = terminals.get(id);
    if (term) term.write(data);
  });

  ipcMain.on('terminal:resize', (event, { id, cols, rows }) => {
    const term = terminals.get(id);
    if (term && cols > 0 && rows > 0) {
      try {
        term.resize(cols, rows);
      } catch {
        // pty already exited, ignore
      }
    }
  });

  // Asked once per prompt, because the branch changes without the cwd
  // changing (`git checkout`). Being a file read, answering it is cheap.
  ipcMain.handle('git:branch', (event, dir) => {
    if (typeof dir !== 'string' || !dir.startsWith('/')) return null;
    try {
      return gitBranchAt(dir);
    } catch {
      return null;
    }
  });

  ipcMain.on('terminal:close', (event, { id }) => {
    const term = terminals.get(id);
    if (term) {
      killTerminal(term);
      terminals.delete(id);
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
