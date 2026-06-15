// Sanity tests for the gen-ui catalog prompt.
//
// This file does NOT exercise the renderer (`public/js/gen-ui.js`) — that
// lives in the Electron renderer and there's no jsdom harness for it yet.
// What we DO guard here is the catalog prompt itself: regressions that
// strip the Input/Select/Icon rows, drop the new actions, or remove the
// "actionable recommendations" worked example would silently degrade
// model output without any other test catching it.

import { describe, it, expect } from 'vitest';
import { GEN_UI_CATALOG_PROMPT, GEN_UI_SHORT_HINT } from '../server/prompts/gen-ui-catalog.js';

describe('gen-ui catalog prompt — component coverage', () => {
  it('documents Icon, Input, Select (renderers existed without catalog rows pre-fix)', () => {
    expect(GEN_UI_CATALOG_PROMPT).toMatch(/\|\s*`Icon`\s*\|/);
    expect(GEN_UI_CATALOG_PROMPT).toMatch(/\|\s*`Input`\s*\|/);
    expect(GEN_UI_CATALOG_PROMPT).toMatch(/\|\s*`Select`\s*\|/);
  });

  it('documents Rating and Stepper (Phase 3)', () => {
    expect(GEN_UI_CATALOG_PROMPT).toMatch(/\|\s*`Rating`\s*\|/);
    expect(GEN_UI_CATALOG_PROMPT).toMatch(/\|\s*`Stepper`\s*\|/);
  });

  it('documents Stat.series sparkline (Phase 4)', () => {
    // The Stat catalog row must mention `series` as a prop. Match within a
    // single table row (no newlines) starting at the `Stat` cell.
    expect(GEN_UI_CATALOG_PROMPT).toMatch(/`Stat`[^\n]*`series`/);
  });

  it('documents Input/Select error + hint (Phase 6)', () => {
    expect(GEN_UI_CATALOG_PROMPT).toMatch(/error.*hint|hint.*error/i);
    // The keyword "Invalid" appears in the worked validation example.
    expect(GEN_UI_CATALOG_PROMPT).toMatch(/Invalid email/);
  });

  it('documents per-spec theme override (Phase 5)', () => {
    expect(GEN_UI_CATALOG_PROMPT).toMatch(/theme.*accent|Per-spec theme/i);
    // The theme example uses a concrete accent color so the model copies the shape.
    expect(GEN_UI_CATALOG_PROMPT).toMatch(/"theme":\s*\{/);
  });

  it('documents $bindState on Input/Select so the agent emits live forms', () => {
    expect(GEN_UI_CATALOG_PROMPT).toMatch(/\$bindState/);
  });
});

describe('gen-ui catalog prompt — action vocabulary', () => {
  it('lists the new actionable-recommendation actions', () => {
    expect(GEN_UI_CATALOG_PROMPT).toMatch(/prefill_chat/);
    expect(GEN_UI_CATALOG_PROMPT).toMatch(/send_prompt/);
    expect(GEN_UI_CATALOG_PROMPT).toMatch(/open_artifact/);
  });

  it('keeps the original action vocabulary', () => {
    expect(GEN_UI_CATALOG_PROMPT).toMatch(/setState/);
    expect(GEN_UI_CATALOG_PROMPT).toMatch(/toggle_visible/);
    expect(GEN_UI_CATALOG_PROMPT).toMatch(/copy_text/);
    expect(GEN_UI_CATALOG_PROMPT).toMatch(/open_url/);
  });

  it('teaches the "every recommendation needs a button" pattern', () => {
    // Catch dilution / removal of the keystone instruction.
    expect(GEN_UI_CATALOG_PROMPT).toMatch(/recommendation/i);
    expect(GEN_UI_CATALOG_PROMPT).toMatch(/MUST have at least one action Button/);
  });
});

describe('gen-ui catalog prompt — worked examples', () => {
  it('includes the actionable-recommendations example', () => {
    // Both action verbs must appear inside a fenced gen-ui block for the
    // model to pick up the pattern reliably.
    const blocks = GEN_UI_CATALOG_PROMPT.match(/```gen-ui[\s\S]*?```/g) || [];
    expect(blocks.length).toBeGreaterThanOrEqual(3);
    const joined = blocks.join('\n');
    expect(joined).toMatch(/send_prompt/);
    expect(joined).toMatch(/prefill_chat/);
  });

  it('includes the form + live-preview example', () => {
    const blocks = GEN_UI_CATALOG_PROMPT.match(/```gen-ui[\s\S]*?```/g) || [];
    const joined = blocks.join('\n');
    expect(joined).toMatch(/\$bindState/);
    expect(joined).toMatch(/"Select"/);
    expect(joined).toMatch(/"Input"/);
  });
});

describe('gen-ui short hint — degraded mode', () => {
  it('still forbids emitting a gen-ui block when catalog is not loaded', () => {
    // Critical guardrail: without this, the model hallucinates the schema.
    expect(GEN_UI_SHORT_HINT).toMatch(/DO NOT emit a/);
    expect(GEN_UI_SHORT_HINT).toMatch(/gen-ui/);
  });
});
