// build/icon.html -> build/icon.png -> build/icon.icns
//
// Neden Electron? ImageMagick'in svg delegate'i kurulu olmayan
// rsvg-convert'e bakıyor, o yoksa kendi iç MSVG motoruna düşüyor — ve o
// motor gradyanları bozup filtreleri (buradaki tanecik) sessizce atıyor:
// hata vermez, yanlış bir PNG verir. Electron zaten devDependency, ve
// Chromium kaynağı tarayıcıdaki haliyle rasterize ediyor.
//
// Kullanım: npm run icon

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

// iconutil bu listenin tamamını ister ve eksiğini tolere etmez: yanlış
// isimlendirilmiş ya da eksik tek bir giriş tüm dönüşümü düşürür.
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
    // 1024 nokta çoğu dizüstü ekranından yüksek. Bu bayrak olmadan pencere
    // ekrana sığdırılır ve kare olmayan bir kare yakalanır.
    enableLargerThanScreen: true,
    useContentSize: true,
    webPreferences: { offscreen: false }
  });

  // Kaynaktaki bir sözdizimi hatası script'i tamamen öldürür ve sayfa yine de
  // "başarıyla" yüklenir: geriye boş bir squircle kalır ve boruhattı bunu
  // geçerli bir ikon sanarak sonuna kadar götürür. Bu sessiz başarısızlık bir
  // kez yaşandı; konsol artık dinleniyor.
  const consoleErrors = [];
  // Yalnızca gerçek hatalar (seviye 3). Electron'un kendi güvenlik uyarıları
  // paketlenmemiş çalıştırmada her zaman düşer ve bizi ilgilendirmez.
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 3 && !message.includes('Electron Security Warning')) {
      consoleErrors.push(message);
    }
  });

  await win.loadFile(SOURCE);

  // Sayfa SVG'yi yükleme anında script ile kuruyor. did-finish-load
  // boyamanın bittiğini garanti etmez; bir kare bekle.
  await win.webContents.executeJavaScript(
    'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))'
  );

  const drawn = await win.webContents.executeJavaScript(
    "document.getElementById('mesa').childElementCount"
  );
  if (consoleErrors.length) {
    win.destroy();
    throw new Error(`icon.html konsol hatası verdi:\n  ${consoleErrors.join('\n  ')}`);
  }
  if (!drawn) {
    win.destroy();
    throw new Error('icon.html hiçbir şey çizmedi — script çalışmamış.');
  }

  let image = await win.webContents.capturePage();
  win.destroy();

  const { width, height } = image.getSize();
  if (width === 0 || height === 0) {
    throw new Error('capturePage boş döndü — pencere hiç boyanmamış.');
  }

  // Retina'da yakalama 2048 gelir. Küçültmek zaten istediğimiz şey: 1024'e
  // indirilen 2048 kenarları temizler.
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
    console.log(`yakalanan: ${captured}`);
    console.log(`build/icon.png  ${kb(PNG)}`);
    buildIcns();
    console.log(`build/icon.icns ${kb(ICNS)}`);
    app.exit(0);
  } catch (err) {
    console.error(err);
    app.exit(1);
  }
});
