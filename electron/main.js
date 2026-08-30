const { app, BrowserWindow, dialog, ipcMain, Menu } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { execFile } = require('node:child_process');

let pty;
try {
  pty = require('node-pty');
} catch (err) {
  console.error('node-pty yuklenemedi, terminaller calismayacak:', err.message);
}

const terminals = new Map();

// The keys the app owns even while a page has the keyboard. A browser pane is
// a separate WebContents with its own input target, so nothing typed inside
// one ever reaches the window's own listeners — ⌘W did nothing until you
// clicked back out onto the canvas, which made the shortcut look broken
// exactly where it was most needed.
//
// Deliberately a short list. Everything not named here stays with the page,
// because a guest is a real browser and ⌘C, ⌘V, ⌘F and ⌘0 belong to it.
const GUEST_APP_KEYS = new Set(['w', 'n', 'b', 't', 'l']);

// Where the last session is kept. userData rather than the renderer's own
// storage: a layout someone spent a morning arranging should not be thrown
// away by a cache clear, it should be readable when a restore goes wrong, and
// it is the same file an export would hand to someone else.
const sessionPath = () => path.join(app.getPath('userData'), 'session.json');

// The other thing kept next to the session: what the app remembers about the
// person rather than about their work. Its own file because the two have
// different lifetimes — the session is rewritten constantly and is archived
// out of the way when it cannot be parsed, and a rescued layout should not
// also cost the answers to questions already asked. See src/flags.mjs.
const flagsPath = () => path.join(app.getPath('userData'), 'flags.json');

// Written to a sibling first and renamed into place, because rename is atomic
// and a write is not. Quitting mid-write is exactly when this file is being
// touched, and a half-written JSON is the one failure that costs the whole
// layout rather than the last few seconds of it.
function writeTextAtomically(file, payload, what) {
  if (typeof payload !== 'string') return false;
  const temp = `${file}.tmp`;
  try {
    fs.writeFileSync(temp, payload, 'utf8');
    fs.renameSync(temp, file);
    return true;
  } catch (err) {
    console.error(`${what} write failed:`, err.message);
    try {
      fs.unlinkSync(temp);
    } catch {
      // nothing to clean up
    }
    return false;
  }
}

const writeSession = (payload) => writeTextAtomically(sessionPath(), payload, 'session');

// Unlike the session, a flags file that cannot be read is not set aside: there
// is no layout in it worth preserving, and the next write should simply
// replace it. Handed over as raw text for the renderer to make sense of, for
// the same reason the session is — the rules for trusting a file live in one
// testable place, not in main.
function readFlags() {
  try {
    const text = fs.readFileSync(flagsPath(), 'utf8');
    JSON.parse(text);
    return text;
  } catch {
    return null; // no file yet, or one this app should just overwrite
  }
}

const writeFlags = (payload) => writeTextAtomically(flagsPath(), payload, 'flags');

// The two places a Mac keeps applications. A per-user install lives in the
// second one and is just as real as a system-wide one.
const applicationFolders = () => ['/Applications', path.join(os.homedir(), 'Applications')];

// Every bundle name found, unfiltered. Which of them is an editor is decided
// in src/editors.mjs for the same reason the shape of a session is decided in
// src/session.mjs: main can see the disk, and nothing else — the knowledge
// belongs in one place that a test can reach without a filesystem.
//
// One level down as well as the top: /Applications/Utilities holds a few, and
// JetBrains Toolbox and the Adobe installers each keep their apps in a folder
// of their own. Not recursive beyond that — a full walk of /Applications means
// descending into every bundle's own contents, which is thousands of entries
// for nothing.
function listApplications() {
  const names = new Set();
  const read = (folder) => {
    try {
      return fs.readdirSync(folder, { withFileTypes: true });
    } catch {
      return []; // no such folder, which is normal for ~/Applications
    }
  };
  for (const folder of applicationFolders()) {
    for (const entry of read(folder)) {
      if (entry.name.endsWith('.app')) {
        names.add(entry.name);
      } else if (entry.isDirectory()) {
        for (const inner of read(path.join(folder, entry.name))) {
          if (inner.name.endsWith('.app')) names.add(inner.name);
        }
      }
    }
  }
  return [...names];
}

// The way out of a fixed list: the system's own application picker. What comes
// back is a bundle name, the same currency everything else here deals in, so a
// hand-picked editor is remembered and validated exactly like a known one.
//
// Restricted to the folders that are already trusted for opening — picking an
// app from somewhere else would be accepted here and then refused at launch,
// which is worse than not offering it.
async function chooseApplication(win) {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Choose an editor',
    message: 'Pick the application Mesa should open folders in.',
    defaultPath: '/Applications',
    properties: ['openFile', 'treatPackageAsDirectory'],
    filters: [{ name: 'Applications', extensions: ['app'] }]
  });
  if (canceled || !filePaths?.length) return null;
  const picked = filePaths[0];
  if (!picked.endsWith('.app')) return null;
  const name = path.basename(picked, '.app');
  return listApplications().includes(`${name}.app`) ? name : null;
}

