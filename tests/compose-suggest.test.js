import { describe, it, expect } from 'vitest';
import { sanitizeSuggestion } from '../server/routes/compose-suggest.js';

describe('sanitizeSuggestion', () => {
  it('passes through a clean single-word continuation', () => {
    expect(sanitizeSuggestion(' the database', 'connect to')).toBe(' the database');
  });

  it('keeps only the first line', () => {
    expect(sanitizeSuggestion('first part\nsecond part', 'draft')).toBe('first part');
  });

  it('strips wrapping quotes and backticks', () => {
    expect(sanitizeSuggestion('"hello world"', 'say ')).toBe('hello world');
    expect(sanitizeSuggestion('`code`', 'run ')).toBe('code');
  });

  it('drops an echoed copy of the draft', () => {
    expect(sanitizeSuggestion('connect to the server', 'connect to')).toBe(' the server');
  });

  it('rejects punctuation-only continuations', () => {
    expect(sanitizeSuggestion('...', 'hmm')).toBe('');
    expect(sanitizeSuggestion('  !? ', 'wow')).toBe('');
  });

  it('returns empty for empty/nullish input', () => {
    expect(sanitizeSuggestion('', 'x')).toBe('');
    expect(sanitizeSuggestion(null, 'x')).toBe('');
    expect(sanitizeSuggestion(undefined, 'x')).toBe('');
  });

  it('caps length at 120 chars', () => {
    const long = 'a'.repeat(300);
    expect(sanitizeSuggestion(long, 'draft').length).toBe(120);
  });

  it('removes carriage returns', () => {
    expect(sanitizeSuggestion('done\r', 'all ')).toBe('done');
  });
});
