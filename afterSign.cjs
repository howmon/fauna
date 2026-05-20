exports.default = async function(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const fs = require('fs');
  const path = require('path');
  const { execFileSync, spawnSync } = require('child_process');
  const { resignWorkiqBinaries } = require('./afterPack.cjs');

  const contentsDir = path.join(
    context.appOutDir,
    context.packager.appInfo.productFilename + '.app',
    'Contents',
  );
  const resDir = path.join(contentsDir, 'Resources');
  if (!fs.existsSync(resDir)) return;

  resignWorkiqBinaries({ fs, path, execFileSync, spawnSync, resDir, baseDir: __dirname, logPrefix: '[afterSign]' });
};