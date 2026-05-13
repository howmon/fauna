/**
 * afterSign.js — electron-builder afterSign hook
 *
 * Runs on every machine before DMG creation. Does two things:
 *
 * 1. Patches the cached dmgbuild/core.py to check the return code of
 *    `hdiutil detach -force`.  The upstream version unconditionally raises
 *    DMGError after calling force-detach, even when the force-detach itself
 *    succeeds — causing the build to fail on machines where something (e.g.
 *    DiskArbitration, Finder, a security agent) briefly delays clean unmounts.
 *    The patch is idempotent: it's a no-op if core.py is already fixed.
 *
 * 2. Briefly kills mds_stores (Spotlight metadata indexer) so it cannot lock
 *    the temp HFS+ disk image that dmgbuild mounts.  mds_stores is a per-user
 *    daemon that macOS auto-restarts within ~1 s, so this is safe.
 */

const path = require('path');
const os   = require('os');
const fs   = require('fs');
const { execSync, execFileSync } = require('child_process');

const BUGGY_DETACH = [
  '    if ret:',
  '        hdiutil("detach", "-force", device, plist=False)',
  '        raise DMGError(callback, f"Unable to detach device cleanly: {output}")',
].join('\n');

const FIXED_DETACH = [
  '    if ret:',
  '        ret2, output2 = hdiutil("detach", "-force", device, plist=False)',
  '        if ret2:',
  '            raise DMGError(callback, f"Unable to detach device cleanly: {output}")',
].join('\n');

function patchDmgbuildCache() {
  const cacheDir = path.join(os.homedir(), 'Library', 'Caches', 'electron-builder');
  if (!fs.existsSync(cacheDir)) return;

  let coreFiles;
  try {
    coreFiles = execFileSync('find', [cacheDir, '-path', '*/dmgbuild/core.py'], { encoding: 'utf8' })
      .trim().split('\n').filter(Boolean);
  } catch (_) { return; }

  for (const corePy of coreFiles) {
    try {
      const src = fs.readFileSync(corePy, 'utf8');
      if (!src.includes(BUGGY_DETACH)) continue; // already patched or different version
      fs.writeFileSync(corePy, src.replace(BUGGY_DETACH, FIXED_DETACH), 'utf8');
      process.stderr.write(`[afterSign] Patched dmgbuild/core.py: ${corePy}\n`);
      // Delete stale bytecode so Python doesn't use the pre-patch .pyc
      const pycacheDir = path.join(path.dirname(corePy), '__pycache__');
      if (fs.existsSync(pycacheDir)) {
        for (const f of fs.readdirSync(pycacheDir)) {
          if (f.startsWith('core.') && f.endsWith('.pyc')) {
            try { fs.unlinkSync(path.join(pycacheDir, f)); } catch (_) {}
          }
        }
      }
    } catch (_) { /* skip unreadable files */ }
  }
}

exports.default = async function afterSign(_context) {
  // 1. Self-applying patch for the dmgbuild force-detach bug
  patchDmgbuildCache();

  // 2. Kill mds_stores briefly so Spotlight can't lock the temp disk image
  try {
    execSync('pkill -x mds_stores', { stdio: 'ignore' });
    await new Promise(r => setTimeout(r, 600));
  } catch (_) {}
};
