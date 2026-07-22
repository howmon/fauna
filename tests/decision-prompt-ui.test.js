import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const componentSource = fs.readFileSync(path.join(process.cwd(), 'public/js/decision-prompt.js'), 'utf8');
const chatSource = fs.readFileSync(path.join(process.cwd(), 'public/js/chat.js'), 'utf8');
const conversationsSource = fs.readFileSync(path.join(process.cwd(), 'public/js/conversations.js'), 'utf8');
const htmlSource = fs.readFileSync(path.join(process.cwd(), 'public/index.html'), 'utf8');
const cssSource = fs.readFileSync(path.join(process.cwd(), 'public/css/styles.css'), 'utf8');

describe('decision prompt composer replacement', () => {
  it('mounts a dedicated prompt host beside the standard composer', () => {
    expect(htmlSource).toContain('<div id="decision-prompt-host" hidden></div>');
    expect(htmlSource).toContain('<script src="js/decision-prompt.js"></script>');
    expect(componentSource).toContain('inputWrap.hidden = true;');
    expect(componentSource).toContain('inputWrap.hidden = false;');
    expect(cssSource).toContain('#input-wrap[hidden] { display: none; }');
  });

  it('sorts and preselects the recommended option', () => {
    expect(componentSource).toContain('Number(!!b.recommended) - Number(!!a.recommended)');
    expect(componentSource).toContain("decision.options.find(function(option) { return option && option.recommended; })");
    expect(componentSource).toContain('radio.checked = option.id === selectedId;');
  });

  it('supports custom responses and resumes through a real user message', () => {
    expect(componentSource).toContain("selected.value === '__custom__'");
    expect(componentSource).toContain('(option && option.custom)');
    expect(componentSource).toContain('customInput.hidden = !(selectedOption && selectedOption.custom);');
    expect(componentSource).toContain("customInput.scrollIntoView({ block: 'nearest', inline: 'nearest' });");
    expect(componentSource).toContain('if (overlap >= 0) form.scrollTop += overlap + 8;');
    expect(componentSource).toContain('input.value = response;');
    expect(componentSource).toContain("if (typeof sendMessage === 'function') sendMessage();");
    expect(chatSource).toContain('renderDecisionPrompt(conv._waitingForUserAction, conv);');
  });

  it('restores the pending prompt when conversations switch', () => {
    expect(conversationsSource).toContain("if (typeof syncDecisionPromptForCurrentConversation === 'function') syncDecisionPromptForCurrentConversation();");
  });

  it('has responsive and reduced-motion styling', () => {
    expect(cssSource).toContain('.decision-prompt-recommended');
    expect(cssSource).toContain('@media (max-width: 600px)');
    expect(cssSource).toContain('position: sticky;');
    expect(cssSource).toContain('@media (prefers-reduced-motion: reduce)');
  });
});