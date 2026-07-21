import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const chatSource = fs.readFileSync(path.join(root, 'public/js/chat.js'), 'utf8');
const uiSource = fs.readFileSync(path.join(root, 'public/js/ui.js'), 'utf8');
const conversationsSource = fs.readFileSync(path.join(root, 'public/js/conversations.js'), 'utf8');

describe('assistant activity timeline', () => {
  it('places the live activity panel before streamed assistant prose', () => {
    expect(chatSource).toContain("msgEl.insertBefore(_liveToolOutputEl, bodyEl)");
    expect(chatSource).toContain("entry.className = 'tool-activity-entry tool-activity-thinking-entry'");
    expect(chatSource).toContain("entry.className = 'tool-activity-entry tool-activity-tool-entry'");
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
    expect(uiSource).toContain("toolOutput.textContent = item.output || 'Completed without preview output.'");
  });
});
