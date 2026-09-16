import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const chatSource = fs.readFileSync(path.join(process.cwd(), 'public/js/chat.js'), 'utf8');
const appSource = fs.readFileSync(path.join(process.cwd(), 'public/js/app.js'), 'utf8');
const conversationsSource = fs.readFileSync(path.join(process.cwd(), 'public/js/conversations.js'), 'utf8');
const mainSource = fs.readFileSync(path.join(process.cwd(), 'main.js'), 'utf8');

describe('renderer performance guards', () => {
  it('throttles full-buffer rendering more aggressively as streams grow', () => {
    expect(chatSource).toContain('buffer.length > 64000 ? 150');
    expect(chatSource).toContain('buffer.length > 12000 ? 75 : 32');
    expect(chatSource).toContain('renderInterval - (Date.now() - _lastLiveRenderAt)');
    expect(chatSource).toContain('Math.ceil(_lastLiveRenderMs * 3)');
  });

  it('bounds hidden conversation DOM while protecting active streams', () => {
    expect(conversationsSource).toContain('MAX_CACHED_CONVERSATION_DOMS = 8');
    expect(conversationsSource).toContain("cachedId !== id && !(conv && conv._streaming)");
  });

  it('uses pushed SSE records instead of full hydration for upserts', () => {
    expect(appSource).toContain("msg.type === 'upsert' && msg.conversation");
    expect(appSource).toContain('_hydrateServerConvs([msg.conversation])');
    expect(appSource).toContain("window.addEventListener('focus', function() { _hydrateChangedServerConvs(); })");
    expect(appSource).toContain("fetch('/api/conversations/' + encodeURIComponent(changed[i].id))");
    expect(appSource).toContain('if (_changedHydrationInFlight) return _changedHydrationInFlight');
  });

  it('bounds completed-stream logging and debounces widget preference writes', () => {
    expect(chatSource).toContain("buffer.length > 2000 ? buffer.slice(0, 2000)");
    expect(mainSource).toContain('savePosTimer = setTimeout(savePos, 200)');
    expect(mainSource).toContain("widgetWindow.on('moved', scheduleSavePos)");
  });
});