// `open -a <app> <dir>`, run through execFile with an argument array and no
// shell, so nothing in either string can be read as syntax.
//
// Both arguments are checked here even though both come from this app's own
// renderer. The folder is whatever a shell last reported through OSC 7, which
// is to say a string a running process chose; and the app name has been out to
// disk and back through a JSON file anyone could have edited. So: the folder
// must be an absolute path that is really a directory, and the application
// must be one this machine actually has, in the folders listApplications
// looks at. An editor uninstalled since the preference was written fails here
// rather than launching something else with a similar name.
function openInEditor({ app: appName, dir }) {
  if (typeof appName !== 'string' || !appName) return false;
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) return false;
  try {
    if (!fs.statSync(dir).isDirectory()) return false;
  } catch {
    return false; // gone, or never there
  }
  if (!listApplications().includes(`${appName}.app`)) return false;

  execFile('open', ['-a', appName, dir], (err) => {
    // Nothing to hand back: the reply went out the moment the launch was
    // accepted, and a failure this late is macOS's to report, not the canvas's.
    if (err) console.error('editor launch failed:', err.message);
  });
  return true;
}

// Handed to the renderer as raw text, which validates it: main has no business
// knowing the shape of a workflow, and the rules for trusting a file live in
// one place (src/session.mjs) where they are testable. Unparseable text is
// kept aside rather than deleted — it is the only copy of a layout, and its
// author may want to look at it.
function readSession() {
  const file = sessionPath();
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null; // no file yet: a first launch
  }
  try {
    JSON.parse(text);
    return text;
  } catch (err) {
    console.error('session file unreadable, set aside:', err.message);
    archiveSession();
    return null;
  }
}

// Put the session file beyond the reach of the next write. Used for a file
// this app cannot make sense of — unparseable, or written by a version that no
// longer exists — because the alternative is that the first save of the new
// session quietly overwrites the only copy of someone's layout. It survives as
// session.json.bak, which is inspectable and can be renamed back by hand.
function archiveSession() {
  try {
    fs.renameSync(sessionPath(), `${sessionPath()}.bak`);
    return true;
  } catch {
    return false; // nothing there, or nowhere to put it
  }
}

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
    // Lifted off the guest before the page sees them and handed to the window,
    // which replays them as if they had been typed on the canvas.
    guest.on('before-input-event', (inputEvent, input) => {
      if (input.type !== 'keyDown') return;
      if (!(process.platform === 'darwin' ? input.meta : input.control)) return;
      // Digits are matched on the physical key: with alt held, the character
      // an input reports depends on the keyboard layout (⌥1 is "¡" on some),
      // and ⌥⌘1..9 is how the workflow rail is reached.
      const isDigit = /^Digit[1-9]$/.test(input.code);
      if (!isDigit && !GUEST_APP_KEYS.has((input.key || '').toLowerCase())) return;
      inputEvent.preventDefault();
      if (win.isDestroyed()) return;
      win.webContents.send('guest:shortcut', {
        key: input.key,
        code: input.code,
        metaKey: input.meta,
        ctrlKey: input.control,
        altKey: input.alt,
        shiftKey: input.shift
      });
    });

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
    TERM_PROGRAM_VERSION: '1.5.0',
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

  ipcMain.handle('session:load', () => readSession());

  // The renderer is the only side that knows whether the text it was handed
  // adds up to a session, so it is the side that asks for an unusable one to
  // be kept.
  ipcMain.handle('session:archive', () => archiveSession());

  // Two doors to the same write. The debounced one is asynchronous and covers
  // the ordinary case; the synchronous one is what the renderer uses on its
  // way out, where a message that merely got sent is not enough — the reply is
  // what proves the file landed before the window was gone.
  ipcMain.on('session:save', (event, payload) => {
    writeSession(payload);
  });

  ipcMain.on('session:save-sync', (event, payload) => {
    event.returnValue = writeSession(payload);
  });

  ipcMain.handle('flags:load', () => readFlags());

  // Not debounced the way the session is: flags change a handful of times in
  // the life of an install, and each change is the answer to a question that
  // must not be asked twice.
  ipcMain.on('flags:save', (event, payload) => {
    writeFlags(payload);
  });

  ipcMain.handle('editor:list', () => listApplications());

  ipcMain.handle('editor:open', (event, payload) => openInEditor(payload ?? {}));

  // Sheeted onto the window that asked, so it arrives attached to Mesa rather
  // than as a loose dialog on the desktop.
  ipcMain.handle('editor:choose', (event) =>
    chooseApplication(BrowserWindow.fromWebContents(event.sender))
  );

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
