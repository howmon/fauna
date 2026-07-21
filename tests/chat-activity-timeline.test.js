import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const chatSource = fs.readFileSync(path.join(root, 'public/js/chat.js'), 'utf8');
const uiSource = fs.readFileSync(path.join(root, 'public/js/ui.js'), 'utf8');
const conversationsSource = fs.readFileSync(path.join(root, 'public/js/conversations.js'), 'utf8');
const chatRouteSource = fs.readFileSync(path.join(root, 'server/routes/chat.js'), 'utf8');
const stylesSource = fs.readFileSync(path.join(root, 'public/css/styles.css'), 'utf8');
const markdownSource = fs.readFileSync(path.join(root, 'public/js/markdown.js'), 'utf8');

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
    expect(uiSource).toContain("itemDetail || 'Completed without preview output.'");
    expect(chatSource).toContain('updateActivityStepDetail(_currentActivityEntry.step, _activityEntryDetail(_currentActivityEntry))');
  });

  it('shows the exact shell command in live and historical Activity details', () => {
    expect(chatRouteSource).toContain('command: activity.command');
    expect(chatSource).toContain("entry.command ? '$ ' + entry.command : ''");
    expect(chatSource).toContain('_beginLiveToolOutput(toolLabel, evt.callId, evt.command, evt.activity)');
    expect(chatSource).toContain("command: entry.command || ''");
    expect(uiSource).toContain("item.command ? '$ ' + item.command : ''");
    expect(chatSource).toContain('updateActivityStepDetail(_currentActivityEntry.step, _activityEntryDetail(_currentActivityEntry))');
  });

  it('renders and persists structured read, search, and edit descriptors', () => {
    expect(chatRouteSource).toContain('const activity = buildToolActivityDescriptor(toolName, args)');
    expect(chatRouteSource).toContain('activity,');
    expect(chatSource).toContain('_beginLiveToolOutput(toolLabel, evt.callId, evt.command, evt.activity)');
    expect(chatSource).toContain('activity: entry.activity || null');
    expect(chatRouteSource).toContain("type: 'tool_activity_result'");
    expect(chatRouteSource).toContain("if (activityResult.status === 'failed') toolFailed = true");
    expect(chatRouteSource).toContain("summary: scrubSecrets(String(e.message || 'Tool failed')).text.slice(0, 500)");
    expect(chatRouteSource).toContain("output: scrubSecrets(text).text");
    expect(chatSource).toContain("if (evt.type === 'tool_activity_result')");
    expect(chatSource).toContain("resultSummary: entry.resultSummary || ''");
    expect(uiSource).toContain('function formatActivityDescriptorDetail(activity)');
    expect(uiSource).toContain("if (kind === 'read') return 'ti-book-2'");
    expect(uiSource).toContain("if (kind === 'search') return 'ti-search'");
    expect(uiSource).toContain("if (kind === 'edit') return 'ti-pencil'");
    expect(uiSource).toContain("activity.queryType === 'regex' ? 'Regex: '");
    expect(uiSource).toContain("stats.push('+' + Number(file.additions))");
  });

  it('shows and persists provider-exposed reasoning summaries', () => {
    expect(chatRouteSource).toContain("send({ type: 'reasoning', summary: String(delta.reasoning_content) })");
    expect(chatSource).toContain("if (evt.summary) _reasoningSummary += String(evt.summary)");
    expect(chatSource).toContain('summary: _reasoningSummary || _publicReasoningSummary || undefined');
    expect(uiSource).toContain("reasoning.summary || '', false");
  });

  it('extracts public approach summaries and strips them from assistant prose', () => {
    const start = markdownSource.indexOf('function extractPublicReasoningSummary');
    const end = markdownSource.indexOf('function renderMarkdown');
    const context = {};
    vm.runInNewContext(markdownSource.slice(start, end), context);
    const sample = '```reasoning-summary\n- Check constraints\n- Answer directly\n```\n\nVisible answer';
    expect(context.extractPublicReasoningSummary(sample)).toBe('- Check constraints\n- Answer directly');
    expect(context.stripPublicReasoningSummaryBlocks(sample).trim()).toBe('Visible answer');
    expect(chatSource).toContain('## Public Approach Summary');
    expect(chatSource).toContain('_syncPublicReasoningSummary();');
  });

  it('does not expose an empty disclosure when no public summary exists', () => {
    expect(uiSource).toContain('setActivityStepDetailAvailability(step, !!String(detailText || \'\').trim())');
    expect(chatSource).toContain('setActivityStepDetailAvailability(_liveActivityThinkingStep, !!displaySummary)');
    expect(stylesSource).toContain('.tool-activity-entry[data-has-detail="0"] .tool-activity-step-chevron');
    expect(uiSource).not.toContain('This model did not provide a displayable reasoning summary.');
  });

  it('finalizes Thinking when visible writing or tool execution begins', () => {
    expect(chatSource).toContain('if (_hasVisibleAssistantStreamContent()) _finalizeReasoningPhase()');
    expect(chatSource).toContain("if (evt.type === 'tool_call') {\n            _finalizeReasoningPhase();");
    expect(chatSource).toContain('_reasoning.durationSeconds = _reasoning.startedAt');
    expect(chatSource).toContain('_updateReasoningPanel(_reasoning.durationSeconds, true, true)');
    expect(chatSource).toContain('_updateLiveToolOutputSummary(!!completed && !keepActivityRunning)');
  });

  it('keeps reasoning time separate from the persisted end-to-end process time', () => {
    const formatterStart = uiSource.indexOf('function formatActivityElapsedSeconds');
    const formatterEnd = uiSource.indexOf('window.createActivityStep');
    const formatterContext = {};
    vm.runInNewContext(uiSource.slice(formatterStart, formatterEnd), formatterContext);
    expect(chatSource).toContain('var doneReasoning = (_reasoning && _reasoning.durationSeconds != null)');
    expect(chatSource).toContain('aiMsg.processDurationSeconds = _processDurationSeconds');
    expect(chatSource).toContain("' · ' + _formatElapsed(elapsedSeconds * 1000)");
    expect(conversationsSource).toContain('m.processDurationSeconds');
    expect(uiSource).toContain('formatActivityElapsedSeconds(processDurationSeconds)');
    expect(uiSource).toContain('+ processDurationMeta +');
    expect(formatterContext.formatActivityElapsedSeconds(65)).toBe('1m 5s');
  });

  it('makes each chain-of-thought step independently collapsible from its rail icon', () => {
    expect(uiSource).toContain("toggle.className = 'tool-activity-step-toggle'");
    expect(uiSource).toContain("entry.dataset.open = nextOpen ? '1' : '0'");
    expect(uiSource).toContain('ti-chevron-right tool-activity-step-chevron');
    expect(stylesSource).toContain('.tool-activity-step-toggle:hover .tool-activity-step-chevron');
    expect(stylesSource).toContain('.tool-activity-entry[data-open="1"] .tool-activity-step-detail');
  });

  it('caps expanded step details and scrolls long output inside the step', () => {
    const detailRule = stylesSource.slice(
      stylesSource.indexOf('.tool-activity-step-detail {'),
      stylesSource.indexOf('.tool-activity-entry[data-open="1"] .tool-activity-step-detail'),
    );
    expect(detailRule).toContain('max-height: min(300px, 38vh)');
    expect(detailRule).toContain('overflow: auto');
    expect(detailRule).toContain('overscroll-behavior: contain');
  });

  it('caps activity to the first and latest four steps until completed steps are expanded', () => {
    const start = uiSource.indexOf('function shouldShowCollapsedActivityStep');
    const end = uiSource.indexOf('window.createActivityStep');
    const entries = Array.from({ length: 9 }, (_, index) => ({ hidden: false, textContent: `Step ${index + 1}` }));
    let showMore = null;
    const body = {
      dataset: {},
      querySelectorAll: () => entries,
      querySelector: () => showMore,
      appendChild: (button) => { showMore = button; },
    };
    const context = {
      document: {
        createElement: () => ({
          addEventListener(type, handler) { this[type] = handler; },
          click() { this.click(); },
          remove() { showMore = null; },
        }),
      },
    };
    vm.runInNewContext(uiSource.slice(start, end), context);
    context.applyActivityStepLimit(body, true);
    expect(entries.filter(entry => !entry.hidden).map(entry => entry.textContent))
      .toEqual(['Step 1', 'Step 6', 'Step 7', 'Step 8', 'Step 9']);
    expect(showMore.textContent).toBe('Show 4 more steps');
    showMore.click();
    expect(entries.every(entry => !entry.hidden)).toBe(true);
    expect(showMore.textContent).toBe('Show less');
    showMore.click();
    expect(entries.filter(entry => !entry.hidden).map(entry => entry.textContent))
      .toEqual(['Step 1', 'Step 6', 'Step 7', 'Step 8', 'Step 9']);
    expect(showMore.textContent).toBe('Show 4 more steps');
    expect(chatSource).toContain('applyActivityStepLimit(_liveToolOutputBody, !!completed)');
    expect(uiSource).toContain('applyActivityStepLimit(activityBody, true)');
    expect(stylesSource).toContain('.tool-activity-entry[hidden]');
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
