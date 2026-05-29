// ── App scaffolding templates ─────────────────────────────────────────
// Each template is a plain object of { relativePath: fileContents }.
// Kept inline (not on disk) so they survive the asar bundle without
// requiring extraResources config in electron-builder.

const FAUNA_THEME_CSS = `:root {
  --accent: #1ec882;
  --accent-2: #18a76b;
  --fau-bg: #0f0f0f;
  --fau-surface: #1a1a1a;
  --fau-surface-2: #232323;
  --fau-border: #2a2a2a;
  --fau-text: #e8e8e8;
  --fau-text-muted: #9a9a9a;
  --fau-danger: #e25555;
  --radius-sm: 6px;
  --radius: 10px;
  --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: var(--fau-bg); color: var(--fau-text); font-family: var(--font); }
button { background: var(--accent); color: #04140c; border: none; border-radius: var(--radius-sm); padding: 8px 16px; font-weight: 600; cursor: pointer; font-family: inherit; }
button:hover { background: var(--accent-2); }
input, textarea, select { background: var(--fau-surface); color: var(--fau-text); border: 1px solid var(--fau-border); border-radius: var(--radius-sm); padding: 8px 10px; font-family: inherit; font-size: 14px; }
input:focus, textarea:focus, select:focus { outline: none; border-color: var(--accent); }
`;

const VITE_REACT_TS = {
  'package.json': JSON.stringify({
    name: '__PROJECT_NAME__',
    private: true,
    version: '0.1.0',
    type: 'module',
    scripts: {
      dev: 'vite',
      build: 'tsc -b && vite build',
      preview: 'vite preview',
    },
    dependencies: {
      react: '^18.3.1',
      'react-dom': '^18.3.1',
    },
    devDependencies: {
      '@types/react': '^18.3.3',
      '@types/react-dom': '^18.3.0',
      '@vitejs/plugin-react': '^4.3.1',
      typescript: '^5.5.3',
      vite: '^5.4.1',
    },
  }, null, 2) + '\n',

  'tsconfig.json': JSON.stringify({
    compilerOptions: {
      target: 'ES2020',
      useDefineForClassFields: true,
      lib: ['ES2020', 'DOM', 'DOM.Iterable'],
      module: 'ESNext',
      skipLibCheck: true,
      moduleResolution: 'bundler',
      allowImportingTsExtensions: true,
      resolveJsonModule: true,
      isolatedModules: true,
      noEmit: true,
      jsx: 'react-jsx',
      strict: true,
      noUnusedLocals: false,
      noUnusedParameters: false,
      noFallthroughCasesInSwitch: true,
    },
    include: ['src'],
    references: [{ path: './tsconfig.node.json' }],
  }, null, 2) + '\n',

  'tsconfig.node.json': JSON.stringify({
    compilerOptions: {
      composite: true,
      skipLibCheck: true,
      module: 'ESNext',
      moduleResolution: 'bundler',
      allowSyntheticDefaultImports: true,
      strict: true,
    },
    include: ['vite.config.ts'],
  }, null, 2) + '\n',

  'vite.config.ts': `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
});
`,

  'index.html': `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>__PROJECT_NAME__</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`,

  'src/main.tsx': `import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './theme.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
`,

  'src/App.tsx': `import { useState } from 'react';

export default function App() {
  const [count, setCount] = useState(0);
  return (
    <main style={{ maxWidth: 720, margin: '64px auto', padding: 24 }}>
      <h1>__PROJECT_NAME__</h1>
      <p style={{ color: 'var(--fau-text-muted)' }}>Scaffolded by Fauna. Edit <code>src/App.tsx</code>.</p>
      <button onClick={() => setCount(c => c + 1)}>Count: {count}</button>
    </main>
  );
}
`,

  'src/theme.css': FAUNA_THEME_CSS,

  '.gitignore': `node_modules
dist
.DS_Store
*.local
.env
`,

  'README.md': `# __PROJECT_NAME__

Scaffolded by Fauna (vite-react-ts).

## Scripts
- \`npm run dev\` — start dev server
- \`npm run build\` — production build
- \`npm run preview\` — preview production build
`,
};

