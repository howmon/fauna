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

  it('provides stable drawer and result layout styles', () => {
    const styles = read('public/css/styles.css');

    expect(styles).toContain('.proj-file-search {');
    expect(styles).toContain('.proj-search-option.active');
    expect(styles).toContain('.proj-search-results');
    expect(styles).toContain('.proj-search-match {');
  });
});