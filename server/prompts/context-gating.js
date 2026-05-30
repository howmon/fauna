// Codex-parity: gate heavy static system-prompt blocks on actual demand
// instead of injecting them every turn. The full GEN_UI catalog, the
// browser-panel doc, and the Frontend Quality bar together cost ~7k tokens
// — but a typical "explain this code" / "fix this bug" / "what does X mean"
// turn needs none of them.
//
// This module inspects the latest user message + the recent assistant
// transcript and returns a flag set telling the chat route which optional
// sections to inject. Once a conversation has used a capability we stay
// "sticky" and keep injecting the relevant block for the rest of the conv
// — flipping it off mid-thread would surprise the model.

const GENUI_KW = /\b(dashboard|scorecard|widget|gen[-_ ]?ui|chart|graph|stat\b|metric|kpi|leaderboard|table|playlist|carousel|podcast|narrat(e|ion)|read .* aloud|say this|tts|voiceover|video|movie|episode|gallery|tabs?\b|circuit|schematic|wiring|netlist|spice|op[- ]?amp|transistor|resistor|capacitor|inductor|whiteboard|lesson|teach me|walk me through|explain how|visualiz)/i;

const BROWSER_KW = /\b(browser|navigate|tab\b|open .* url|fetch .* page|crawl|scrape|click|fill .* form|type into|screenshot|snapshot|dev[- ]?server|localhost|https?:\/\/|extension|playwright|extract page)/i;

const FRONTEND_KW = /\b(ui|ux|frontend|front[- ]?end|website|landing page|hero section|component library|css|tailwind|react|next\.?js|svelte|vue|design system|figma|typography|color palette|gradient|hover state|animation|motion|micro[- ]?interaction|responsive|mobile view|landing|portfolio site|case stud)/i;

// Did the assistant already render any of these in this conversation? Once
// yes, keep injecting — switching modes mid-thread would confuse the model
// and break references to prior widgets.
function stickyFlags(messages) {
  let genui = false, browser = false, frontend = false;
  if (!Array.isArray(messages)) return { genui, browser, frontend };
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || m.role !== 'assistant') continue;
    const text = typeof m.content === 'string'
      ? m.content
      : Array.isArray(m.content)
        ? m.content.map(c => (c && typeof c.text === 'string') ? c.text : '').join('\n')
        : '';
    if (!text) continue;
    if (!genui   && /```gen-ui|```artifact:|fauna_render_circuit|fauna_speak|fauna_podcast|fauna_lesson_create/.test(text)) genui = true;
    if (!browser && /```browser-action|```browser-ext-action|fauna_browser/.test(text)) browser = true;
    if (!frontend && /```artifact:html|tailwind|className=|<style|gradient\(|@keyframes/.test(text))     frontend = true;
    if (genui && browser && frontend) break;
  }
  return { genui, browser, frontend };
}

// Latest user message text (cheap: we only need to keyword-scan it).
function lastUserText(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      return m.content
        .map(c => (c && typeof c.text === 'string') ? c.text : '')
        .join(' ');
    }
  }
  return '';
}

/**
 * Decide which optional system-prompt sections to inject this turn.
 * @param {object} opts
 * @param {Array}  opts.messages          – full conversation (user+assistant) being sent
 * @param {string} opts.systemPrompt      – the user's per-conv system prompt (also scanned)
 * @param {boolean} opts.isDelegation     – sub-agent calls always skip heavy blocks
 * @param {boolean} opts.isCLI            – CLI mode skips browser/genui (no rendering surface)
 * @param {boolean} opts.noTools          – tools disabled → no point describing them
 * @returns {{ genui:boolean, browser:boolean, frontend:boolean }}
 */
export function computeContextFlags({ messages, systemPrompt, isDelegation, isCLI, noTools }) {
  if (isDelegation) return { genui: false, browser: false, frontend: false };
  const sticky = stickyFlags(messages);
  const probe = (lastUserText(messages) + ' ' + (systemPrompt || '')).slice(0, 4000);
  const genui    = sticky.genui    || GENUI_KW.test(probe);
  // Browser context only makes sense when tools are enabled and we're not in
  // a plain-text CLI surface.
  const browser  = !noTools && !isCLI && (sticky.browser || BROWSER_KW.test(probe));
  const frontend = sticky.frontend || FRONTEND_KW.test(probe);
  return { genui, browser, frontend };
}
