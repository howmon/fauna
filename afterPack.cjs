// afterPack hook — called by electron-builder after each arch is packaged.
//
// 1. Prevents Spotlight from indexing the temp DMG mount.
// 2. Copies all transitive JS deps of @softeria/ms-365-mcp-server into
//    app.asar.unpacked/node_modules so spawned subprocesses can resolve them.
//    electron-builder copies the package via asarUnpack including any nested
//    node_modules, but does NOT copy deps of THOSE nested packages.
exports.default = async function(context) {
  const fs   = require('fs');
  const path = require('path');

  // 1. Spotlight guard
  const noIndex = path.join(context.appOutDir, '.metadata_never_index');
  try { fs.writeFileSync(noIndex, ''); } catch (_) {}

  // 2. Copy ms-365-mcp-server deps into asar.unpacked
  let resDir;
  try {
    const appName = fs.readdirSync(context.appOutDir).find(f => f.endsWith('.app'));
    if (!appName) return;
    resDir = path.join(context.appOutDir, appName, 'Contents', 'Resources');
  } catch (_) { return; }

  const unpackedMods = path.join(resDir, 'app.asar.unpacked', 'node_modules');
  const softeriaPkg  = path.join(unpackedMods, '@softeria', 'ms-365-mcp-server', 'package.json');
  if (!fs.existsSync(softeriaPkg)) {
    console.log('[afterPack] ms-365-mcp-server not in asar.unpacked, skipping');
    return;
  }

  // srcMods = flat top-level node_modules
  const srcMods = path.join(__dirname, 'node_modules');

  // Collect deps from a given node_modules root (could be nested or top-level).
  // Puts package names into `result` set. Packages resolved through `lookupRoots`
  // in order (first match wins), matching npm's resolution algorithm.
  const collected = new Set();

  function collectFromRoot(pkgName, lookupRoots) {
    if (collected.has(pkgName)) return;
    // Find this package in the lookup roots
    let pkgDir = null;
    for (const root of lookupRoots) {
      const candidate = path.join(root, pkgName);
      if (fs.existsSync(path.join(candidate, 'package.json'))) {
        pkgDir = candidate;
        break;
      }
    }
    if (!pkgDir) return;

    // Only add to the copy list if it's from the TOP-LEVEL srcMods
    // (nested packages are already bundled by asarUnpack)
    if (pkgDir.startsWith(srcMods + path.sep)) {
      collected.add(pkgName);
    }

    // Recurse into this package's deps using its own nested node_modules first
    const nestedRoot = path.join(pkgDir, 'node_modules');
    const newRoots = fs.existsSync(nestedRoot)
      ? [nestedRoot, ...lookupRoots]
      : lookupRoots;

    let deps = {};
    try { deps = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).dependencies || {}; } catch (_) {}
    for (const dep of Object.keys(deps)) collectFromRoot(dep, newRoots);
  }

  // Also scan deps of packages in ms-365-mcp-server's own nested node_modules
  // since those can reference packages in the outer (top-level) node_modules.
  function collectNestedPkgDeps(nestedModsDir, outerLookupRoots) {
    if (!fs.existsSync(nestedModsDir)) return;
    for (const entry of fs.readdirSync(nestedModsDir, { withFileTypes: true })) {
      const pkgNames = entry.name.startsWith('@')
        ? fs.readdirSync(path.join(nestedModsDir, entry.name))
            .filter(n => fs.existsSync(path.join(nestedModsDir, entry.name, n, 'package.json')))
            .map(n => entry.name + '/' + n)
        : [entry.name];
      for (const pkgName of pkgNames) {
        const pkgDir = path.join(nestedModsDir, pkgName);
        if (!fs.existsSync(path.join(pkgDir, 'package.json'))) continue;
        let deps = {};
        try { deps = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).dependencies || {}; } catch (_) {}
        // For each dep: look in the nested mods first, then outer
        const nestedRoot = path.join(pkgDir, 'node_modules');
        const lookupRoots = [
          ...(fs.existsSync(nestedRoot) ? [nestedRoot] : []),
          nestedModsDir,
          ...outerLookupRoots
        ];
        for (const dep of Object.keys(deps)) collectFromRoot(dep, lookupRoots);
      }
    }
  }

  // Start collection from the top-level ms-365-mcp-server
  collectFromRoot('@softeria/ms-365-mcp-server', [srcMods]);
  collected.delete('@softeria/ms-365-mcp-server'); // already in asar.unpacked

  // Also handle deps of packages nested inside ms-365-mcp-server's own node_modules
  const ms365NestedMods = path.join(srcMods, '@softeria', 'ms-365-mcp-server', 'node_modules');
  collectNestedPkgDeps(ms365NestedMods, [ms365NestedMods, srcMods]);

  console.log('[afterPack] Copying ' + collected.size + ' ms-365 dep packages into asar.unpacked...');

  let copied = 0, skipped = 0;
  for (const name of collected) {
    const src  = path.join(srcMods, name);
    const dest = path.join(unpackedMods, name);
    if (fs.existsSync(dest)) { skipped++; continue; }
    if (!fs.existsSync(src)) continue;
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      copyDirSync(src, dest, fs, path);
      copied++;
    } catch (e) {
      console.error('[afterPack] failed to copy ' + name + ':', e.message);
    }
  }
  console.log('[afterPack] done — copied ' + copied + ', skipped ' + skipped + ' already-present');
};

function copyDirSync(src, dest, fs, path) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isSymbolicLink()) {
      try { if (!fs.existsSync(d)) fs.symlinkSync(fs.readlinkSync(s), d); } catch (_) {}
    } else if (entry.isDirectory()) {
      copyDirSync(s, d, fs, path);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}
