// server/routes/genui-explore.js
//
// POST /api/genui-explore — generate a single interactive gen-ui spec for the
// Explore page. The Explore page is a GenUI-first "front door": the user types
// what they want to explore, and we return a flat gen-ui spec (the same shape
// rendered by public/js/gen-ui.js renderGenUI). Generated specs include
// drill-down Buttons using the `explore_into` action so the user can keep
// clicking deeper, building a breadcrumb journey.
//
// Returns: { ok: true, title, spec } where `spec` is a parsed flat gen-ui
// spec object: { root, elements, state?, theme? }.

import { getCopilotClient } from '../copilot/auth.js';
import { GEN_UI_CATALOG_PROMPT } from '../prompts/gen-ui-catalog.js';

const EXPLORE_RULES = `
## Explore page output contract (STRICT)

You are powering an interactive "Explore" surface. The user gives a topic or a
drill-down path, and you respond with ONE generative-UI flat spec.

Respond with **ONLY** a single JSON object — no markdown, no \`\`\` fences, no
prose before or after. The object is a flat gen-ui spec:

{ "root": "<id>", "elements": { "<id>": { "type", "props", "children": [] } }, "state": {}, "theme": {} }

Hard requirements:
- Make it **visual and scannable**: lead with a Card or Heading, then use a mix
  of Grid, Stat, Badge, List, Table, KeyValue, Rating, Stepper, Progress, Alert,
  Text, Divider and Icon to present the topic richly. Aim for 8–28 elements.
- ALWAYS include a "journey map": 3–6 \`Button\` elements that let the user dive
  deeper into sub-topics. Each such Button MUST use:
    "action": "explore_into",
    "actionParams": { "prompt": "<a self-contained instruction to explore this sub-topic>", "title": "<short crumb label, 1-3 words>" }
  Give them descriptive labels and \`icon\` names (Tabler glyph suffix). Group
  them under a Heading like "Go deeper" or inside a Grid so they read as a map of
  possible journeys.
- You MAY also use \`send_prompt\` (actionParams.text) for a Button that hands the
  topic back to the main chat, and \`open_url\` (actionParams.url) for external
  references. Never invent other actions.
- Do NOT use 3D widgets, artifact blocks, or shell here — only the flat gen-ui spec.
- Keep all strings valid JSON (escape quotes/newlines). Do not emit trailing text.
`;

// Extract page/search content via the Playwright browse manager, with a curl
// fallback. Returns { url, title, content } or null.
async function browseExtract(manager, url, maxChars) {
  try {
    if (manager && typeof manager.handleAction === 'function') {
      return await manager.handleAction({ action: 'extract', url, maxChars });
    }
  } catch (_) {}
  try {
    if (manager && typeof manager.fetchUrlFallback === 'function') {
      return await manager.fetchUrlFallback(url, maxChars);
    }
  } catch (_) {}
  return null;
}

// Pick a few real external result URLs out of DuckDuckGo HTML markdown. DDG
// wraps results in /l/?uddg=<encoded-target> redirect links; decode those
// first, then fall back to any absolute non-DDG link in the markdown.
function pickResultUrls(md, max) {
  const urls = [];
  const seen = new Set();
  const push = (u) => {
    if (!u || seen.has(u) || !/^https?:\/\//.test(u)) return;
    if (/duckduckgo\.com/.test(u)) return;
    seen.add(u); urls.push(u);
  };
  let m;
  const reUddg = /uddg=([^&)"'\s]+)/g;
  while ((m = reUddg.exec(md)) && urls.length < max) {
    try { push(decodeURIComponent(m[1])); } catch (_) {}
  }
  if (urls.length < max) {
    const reAbs = /\((https?:\/\/[^)\s]+)\)/g;
    while ((m = reAbs.exec(md)) && urls.length < max) push(m[1]);
  }
  return urls;
}

// Run a live web search + top-result fetch and return a grounding string the
// model can build a gen-ui view from (real titles, snippets, links, images).
async function gatherWebGrounding(manager, prompt) {
  if (!manager) return '';
  const query = prompt.replace(/\s+/g, ' ').trim().slice(0, 256);
  if (!query) return '';
  const searchUrl = 'https://duckduckgo.com/html/?q=' + encodeURIComponent(query);
  const search = await browseExtract(manager, searchUrl, 5000);
  if (!search || !search.content) return '';
  let grounding = `### Search results for "${query}"\n${String(search.content).slice(0, 5000)}\n`;
  const urls = pickResultUrls(String(search.content), 2);
  for (const u of urls) {
    const page = await browseExtract(manager, u, 5000);
    if (page && page.content) {
      grounding += `\n### Source: ${u}\n${page.title ? page.title + '\n' : ''}${String(page.content).slice(0, 5000)}\n`;
    }
  }
  return grounding;
}

// Pull a JSON object out of a model response that may include stray fences or
// prose despite instructions. Mirrors the recovery the client does, server-side.
function extractSpecJson(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let s = raw.trim();
  // Strip a leading ```json / ```gen-ui fence and trailing ```.
  s = s.replace(/^```[a-z-]*\s*/i, '').replace(/```\s*$/i, '').trim();
  try { return JSON.parse(s); } catch (_) {}
  // Fall back to the first balanced {...} block.
  const start = s.indexOf('{');
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const candidate = s.slice(start, i + 1);
        try { return JSON.parse(candidate); } catch (_) { return null; }
      }
    }
  }
  return null;
}

