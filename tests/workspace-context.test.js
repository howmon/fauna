import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { resolveWorkspaceContext } from '../lib/workspace-context.js';

describe('resolveWorkspaceContext', () => {
  it('treats a Fauna project as a workspace', () => {
    const root = fs.mkdtempSync(path.join(os.homedir(), 'fauna-ws-project-'));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'vitest', build: 'vite build' } }), 'utf8');
    const ctx = resolveWorkspaceContext({
      project: {
        id: 'p1',
        name: 'Project One',
        rootPath: root,
        permissions: { fileRead: [root], fileWrite: [root] },
        qa: { command: 'npm run test' },
      },
      conversationId: 'c1',
    });

    expect(ctx.scope).toBe('project');
    expect(ctx.projectId).toBe('p1');
    expect(ctx.cwd).toBe(root);
    expect(ctx.rootPaths).toContain(root);
    expect(ctx.readPaths).toContain(root);
    expect(ctx.writePaths).toContain(root);
    expect(ctx.validation.map(v => v.command)).toContain('npm run test');
    expect(ctx.validation.map(v => v.command)).toContain('npm run build');
  });

  it('treats non-project conversations as document/global work contexts', () => {
    const dir = fs.mkdtempSync(path.join(os.homedir(), 'fauna-ws-doc-'));
    const doc = path.join(dir, 'brief.md');
    fs.writeFileSync(doc, '# Brief\n', 'utf8');
    const ctx = resolveWorkspaceContext({
      conversationId: 'c2',
      cwd: dir,
      documents: [doc],
    });

    expect(ctx.scope).toBe('conversation');
    expect(ctx.project).toBeNull();
    expect(ctx.cwd).toBe(dir);
    expect(ctx.documents[0]).toMatchObject({ path: doc, exists: true });
    expect(ctx.readPaths).toContain(doc);
    expect(ctx.writePaths).toContain(dir);
    expect(ctx.safety.nonProjectWritesRequireExplicitCwd).toBe(true);
  });
});
