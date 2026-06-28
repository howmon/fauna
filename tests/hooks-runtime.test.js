import { describe, it, expect } from 'vitest';
import { collectHookEntries, runHooks } from '../server/lib/hooks-runtime.js';

describe('hooks runtime', () => {
  it('collects hook entries for an event', () => {
    const records = [{
      relativePath: '.github/hooks/policy.json',
      hooks: {
        PreToolUse: [{ type: 'command', command: 'echo ok' }],
        PostToolUse: [{ type: 'command', command: 'echo done' }],
      },
    }];

    const entries = collectHookEntries(records, 'PreToolUse');
    expect(entries).toHaveLength(1);
    expect(entries[0].command).toBe('echo ok');
    expect(entries[0]._source).toBe('.github/hooks/policy.json');
  });

  it('blocks when a hook returns continue false', async () => {
    const records = [{
      relativePath: '.github/hooks/policy.json',
      hooks: {
        PreToolUse: [{
          type: 'command',
          command: `node -e "process.stdin.resume();process.stdin.on('data',d=>{const p=JSON.parse(d);process.stdout.write(JSON.stringify({continue:false,stopReason:'blocked '+p.toolName}))})"`,
        }],
      },
    }];

    const result = await runHooks(records, 'PreToolUse', { toolName: 'fauna_shell_exec', args: {} }, { timeoutMs: 5000 });
    expect(result.ok).toBe(false);
    expect(result.blocked).toBe(true);
    expect(result.stopReason).toBe('blocked fauna_shell_exec');
  });

  it('collects system messages from hook output', async () => {
    const records = [{
      relativePath: '.github/hooks/audit.json',
      hooks: {
        PostToolUse: [{
          type: 'command',
          command: `node -e "process.stdin.resume();process.stdin.on('data',()=>{process.stdout.write(JSON.stringify({systemMessage:'audit note'}))})"`,
        }],
      },
    }];

    const result = await runHooks(records, 'PostToolUse', { toolName: 'fauna_read_file', args: {}, result: 'ok' }, { timeoutMs: 5000 });
    expect(result.ok).toBe(true);
    expect(result.systemMessages).toEqual(['audit note']);
  });
});
