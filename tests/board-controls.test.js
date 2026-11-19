import fs from 'node:fs';
import vm from 'node:vm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const source = fs.readFileSync(new URL('../public/js/board.js', import.meta.url), 'utf8');

describe('Board model and per-project parallel controls', () => {
  let window, elements, fetch, toast, mount;
  const projects = [
    { id: 'p1', name: 'First', kanban: { concurrency: 2, autopilot: true } },
    { id: 'p2', name: 'Empty project', kanban: { concurrency: 5 } },
  ];
  const settle = async () => {
    await new Promise(resolve => setImmediate(resolve));
  };

  beforeEach(() => {
    window = {};
    elements = {
      'kb-concurrency-project': { innerHTML: '', value: '' },
      'kb-concurrency': { value: '', disabled: false },
      'kb-board-grid': { innerHTML: '' },
    };
    mount = { innerHTML: '' };
    toast = vi.fn();
    fetch = vi.fn(async url => ({
      ok: true,
      json: async () => url === '/api/projects' ? structuredClone(projects)
        : url === '/api/board' ? { items: [] }
        : { ...projects[1], kanban: { concurrency: 4 } },
    }));
    vm.runInNewContext(source, {
      window,
      document: { getElementById: id => elements[id] || null },
      fetch, showToast: toast, console,
      setInterval: vi.fn(), clearInterval: vi.fn(),
    });
  });

  it('lists projects without cards and saves only the chosen project limit', async () => {
    window.renderKanbanBoard({ scope: 'global' }, mount);
    await settle();
    expect(mount.innerHTML).toContain('id="kb-concurrency-project"');
    expect(elements['kb-concurrency-project'].innerHTML).toContain('Empty project');
    expect(elements['kb-concurrency'].value).toBe(2);
    window.kbSelectConcurrencyProject('p2');
    expect(elements['kb-concurrency'].value).toBe(5);
    await window.kbSetConcurrency('4');
    expect(fetch).toHaveBeenLastCalledWith('/api/projects/p2', expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({ kanban: { concurrency: 4 } }),
    }));
    expect(window._kbState.projectsById.p1.kanban.concurrency).toBe(2);
    expect(elements['kb-concurrency'].value).toBe(4);
    window.refreshKanbanBoard();
    await settle();
    expect(elements['kb-concurrency-project'].value).toBe('p2');
  });

  it('rejects invalid limits and restores the server value after save errors', async () => {
    window.renderKanbanBoard({ scope: 'global' }, mount);
    await settle();
    for (const invalid of ['0', '11', '2.5', 'oops']) {
      fetch.mockClear();
      window.kbSetConcurrency(invalid);
      expect(fetch).not.toHaveBeenCalled();
      expect(elements['kb-concurrency'].value).toBe(2);
    }
    fetch.mockResolvedValueOnce({ ok: false, status: 500 });
    await window.kbSetConcurrency('3');
    expect(toast).toHaveBeenLastCalledWith('Update failed: HTTP 500', true);
    expect(elements['kb-concurrency'].value).toBe(2);
  });

  it('disables the global limit when no projects exist', async () => {
    fetch.mockImplementation(async url => ({
      ok: true, json: async () => url === '/api/projects' ? [] : { items: [] },
    }));
    window.renderKanbanBoard({ scope: 'global' }, mount);
    await settle();
    expect(elements['kb-concurrency'].disabled).toBe(true);
    fetch.mockClear();
    window.kbSetConcurrency('4');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('shows the actual board default rather than the chat model on inherited cards', () => {
    elements['kb-modal-host'] = { innerHTML: '' };
    window._kbState.items = [{ id: 'c1', title: 'Card', model: null, runs: [] }];
    window.openWorkItemModal('p1', 'c1');
    expect(elements['kb-modal-host'].innerHTML).toContain('data-current="mai-code-2"');
  });
});