export function registerGenUiExploreRoutes(app, { getBrowseManager } = {}) {
  app.post('/api/genui-explore', async (req, res) => {
    const body = req.body || {};
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    const path = Array.isArray(body.path) ? body.path.filter(p => typeof p === 'string') : [];
    const context = typeof body.context === 'string' ? body.context.slice(0, 4000) : '';
    const model = typeof body.model === 'string' && body.model ? body.model : 'claude-sonnet-4.6';
    const useWeb = body.web === true;
    const agentPrompt = typeof body.agentPrompt === 'string' ? body.agentPrompt.slice(0, 6000) : '';
    const agentName = typeof body.agentName === 'string' ? body.agentName.slice(0, 80) : '';

    if (!prompt) return res.status(400).json({ ok: false, error: 'prompt required' });

    const trail = path.length ? `\n\n## Journey so far (breadcrumb)\n${path.join(' → ')}` : '';
    const ctx = context ? `\n\n## Relevant context\n${context}` : '';

    // Optional live-web grounding via the Playwright browse manager.
    let grounding = '';
    if (useWeb && typeof getBrowseManager === 'function') {
      try { grounding = await gatherWebGrounding(getBrowseManager(), prompt); } catch (_) {}
    }

    let system = GEN_UI_CATALOG_PROMPT + '\n' + EXPLORE_RULES;
    if (agentPrompt) {
      system = `## Active agent persona\nYou are acting as the "${agentName || 'custom'}" agent. Adopt its expertise, focus, and voice when building the view:\n${agentPrompt}\n\n` + system;
    }

    let userContent = `Explore this for me and return one interactive gen-ui spec:\n\n${prompt}${trail}${ctx}`;
    if (grounding) {
      userContent += `\n\n## LIVE WEB DATA (fetched just now — current)\n${grounding}\n` +
        'Build the view from this live data. Use ONLY URLs that appear above for Image `src`, links, and `open_url` buttons — never invent URLs. Add an `open_url` Button to each source you cite, and prefer real images found in the data.';
    }

    try {
      const client = getCopilotClient();
      const response = await client.chat.completions.create({
        model,
        max_tokens: 3200,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userContent },
        ],
      });
      const rawOut = response.choices?.[0]?.message?.content || '';
      const spec = extractSpecJson(rawOut);
      if (!spec || !spec.root || !spec.elements) {
        return res.status(502).json({ ok: false, error: 'Model did not return a valid gen-ui spec' });
      }
      // Derive a title: root props.title → first Heading → root type.
      let title = '';
      const rootEl = spec.elements[spec.root];
      if (rootEl && rootEl.props && rootEl.props.title) title = String(rootEl.props.title);
      if (!title) {
        for (const k of Object.keys(spec.elements)) {
          const el = spec.elements[k];
          if (el && el.type === 'Heading' && el.props && el.props.text) { title = String(el.props.text); break; }
        }
      }
      if (!title) title = prompt.slice(0, 60);
      res.json({ ok: true, title, spec, grounded: !!grounding });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || 'generation failed' });
    }
  });
}
