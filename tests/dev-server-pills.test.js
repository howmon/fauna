import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const shellSource = fs.readFileSync(path.join(process.cwd(), 'public/js/shell.js'), 'utf8');
const projectsSource = fs.readFileSync(path.join(process.cwd(), 'public/js/projects.js'), 'utf8');

describe('dev-server input pills', () => {
  it('deduplicates repeated launches by normalized command', () => {
    expect(shellSource).toContain('function _devServerPillKey(code, convId)');
    expect(shellSource).toContain('candidate.dataset.serverKey === serverKey');
    expect(shellSource).toContain("matchingPill.dataset.regIds = JSON.stringify(matchingIds)");
  });

  it('removes pills after all matching registry entries stop', () => {
    expect(shellSource).toContain('function reconcileDevServerPills(servers)');
    expect(shellSource).toContain("server.status === 'running' || server.status === 'starting'");
    expect(shellSource).toContain('if (!ids.length)');
    expect(projectsSource).toContain('reconcileDevServerPills(servers)');
  });

  it('offers a conversation stop control for every grouped run', () => {
    expect(shellSource).toContain('class="dev-server-stop"');
    expect(shellSource).toContain('async function stopDevServerPill(event, pill)');
    expect(shellSource).toContain("fetch('/api/dev-servers/' + encodeURIComponent(id) + '/kill', { method: 'POST' })");
    expect(shellSource).toContain('await Promise.all(ids.map');
  });

  it('opens a dismissible dev-server widget instead of hidden settings', () => {
    expect(projectsSource).toContain("widget.id = 'dev-servers-widget'");
    expect(projectsSource).toContain("widget.setAttribute('role', 'dialog')");
    expect(projectsSource).toContain('function _closeDevServersWidget()');
    expect(projectsSource).toContain("if (keyEvent.key === 'Escape') _closeDevServersWidget()");
    const quickHandler = projectsSource.slice(
      projectsSource.indexOf('function _openDevServersQuick(event)'),
      projectsSource.indexOf('async function _pollPorts()'),
    );
    expect(quickHandler).not.toContain('switchSettingsPage');
    expect(quickHandler).not.toContain('toggleSettings');
  });
});