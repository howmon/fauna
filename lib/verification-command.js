import fs from 'node:fs';
import path from 'node:path';

export function resolveBrowserExtensionRoot(rootPath, files = []) {
  const root = path.resolve(rootPath || process.cwd());
  const withinRoot = target => target === root || target.startsWith(root + path.sep);
  const targets = files.length ? files.map(file => path.resolve(root, typeof file === 'string' ? file : file.path)) : [root];
  const roots = targets.map(target => {
    if (!withinRoot(target)) return null;
    let directory = target === root ? root : path.dirname(target);
    while (withinRoot(directory)) {
      const manifestPath = path.join(directory, 'manifest.json');
      if (fs.existsSync(manifestPath)) {
        try {
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
          return [2, 3].includes(manifest.manifest_version) && typeof manifest.name === 'string'
            && typeof manifest.version === 'string' ? directory : null;
        } catch (error) {
          console.warn('[verification] cannot inspect extension manifest:', error.message);
          return null;
        }
      }
      if (directory === root || fs.existsSync(path.join(directory, 'package.json'))) break;
      directory = path.dirname(directory);
    }
    return null;
  });
  return roots[0] && roots.every(directory => directory === roots[0]) ? roots[0] : null;
}

export function resolveVerificationRoot(rootPath, files = []) {
  const root = path.resolve(rootPath || process.cwd());
  const withinRoot = directory => {
    const relative = path.relative(root, directory);
    return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
  };
  const nearestPackage = directory => {
    while (withinRoot(directory)) {
      if (fs.existsSync(path.join(directory, 'package.json')) || fs.existsSync(path.join(directory, 'pyproject.toml'))) {
        return directory;
      }
      if (directory === root) break;
      directory = path.dirname(directory);
    }
    return root;
  };
  const packages = [];
  for (const file of files) {
    const name = typeof file === 'string' ? file : file?.path;
    if (!name) continue;
    const target = path.resolve(root, name.split(/[*?{]/, 1)[0]);
    if (!withinRoot(target)) continue;
    let directory = path.dirname(target);
    try {
      if (fs.existsSync(target) && fs.statSync(target).isDirectory()) directory = target;
    } catch (error) {
      console.warn('[verification] cannot inspect changed path:', error.message);
    }
    packages.push(nearestPackage(directory));
  }
  if (!packages.length) return root;
  let common = packages[0];
  while (!packages.every(directory => directory === common || directory.startsWith(common + path.sep))) {
    common = path.dirname(common);
  }
  return nearestPackage(common);
}

// Ignore environment setup and version probes when recognizing a retry.
export function validationCommandKeys(command, cwd) {
  const text = String(command || '');
  // Only reuse straightforward successful command chains. Pipes, conditionals,
  // substitutions, and redirections can mask failure or merely print a command.
  if (/[<>`]|[$]\(|(?:^|\s)#/.test(text)) return [];
  const pieces = text.match(/(?:[^"';&|\n]|"(?:\\.|[^"\\])*"|'[^']*')+|&&|[;&|\n]/g) || [];
  if (pieces.join('') !== text || pieces.some(value => /^[;&|\n]$/.test(value))) return [];
  const invocations = pieces.flatMap(piece => {
    const match = piece.trim().match(
      /^(?:env\s+)?(?:[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\S+)\s+)*((?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test(?::[\w:-]+)?|lint|typecheck|check|build)|(?:\.\/node_modules\/\.bin\/)?(?:vitest|jest|pytest|tsc|eslint)|cargo\s+test|go\s+test|mvn\s+test|gradle\s+test)\b.*)$/,
    );
    return match ? [match[1]] : [];
  });
  return invocations.map(value => path.resolve(cwd) + '\n' + value.trim()
    .replace(/^(npm|pnpm|yarn|bun)\s+(?:run\s+)?/, '$1 run '));
}

// Discover existing tests without installing a runner or entering watch mode.
export function detectAutoVerifyCommand(rootPath) {
  if (!rootPath) return null;
  const pkgPath = path.join(rootPath, 'package.json');
  try {
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const scripts = pkg.scripts || {};
      const manager = /^pnpm@/.test(pkg.packageManager || '') || fs.existsSync(path.join(rootPath, 'pnpm-lock.yaml'))
        ? 'pnpm'
        : /^yarn@/.test(pkg.packageManager || '') || fs.existsSync(path.join(rootPath, 'yarn.lock'))
          ? 'yarn'
          : /^bun@/.test(pkg.packageManager || '') || fs.existsSync(path.join(rootPath, 'bun.lock'))
            || fs.existsSync(path.join(rootPath, 'bun.lockb')) ? 'bun' : 'npm';
      for (const name of ['test:ci', 'test:unit', 'test']) {
        const script = scripts[name];
        if (typeof script !== 'string' || !script.trim() || /no test specified/i.test(script)) continue;
        if (/(?:--watch\b|(?:^|\s)watch(?:\s|$))/.test(script)) continue;
        const run = manager + ' run ' + name;
        return /\bvitest\b/.test(script) && !/\b(?:run|--run)\b/.test(script)
          ? run + (manager === 'npm' ? ' -- --run' : ' --run') : run;
      }
      if (pkg.devDependencies?.vitest || pkg.dependencies?.vitest) {
        return './node_modules/.bin/vitest run';
      }
    }
    if (fs.existsSync(path.join(rootPath, 'tests')) && fs.existsSync(path.join(rootPath, 'pyproject.toml'))) {
      return 'pytest -q';
    }
  } catch (error) {
    console.warn('[verification] cannot inspect test configuration:', error.message);
  }
  return null;
}
