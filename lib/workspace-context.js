import fs from 'fs';
import os from 'os';
import path from 'path';

function _home() { return os.homedir(); }

function _resolveMaybe(input, base) {
  if (!input) return null;
  const text = String(input);
  if (text.startsWith('~/')) return path.resolve(path.join(_home(), text.slice(2)));
  if (path.isAbsolute(text)) return path.resolve(text);
  return path.resolve(base || _home(), text);
}

function _unique(arr) {
  return Array.from(new Set((arr || []).filter(Boolean)));
}

function _readPackageScripts(rootPath) {
  if (!rootPath) return {};
  try {
    const pkgPath = path.join(rootPath, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return pkg && pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  } catch (_) {
    return {};
  }
}

function _preferredValidation(rootPath, project) {
  const scripts = _readPackageScripts(rootPath);
  const commands = [];
  if (project && project.qa && project.qa.command) commands.push({ source: 'project.qa', command: project.qa.command });
  for (const name of ['typecheck', 'lint', 'test', 'build']) {
    if (scripts[name]) commands.push({ source: 'package.json', script: name, command: 'npm run ' + name });
  }
  return commands;
}

export function resolveWorkspaceContext(opts = {}) {
  const project = opts.project || null;
  const projectId = opts.projectId || (project && project.id) || null;
  const conversationId = opts.conversationId || opts.convId || null;
  const rootPath = project && project.rootPath ? path.resolve(project.rootPath) : null;
  const requestedCwd = _resolveMaybe(opts.cwd, rootPath || _home());
  const cwd = requestedCwd || rootPath || _home();
  const permissions = (project && project.permissions) || {};
  const documents = Array.isArray(opts.documents) ? opts.documents : [];
  const documentPaths = documents.map((doc) => {
    if (!doc) return null;
    if (typeof doc === 'string') return _resolveMaybe(doc, cwd);
    return _resolveMaybe(doc.path || doc.sourcePath || doc.filePath, cwd);
  });

  const scope = project ? 'project' : (conversationId || documentPaths.length ? 'conversation' : 'global');
  const rootPaths = project
    ? _unique([rootPath].concat(Array.isArray(project.sources) ? project.sources.map(s => s && s.path) : []))
    : _unique([requestedCwd].concat(documentPaths.map(p => p && path.dirname(p))));
  const readPaths = project
    ? _unique((permissions.fileRead || []).concat(rootPath || []))
    : _unique(documentPaths.concat(requestedCwd || []));
  const writePaths = project
    ? _unique((permissions.fileWrite || []).concat(rootPath || []))
    : _unique(requestedCwd ? [requestedCwd] : []);
  const validation = _preferredValidation(rootPath || requestedCwd, project);

  return {
    ok: true,
    scope,
    projectId,
    conversationId,
    cwd,
    project: project ? {
      id: project.id,
      name: project.name,
      rootPath,
      autonomousMode: !!project.autonomousMode,
    } : null,
    rootPaths,
    readPaths,
    writePaths,
    documents: documentPaths.map((p, i) => ({ path: p, exists: p ? fs.existsSync(p) : false, index: i })),
    validation,
    terminal: { cwd },
    safety: {
      projectScoped: !!project,
      nonProjectWritesRequireExplicitCwd: !project,
    },
  };
}