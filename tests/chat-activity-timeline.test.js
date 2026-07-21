import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const chatSource = fs.readFileSync(path.join(root, 'public/js/chat.js'), 'utf8');
const uiSource = fs.readFileSync(path.join(root, 'public/js/ui.js'), 'utf8');
const conversationsSource = fs.readFileSync(path.join(root, 'public/js/conversations.js'), 'utf8');
const chatRouteSource = fs.readFileSync(path.join(root, 'server/routes/chat.js'), 'utf8');
const stylesSource = fs.readFileSync(path.join(root, 'public/css/styles.css'), 'utf8');

describe('assistant activity timeline', () => {
  it('places the live activity panel before streamed assistant prose', () => {
    expect(chatSource).toContain("msgEl.insertBefore(_liveToolOutputEl, bodyEl)");
    expect(chatSource).toContain("_liveToolOutputEl.setAttribute('data-open', '1')");
    expect(chatSource).toContain("createActivityStep('Thinking…', 'thinking'");
    expect(chatSource).toContain("createActivityStep(label || 'Tool output', toolKind");
  });

  it('does not add ephemeral tool statuses inside the message body', () => {
    const toolCallHandler = chatSource.slice(
      chatSource.indexOf("if (evt.type === 'tool_call')"),
      chatSource.indexOf("if (evt.type === 'artifact_created')"),
    );
    expect(toolCallHandler).not.toContain('_addToolStatus(');
  });

  it('persists output previews and rehydrates them before historical prose', () => {
    expect(chatSource).toContain('if (_activityEntries.length) aiMsg.activity');
    expect(conversationsSource).toContain('m.activity || null');
    expect(conversationsSource).toContain('if (m.activity) entry.activity = m.activity;');
    expect(uiSource).toContain('el.insertBefore(activityPanel, body)');
    expect(uiSource).toContain("item.output || 'Completed without preview output.'");
    expect(chatSource).toContain('updateActivityStepDetail(_currentActivityEntry.step, _currentActivityEntry.output)');
  });

  it('shows and persists provider-exposed reasoning summaries', () => {
    expect(chatRouteSource).toContain("send({ type: 'reasoning', summary: String(delta.reasoning_content) })");
    expect(chatSource).toContain("if (evt.summary) _reasoningSummary += String(evt.summary)");
    expect(chatSource).toContain('summary: _reasoningSummary || undefined');
    expect(uiSource).toContain("reasoning.summary || 'This model did not provide a displayable reasoning summary.'");
  });

  it('makes each chain-of-thought step independently collapsible from its rail icon', () => {
    expect(uiSource).toContain("toggle.className = 'tool-activity-step-toggle'");
    expect(uiSource).toContain("entry.dataset.open = nextOpen ? '1' : '0'");
    expect(uiSource).toContain('ti-chevron-right tool-activity-step-chevron');
    expect(stylesSource).toContain('.tool-activity-step-toggle:hover .tool-activity-step-chevron');
    expect(stylesSource).toContain('.tool-activity-entry[data-open="1"] .tool-activity-step-detail');
  });

  it('renders remote, data, and local image previews in expanded step details', () => {
    expect(uiSource).toContain("fetch('/api/read-image?path=' + encodeURIComponent(src))");
    expect(uiSource).toContain("img.className = 'tool-activity-step-image'");
    expect(uiSource).toContain("openImageLightbox(imageSrc, 'Activity preview')");
    expect(uiSource).toContain("'[Image preview]'");
    expect(stylesSource).toContain('.tool-activity-step-media:not(:empty)');
    expect(chatSource).toContain("evt.artType === 'image'");
  });
});