const VITE_REACT_TS_SQLITE = {
  ...VITE_REACT_TS,

  'package.json': JSON.stringify({
    name: '__PROJECT_NAME__',
    private: true,
    version: '0.1.0',
    type: 'module',
    scripts: {
      'dev:web': 'vite',
      'dev:server': 'tsx watch server/index.ts',
      dev: 'npm-run-all --parallel dev:web dev:server',
      build: 'tsc -b && vite build && tsc -p server/tsconfig.json',
      start: 'node server/dist/index.js',
    },
    dependencies: {
      '@hono/node-server': '^1.12.0',
      'better-sqlite3': '^11.3.0',
      hono: '^4.5.0',
      react: '^18.3.1',
      'react-dom': '^18.3.1',
      zod: '^3.23.8',
    },
    devDependencies: {
      '@types/better-sqlite3': '^7.6.11',
      '@types/node': '^22.5.0',
      '@types/react': '^18.3.3',
      '@types/react-dom': '^18.3.0',
      '@vitejs/plugin-react': '^4.3.1',
      'npm-run-all': '^4.1.5',
      tsx: '^4.19.0',
      typescript: '^5.5.3',
      vite: '^5.4.1',
    },
  }, null, 2) + '\n',

  'server/tsconfig.json': JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'bundler',
      outDir: './dist',
      rootDir: './',
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      forceConsistentCasingInFileNames: true,
      resolveJsonModule: true,
    },
    include: ['./**/*.ts'],
  }, null, 2) + '\n',

  'server/index.ts': `import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { db, runMigrations } from './db.js';

runMigrations();

const app = new Hono();

app.get('/api/health', (c) => c.json({ ok: true }));

// Example: list all rows from a generic 'items' table (created by migration).
app.get('/api/items', (c) => {
  const rows = db.prepare('SELECT * FROM items ORDER BY id DESC').all();
  return c.json({ items: rows });
});

// Serve the built Vite SPA in production.
app.use('/*', serveStatic({ root: './dist' }));

const port = Number(process.env.PORT) || 3000;
serve({ fetch: app.fetch, port });
console.log(\`[server] http://localhost:\${port}\`);
`,

  'server/db.ts': `import Database from 'better-sqlite3';
import { readFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_DIR = join(__dirname, '..', '.data');
if (!existsSync(DB_DIR)) mkdirSync(DB_DIR, { recursive: true });

export const db = new Database(join(DB_DIR, 'app.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export function runMigrations() {
  db.exec(\`CREATE TABLE IF NOT EXISTS _migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  );\`);
  const dir = join(__dirname, '..', 'migrations');
  if (!existsSync(dir)) return;
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const applied = new Set(db.prepare('SELECT name FROM _migrations').all().map((r: any) => r.name));
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = readFileSync(join(dir, f), 'utf8');
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(f);
      db.exec('COMMIT');
      console.log('[migrate]', f);
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}
`,

  'migrations/0001_init.sql': `-- # 0001_init
-- **Purpose**: Seed initial \`items\` table so the example API has something to query.
-- **Tables changed**: items (new)
-- **Rollback**: DROP TABLE items;

CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`,

  '.gitignore': `node_modules
dist
server/dist
.data
.DS_Store
*.local
.env
`,

  'README.md': `# __PROJECT_NAME__

Scaffolded by Fauna (vite-react-ts-sqlite).

Stack: Vite + React + TypeScript frontend, Hono server, better-sqlite3 persistence.
Database file lives at \`.data/app.db\` (gitignored). Migrations auto-apply on server boot.

## Scripts
- \`npm run dev\` — start Vite + server in parallel
- \`npm run build\` — production build (web + server)
- \`npm start\` — run built server
`,
};

const TEMPLATES = {
  'vite-react-ts': VITE_REACT_TS,
  'vite-react-ts-sqlite': VITE_REACT_TS_SQLITE,
};

export function listTemplates() {
  return Object.keys(TEMPLATES);
}

export function getTemplate(name) {
  return TEMPLATES[name] || null;
}

export function scaffoldTemplate({ template, rootPath, projectName, fs, path }) {
  const tpl = TEMPLATES[template];
  if (!tpl) throw new Error(`unknown template "${template}". Available: ${Object.keys(TEMPLATES).join(', ')}`);
  if (!rootPath) throw new Error('rootPath required');
  fs.mkdirSync(rootPath, { recursive: true });
  const written = [];
  const safeName = String(projectName || 'app').replace(/[^a-z0-9-_]/gi, '-').toLowerCase();
  for (const rel of Object.keys(tpl)) {
    const full = path.join(rootPath, rel);
    const dir = path.dirname(full);
    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(full)) continue; // never overwrite existing files
    const content = String(tpl[rel]).replace(/__PROJECT_NAME__/g, safeName);
    fs.writeFileSync(full, content);
    written.push(rel);
  }
  return { template, rootPath, written, skippedExisting: Object.keys(tpl).length - written.length };
}
