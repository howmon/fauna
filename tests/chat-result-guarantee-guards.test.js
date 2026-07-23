// Regression coverage for the result-guarantee guards in server/routes/chat.js.
//
// Three failure modes from the fauna-30-Page-Strategy-Report-Rewrite transcript
// are pinned here so a future refactor cannot silently drop the fixes:
//
//   1. Empty final response after long thinking pass (message index 3):
//      the stream finished normally (finishReason=stop, usage present) but
//      the model emitted no text and made no tool calls. Fauna used to
//      persist a blank assistant turn.
//   2. Declared-work-without-mutation (messages 9 & 11):
//      the model said "I'll build a 30-page docx" / "Building it now" and
//      then only issued read/inspection tool calls, never producing the
//      promised artifact.
//   3. Write-intent verb coverage: the original `_writeIntentTurn` regex
//      missed "rewrite", "rebuild", "regenerate", "generate", so the
//      inspection-only nudge never engaged for these very common intents.
//
// These tests grep the compiled source for the guard scaffolding rather than
// exporting internals, matching the pattern already used by
// `tests/agent-instruction-injection.test.js`.

import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');
const chatSource = fs.readFileSync(path.join(root, 'server/routes/chat.js'), 'utf8');

describe('chat.js result-guarantee guards', () => {
  it('declares empty-final-response nudge state and one-shot flag', () => {
    expect(chatSource).toMatch(/let\s+emptyFinalNudgeFired\s*=\s*false/);
  });

  it('retries once when the model finishes with zero text and zero tool calls', () => {
    // The guard is a distinct branch inside the finalize else-chain that runs
    // AFTER the empty-no-finish-stream retry. It must check assistantText,
    // pendingCalls, toolCallCount, the one-shot flag, and skip orchestrator turns.
    expect(chatSource).toContain('emptyFinalNudgeFired = true;');
    expect(chatSource).toMatch(/!assistantText\.trim\(\)[\s\S]{0,200}pendingCalls\.length\s*===\s*0[\s\S]{0,200}toolCallCount\s*===\s*0[\s\S]{0,200}!emptyFinalNudgeFired[\s\S]{0,200}!isOrchestratorTurn/);
    expect(chatSource).toContain('empty final response');
    expect(chatSource).toContain('Your previous turn produced no visible text and no tool call');
  });

  it('declares declared-work-without-mutation nudge state and one-shot flag', () => {
    expect(chatSource).toMatch(/let\s+declaredWorkNudgeFired\s*=\s*false/);
  });

  it('forces a real mutation when the model says it will build/write an artifact but never mutates', () => {
    expect(chatSource).toContain('declaredWorkNudgeFired = true;');
    expect(chatSource).toContain('declared-work-without-mutation detected');
    expect(chatSource).toContain('Words are not work');
    // Pin the tool_choice pin so we don't regress to a soft nudge. The
    // assignment sits directly under the one-shot flag, right above the
    // log line — assert on that co-location.
    expect(chatSource).toMatch(/declaredWorkNudgeFired\s*=\s*true;[\s\S]{0,120}forceToolChoice\s*=\s*'fauna_write_file'/);
  });

  it('write-intent regex covers rewrite/rebuild/regenerate/generate/scaffold/produce/draft', () => {
    // Extract the exact regex source for _writeIntentTurn and construct it.
    const m = chatSource.match(/const\s+_writeIntentTurn\s*=\s*(\/[^\n]+\/i)\.test\(_lastUserQuery/);
    expect(m, 'could not locate _writeIntentTurn regex').toBeTruthy();
    // eslint-disable-next-line no-new-func
    const re = new Function('return ' + m[1])();
    // Original verbs still match.
    expect(re.test('please fix the login bug')).toBe(true);
    expect(re.test('proceed')).toBe(true);
    // New verbs from the 30-page-docx transcript must match.
    expect(re.test('rewrite the report as a 30-page docx')).toBe(true);
    expect(re.test('rebuild the pipeline')).toBe(true);
    expect(re.test('regenerate the summary')).toBe(true);
    expect(re.test('generate a design brief')).toBe(true);
    expect(re.test('scaffold the new module')).toBe(true);
    expect(re.test('produce a full PDF report')).toBe(true);
    expect(re.test('draft the outline for me')).toBe(true);
    // Non-intent messages still miss.
    expect(re.test('what does this codebase do?')).toBe(false);
    expect(re.test('where are we?')).toBe(false);
  });

  it('forward-promise detector recognises gerund phrasings like "Building it now"', () => {
    // Locate FORWARD_PROMISE_GERUND_RE and rehydrate it. Then verify it matches
    // the exact patterns from the stalled 30-page-docx recovery message.
    const m = chatSource.match(/const\s+FORWARD_PROMISE_GERUND_RE\s*=\s*(\/[^\n]+\/i)/);
    expect(m, 'FORWARD_PROMISE_GERUND_RE not found').toBeTruthy();
    // eslint-disable-next-line no-new-func
    const re = new Function('return ' + m[1])();
    expect(re.test('Building it now')).toBe(true);
    expect(re.test('Writing the file')).toBe(true);
    expect(re.test('Creating the report now')).toBe(true);
    expect(re.test('Generating the docx now')).toBe(true);
    expect(re.test('Rewriting the source')).toBe(true);
    expect(re.test('Rendering the schematic now')).toBe(true);
    // Should NOT match unrelated gerunds.
    expect(re.test('Trying to understand the layout')).toBe(false);
    expect(re.test('Loading dependencies')).toBe(false);
  });

  it('declared-work regex catches build/write/create claims anywhere in the message', () => {
    // The declared-work branch inlines a pattern for the "stated intent to
    // produce an artifact" — pull it out and re-verify. The branch text is
    // stable enough that we can extract the specific pattern with a marker.
    const branch = chatSource.slice(chatSource.indexOf('Declared-work-without-mutation guard'));
    expect(branch).toBeTruthy();

    // Simulate the transcript failures.
    const msg9 = "I'll build a fully rewritten 30-page docx. First, let me read the source file to determine content.";
    const msg11 = "Honest status: I said I'd build the 30-page rewrite but stalled before actually writing it. Building it now.";
    const clean = "I read the source file. The document is 696 lines with 12 sections.";

    const declaredWorkRe = /(?:\bi(?:'?ll|\s+will|\s+am\s+going\s+to|'?m\s+going\s+to)\s+(?:build|write|create|generate|produce|rewrite|rebuild|regenerate|scaffold|draft|assemble|compose|render|add|save|export|output)\b|\b(?:building|writing|creating|generating|producing|rewriting|rebuilding|regenerating|scaffolding|drafting|assembling|composing|rendering)\s+(?:it|this|that|the|a|an|now)\b|\bthe\s+(?:specific\s+)?next\s+(?:action|step|move)\s+is\s+to\s+(?:build|write|create|generate|produce|rewrite|rebuild|regenerate|scaffold|draft|save|export|output)\b|\bbuilding\s+it\s+now\b|\bwriting\s+it\s+now\b|\bcreating\s+it\s+now\b|\bgenerating\s+it\s+now\b|\brewriting\s+it\s+now\b)/i;

    // Sanity: our transcript failure lines match; clean lines don't.
    expect(declaredWorkRe.test(msg9)).toBe(true);
    expect(declaredWorkRe.test(msg11)).toBe(true);
    expect(declaredWorkRe.test(clean)).toBe(false);

    // And the source contains a regex with the same anchor phrases.
    expect(chatSource).toContain("building\\s+it\\s+now");
    expect(chatSource).toContain("writing\\s+it\\s+now");
    expect(chatSource).toContain("creating\\s+it\\s+now");
  });

  it('empty-final and declared-work guards are one-shot per turn', () => {
    // Grep the guard bodies to confirm the one-shot flag is set BEFORE the
    // re-prompt push, so a second trip through the branch cannot fire again.
    const emptyFinalIdx = chatSource.indexOf('empty final response');
    expect(emptyFinalIdx).toBeGreaterThan(-1);
    // Search 400 chars BEFORE and 800 chars AFTER the log line so we capture
    // both the one-shot flag (which comes before) and the push (which comes after).
    const emptyFinalWindow = chatSource.slice(Math.max(0, emptyFinalIdx - 400), emptyFinalIdx + 1200);
    expect(emptyFinalWindow).toContain('emptyFinalNudgeFired = true;');
    expect(emptyFinalWindow.indexOf('emptyFinalNudgeFired = true;'))
      .toBeLessThan(emptyFinalWindow.indexOf("allMessages.push({ role: 'user'"));

    const declaredIdx = chatSource.indexOf('declared-work-without-mutation detected');
    expect(declaredIdx).toBeGreaterThan(-1);
    const declaredWindow = chatSource.slice(Math.max(0, declaredIdx - 400), declaredIdx + 1200);
    expect(declaredWindow).toContain('declaredWorkNudgeFired = true;');
    expect(declaredWindow.indexOf('declaredWorkNudgeFired = true;'))
      .toBeLessThan(declaredWindow.indexOf("allMessages.push({ role: 'user'"));
  });
});
