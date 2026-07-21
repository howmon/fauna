import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

describe('agent creation entrypoint', () => {
  it('opens Add Agent from the initial and restored Builder rail', () => {
    expect(read('public/index.html')).toContain(
      'class="builder-rail-toggle" onclick="openAgentActionsPage()"'
    );
    expect(read('public/js/agent-builder.js')).toContain(
      'class="builder-rail-toggle" onclick="openAgentActionsPage()"'
    );
  });

  it('uses the shared titlebar instead of rendering a duplicate page header', () => {
    const agentSystem = read('public/js/agent-system.js');
    const actionsRenderer = agentSystem.slice(
      agentSystem.indexOf('function renderAgentActionsPage()'),
      agentSystem.indexOf('// ── Init', agentSystem.indexOf('function renderAgentActionsPage()'))
    );

    expect(actionsRenderer).not.toContain('agent-actions-header');
    expect(actionsRenderer).not.toContain('all-agents-close');
    expect(read('public/css/styles.css')).toContain(
      'body.app-page-open[data-page-strip="titlebar"] #agent-actions-page { top: 44px; }'
    );
  });
});