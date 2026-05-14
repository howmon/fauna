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
  try { return JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8')); }
  catch (_) { return []; }
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
  const project = {
    id:              uid('proj'),
    name:            (opts.name || 'New Project').slice(0, 120),
    description:     opts.description || '',
    icon:            opts.icon || null,
    color:           ACCENT_COLORS.includes(opts.color) ? opts.color : 'teal',
    rootPath:        opts.rootPath || null,
    sources:         [],
    contexts:        [],
    connectors:      [],
    conversationIds: [],
    taskIds:         [],
    defaultAgent:    opts.defaultAgent || null,
    permissions: {
      shell:     opts.permissions?.shell ?? (opts.rootPath ? { cwd: opts.rootPath } : true),
      fileRead:  opts.permissions?.fileRead  || (opts.rootPath ? [opts.rootPath] : []),
      fileWrite: opts.permissions?.fileWrite || (opts.rootPath ? [opts.rootPath] : []),
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
  return readProjects();
}

export function updateProject(id, patch = {}) {
  const projects = readProjects();
  const idx = projects.findIndex(p => p.id === id);
  if (idx === -1) return null;
  const p = projects[idx];
  // Allowed top-level fields
  const allowed = ['name', 'description', 'icon', 'color', 'rootPath', 'defaultAgent', 'permissions', 'allowFileEditing', 'design'];
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
  if (p.rootPath) out += `Root path: ${p.rootPath}\n`;
  if (p.sources && p.sources.length) {
    out += '\n### Sources\n';
    for (const src of p.sources) {
      const loc = src.type === 'local' && src.path ? ` — \`${src.path}\`` :
                  src.url ? ` — ${src.url}` : '';
      out += `- **${src.name}** (${src.type})${loc}\n`;
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
