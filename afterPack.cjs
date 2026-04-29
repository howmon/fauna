// afterPack hook — prevents Spotlight from indexing the temp DMG mount,
// which would cause hdiutil to fail with "Resource busy" during dmgbuild.
exports.default = async function(context) {
  const fs   = require('fs');
  const path = require('path');
  const noIndex = path.join(context.appOutDir, '.metadata_never_index');
  try { fs.writeFileSync(noIndex, ''); } catch (_) {}
};
