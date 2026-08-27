// build/icon.html -> build/icon.png -> build/icon.icns
//
// Why Electron? ImageMagick's svg delegate looks for rsvg-convert, which is
// usually not installed, and without it falls back to its own internal MSVG
// engine — an engine that mangles gradients and silently drops filters (the
// grain here): it does not error, it hands back a wrong PNG. Electron is
// already a devDependency, and Chromium rasterises the source exactly as the
// browser does.
//
// Usage: npm run icon

const { app, BrowserWindow } = require('electron');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const BUILD = path.join(__dirname, '..', 'build');
const SOURCE = path.join(BUILD, 'icon.html');
const ICONSET = path.join(BUILD, 'icon.iconset');
const ICNS = path.join(BUILD, 'icon.icns');
const PNG = path.join(BUILD, 'icon.png');

const SIZE = 1024;

// iconutil wants this list in full and tolerates nothing missing: one
// misnamed or absent entry drops the whole conversion.
const ICONSET_ENTRIES = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024]
];

async function render() {
  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    // 1024 points is taller than most laptop screens. Without this flag the
    // window is fitted to the screen and the capture comes back non-square.
    enableLargerThanScreen: true,
    useContentSize: true,
    webPreferences: { offscreen: false }
  });

  // A syntax error in the source kills the script outright and the page still
  // loads "successfully": what is left is an empty squircle, and the pipeline
  // carries it all the way through believing it is a valid icon. That silent
  // failure happened once; the console is listened to now.
  const consoleErrors = [];
  // Real errors only (level 3). Electron's own security warnings always land
  // in an unpackaged run and are none of our business.
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 3 && !message.includes('Electron Security Warning')) {
      consoleErrors.push(message);
    }
  });

  await win.loadFile(SOURCE);

  // The page builds the SVG with script at load time. did-finish-load does not
  // guarantee the paint is done, so wait a frame.
  await win.webContents.executeJavaScript(
    'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))'
  );

  const drawn = await win.webContents.executeJavaScript(
    "document.getElementById('mesa').childElementCount"
  );
  if (consoleErrors.length) {
    win.destroy();
    throw new Error(`icon.html reported console errors:\n  ${consoleErrors.join('\n  ')}`);
  }
  if (!drawn) {
    win.destroy();
    throw new Error('icon.html drew nothing — the script did not run.');
  }

  let image = await win.webContents.capturePage();
  win.destroy();

  const { width, height } = image.getSize();
  if (width === 0 || height === 0) {
    throw new Error('capturePage came back empty — the window never painted.');
  }

  // On Retina the capture arrives at 2048. Scaling down is what we want
  // anyway: 2048 brought to 1024 cleans up the edges.
  if (width !== SIZE || height !== SIZE) {
    image = image.resize({ width: SIZE, height: SIZE, quality: 'best' });
  }

  fs.writeFileSync(PNG, image.toPNG());
  return { captured: `${width}x${height}` };
}

function buildIcns() {
  fs.rmSync(ICONSET, { recursive: true, force: true });
  fs.mkdirSync(ICONSET, { recursive: true });

  for (const [name, size] of ICONSET_ENTRIES) {
    const out = path.join(ICONSET, name);
    fs.copyFileSync(PNG, out);
    execFileSync('sips', ['-z', String(size), String(size), out], {
      stdio: 'ignore'
    });
  }

  fs.rmSync(ICNS, { force: true });
  execFileSync('iconutil', ['-c', 'icns', ICONSET, '-o', ICNS], {
    stdio: 'inherit'
  });
  fs.rmSync(ICONSET, { recursive: true, force: true });
}

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  app.dock?.hide();
  try {
    const kb = (n) => `${(fs.statSync(n).size / 1024).toFixed(0)} KB`;
    const { captured } = await render();
    console.log(`captured: ${captured}`);
    console.log(`build/icon.png  ${kb(PNG)}`);
    buildIcns();
    console.log(`build/icon.icns ${kb(ICNS)}`);
    app.exit(0);
  } catch (err) {
    console.error(err);
    app.exit(1);
  }
});
