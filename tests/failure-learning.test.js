import { describe, it, expect } from 'vitest';
import { extractCorrections } from '../server/lib/failure-learning.js';

function call(id, name, args) {
  return { role: 'assistant', tool_calls: [{ id, function: { name, arguments: JSON.stringify(args) } }] };
}
function result(id, content) {
  return { role: 'tool', tool_call_id: id, content: typeof content === 'string' ? content : JSON.stringify(content) };
}

describe('extractCorrections', () => {
  it('learns a path correction from a failed read then a successful one', () => {
    const messages = [
      call('1', 'fauna_read_file', { path: 'src/java/Foo.java' }),
      result('1', { ok: false, error: 'ENOENT: no such file' }),
      call('2', 'fauna_read_file', { path: 'src/scala/Foo.java' }),
      result('2', { ok: true, content: 'package foo' }),
    ];
    const corrections = extractCorrections(messages);
    expect(corrections.length).toBe(1);
    expect(corrections[0].category).toBe('correction');
    expect(corrections[0].text).toContain('Foo.java');
    expect(corrections[0].text).toContain('src/scala/Foo.java');
    expect(corrections[0].text).toContain('src/java/Foo.java');
  });

  it('learns a command correction from a failed shell then a working one', () => {
    const messages = [
      call('1', 'fauna_shell_exec', { command: 'python script.py' }),
      result('1', { ok: false, exitCode: 127, stderr: 'python: command not found' }),
      call('2', 'fauna_shell_exec', { command: 'python3 script.py' }),
      result('2', { ok: true, exitCode: 0, stdout: 'done' }),
    ];
    const corrections = extractCorrections(messages);
    expect(corrections.length).toBe(1);
    expect(corrections[0].text).toContain('python3 script.py');
    expect(corrections[0].text).toContain('python script.py');
  });

  it('emits nothing when there are no failures', () => {
    const messages = [
      call('1', 'fauna_read_file', { path: 'a.txt' }),
      result('1', { ok: true, content: 'hi' }),
    ];
    expect(extractCorrections(messages)).toEqual([]);
  });

  it('does not pair unrelated commands', () => {
    const messages = [
      call('1', 'fauna_shell_exec', { command: 'foobar --x' }),
      result('1', { ok: false, exitCode: 127, stderr: 'foobar: command not found' }),
      call('2', 'fauna_shell_exec', { command: 'ls -la' }),
      result('2', { ok: true, exitCode: 0, stdout: '.' }),
    ];
    expect(extractCorrections(messages)).toEqual([]);
  });

  it('is resilient to malformed messages', () => {
    expect(extractCorrections(null)).toEqual([]);
    expect(extractCorrections([{ role: 'user', content: 'hi' }])).toEqual([]);
  });
});
