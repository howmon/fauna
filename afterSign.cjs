/**
 * afterSign.cjs — runs after electron-builder signs the .app
 *
 * Submits to Apple notarization using the "fauna-notarize" keychain profile
 * (stored via: xcrun notarytool store-credentials "fauna-notarize" ...)
 * then staples the ticket so Gatekeeper accepts the app offline.
 *
 * Only runs on macOS and only when SKIP_NOTARIZE is not set.
 */

'use strict';

const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const KEYCHAIN_PROFILE = 'fauna-notarize';

module.exports = async function afterSign(context) {
  const { electronPlatformName, appOutDir, packager } = context;

  if (electronPlatformName !== 'darwin') return;
  if (process.env.SKIP_NOTARIZE === '1') {
    console.log('[afterSign] SKIP_NOTARIZE=1 — skipping notarization');
    return;
  }

  const appName = packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);

  if (!fs.existsSync(appPath)) {
    console.warn(`[afterSign] App not found at ${appPath} — skipping notarization`);
    return;
  }

  // Zip the .app into a temp file for submission
  const tmpZip = path.join(os.tmpdir(), `${appName}-notarize-${Date.now()}.zip`);
  console.log(`[afterSign] Zipping ${appPath} → ${tmpZip}`);
  execFileSync('ditto', ['-c', '-k', '--keepParent', appPath, tmpZip], { stdio: 'inherit' });

  try {
    // Submit and wait (--wait blocks until Apple approves or rejects, typically 1–3 min)
    console.log('[afterSign] Submitting to Apple notarization service (this takes 1–3 minutes)…');
    execFileSync(
      'xcrun',
      ['notarytool', 'submit', tmpZip, '--keychain-profile', KEYCHAIN_PROFILE, '--wait'],
      { stdio: 'inherit' },
    );

    // Staple the notarization ticket so the app works offline
    console.log('[afterSign] Stapling notarization ticket…');
    execFileSync('xcrun', ['stapler', 'staple', appPath], { stdio: 'inherit' });
    console.log('[afterSign] ✓ Notarization and stapling complete');
  } finally {
    try { fs.unlinkSync(tmpZip); } catch (_) {}
  }
};
