import fs from 'node:fs';
import path from 'node:path';

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
