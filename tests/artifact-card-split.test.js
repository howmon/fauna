import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('artifact entity card split action', () => {
  const js = fs.readFileSync(path.join(process.cwd(), 'public/js/artifacts.js'), 'utf8');
  const css = fs.readFileSync(path.join(process.cwd(), 'public/css/styles.css'), 'utf8');

  it('uses the entire artifact row as the primary split action', () => {
    expect(js).toContain('class="artifact-card-primary"');
    expect(js).toContain('artifact-card-expand-indicator');
    expect(js).toContain('ti ti-external-link');
    expect(js).toContain('class="artifact-card-more"');
    expect(js).toContain('Open file location');
    expect(js).not.toContain("_artifactThumbnailMarkup(a, 'artifact-card-thumb')");
    expect(js).not.toContain('class="artifact-card-type"');
  });

  it('removes border chrome and keeps the file type icon', () => {
    expect(css).toMatch(/\.artifact-card\s*\{[\s\S]*border:\s*0/);
    expect(css).toMatch(/\.wf-created-artifacts\s*\{[\s\S]*padding:\s*0/);
    expect(css).toMatch(/\.wf-created-artifacts\s*\{[\s\S]*border:\s*0/);
    expect(css).toMatch(/\.wf-created-artifacts\s*\{[\s\S]*background:\s*transparent/);
    expect(css).toMatch(/\.artifact-card-primary\s*\{[\s\S]*gap:\s*2px/);
    expect(css).toMatch(/\.artifact-card\s*\{[\s\S]*width:\s*auto/);
    expect(css).toMatch(/\.artifact-card-primary\s*\{[\s\S]*flex:\s*0 1 auto/);
    expect(css).toMatch(/\.artifact-card-title\s*\{[\s\S]*flex:\s*0 1 auto/);
    expect(css).toMatch(/\.artifact-card-expand-indicator\s*\{[\s\S]*align-items:\s*center/);
    expect(css).toMatch(/\.artifact-card-icon\s*\{[\s\S]*font-size:\s*15px/);
    expect(css).not.toContain('body:has(#artifact-pane.open) .artifact-card-type');
  });
});