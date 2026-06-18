// Tests for server/prompts/context-gating.js — focused on the backlog cluster
// trigger regex (the "AI didn't see fauna_feature_request_create when I said
// 'add to taskboard'" class of bug).

import { describe, it, expect } from 'vitest';

const { computeToolFlags } = await import('../server/prompts/context-gating.js');

function withUserText(text) {
  return computeToolFlags({
    messages: [{ role: 'user', content: text }],
    systemPrompt: '',
    isDelegation: false,
    isCLI: false,
    noTools: false,
  });
}

describe('computeToolFlags — backlog cluster', () => {
  it('triggers on "taskboard" (compound word)', () => {
    expect(withUserText('add this to the taskboard').backlog).toBe(true);
  });

  it('triggers on "task board" (two words)', () => {
    expect(withUserText('please add to task board').backlog).toBe(true);
  });

  it('triggers on "task-board" (hyphenated)', () => {
    expect(withUserText('drop this on the task-board').backlog).toBe(true);
  });

  it('triggers on "kanban"', () => {
    expect(withUserText('show me the kanban').backlog).toBe(true);
  });

  it('triggers on "backlog"', () => {
    expect(withUserText('add to backlog').backlog).toBe(true);
  });

  it('triggers on "what should i do next"', () => {
    expect(withUserText('what should I do next?').backlog).toBe(true);
  });

  it('does NOT trigger on unrelated chat', () => {
    expect(withUserText('what is the weather in tokyo').backlog).toBeUndefined();
  });

  it('triggers on "add to the board"', () => {
    expect(withUserText('add this to the board').backlog).toBe(true);
  });
});

// Regression: the "fetch some images into genui from pexel" miss — see
// transcript 2026-06-18T22-00 where the model called fauna_doctor, saw
// Pexels was configured, then said "fauna_stock_image_search is not
// registered in my available tool list" because the keyword regex required
// a literal "pexels" with the trailing s and a verb from a short whitelist
// (find/download/generate/create/make). The user typed "fetch" + "pexel".
describe('computeToolFlags — images cluster', () => {
  it('triggers on the exact phrasing that previously failed', () => {
    expect(withUserText('fetch some images into genui from pexel').images).toBe(true);
  });

  it('triggers when the user types "pexel" without the trailing s', () => {
    expect(withUserText('grab a pexel photo').images).toBe(true);
  });

  it('triggers on bare provider names', () => {
    expect(withUserText('use pexels').images).toBe(true);
    expect(withUserText('use unsplash').images).toBe(true);
    expect(withUserText('use pixabay').images).toBe(true);
  });

  it('triggers on common verbs the old regex missed (fetch/get/grab/pull/need/show/embed)', () => {
    expect(withUserText('fetch an image of a cat').images).toBe(true);
    expect(withUserText('get me a photo of the ocean').images).toBe(true);
    expect(withUserText('grab a picture of mountains').images).toBe(true);
    expect(withUserText('pull a pic of a sunset').images).toBe(true);
    expect(withUserText('I need an image for the hero').images).toBe(true);
    expect(withUserText('show me a stock photo').images).toBe(true);
    expect(withUserText('embed an image here').images).toBe(true);
  });

  it('triggers on "images from/for/of/into" prepositional anchors', () => {
    expect(withUserText('images from the web').images).toBe(true);
    expect(withUserText('images for the landing page').images).toBe(true);
    expect(withUserText('images of dogs').images).toBe(true);
    expect(withUserText('images into the deck').images).toBe(true);
  });

  it('still triggers on the original-style phrasings', () => {
    expect(withUserText('find an image of a cat').images).toBe(true);
    expect(withUserText('download a photo of a dog').images).toBe(true);
    expect(withUserText('generate a logo').images).toBe(true);
    expect(withUserText('create an icon').images).toBe(true);
  });

  it('does NOT trigger on unrelated chat', () => {
    expect(withUserText('what is the weather in tokyo').images).toBeUndefined();
    expect(withUserText('fix the build').images).toBeUndefined();
    expect(withUserText('refactor this function').images).toBeUndefined();
  });
});

// Defensive: fauna_write_offloaded must be in the core (always-on) cluster.
// The offload marker (server/routes/chat.js) instructs the model to call it,
// but the model can only do that if the schema is in its tool list. Keeping
// it pinned to `core` ensures a future cluster reshuffle can't silently
// gate it out and resurrect the Track B/C CSV thrash.
describe('computeToolFlags — offload tools always available', () => {
  it('fauna_write_offloaded survives even a totally unrelated prompt', async () => {
    // Reach into the module to assert membership directly.
    const mod = await import('../server/prompts/context-gating.js');
    const sample = [
      { type: 'function', function: { name: 'fauna_write_offloaded', parameters: {} } },
      { type: 'function', function: { name: 'fauna_retrieve_output', parameters: {} } },
      { type: 'function', function: { name: 'fauna_video_create', parameters: {} } },
    ];
    const flags = withUserText('what is 2+2');
    const filtered = mod.filterToolSchemas(sample, flags);
    const names = filtered.map(t => t.function.name);
    expect(names).toContain('fauna_write_offloaded');
    expect(names).toContain('fauna_retrieve_output');
    expect(names).not.toContain('fauna_video_create');
  });
});
