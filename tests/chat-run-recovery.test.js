import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.join(process.cwd(), 'public/js/chat.js'), 'utf8');

describe('durable chat stream recovery', () => {
  it('tracks SSE cursors and replays only missing run events', () => {
    expect(source).toContain("if (line.startsWith('id:'))");
    expect(source).toContain("'/events?after=' + lastRunEventId");
    expect(source).toContain("lastRunEventId = Math.max(lastRunEventId, Number(envelope.id) || 0)");
  });

  it('reconstructs pending user actions and resolves durable pauses', () => {
    expect(source).toContain("recoveredEvent.type === 'requires_user_action'");
    expect(source).toContain("['completed', 'failed', 'cancelled', 'paused']");
    expect(source).toContain("'/pauses/' + encodeURIComponent(pendingUserAction.pauseId) + '/resolve'");
  });
});