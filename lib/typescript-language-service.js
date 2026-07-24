import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { getWorkspaceIndex, invalidateWorkspaceIndex } from './workspace-index.js';

const TS_JS_EXT_RE = /\.(?:[cm]?[jt]sx?)$/i;
const _services = new Map();

function _normalizePath(value) {
  return String(value || '').split(path.sep).join('/');
}

const MAX_TS_FILE_BYTES = 200_000;  // skip large/minified files — they balloon TS AST memory
const MAX_TS_FILES = 500;           // hard cap to bound language service memory

function _workspaceFileNames(root) {
  const all = getWorkspaceIndex({ cwd: root }).entries
    .filter(entry => TS_JS_EXT_RE.test(entry.path) && entry.size <= MAX_TS_FILE_BYTES);
  if (all.length > MAX_TS_FILES) all.length = MAX_TS_FILES;
  return all.map(entry => entry.absolutePath);
}

function _compilerOptions(root) {
  const configPath = ts.findConfigFile(root, ts.sys.fileExists, 'tsconfig.json')
    || ts.findConfigFile(root, ts.sys.fileExists, 'jsconfig.json');
  if (configPath) {
    const loaded = ts.readConfigFile(configPath, ts.sys.readFile);
    if (!loaded.error) {
      return ts.parseJsonConfigFileContent(loaded.config, ts.sys, path.dirname(configPath)).options;
    }
  }
  return {
    allowJs: true,
    checkJs: false,
    jsx: ts.JsxEmit.Preserve,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ES2022,
  };
}

function _serviceFor(rootValue) {
  const root = path.resolve(rootValue || process.cwd());
  const cached = _services.get(root);
  if (cached) return cached;
  const host = {
    getScriptFileNames: () => _workspaceFileNames(root),
    getScriptVersion(fileName) {
      try {
        const stat = fs.statSync(fileName);
        return String(stat.mtimeMs) + ':' + String(stat.size);
      } catch (_) {
        return '0';
      }
    },
    getScriptSnapshot(fileName) {
      const text = ts.sys.readFile(fileName);
      return text == null ? undefined : ts.ScriptSnapshot.fromString(text);
    },
    getCurrentDirectory: () => root,
    getCompilationSettings: () => _compilerOptions(root),
    getDefaultLibFileName: options => ts.getDefaultLibFilePath(options),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
    useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
    getNewLine: () => ts.sys.newLine,
  };
  const service = ts.createLanguageService(host, ts.createDocumentRegistry());
  const state = { root, service };
  _services.set(root, state);
  return state;
}

function _anchor(opts = {}) {
  const root = path.resolve(opts.cwd || process.cwd());
  if (!opts.path || !Number(opts.line)) return null;
  const fileName = path.isAbsolute(String(opts.path))
    ? path.resolve(String(opts.path))
    : path.resolve(root, String(opts.path));
  if (!TS_JS_EXT_RE.test(fileName) || !fs.existsSync(fileName)) return null;
  const text = fs.readFileSync(fileName, 'utf8');
  const lines = text.split('\n');
  const line = Math.max(1, Math.min(Number(opts.line) || 1, lines.length));
  const lineText = lines[line - 1] || '';
  let column = Math.max(1, Number(opts.column) || 1);
  if (!opts.column && opts.symbol) {
    const found = lineText.indexOf(String(opts.symbol));
    if (found >= 0) column = found + 1;
  }
  column = Math.min(column, lineText.length + 1);
  let position = column - 1;
  for (let index = 0; index < line - 1; index++) position += lines[index].length + 1;
  return { root, fileName, text, line, column, position };
}

function _location(state, fileName, textSpan, extra = {}) {
  const source = state.service.getProgram()?.getSourceFile(fileName);
  const text = source?.getFullText() ?? ts.sys.readFile(fileName) ?? '';
  const start = source
    ? ts.getLineAndCharacterOfPosition(source, textSpan.start)
    : { line: 0, character: textSpan.start };
  const endPosition = textSpan.start + textSpan.length;
  const end = source
    ? ts.getLineAndCharacterOfPosition(source, endPosition)
    : start;
  const lineText = text.split('\n')[start.line] || '';
  return {
    path: _normalizePath(path.relative(state.root, fileName)),
    line: start.line + 1,
    column: start.character + 1,
    endLine: end.line + 1,
    endColumn: end.character + 1,
    text: lineText.trim().slice(0, 500),
    ...extra,
  };
}

export function semanticDefinition(opts = {}) {
  const anchor = _anchor(opts);
  if (!anchor) return null;
  const state = _serviceFor(anchor.root);
  const definitions = (state.service.getDefinitionAtPosition(anchor.fileName, anchor.position) || [])
    .map(definition => _location(state, definition.fileName, definition.textSpan, { kind: definition.kind || 'definition', name: definition.name || opts.symbol || '' }));
  return { ok: true, root: anchor.root, symbol: String(opts.symbol || ''), definitions, engine: 'typescript-language-service' };
}

