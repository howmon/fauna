// ── Project Manager — CRUD, Sources, Contexts, Connectors ────────────────
// Manages projects stored in ~/.config/fauna/projects.json
// Each project can have local/remote sources, saved contexts, and connectors.

import fs   from 'fs';
import path from 'path';
import os   from 'os';
import { execSync, spawn as _spawn } from 'child_process';

const CONFIG_DIR   = path.join(os.homedir(), '.config', 'fauna');
const PROJECTS_FILE = path.join(CONFIG_DIR, 'projects.json');

// Accepted project accent colors (matches --proj-* CSS tokens)
const ACCENT_COLORS = ['teal', 'teal2', 'purple', 'green', 'orange', 'red', 'violet', 'pink'];

// Max content size stored per context (256 KB)
const MAX_CONTEXT_BYTES = 256 * 1024;

// ── File type classification ──────────────────────────────────────────────
const TEXT_EXTS = new Set([
  'js','ts','jsx','tsx','mjs','cjs','json','jsonc','yaml','yml','toml',
  'md','txt','html','htm','css','scss','sass','less','py','go','rs','java','c','cpp','h',
  'sh','bash','zsh','fish','env','gitignore','sql','graphql','gql','graphqls','xml','csv','log',
  'rb','php','swift','kt','dart','ex','exs','lua','vim','conf','ini','cfg',
  'hpp','hh','cc','cs','vb','r','m','mm','pl','hs','ml','proto','thrift',
  'tf','tfvars','bicep','svelte','vue','astro','mdx','tex','rst',
  'lock','gradle','properties','pom','f','f90',
  'prisma','snap','njk','ejs','pug','hbs','mustache','twig',
  'patch','diff','cmake','mk','bat','cmd','ps1','psm1',
  'erl','clj','cljs','scala','groovy','kt','kts','nim','zig','v','d',
  'plist','strings','entitlements','pbxproj',
  'crt','pem','pub','asc',
  'applescript','awk','sed','tcl',
  'org','adoc','asciidoc','textile','wiki',
  'npmrc','nvmrc','yarnrc','bowerrc','stylelintrc','huskyrc',
  'editorconfig','prettierrc','eslintrc','babelrc','tsconfig','jsconfig',
  'browserslistrc','postcssrc','swcrc',
]);

// Extensionless files recognised as text by basename (case-insensitive)
const TEXT_BASENAMES = new Set([
  'makefile','dockerfile','containerfile','gemfile','rakefile','procfile',
  'vagrantfile','brewfile','justfile','taskfile','cakefile','guardfile',
  'license','licence','copying','authors','contributors','changelog',
  'readme','todo','news','history','notice','install','maintainers',
  'codeowners','watchmanconfig','flowconfig','gitattributes','gitmodules',
  'gitignore','dockerignore','npmignore','eslintignore','prettierignore',
  'hgignore','stylelintignore','slugignore','vercelignore','nowignore',
  'htaccess','htpasswd',
]);
const IMAGE_EXTS  = new Set(['png','jpg','jpeg','gif','webp','svg','ico','bmp','tiff','tif','avif']);
const VIDEO_EXTS  = new Set(['mp4','webm','mov','avi','mkv','m4v','3gp','ogv']);
const AUDIO_EXTS  = new Set(['mp3','wav','flac','m4a','aac','opus','ogg','oga','wma']);
const PDF_EXTS    = new Set(['pdf']);
const OFFICE_EXTS = new Set(['doc','docx','xls','xlsx','ppt','pptx','odt','ods','odp']);

const MIME_MAP = {
  // Images
  png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', gif:'image/gif',
  webp:'image/webp', svg:'image/svg+xml', ico:'image/x-icon', bmp:'image/bmp',
  tiff:'image/tiff', tif:'image/tiff', avif:'image/avif',
  // Video
  mp4:'video/mp4', webm:'video/webm', mov:'video/quicktime',
  avi:'video/x-msvideo', mkv:'video/x-matroska', m4v:'video/mp4',
  '3gp':'video/3gpp', ogv:'video/ogg',
  // Audio
  mp3:'audio/mpeg', wav:'audio/wav', flac:'audio/flac', m4a:'audio/mp4',
  aac:'audio/aac', opus:'audio/opus', ogg:'audio/ogg', oga:'audio/ogg', wma:'audio/x-ms-wma',
  // Documents
  pdf:'application/pdf',
  doc:'application/msword',
  docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls:'application/vnd.ms-excel',
  xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt:'application/vnd.ms-powerpoint',
  pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt:'application/vnd.oasis.opendocument.text',
  ods:'application/vnd.oasis.opendocument.spreadsheet',
  odp:'application/vnd.oasis.opendocument.presentation',
};

function _fileType(ext, basename) {
  if (TEXT_EXTS.has(ext))   return 'text';
  if (!ext && basename && TEXT_BASENAMES.has(basename.toLowerCase())) return 'text';
  if (IMAGE_EXTS.has(ext))  return 'image';
  if (VIDEO_EXTS.has(ext))  return 'video';
  if (AUDIO_EXTS.has(ext))  return 'audio';
  if (PDF_EXTS.has(ext))    return 'pdf';
  if (OFFICE_EXTS.has(ext)) return 'office';
  return 'unknown'; // caller will attempt text detection
}

// ── Persistence ──────────────────────────────────────────────────────────

function readProjects() {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8')); }
  catch (_) { return []; }
  if (!Array.isArray(raw)) return [];
  // Migrate legacy single-link shape (githubIntegration) to the per-source map
  // (githubIntegrations) so older project files keep working transparently.
  for (const p of raw) {
    if (!p || typeof p !== 'object') continue;
    if (!p.githubIntegrations || typeof p.githubIntegrations !== 'object') {
      p.githubIntegrations = {};
    }
    if (p.githubIntegration && !p.githubIntegrations.__root) {
      p.githubIntegrations.__root = p.githubIntegration;
      delete p.githubIntegration;
    }
  }
  return raw;
}

function writeProjects(projects) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(PROJECTS_FILE, JSON.stringify(projects, null, 2));
}

function now() { return new Date().toISOString(); }
function uid(prefix) {
  return prefix + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
}

// ── Project CRUD ─────────────────────────────────────────────────────────

