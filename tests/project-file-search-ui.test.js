import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

describe('Project Hub Files find and replace UI', () => {
  it('renders VS Code-style search controls and the project-wide shortcut', () => {
    const source = read('public/js/projects.js');

    expect(source).toContain('Find in files (Cmd/Ctrl+Shift+F)');
    expect(source).toContain('id="proj-search-query"');
    expect(source).toContain('id="proj-search-replacement"');
    expect(source).toContain('Match Case');
    expect(source).toContain('Match Whole Word');
    expect(source).toContain('Use Regular Expression');
    expect(source).toContain('files to include');
    expect(source).toContain('files to exclude');
    expect(source).toContain("event.key.toLowerCase() !== 'f'");
  });

  it('connects search, replace, grouped results, and click-to-line navigation', () => {
    const source = read('public/js/projects.js');

    expect(source).toContain("+ '/search'");
    expect(source).toContain("+ '/replace'");
    expect(source).toContain('replaceAllProjectMatches');
    expect(source).toContain("data-path=\"");
    expect(source).toContain('_projMonacoEditor.setPosition');
    expect(source).toContain('_projMonacoEditor.revealLineInCenter');
    expect(source).toContain("await _projConfirm('Replace '");
  });

  it('supports guarded agentic search and refactoring in the active project', () => {
    const source = read('public/js/projects.js');
    const chatRoute = read('server/routes/chat.js');

    expect(source).toContain('setProjectSearchMode');
    expect(source).toContain("s.mode === 'agent'");
    expect(source).toContain('id="proj-agent-search-task"');
    expect(source).toContain('runProjectAgentSearch');
    expect(source).toContain('cancelProjectAgentSearch');
    expect(source).toContain('projectId: runProjectId');
    expect(source).toContain("clientContext: 'project-search'");
    expect(source).toContain('agentPermissions: permissions');
    expect(source).toContain('Agent search requires a local project source.');
    expect(source).toContain('fileWrite: s.agentApply ? [sourcePath] : []');
    expect(source).toContain('shell: false');
    expect(source).toContain('Use agent_search_files and agent_read_file');
    expect(source).toContain("await _projConfirm('Allow '");
    expect(source).toContain('await loadProjectFileTree(runSourceId');
    expect(source).toContain('_hubTreeState.srcId !== srcId');
    expect(source).toContain('_projFileSearchState.agentRunning && state.activeProjectId !== id');
    expect(chatRoute).toContain("const isProjectSearch = clientContext === 'project-search'");
    expect(chatRoute).toContain('resolveProjectSourceRoot(projectId, sourceId, { localOnly: true })');
    expect(chatRoute).toContain('fileWrite: projectSearchApply ? [projectSearchScope.root] : []');
    expect(chatRoute).toContain('isProjectSearch ? [] : (mcpTools || [])');
    expect(chatRoute).toContain('!noTools && !isProjectSearch');
    expect(chatRoute).toContain('{ builtInsOnly: isProjectSearch }');
  });

  it('provides stable drawer and result layout styles', () => {
    const styles = read('public/css/styles.css');

    expect(styles).toContain('.proj-file-search {');
    expect(styles).toContain('.proj-search-option.active');
    expect(styles).toContain('.proj-search-results');
    expect(styles).toContain('.proj-search-match {');
    expect(styles).toContain('.proj-search-mode.active');
    expect(styles).toContain('.proj-agent-search-task {');
    expect(styles).toContain('.proj-agent-search-output {');
  });
});