export function semanticWorkspaceSymbols(opts = {}) {
  const root = path.resolve(opts.cwd || process.cwd());
  const state = _serviceFor(root);
  const query = String(opts.query || '').trim().toLowerCase();
  const maxResults = Math.max(1, Math.min(Number(opts.maxResults) || 200, 1000));
  const symbols = [];
  const seen = new Set();
  function visit(fileName, item) {
    if (symbols.length >= maxResults) return;
    const name = String(item.text || '').replace(/^["']|["']$/g, '');
    if (name && name !== '<global>' && (!query || name.toLowerCase().includes(query))) {
      const span = Array.isArray(item.spans) ? item.spans[0] : null;
      if (span) {
        const location = _location(state, fileName, span, { name, kind: item.kind || 'symbol' });
        const key = location.path + ':' + location.line + ':' + location.column + ':' + name;
        if (!seen.has(key)) {
          seen.add(key);
          symbols.push(location);
        }
      }
    }
    for (const child of item.childItems || []) visit(fileName, child);
  }
  for (const fileName of _workspaceFileNames(root)) {
    visit(fileName, state.service.getNavigationTree(fileName));
    if (symbols.length >= maxResults) break;
  }
  return { ok: true, root, symbols, truncated: symbols.length >= maxResults, engine: 'typescript-language-service' };
}

export function semanticReferences(opts = {}) {
  const anchor = _anchor(opts);
  if (!anchor) return null;
  const state = _serviceFor(anchor.root);
  const groups = state.service.findReferences(anchor.fileName, anchor.position) || [];
  const references = [];
  const maxResults = Math.max(1, Math.min(Number(opts.maxResults) || 500, 2000));
  const seen = new Set();
  for (const group of groups) {
    for (const reference of group.references || []) {
      const key = reference.fileName + ':' + reference.textSpan.start + ':' + reference.textSpan.length;
      if (seen.has(key)) continue;
      seen.add(key);
      references.push(_location(state, reference.fileName, reference.textSpan, { isDefinition: !!reference.isDefinition, kind: reference.isDefinition ? 'definition' : 'reference' }));
      if (references.length >= maxResults) break;
    }
    if (references.length >= maxResults) break;
  }
  return { ok: true, root: anchor.root, symbol: String(opts.symbol || ''), references, truncated: references.length >= maxResults, engine: 'typescript-language-service' };
}

export function semanticRename(opts = {}) {
  const anchor = _anchor(opts);
  if (!anchor) return null;
  const newName = String(opts.newName || '').trim();
  if (!/^[A-Za-z_$][\w$]*$/.test(newName)) return { ok: false, error: 'valid newName required' };
  const state = _serviceFor(anchor.root);
  const info = state.service.getRenameInfo(anchor.fileName, anchor.position, { allowRenameOfImportPath: false });
  if (!info.canRename) return { ok: false, error: info.localizedErrorMessage || 'Symbol cannot be renamed', engine: 'typescript-language-service' };
  const locations = state.service.findRenameLocations(anchor.fileName, anchor.position, false, false, true) || [];
  const byFile = new Map();
  for (const location of locations) {
    const replacement = String(location.prefixText || '') + newName + String(location.suffixText || '');
    const edit = _location(state, location.fileName, location.textSpan, { newText: replacement, start: location.textSpan.start, length: location.textSpan.length });
    if (!byFile.has(location.fileName)) byFile.set(location.fileName, []);
    byFile.get(location.fileName).push(edit);
  }
  const changed = [];
  for (const [fileName, edits] of byFile) {
    changed.push({ path: _normalizePath(path.relative(anchor.root, fileName)), replacements: edits.length, edits: edits.map(({ start, length, ...edit }) => edit) });
    if (opts.apply === true) {
      let text = fs.readFileSync(fileName, 'utf8');
      for (const edit of edits.slice().sort((left, right) => right.start - left.start)) {
        text = text.slice(0, edit.start) + edit.newText + text.slice(edit.start + edit.length);
      }
      fs.writeFileSync(fileName, text, 'utf8');
    }
  }
  if (opts.apply === true) invalidateWorkspaceIndex(anchor.root);
  return {
    ok: true,
    root: anchor.root,
    symbol: String(opts.symbol || info.displayName || ''),
    newName,
    preview: opts.apply !== true,
    changed,
    engine: 'typescript-language-service',
  };
}

export function semanticDiagnostics(opts = {}) {
  const root = path.resolve(opts.cwd || process.cwd());
  const state = _serviceFor(root);
  const requestedPath = opts.path
    ? (path.isAbsolute(String(opts.path)) ? path.resolve(String(opts.path)) : path.resolve(root, String(opts.path)))
    : null;
  const files = requestedPath ? [requestedPath] : _workspaceFileNames(root);
  const maxResults = Math.max(1, Math.min(Number(opts.maxResults) || 500, 2000));
  const diagnostics = [];
  for (const fileName of files) {
    if (!TS_JS_EXT_RE.test(fileName)) continue;
    const fileDiagnostics = [
      ...state.service.getSyntacticDiagnostics(fileName),
      ...state.service.getSemanticDiagnostics(fileName),
      ...state.service.getSuggestionDiagnostics(fileName),
    ];
    for (const diagnostic of fileDiagnostics) {
      const span = { start: diagnostic.start || 0, length: diagnostic.length || 0 };
      diagnostics.push(_location(state, fileName, span, {
        severity: diagnostic.category === ts.DiagnosticCategory.Error ? 'error' : diagnostic.category === ts.DiagnosticCategory.Warning ? 'warning' : 'info',
        source: 'typescript',
        code: diagnostic.code,
        message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
      }));
      if (diagnostics.length >= maxResults) break;
    }
    if (diagnostics.length >= maxResults) break;
  }
  return { ok: true, root, diagnostics, count: diagnostics.length, truncated: diagnostics.length >= maxResults, engine: 'typescript-language-service' };
}

export function disposeTypeScriptServices() {
  for (const state of _services.values()) state.service.dispose();
  _services.clear();
}