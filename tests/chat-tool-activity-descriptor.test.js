import { describe, expect, it } from 'vitest';
import { buildToolActivityDescriptor, buildToolActivityResult } from '../server/routes/chat.js';

describe('structured chat tool activity descriptors', () => {
  it('describes file reads with exact line ranges', () => {
    expect(buildToolActivityDescriptor('fauna_read_file', {
      path: '/repo/public/js/chat.js', startLine: 1400, endLine: 1485,
    })).toMatchObject({
      kind: 'read', label: 'Read chat.js, lines 1400 to 1485',
      path: '/repo/public/js/chat.js', name: 'chat.js', startLine: 1400, endLine: 1485,
    });
  });

  it('describes regex searches without exposing unrelated arguments', () => {
    const activity = buildToolActivityDescriptor('fauna_grep', {
      query: 'updateActivityStepDetail\\(', isRegexp: true,
      includePattern: 'public/js/**', cwd: '/repo', secret: 'do-not-expose',
    });
    expect(activity).toMatchObject({
      kind: 'search', label: 'Searched for regex', query: 'updateActivityStepDetail\\(',
      queryType: 'regex', include: 'public/js/**', scope: '/repo',
    });
    expect(activity).not.toHaveProperty('secret');
  });

  it('summarizes multi-file patches with additions, deletions, and hunks', () => {
    const patch = `*** Begin Patch
*** Update File: /repo/a.js
@@ function a
-old
+new
+extra
*** Add File: /repo/b.js
+first
+second
*** End Patch`;
    expect(buildToolActivityDescriptor('fauna_apply_patch', { patch })).toMatchObject({
      kind: 'edit', label: 'Edited 2 files', files: [
        { name: 'a.js', operation: 'update', additions: 2, deletions: 1, hunks: 1 },
        { name: 'b.js', operation: 'add', additions: 2, deletions: 0, hunks: 0 },
      ],
    });
  });

  it('keeps shell command and cwd as typed fields', () => {
    expect(buildToolActivityDescriptor('fauna_shell_exec', {
      command: 'npm test', cwd: '/repo', token: 'hidden',
    })).toMatchObject({ kind: 'shell', label: 'Ran shell command', command: 'npm test', cwd: '/repo' });
  });

  it('redacts secrets from displayed shell commands', () => {
    const token = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890';
    const activity = buildToolActivityDescriptor('fauna_shell_exec', { command: `curl -H "Authorization: Bearer ${token}" example.com` });
    expect(activity.command).toMatch(/Bearer \[REDACTED:[A-Z_]+\]/);
    expect(activity.command).not.toContain(token);
  });

  it('summarizes results without forwarding raw tool content', () => {
    expect(buildToolActivityResult('fauna_grep', {}, JSON.stringify({
      ok: true, count: 15, filesScanned: 42, matches: [{ text: 'private source content' }],
    }))).toEqual({ status: 'completed', summary: '15 results · 42 files scanned' });
    expect(buildToolActivityResult('fauna_read_file', { startLine: 10, endLine: 20 }, JSON.stringify({
      ok: true, bytes: 1200, totalLines: 80, content: 'private source content', truncated: false,
    }))).toEqual({ status: 'completed', summary: '11 lines · 1,200 bytes' });
  });

  it('clamps read counts and refuses unconfirmed patch success', () => {
    expect(buildToolActivityResult('fauna_read_file', { startLine: 90, endLine: 200 }, JSON.stringify({
      ok: true, bytes: 1200, totalLines: 100, content: '', truncated: false,
    }))).toEqual({ status: 'completed', summary: '11 lines · 1,200 bytes' });
    expect(buildToolActivityDescriptor('fauna_apply_patch', { patch: '*** Update File: a.js\n+new' }))
      .toMatchObject({ kind: 'edit', label: 'Applying patch', files: [] });
    expect(buildToolActivityResult('fauna_apply_patch', { patch: '*** Update File: a.js' }, 'not-json'))
      .toEqual({ status: 'failed', summary: 'Patch result was not confirmed' });
  });

  it('describes diagnostics using its command and workspace scope', () => {
    expect(buildToolActivityDescriptor('fauna_diagnostics', {
      command: 'npm run typecheck', cwd: '/repo',
    })).toMatchObject({
      kind: 'diagnostics', label: 'Checked diagnostics', command: 'npm run typecheck', scope: '/repo',
    });
  });
});