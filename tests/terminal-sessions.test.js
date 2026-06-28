import { describe, it, expect } from 'vitest';

import { startTerminalSession, sendTerminalInput, getTerminalOutput, listTerminalSessions, killTerminalSession } from '../lib/terminal-sessions.js';

function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

describe('terminal sessions', () => {
  it('starts, sends input, captures output, lists, and kills', async () => {
    const started = startTerminalSession({ cwd: process.cwd(), shell: '/bin/sh', command: 'printf READY' });
    expect(started.id).toMatch(/^term_/);
    await wait(80);
    const out = getTerminalOutput(started.id, 2000);
    expect(out.ok).toBe(true);
    expect(out.output).toContain('READY');

    const sent = sendTerminalInput(started.id, 'printf NEXT');
    expect(sent.ok).toBe(true);
    await wait(80);
    expect(getTerminalOutput(started.id, 2000).output).toContain('NEXT');
    expect(listTerminalSessions().some(s => s.id === started.id)).toBe(true);
    expect(killTerminalSession(started.id)).toMatchObject({ ok: true, id: started.id });
  });
});
