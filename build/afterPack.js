// electron-builder leaves the bundle unsigned when `mac.identity` is null: the
// main binary keeps Electron's own linker ad-hoc signature, but the bundle has
// no sealed resources, so a copy that ever picks up a quarantine flag (AirDrop,
// a download, another Mac) is refused by Gatekeeper as "damaged" rather than
// merely "unidentified developer".
//
// Ad-hoc signing the finished bundle costs nothing, needs no Apple account,
// and turns that hard failure into the normal right-click -> Open prompt.
const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  );

  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], {
    stdio: 'inherit'
  });
};
