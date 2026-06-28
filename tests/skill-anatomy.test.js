// Tests for lib/skill-anatomy.js — the parser/linter underpinning the
// SKILL.md contract (addyosmani-compatible).

import { describe, it, expect } from 'vitest';
import {
  parseFrontmatter,
  listSections,
  extractSection,
  findSection,
  lintSkill,
} from '../lib/skill-anatomy.js';

const VALID = `---
name: incremental-implementation
description: Implements features in thin slices. Use when implementing any change touching multiple files.
---

# Incremental Implementation

## Overview
Ship thin vertical slices.

## When to Use
- Multi-file changes

## Process
1. Identify slice
2. Implement

## Common Rationalizations
| Excuse | Reality |
|---|---|
| A | B |

## Red Flags
- A

## Verification
- [ ] One test per slice
`;

describe('parseFrontmatter', () => {
  it('extracts name + description', () => {
    const { frontmatter, body, hasFrontmatter } = parseFrontmatter(VALID);
    expect(hasFrontmatter).toBe(true);
    expect(frontmatter.name).toBe('incremental-implementation');
    expect(frontmatter.description).toMatch(/Use when/);
    expect(body).toMatch(/^# Incremental Implementation/);
  });

  it('reports missing frontmatter', () => {
    const r = parseFrontmatter('# No frontmatter here\n');
    expect(r.hasFrontmatter).toBe(false);
    expect(r.frontmatter).toEqual({});
  });
});

describe('listSections', () => {
  it('returns headings in source order', () => {
    const { body } = parseFrontmatter(VALID);
    const titles = listSections(body).map((s) => s.title);
    expect(titles).toEqual([
      'Overview', 'When to Use', 'Process', 'Common Rationalizations', 'Red Flags', 'Verification',
    ]);
  });
});

describe('extractSection / findSection', () => {
  it('extracts a single section body', () => {
    const { body } = parseFrontmatter(VALID);
    const slice = extractSection(body, 'Verification');
    expect(slice).toContain('[ ] One test per slice');
    expect(slice).not.toContain('Red Flags');
  });

  it('findSection accepts aliases', () => {
    const { body } = parseFrontmatter(VALID);
    const slice = findSection(body, ['Use When', 'When to Use']);
    expect(slice).toContain('Multi-file changes');
  });

  it('returns null for missing sections', () => {
    const { body } = parseFrontmatter(VALID);
    expect(extractSection(body, 'Nonexistent')).toBeNull();
  });
});

describe('lintSkill', () => {
  it('passes a well-formed skill', () => {
    const r = lintSkill(VALID, { dirName: 'incremental-implementation' });
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('flags missing frontmatter', () => {
    const r = lintSkill('# No frontmatter\n');
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/frontmatter/i);
  });

  it('flags an invalid name slug', () => {
    const bad = VALID.replace('name: incremental-implementation', 'name: Bad_Name');
    const r = lintSkill(bad);
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/name/i);
  });

  it('flags a description over 1024 chars', () => {
    const long = 'Use when ' + 'x'.repeat(1100);
    const bad = VALID.replace(
      /description: .+/,
      'description: ' + long
    );
    const r = lintSkill(bad);
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/1024|length/i);
  });

  it('flags a description missing "Use when"', () => {
    const bad = VALID.replace(
      /description: .+/,
      'description: Implements features without trigger phrase.'
    );
    const r = lintSkill(bad);
    // Either errors or warnings should mention "Use when"
    const all = [...(r.errors || []), ...(r.warnings || [])].join(' ');
    expect(all).toMatch(/use when/i);
  });

  it('accepts common equivalent section headings', () => {
    const equivalent = VALID
      .replace('## When to Use', '## Usage')
      .replace('## Process', '## Implementation Procedure')
      .replace('## Red Flags', '## Anti-Patterns')
      .replace('## Verification', '## Validation Checklist');
    const r = lintSkill(equivalent, { dirName: 'incremental-implementation' });
    expect(r.warnings).not.toContain(expect.stringMatching(/When to Use|Process|Red Flags|Verification/));
  });

  it('flags dirName/name mismatch', () => {
    const r = lintSkill(VALID, { dirName: 'something-else' });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/match|dirName|directory/i);
  });
});