export function createProject(opts = {}) {
  const projects = readProjects();
  const name = (opts.name || 'New Project').slice(0, 120);
  // Dedupe: if a project with the same (trimmed, case-insensitive) name already
  // exists, return it instead of creating a duplicate. Prevents accidental
  // duplicates from double-clicks, retried tool calls, or agent loops.
  const _normName = name.trim().toLowerCase();
  if (_normName) {
    const existing = projects.find(p => String(p.name || '').trim().toLowerCase() === _normName);
    if (existing) {
      try { console.warn('[projects] createProject: returning existing project with same name:', existing.id, name); } catch (_) {}
      return existing;
    }
  }
  let rootPath = opts.rootPath || null;
  // If no folder is set, auto-create one under ~/Documents/Fauna/<sanitized name>
  if (!rootPath) {
    try {
      const safe = name.trim().replace(/[<>:"/\\|?*\x00-\x1f]+/g, '_').replace(/\s+/g, ' ').slice(0, 80) || 'Untitled Project';
      const base = path.join(os.homedir(), 'Documents', 'Fauna');
      let candidate = path.join(base, safe);
      let n = 2;
      while (fs.existsSync(candidate)) {
        candidate = path.join(base, `${safe} (${n++})`);
        if (n > 999) break;
      }
      fs.mkdirSync(candidate, { recursive: true });
      rootPath = candidate;
    } catch (e) {
      console.warn('[projects] failed to auto-create root folder:', e?.message || e);
      rootPath = null;
    }
  }
  const project = {
    id:              uid('proj'),
    name,
    description:     opts.description || '',
    icon:            opts.icon || null,
    color:           ACCENT_COLORS.includes(opts.color) ? opts.color : 'teal',
    rootPath,
    sources:         [],
    contexts:        [],
    connectors:      [],
    conversationIds: [],
    taskIds:         [],
    defaultAgent:    opts.defaultAgent || null,
    // When true, conversations under this project default to an autonomous
    // agent loop (raised tool-call cap, no half-stop nudges, persistence
    // directive injected). Per-conversation `config.autonomousMode` overrides
    // this. See server/routes/chat.js for the effective resolution order.
    autonomousMode:  opts.autonomousMode === true,
    // Free-text acceptance criteria injected into the system prompt when
    // autonomous mode is on. The model must explicitly satisfy each item
    // before emitting the DONE: marker.
    acceptanceCriteria: opts.acceptanceCriteria || '',
    // QA gate. Before the autonomous loop is allowed to terminate, fauna
    // runs `qa.command` (shell), optionally drives a browser smoke check,
    // and feeds the result back as a tool message. The model can only emit
    // DONE: once QA passes.
    qa: opts.qa || { command: '', browserSmoke: '', requireScreenshot: false },
    // Deploy gate. After QA passes (or after DONE: when no QA is configured),
    // fauna runs `deploy.command` ONLY when `deploy.confirm` has been satisfied
    // — i.e. the user explicitly approved this run via the client (sets a
    // deployApproved flag on the request body). Mirrors Codex's pluggable
    // publishConfirmHook chain. Off by default; opt in per project.
    deploy: opts.deploy || { command: '', confirm: 'always', notes: '' },
    // Lightweight backlog: feature requests + grooming notes the agent can
    // append, list, and prioritize without leaving the project.
    backlog: Array.isArray(opts.backlog) ? opts.backlog : [],
    // Kanban / autopilot config. Off by default. When `kanbanAutopilot` is
    // true, the kanban-worker periodically claims Todo cards assigned to AI
    // and runs them through the pipeline. See kanban-worker.js.
    kanban: Object.assign({
      autopilot: false,            // master switch for AI auto-claim
      concurrency: 3,              // max in-flight AI items per project
      archiveDelayMin: 10,         // auto-archive done items after N min
      maxAiRetries: 2,             // failures before card returns to human
      dailyAiQuota: 10,            // safety cap per UTC day
      columns: null,               // null = use defaults; or override labels
    }, opts.kanban || {}),
    // Per-source GitHub links. Keys are source ids; the special key '__root'
    // refers to the project's own rootPath. Value shape:
    //   { accountId, repo: 'owner/name', defaultBranch, linkedAt }
    // Tokens are stored encrypted in github-accounts.js / credentials-store.js;
    // this map only references which account each git target uses.
    githubIntegrations: opts.githubIntegrations || {},
    // Per-project memory engine config. Mirrors supermemory's container-scoped
    // settings. Defaults are conservative: auto-extraction runs on conversation
    // save (cheap, one LLM call) and proposals are auto-approved.
    memoryConfig: Object.assign({
      autoExtract: 'on-save',       // 'off' | 'on-save' | 'every-turn'
      requireApproval: false,       // when true, proposals stay pending
      retentionDays: 60,            // overrides global DECAY_DAYS for this scope
      contradictionResolution: 'auto', // 'auto' | 'off'
      embeddingsEnabled: false,     // Phase 2 toggle
    }, opts.memoryConfig || {}),
    permissions: {
      shell:     opts.permissions?.shell ?? (rootPath ? { cwd: rootPath } : true),
      fileRead:  opts.permissions?.fileRead  || (rootPath ? [rootPath] : []),
      fileWrite: opts.permissions?.fileWrite || (rootPath ? [rootPath] : []),
      browser:   opts.permissions?.browser ?? false,
    },
    createdAt:    now(),
    updatedAt:    now(),
    lastActiveAt: now(),
  };
  projects.push(project);
  writeProjects(projects);
  return project;
}

export function getProject(id) {
  return readProjects().find(p => p.id === id) || null;
}

export function getAllProjects() {
  const projects = readProjects();
  // Backfill: any project without a rootPath gets one under ~/Documents/Fauna
  let dirty = false;
  for (const p of projects) {
    if (p.rootPath) continue;
    try {
      const safe = String(p.name || 'Untitled Project').trim()
        .replace(/[<>:"/\\|?*\x00-\x1f]+/g, '_').replace(/\s+/g, ' ').slice(0, 80) || 'Untitled Project';
      const base = path.join(os.homedir(), 'Documents', 'Fauna');
      let candidate = path.join(base, safe);
      let n = 2;
      while (fs.existsSync(candidate)) {
        candidate = path.join(base, `${safe} (${n++})`);
        if (n > 999) break;
      }
      fs.mkdirSync(candidate, { recursive: true });
      p.rootPath = candidate;
      p.permissions = p.permissions || {};
      if (p.permissions.shell === undefined || p.permissions.shell === true) p.permissions.shell = { cwd: candidate };
      if (!Array.isArray(p.permissions.fileRead)  || p.permissions.fileRead.length  === 0) p.permissions.fileRead  = [candidate];
      if (!Array.isArray(p.permissions.fileWrite) || p.permissions.fileWrite.length === 0) p.permissions.fileWrite = [candidate];
      p.updatedAt = now();
      dirty = true;
    } catch (e) {
      console.warn('[projects] backfill rootPath failed for', p.id, e?.message || e);
    }
  }
  if (dirty) {
    try { writeProjects(projects); } catch (e) { console.warn('[projects] backfill save failed:', e?.message || e); }
  }
  return projects;
}

export function updateProject(id, patch = {}) {
  const projects = readProjects();
  const idx = projects.findIndex(p => p.id === id);
  if (idx === -1) return null;
  const p = projects[idx];
  // Allowed top-level fields
  const allowed = ['name', 'description', 'icon', 'color', 'rootPath', 'defaultAgent', 'permissions', 'allowFileEditing', 'design', 'autonomousMode', 'acceptanceCriteria', 'qa', 'deploy', 'backlog', 'kanban', 'memoryConfig', 'githubIntegrations'];
  for (const k of allowed) {
    if (patch[k] !== undefined) p[k] = patch[k];
  }
  if (patch.color && !ACCENT_COLORS.includes(patch.color)) p.color = 'teal';
  p.updatedAt = now();
  writeProjects(projects);
  return p;
}

export function deleteProject(id) {
  const projects = readProjects();
  const idx = projects.findIndex(p => p.id === id);
  if (idx === -1) return false;
  // Remove cloned source directories
  const p = projects[idx];
  for (const src of p.sources || []) {
    if (src.type !== 'local') {
      const cloneDir = _sourceCloneDir(id, src.id);
      try { fs.rmSync(cloneDir, { recursive: true, force: true }); } catch (_) {}
    }
  }
  projects.splice(idx, 1);
  writeProjects(projects);
  return true;
}

// Touch lastActiveAt — called when project becomes active
export function touchProject(id) {
  const projects = readProjects();
  const p = projects.find(x => x.id === id);
  if (p) { p.lastActiveAt = now(); writeProjects(projects); }
}

// Link a conversation to a project
export function linkConversation(projectId, convId) {
  const projects = readProjects();
  const p = projects.find(x => x.id === projectId);
  if (!p) return false;
  if (!p.conversationIds.includes(convId)) {
    p.conversationIds.unshift(convId);
    p.updatedAt = now();
    writeProjects(projects);
  }
  return true;
}

// Link a task to a project
export function linkTask(projectId, taskId) {
  const projects = readProjects();
  const p = projects.find(x => x.id === projectId);
  if (!p) return false;
  if (!p.taskIds.includes(taskId)) {
    p.taskIds.unshift(taskId);
    p.updatedAt = now();
    writeProjects(projects);
  }
  return true;
}

// ── Sources ───────────────────────────────────────────────────────────────

function _sourceCloneDir(projectId, srcId) {
  return path.join(CONFIG_DIR, 'projects', projectId, 'sources', srcId);
}

export function addSource(projectId, opts = {}) {
  const projects = readProjects();
  const p = projects.find(x => x.id === projectId);
  if (!p) throw new Error('Project not found');

  const type = opts.type || 'local';
  const allowed = ['local', 'github', 'gitlab', 'bitbucket', 'url'];
  if (!allowed.includes(type)) throw new Error('Invalid source type');

  const src = {
    id:          uid('src'),
    type,
    name:        opts.name || opts.path || opts.url || 'Source',
    path:        opts.path || null,
    url:         opts.url || null,
    connectorId: opts.connectorId || null,
    owner:       opts.owner || null,
    repo:        opts.repo || null,
    branch:      opts.branch || 'main',
    syncedAt:    null,
    status:      'active',
    error:       null,
  };

  // Validate local path exists
  if (type === 'local' && src.path) {
    const resolved = path.resolve(src.path);
    if (!fs.existsSync(resolved)) throw new Error('Path does not exist: ' + resolved);
    src.path = resolved;
    src.name = opts.name || path.basename(resolved);
    src.syncedAt = now();
  }

  p.sources.push(src);
  p.updatedAt = now();
  // Auto-add to fileRead permissions if local
  if (type === 'local' && src.path && !p.permissions.fileRead.includes(src.path)) {
    p.permissions.fileRead.push(src.path);
  }
  writeProjects(projects);
  return src;
}

export function removeSource(projectId, srcId) {
  const projects = readProjects();
  const p = projects.find(x => x.id === projectId);
  if (!p) return false;
  const src = p.sources.find(s => s.id === srcId);
  if (!src) return false;
  // Remove clone dir for remote sources
  if (src.type !== 'local') {
    try { fs.rmSync(_sourceCloneDir(projectId, srcId), { recursive: true, force: true }); } catch (_) {}
  }
  p.sources = p.sources.filter(s => s.id !== srcId);
  p.updatedAt = now();
  writeProjects(projects);
  return true;
}

// Shallow clone / pull for git-backed sources (async)
export async function syncSource(projectId, srcId) {
  const projects = readProjects();
  const p = projects.find(x => x.id === projectId);
  if (!p) throw new Error('Project not found');
  const src = p.sources.find(s => s.id === srcId);
  if (!src) throw new Error('Source not found');

  if (src.type === 'local') {
    // Local — just stat the directory
    if (!fs.existsSync(src.path)) throw new Error('Path does not exist: ' + src.path);
    src.syncedAt = now();
    src.status = 'active';
    writeProjects(projects);
    return src;
  }

  // Resolve clone URL
  let cloneUrl = src.url;
  if (!cloneUrl && (src.type === 'github' || src.type === 'gitlab') && src.owner && src.repo) {
    const base = src.type === 'github' ? 'https://github.com' : 'https://gitlab.com';
    cloneUrl = base + '/' + src.owner + '/' + src.repo + '.git';
  }
  if (!cloneUrl) throw new Error('Cannot determine clone URL');

  // Inject token into URL if connector has one
  if (src.connectorId) {
    const conn = (p.connectors || []).find(c => c.id === src.connectorId);
    if (conn?.accessToken) {
      const u = new URL(cloneUrl);
      u.username = 'oauth2';
      u.password = conn.accessToken;
      cloneUrl = u.toString();
    }
  }

  const cloneDir = _sourceCloneDir(projectId, srcId);
  fs.mkdirSync(cloneDir, { recursive: true });

  src.status = 'syncing';
  writeProjects(projects);

  await new Promise((resolve, reject) => {
    const isClone = !fs.existsSync(path.join(cloneDir, '.git'));
    const args = isClone
      ? ['clone', '--depth=1', '--branch', src.branch || 'main', cloneUrl, cloneDir]
      : ['-C', cloneDir, 'pull', '--ff-only'];
    const proc = _spawn('git', args, { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    let errOut = '';
    proc.stderr.on('data', d => { errOut += d; });
    proc.on('close', code => {
      if (code !== 0) reject(new Error(errOut.trim().slice(0, 300)));
      else resolve();
    });
    proc.on('error', e => reject(e));
  });

  src.status = 'active';
  src.syncedAt = now();
  src.error = null;
  writeProjects(projects);
  return src;
}

// List files in a source at a given sub-path — returns array of {name, path, type, size}
export function listFiles(projectId, srcId, subPath) {
  const p = getProject(projectId);
  if (!p) throw new Error('Project not found');

  let root;
  if (srcId === '__rootpath__') {
    if (!p.rootPath) throw new Error('No root folder set for this project');
    root = p.rootPath;
  } else {
    const src = p.sources.find(s => s.id === srcId);
    if (!src) throw new Error('Source not found');
    root = src.type === 'local' ? src.path : _sourceCloneDir(projectId, srcId);
  }
  if (!root || !fs.existsSync(root)) throw new Error('Source directory not available');

  const rel   = (subPath || '').replace(/^\/+/, '');
  const target = rel ? path.join(root, rel) : root;

  // Security: ensure target is within root
  const resolvedTarget = path.resolve(target);
  const resolvedRoot   = path.resolve(root);
  if (!resolvedTarget.startsWith(resolvedRoot + path.sep) && resolvedTarget !== resolvedRoot) {
    throw new Error('Path traversal not allowed');
  }

  if (!fs.existsSync(resolvedTarget)) throw new Error('Path not found');
  if (!fs.statSync(resolvedTarget).isDirectory()) throw new Error('Not a directory');

  const entries = fs.readdirSync(resolvedTarget, { withFileTypes: true });
  return entries
    .filter(e => !e.name.startsWith('.') || e.name === '.env')  // hide dotfiles except .env preview
    .map(e => {
      const fullPath = path.join(resolvedTarget, e.name);
      const relPath  = path.relative(resolvedRoot, fullPath);
      // Use statSync (follows symlinks) so symlinked directories are detected correctly
      let stat;
      try { stat = fs.statSync(fullPath); } catch (_) { return null; } // skip broken symlinks
      const isDir  = stat.isDirectory();
      const isFile = stat.isFile();
      return {
        name: e.name,
        path: relPath,
        type: isDir ? 'dir' : 'file',
        size: isFile ? stat.size : 0,
        ext:  isFile ? path.extname(e.name).slice(1).toLowerCase() : null,
      };
    })
    .filter(Boolean)
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

// Read a single file within a source — returns {content, size, mime}
export function readSourceFile(projectId, srcId, filePath) {
  const p = getProject(projectId);
  if (!p) throw new Error('Project not found');

  let root;
  if (srcId === '__rootpath__') {
    if (!p.rootPath) throw new Error('No root folder set for this project');
    root = p.rootPath;
  } else {
    const src = p.sources.find(s => s.id === srcId);
    if (!src) throw new Error('Source not found');
    root = src.type === 'local' ? src.path : _sourceCloneDir(projectId, srcId);
  }
  if (!root || !fs.existsSync(root)) throw new Error('Source not available');

  const rel  = (filePath || '').replace(/^\/+/, '');
  const full = path.resolve(path.join(root, rel));
  const resolvedRoot = path.resolve(root);

  if (!full.startsWith(resolvedRoot + path.sep)) throw new Error('Path traversal not allowed');
  if (!fs.existsSync(full)) throw new Error('File not found');
  const stat = fs.statSync(full);
  if (!stat.isFile()) throw new Error('Not a file');

  const ext  = path.extname(full).slice(1).toLowerCase();
  const basename = path.basename(full);
  const mime = MIME_MAP[ext] || 'application/octet-stream';
  let type = _fileType(ext, basename);

  // For unknown types, try to detect text by reading a small sample
  if (type === 'unknown') {
    if (stat.size === 0) {
      type = 'text'; // empty files are safe to show as text
    } else if (stat.size <= 2 * 1024 * 1024) { // up to 2 MB
      try {
        const fd = fs.openSync(full, 'r');
        const sample = Buffer.alloc(Math.min(8192, stat.size));
        fs.readSync(fd, sample, 0, sample.length, 0);
        fs.closeSync(fd);
        // If no null bytes in the sample, treat as text
        type = sample.includes(0) ? 'binary' : 'text';
      } catch (_) {
        type = 'binary';
      }
    } else {
      type = 'binary';
    }
  }

  if (type === 'text') {
    const content = fs.readFileSync(full, 'utf8');
    return { type: 'text', content, size: stat.size, mime: 'text/plain', ext: ext || basename.toLowerCase(), path: rel };
  }

  // Non-text: return metadata only — bytes served by the /raw endpoint
  return { type, size: stat.size, mime, ext, path: rel };
}

// Create a new empty file or directory within a source. `type` must be
// 'file' or 'dir'. Parent directories are created automatically. Refuses
// to overwrite an existing entry. Returns { path, type } of the created
// entry (path is relative to the source root, forward-slash separated).
export function createSourceEntry(projectId, srcId, relPath, type) {
  const p = getProject(projectId);
  if (!p) throw new Error('Project not found');
  if (type !== 'file' && type !== 'dir') throw new Error('Invalid type — expected "file" or "dir"');

  let root;
  if (srcId === '__rootpath__') {
    if (!p.rootPath) throw new Error('No root folder set for this project');
    root = p.rootPath;
  } else {
    const src = p.sources.find(s => s.id === srcId);
    if (!src) throw new Error('Source not found');
    if (src.type !== 'local') throw new Error('Can only create files in local sources');
    root = src.path;
  }
  if (!root || !fs.existsSync(root)) throw new Error('Source directory not available');

  // Normalize: strip leading slashes, reject empty path or just dots
  const rel = String(relPath || '').replace(/^\/+/, '').replace(/\\/g, '/');
  if (!rel || rel === '.' || rel === '..') throw new Error('Invalid path');

  // Reject any segment that's a dot reference or contains a null byte
  const segments = rel.split('/').filter(Boolean);
  if (!segments.length) throw new Error('Invalid path');
  for (const seg of segments) {
    if (seg === '.' || seg === '..') throw new Error('Path traversal not allowed');
    if (seg.includes('\0')) throw new Error('Invalid filename');
  }

  const full = path.resolve(path.join(root, rel));
  const resolvedRoot = path.resolve(root);
  if (!full.startsWith(resolvedRoot + path.sep) && full !== resolvedRoot) {
    throw new Error('Path traversal not allowed');
  }
  if (fs.existsSync(full)) throw new Error('A file or folder with that name already exists');

  if (type === 'dir') {
    fs.mkdirSync(full, { recursive: true });
  } else {
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, '', 'utf8');
  }

  return { path: rel, type };
}

// Validate path and return absolute file path + metadata (for the /raw streaming endpoint)
export function resolveSourceFilePath(projectId, srcId, filePath) {
  const p = getProject(projectId);
  if (!p) throw new Error('Project not found');

  let root;
  if (srcId === '__rootpath__') {
    if (!p.rootPath) throw new Error('No root folder set for this project');
    root = p.rootPath;
  } else {
    const src = p.sources.find(s => s.id === srcId);
    if (!src) throw new Error('Source not found');
    root = src.type === 'local' ? src.path : _sourceCloneDir(projectId, srcId);
  }
  if (!root || !fs.existsSync(root)) throw new Error('Source not available');

  const rel  = (filePath || '').replace(/^\/+/, '');
  const full = path.resolve(path.join(root, rel));
  const resolvedRoot = path.resolve(root);

  if (!full.startsWith(resolvedRoot + path.sep)) throw new Error('Path traversal not allowed');
  if (!fs.existsSync(full)) throw new Error('File not found');
  const stat = fs.statSync(full);
  if (!stat.isFile()) throw new Error('Not a file');

  const ext  = path.extname(full).slice(1).toLowerCase();
  const mime = MIME_MAP[ext] || 'application/octet-stream';
  return { fullPath: full, mime, size: stat.size, ext };
}

// ── Contexts ─────────────────────────────────────────────────────────────

export function addContext(projectId, opts = {}) {
  const projects = readProjects();
  const p = projects.find(x => x.id === projectId);
  if (!p) throw new Error('Project not found');

  const allowed = ['file', 'url', 'artifact', 'snippet', 'note'];
  const type = opts.type || 'snippet';
  if (!allowed.includes(type)) throw new Error('Invalid context type');

  let content = opts.content || '';
  if (content.length > MAX_CONTEXT_BYTES) {
    content = content.slice(0, MAX_CONTEXT_BYTES) + '\n\n[…truncated]';
  }

  const ctx = {
    id:         uid('ctx'),
    type,
    name:       (opts.name || 'Context').slice(0, 200),
    content,
    path:       opts.path || null,
    url:        opts.url || null,
    artifactId: opts.artifactId || null,
    tags:       opts.tags || [],
    pinned:     opts.pinned || false,
    size:       Buffer.byteLength(content, 'utf8'),
    addedAt:    now(),
    updatedAt:  now(),
  };
  p.contexts.push(ctx);
  p.updatedAt = now();
  writeProjects(projects);
  return ctx;
}

export function updateContext(projectId, ctxId, patch = {}) {
  const projects = readProjects();
  const p = projects.find(x => x.id === projectId);
  if (!p) return null;
  const ctx = p.contexts.find(c => c.id === ctxId);
  if (!ctx) return null;
  const allowed = ['name', 'content', 'pinned', 'tags', 'url'];
  for (const k of allowed) {
    if (patch[k] !== undefined) ctx[k] = patch[k];
  }
  if (ctx.content != null) ctx.size = Buffer.byteLength(ctx.content, 'utf8');
  ctx.updatedAt = now();
  p.updatedAt = now();
  writeProjects(projects);
  return ctx;
}

export function removeContext(projectId, ctxId) {
  const projects = readProjects();
  const p = projects.find(x => x.id === projectId);
  if (!p) return false;
  const before = p.contexts.length;
  p.contexts = p.contexts.filter(c => c.id !== ctxId);
  if (p.contexts.length === before) return false;
  p.updatedAt = now();
  writeProjects(projects);
  return true;
}

// Save an artifact as a named project context
export function contextFromArtifact(projectId, artifactData) {
  const { id: artifactId, title, content, type } = artifactData;
  return addContext(projectId, {
    type:       'artifact',
    name:       title || 'Artifact',
    content:    content || '',
    artifactId: artifactId || null,
    tags:       [type || 'artifact'],
  });
}

// Build a formatted context payload for injection into chat/tasks
export function buildContextPayload(projectId, ctxIds) {
  const p = getProject(projectId);
  if (!p) return '';
  const selected = ctxIds && ctxIds.length
    ? p.contexts.filter(c => ctxIds.includes(c.id))
    : p.contexts.filter(c => c.pinned);
  if (!selected.length) return '';
  let out = `## Project: ${p.name}\n`;
  if (p.rootPath) out += `Root: ${p.rootPath}\n`;
  out += '\n';
  for (const ctx of selected) {
    out += `### Context: ${ctx.name} (${ctx.type})\n`;
    if (ctx.url) out += `Source URL: ${ctx.url}\n`;
    if (ctx.path) out += `Full path: ${ctx.path}\n`;
    out += ctx.content ? ctx.content + '\n\n' : '(empty)\n\n';
  }
  return out.trim();
}

// Build project system context (pinned contexts + metadata) for injection
export function getProjectSystemContext(projectId) {
  const p = getProject(projectId);
  if (!p) return '';
  const pinned = p.contexts.filter(c => c.pinned);
  let out = `## Active Project: ${p.name}\n`;
  if (p.description) out += `${p.description}\n`;
  if (p.rootPath) {
    out += `Root path: ${p.rootPath}\n`;
    out += `Working directory: shell and file tools default to this project root. Run commands here unless a source below points elsewhere. Do NOT operate on other projects' directories.\n`;
  }
  if (p.sources && p.sources.length) {
    out += '\n### Sources\n';
    for (const src of p.sources) {
      const loc = src.type === 'local' && src.path ? ` — \`${src.path}\`` :
                  src.url ? ` — ${src.url}` : '';
      out += `- **${src.name}** (${src.type})${loc}\n`;
    }
  }
  // Auto-load AGENTS.md / FAUNA.md / CLAUDE.md from the project root if present.
  // Mirrors the convention used by Codex, Claude Code, and Aider — projects can
  // drop a markdown file at the repo root with conventions, build commands,
  // and constraints, and any agent working in that root will pick it up.
  if (p.rootPath) {
    const candidates = ['AGENTS.md', 'FAUNA.md', 'CLAUDE.md'];
    for (const name of candidates) {
      try {
        const full = path.join(p.rootPath, name);
        if (fs.existsSync(full)) {
          const stat = fs.statSync(full);
          if (stat.size > 0 && stat.size < 64 * 1024) {
            const body = fs.readFileSync(full, 'utf8').trim();
            if (body) {
              out += `\n### Project Conventions (from ${name})\n${body}\n`;
              break; // first match wins
            }
          }
        }
      } catch (_) { /* ignore */ }
    }
  }
  if (pinned.length) {
    out += '\n### Pinned Project Contexts\n';
    for (const ctx of pinned) {
      out += `\n#### ${ctx.name}\n${ctx.content || '(empty)'}\n`;
    }
  }
  return out;
}

// ── Connectors ────────────────────────────────────────────────────────────

export function addConnector(projectId, opts = {}) {
  const projects = readProjects();
  const p = projects.find(x => x.id === projectId);
  if (!p) throw new Error('Project not found');

  const allowed = ['github', 'gitlab', 'bitbucket'];
  const type = opts.type;
  if (!allowed.includes(type)) throw new Error('Invalid connector type');

  // Never store tokens in the JSON file — callers must pass them separately
  // and use the OS keychain. For now we store a hashed hint only.
  const conn = {
    id:         uid('conn'),
    type,
    name:       opts.name || (type.charAt(0).toUpperCase() + type.slice(1)),
    baseUrl:    opts.baseUrl || (type === 'github' ? 'https://api.github.com' : type === 'gitlab' ? 'https://gitlab.com/api/v4' : 'https://api.bitbucket.org/2.0'),
    authType:   opts.authType || 'pat',
    // accessToken is stored in memory only — not written to disk
    status:     'disconnected',
    addedAt:    now(),
  };
  // Test connectivity if token provided (transient)
  if (opts.accessToken) {
    conn._accessToken = opts.accessToken; // transient, not written
    conn.status = 'connected';
  }
  p.connectors = p.connectors || [];
  p.connectors.push(conn);
  p.updatedAt = now();
  writeProjects(projects);
  return conn;
}

export function removeConnector(projectId, connId) {
  const projects = readProjects();
  const p = projects.find(x => x.id === projectId);
  if (!p) return false;
  const before = (p.connectors || []).length;
  p.connectors = (p.connectors || []).filter(c => c.id !== connId);
  if (p.connectors.length === before) return false;
  // Remove any sources that used this connector
  p.sources = p.sources.filter(s => s.connectorId !== connId);
  p.updatedAt = now();
  writeProjects(projects);
  return true;
}

// Test a connector's PAT against its API
export async function testConnector(projectId, connId, accessToken) {
  const p = getProject(projectId);
  if (!p) throw new Error('Project not found');
  const conn = (p.connectors || []).find(c => c.id === connId);
  if (!conn) throw new Error('Connector not found');

  const headers = { 'Authorization': 'Bearer ' + accessToken, 'User-Agent': 'Fauna/1.0' };
  let testUrl = conn.baseUrl;
  if (conn.type === 'github')    testUrl += '/user';
  if (conn.type === 'gitlab')    testUrl += '/user';
  if (conn.type === 'bitbucket') testUrl += '/user';

  const res = await fetch(testUrl, { headers });
  if (!res.ok) throw new Error('Authentication failed: ' + res.status);
  const data = await res.json();
  return { ok: true, login: data.login || data.username || data.display_name || '?' };
}

// List repos for a connector
export async function listRepos(projectId, connId, accessToken) {
  const p = getProject(projectId);
  if (!p) throw new Error('Project not found');
  const conn = (p.connectors || []).find(c => c.id === connId);
  if (!conn) throw new Error('Connector not found');

  const headers = { 'Authorization': 'Bearer ' + accessToken, 'User-Agent': 'Fauna/1.0' };
  let url;
  if (conn.type === 'github')    url = conn.baseUrl + '/user/repos?per_page=100&sort=updated';
  if (conn.type === 'gitlab')    url = conn.baseUrl + '/projects?membership=true&per_page=50&order_by=last_activity_at';
  if (conn.type === 'bitbucket') url = conn.baseUrl + '/repositories?role=member&pagelen=50';

  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error('API error: ' + res.status);
  const data = await res.json();

  // Normalise to {name, fullName, url, defaultBranch}
  if (conn.type === 'github') {
    return (data || []).map(r => ({ name: r.name, fullName: r.full_name, url: r.clone_url, defaultBranch: r.default_branch || 'main', private: r.private }));
  }
  if (conn.type === 'gitlab') {
    return (data || []).map(r => ({ name: r.name, fullName: r.path_with_namespace, url: r.http_url_to_repo, defaultBranch: r.default_branch || 'main', private: r.visibility !== 'public' }));
  }
  if (conn.type === 'bitbucket') {
    return ((data.values) || []).map(r => ({ name: r.name, fullName: r.full_name, url: r.links?.clone?.find(l => l.name === 'https')?.href, defaultBranch: r.mainbranch?.name || 'main', private: r.is_private }));
  }
  return [];
}

// ── Backlog helpers (Phase 3 — feature intake + prioritization) ──────────
// Backlog items live on the project record itself so they roll up with
// project export and don't require a separate store. Items are small.
//
// Phase 6+ (Kanban): the legacy `status` field (new|groomed|in-progress|
// done|dropped) is mirrored onto `column` (backlog|todo|in_progress|review|
// done|archived). Both fields are kept on disk so older code paths keep
// working. `_migrateWorkItem` synchronises them on read/write.

const _RICE_DEFAULTS = { reach: 1, impact: 1, confidence: 1, effort: 1 };

// Allowed Kanban columns + canonical transitions. The board accepts manual
// moves between any two columns (humans drag freely); the worker is
// restricted to the canonical forward path. See moveWorkItem.
export const WORK_ITEM_COLUMNS = ['backlog', 'todo', 'in_progress', 'review', 'done', 'archived'];
export const WORK_ITEM_PRIORITIES = ['p0', 'p1', 'p2', 'p3'];

// Map legacy `status` ↔ new `column`. Done lazily on read; persisted on
// next write through addBacklogItem / updateBacklogItem / moveWorkItem.
const _STATUS_TO_COLUMN = {
  'new':         'backlog',
  'groomed':     'todo',
  'in-progress': 'in_progress',
  'in_progress': 'in_progress',
  'review':      'review',
  'done':        'done',
  'dropped':     'archived',
  'archived':    'archived',
};
const _COLUMN_TO_STATUS = {
  'backlog':     'new',
  'todo':        'groomed',
  'in_progress': 'in-progress',
  'review':      'in-progress',
  'done':        'done',
  'archived':    'dropped',
};

function _migrateWorkItem(item) {
  if (!item || typeof item !== 'object') return item;
  // Derive column from status if missing
  if (!item.column) {
    item.column = _STATUS_TO_COLUMN[item.status] || 'backlog';
  } else if (!WORK_ITEM_COLUMNS.includes(item.column)) {
    item.column = 'backlog';
  }
  // Keep legacy status in sync from column if missing/inconsistent
  if (!item.status) {
    item.status = _COLUMN_TO_STATUS[item.column] || 'new';
  }
  // Defaults for new Kanban fields
  if (item.assignee === undefined)        item.assignee = null;          // 'ai' | 'human' | null
  if (item.claimedBy === undefined)       item.claimedBy = null;         // 'ai:<agent>' | 'user:<id>' | null
  if (item.lockedByUser === undefined)    item.lockedByUser = false;
  if (!WORK_ITEM_PRIORITIES.includes(item.priority)) item.priority = item.priority || 'p2';
  if (item.estimateMinutes === undefined) item.estimateMinutes = null;
  if (item.dueAt === undefined)           item.dueAt = null;
  if (item.parentId === undefined)        item.parentId = null;
  if (!Array.isArray(item.blockedBy))     item.blockedBy = [];
  if (item.acceptance === undefined)      item.acceptance = '';
  // Optional model override for AI runs. null = inherit from settings.
  if (item.model === undefined)           item.model = null;
  if (!Array.isArray(item.runs))          item.runs = [];
  if (!Array.isArray(item.comments))      item.comments = [];
  if (!item.movedAt)                      item.movedAt = item.updatedAt || item.createdAt || now();
  if (item.researchOf === undefined)      item.researchOf = null;
  // ── P7 verification fields ──
  // verifyCommand: optional per-card shell command to run as a hard gate
  //   before AI may move the card to 'done'. Falls back to project.qa.command.
  // verified: last verification outcome, { ok:bool, exitCode, output, ts, runId }
  //   or null. Reset on every move out of in_progress so stale passes can't
  //   be reused for a different change.
  if (item.verifyCommand === undefined)   item.verifyCommand = null;
  if (item.verified === undefined)        item.verified = null;
  return item;
}

// Idempotent: ensure every item in `arr` has the migrated shape.
function _migrateBacklogArray(arr) {
  if (!Array.isArray(arr)) return [];
  for (const item of arr) _migrateWorkItem(item);
  return arr;
}

export function addBacklogItem(projectId, item = {}) {
  const projects = readProjects();
  const p = projects.find(x => x.id === projectId);
  if (!p) return null;
  if (!Array.isArray(p.backlog)) p.backlog = [];
  const ts = now();
  // Normalise inputs: callers may pass either status or column.
  const column =
    item.column && WORK_ITEM_COLUMNS.includes(item.column) ? item.column :
    item.status ? (_STATUS_TO_COLUMN[item.status] || 'backlog') :
    'backlog';
  const assignee =
    item.assignee === 'ai' || item.assignee === 'human' ? item.assignee : null;
  const priority =
    WORK_ITEM_PRIORITIES.includes(item.priority) ? item.priority : 'p2';
  const entry = {
    id: uid('bk'),
    title: String(item.title || '').slice(0, 200) || 'Untitled item',
    body:  String(item.body  || '').slice(0, 4000),
    status: _COLUMN_TO_STATUS[column] || 'new', // legacy
    column,                                      // canonical
    score: null,
    rice: { ..._RICE_DEFAULTS, ...(item.rice || {}) },
    tags: Array.isArray(item.tags) ? item.tags.slice(0, 10).map(String) : [],
    source: item.source || 'agent', // agent | user | reflection
    assignee,
    claimedBy: item.claimedBy || null,
    lockedByUser: item.lockedByUser === true,
    priority,
    estimateMinutes: Number.isFinite(item.estimateMinutes) ? item.estimateMinutes : null,
    dueAt: item.dueAt || null,
    parentId: item.parentId || null,
    blockedBy: Array.isArray(item.blockedBy) ? item.blockedBy.slice(0, 20).map(String) : [],
    acceptance: String(item.acceptance || '').slice(0, 4000),
    model: item.model ? String(item.model).slice(0, 100) : null,
    runs: [],
    comments: [],
    researchOf: item.researchOf || null,
    verifyCommand: item.verifyCommand ? String(item.verifyCommand).slice(0, 1000) : null,
    verified: null,
    createdAt: ts,
    updatedAt: ts,
    movedAt: ts,
  };
  p.backlog.unshift(entry);
  // Soft cap — projects shouldn't carry unbounded backlogs.
  if (p.backlog.length > 500) p.backlog.length = 500;
  p.updatedAt = ts;
  writeProjects(projects);
  return entry;
}

export function listBacklog(projectId, { status = null, column = null, limit = 200 } = {}) {
  const p = getProject(projectId);
  if (!p) return [];
  const items = _migrateBacklogArray(Array.isArray(p.backlog) ? p.backlog.slice() : []);
  let filtered = items;
  if (column) filtered = filtered.filter(i => i.column === column);
  else if (status) filtered = filtered.filter(i => i.status === status);
  return filtered.slice(0, limit);
}

// Compute a RICE score for each item and persist `score` + `status: 'groomed'`.
// `method` is 'rice' (default) or 'moscow'. MoSCoW just buckets by tags.
export function prioritizeBacklog(projectId, { method = 'rice' } = {}) {
  const projects = readProjects();
  const p = projects.find(x => x.id === projectId);
  if (!p) return null;
  if (!Array.isArray(p.backlog) || !p.backlog.length) return { ok: true, items: [] };
  _migrateBacklogArray(p.backlog);
  for (const item of p.backlog) {
    if (method === 'moscow') {
      const tag = (item.tags || []).map(t => t.toLowerCase());
      item.score = tag.includes('must') ? 4 : tag.includes('should') ? 3 : tag.includes('could') ? 2 : tag.includes('wont') ? 1 : 0;
    } else {
      const r = { ..._RICE_DEFAULTS, ...(item.rice || {}) };
      const effort = Math.max(0.25, Number(r.effort) || 1);
      item.score = Math.round(((Number(r.reach) || 0) * (Number(r.impact) || 0) * (Number(r.confidence) || 0)) / effort * 100) / 100;
    }
    // Grooming promotes brand-new cards to the Todo column so the AI worker
    // can pick them up. We don't touch items already past Todo.
    if (item.status === 'new' || item.column === 'backlog') {
      item.status = 'groomed';
      item.column = 'todo';
      item.movedAt = now();
    }
    item.updatedAt = now();
  }
  p.backlog.sort((a, b) => (b.score || 0) - (a.score || 0));
  p.updatedAt = now();
  writeProjects(projects);
  return { ok: true, items: p.backlog.slice(0, 50) };
}

export function updateBacklogItem(projectId, itemId, patch = {}) {
  const projects = readProjects();
  const p = projects.find(x => x.id === projectId);
  if (!p || !Array.isArray(p.backlog)) return null;
  _migrateBacklogArray(p.backlog);
  const it = p.backlog.find(x => x.id === itemId);
  if (!it) return null;
  const allow = [
    'title', 'body', 'status', 'rice', 'tags',
    'assignee', 'priority', 'estimateMinutes', 'dueAt',
    'parentId', 'blockedBy', 'acceptance', 'lockedByUser', 'researchOf',
    'verifyCommand', 'model',
  ];
  for (const k of allow) if (patch[k] !== undefined) it[k] = patch[k];
  // Keep column ↔ status mirrored if status was changed externally
  if (patch.status !== undefined && _STATUS_TO_COLUMN[patch.status]) {
    it.column = _STATUS_TO_COLUMN[patch.status];
  }
  if (patch.column !== undefined && WORK_ITEM_COLUMNS.includes(patch.column)) {
    it.column = patch.column;
    it.status = _COLUMN_TO_STATUS[patch.column] || it.status;
  }
  it.updatedAt = now();
  p.updatedAt = now();
  writeProjects(projects);
  return it;
}

// ── Kanban: column move, claim, comment, lock, global list ───────────────

const _AI_FORWARD_PATH = ['todo', 'in_progress', 'review', 'done', 'archived'];

/**
 * Move a work item between Kanban columns.
 *
 * @param projectId
 * @param itemId
 * @param patch    { column, assignee?, claimedBy?, runEntry? }
 * @param opts     { actor: 'human' | 'ai', strict?: bool }
 *
 * `strict: true` (used by the worker) restricts moves to the canonical AI
 * forward path: todo → in_progress → review → done → archived. Backward
 * moves are rejected unless actor is 'human'.
 */
export function moveWorkItem(projectId, itemId, patch = {}, opts = {}) {
  const actor = opts.actor === 'ai' ? 'ai' : 'human';
  const strict = opts.strict === true;
  const projects = readProjects();
  const p = projects.find(x => x.id === projectId);
  if (!p || !Array.isArray(p.backlog)) return { ok: false, error: 'project not found' };
  _migrateBacklogArray(p.backlog);
  const it = p.backlog.find(x => x.id === itemId);
  if (!it) return { ok: false, error: 'item not found' };

  const targetCol = patch.column;
  if (targetCol && !WORK_ITEM_COLUMNS.includes(targetCol)) {
    return { ok: false, error: 'invalid column: ' + targetCol };
  }

  // Locked cards: AI cannot move them. Humans can.
  if (it.lockedByUser && actor === 'ai') {
    return { ok: false, error: 'item is locked by user' };
  }

  // AI-claimed cards are only movable by the claiming agent (or any human).
  if (actor === 'ai' && it.claimedBy && it.claimedBy.startsWith('user:')) {
    return { ok: false, error: 'item is claimed by a human' };
  }

  if (targetCol && targetCol !== it.column) {
    if (strict && actor === 'ai') {
      const fromIdx = _AI_FORWARD_PATH.indexOf(it.column);
      const toIdx   = _AI_FORWARD_PATH.indexOf(targetCol);
      if (fromIdx === -1 || toIdx === -1 || toIdx < fromIdx) {
        return { ok: false, error: 'AI cannot move ' + it.column + ' → ' + targetCol };
      }
    }
    // ── P7 verification gate ──
    // AI may only move a card to 'done' when its last verification passed.
    // Humans are trusted (they can mark anything done manually). The gate
    // applies regardless of strict mode — verification is non-negotiable.
    if (actor === 'ai' && targetCol === 'done') {
      const projectQa = (p.qa && p.qa.command && p.qa.command.trim()) || null;
      const hasVerifier = !!(it.verifyCommand || projectQa);
      if (hasVerifier) {
        const v = it.verified;
        if (!v || v.ok !== true) {
          return { ok: false, error: 'cannot move to done without a passing verification (call fauna_workitem_verify first)' };
        }
        // Tie verification to the most recent in_progress run so a stale
        // pass from a previous attempt can't be reused.
        const lastRun = it.runs.length ? it.runs[it.runs.length - 1] : null;
        if (lastRun && v.runId && lastRun.taskId && v.runId !== lastRun.taskId) {
          return { ok: false, error: 'verification is stale (from a previous run) — re-verify before moving to done' };
        }
      }
    }
    // Reset verified when leaving in_progress backwards or being reassigned.
    if (it.column === 'in_progress' && targetCol === 'todo') {
      it.verified = null;
    }
    it.column = targetCol;
    it.status = _COLUMN_TO_STATUS[targetCol] || it.status;
    it.movedAt = now();
  }
  if (patch.assignee !== undefined) {
    it.assignee = (patch.assignee === 'ai' || patch.assignee === 'human') ? patch.assignee : null;
  }
  if (patch.claimedBy !== undefined) it.claimedBy = patch.claimedBy || null;
  if (patch.runEntry && typeof patch.runEntry === 'object') {
    it.runs.push({ ts: Date.now(), ...patch.runEntry });
    if (it.runs.length > 50) it.runs.splice(0, it.runs.length - 50);
  }
  it.updatedAt = now();
  p.updatedAt = now();
  writeProjects(projects);
  return { ok: true, item: it };
}

export function addWorkItemComment(projectId, itemId, { author = 'human', body = '' } = {}) {
  const projects = readProjects();
  const p = projects.find(x => x.id === projectId);
  if (!p || !Array.isArray(p.backlog)) return null;
  _migrateBacklogArray(p.backlog);
  const it = p.backlog.find(x => x.id === itemId);
  if (!it) return null;
  const comment = {
    id: uid('cmt'),
    author: author === 'ai' ? 'ai' : 'human',
    body: String(body || '').slice(0, 4000),
    ts: Date.now(),
  };
  it.comments.push(comment);
  if (it.comments.length > 200) it.comments.splice(0, it.comments.length - 200);
  it.updatedAt = now();
  p.updatedAt = now();
  writeProjects(projects);
  return comment;
}

export function setWorkItemLock(projectId, itemId, locked) {
  const projects = readProjects();
  const p = projects.find(x => x.id === projectId);
  if (!p || !Array.isArray(p.backlog)) return null;
  _migrateBacklogArray(p.backlog);
  const it = p.backlog.find(x => x.id === itemId);
  if (!it) return null;
  it.lockedByUser = locked === true;
  it.updatedAt = now();
  p.updatedAt = now();
  writeProjects(projects);
  return it;
}

/**
 * Record the result of a verification run for a work item. The shape is
 *   { ok:bool, exitCode:number|null, output:string, ts:number, runId:string|null,
 *     command:string, source:'shell'|'judge' }
 * `runId` should be the task-runner task id (if any) so moveWorkItem can
 * detect stale verifications from earlier attempts.
 */
export function setWorkItemVerification(projectId, itemId, verification) {
  const projects = readProjects();
  const p = projects.find(x => x.id === projectId);
  if (!p || !Array.isArray(p.backlog)) return null;
  _migrateBacklogArray(p.backlog);
  const it = p.backlog.find(x => x.id === itemId);
  if (!it) return null;
  if (!verification || typeof verification !== 'object') {
    it.verified = null;
  } else {
    it.verified = {
      ok:        verification.ok === true,
      exitCode:  Number.isFinite(verification.exitCode) ? verification.exitCode : null,
      output:    String(verification.output || '').slice(0, 8000),
      ts:        Date.now(),
      runId:     verification.runId || null,
      command:   String(verification.command || '').slice(0, 1000),
      source:    verification.source === 'judge' ? 'judge' : 'shell',
    };
  }
  it.updatedAt = now();
  p.updatedAt = now();
  writeProjects(projects);
  return it;
}

/**
 * List work items across every project. Filters compose with AND.
 * Each item is annotated with { projectId, projectName, projectColor }.
 */
export function listAllWorkItems({ column = null, assignee = null, claimedBy = null, limit = 1000 } = {}) {
  const out = [];
  for (const p of readProjects()) {
    if (!Array.isArray(p.backlog) || !p.backlog.length) continue;
    _migrateBacklogArray(p.backlog);
    for (const it of p.backlog) {
      if (column && it.column !== column) continue;
      if (assignee && it.assignee !== assignee) continue;
      if (claimedBy && it.claimedBy !== claimedBy) continue;
      out.push({ ...it, projectId: p.id, projectName: p.name, projectColor: p.color });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/**
 * Get the per-project board grouped by column. Useful for the UI render.
 */
export function getProjectBoard(projectId) {
  const p = getProject(projectId);
  if (!p) return null;
  _migrateBacklogArray(p.backlog || []);
  const columns = Object.fromEntries(WORK_ITEM_COLUMNS.map(c => [c, []]));
  for (const it of (p.backlog || [])) {
    (columns[it.column] || columns.backlog).push(it);
  }
  return {
    projectId: p.id,
    projectName: p.name,
    columns,
    kanban: p.kanban || {},
    qa: p.qa || null,
  };
}

// ── Autonomous-run telemetry (Phase 5) ───────────────────────────────────
// Append-only JSONL log per project per day. Lives under
// ~/.config/fauna/autonomous-runs/<projectId>-YYYY-MM-DD.jsonl
const AUTONOMOUS_RUNS_DIR = path.join(CONFIG_DIR, 'autonomous-runs');

export function appendAutonomousRunLog(projectId, runData = {}) {
  try {
    fs.mkdirSync(AUTONOMOUS_RUNS_DIR, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    const file = path.join(AUTONOMOUS_RUNS_DIR, `${projectId || 'global'}-${day}.jsonl`);
    fs.appendFileSync(file, JSON.stringify({ ts: Date.now(), ...runData }) + '\n');
    return file;
  } catch (e) {
    console.warn('[autonomous-runs] failed to append log:', e?.message || e);
    return null;
  }
}
