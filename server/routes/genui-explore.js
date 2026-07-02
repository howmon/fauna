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
- Include a "journey map": 3–6 \`Button\` elements that let the user dive deeper
  into sub-topics. Each such Button MUST use:
    "action": "explore_into",
    "actionParams": { "prompt": "<a self-contained instruction to explore this sub-topic>", "title": "<short crumb label, 1-3 words>" }
  Give them descriptive labels and \`icon\` names (Tabler glyph suffix). Group
  them under a Heading like "Go deeper" or inside a Grid so they read as a map of
  possible journeys. (For pure task/data-collection prompts — see below — a form
  may replace the journey map.)
- **Make the whole view actionable — not just the "Go deeper" section.** Beyond
  the journey map, most cards, sections, list rows, and feature items should
  carry their OWN contextual CTA \`Button\` (or clickable Image/Card) that does
  something useful right there. Aim for a few inline CTAs across the view, placed
  next to the content they act on — a view where the ONLY interactive elements
  are the Go deeper buttons is TOO BARE. Good inline CTAs use these in-app actions:
    - \`send_prompt\` (actionParams.text) — hand a specific task/question to the main
      chat, e.g. "Draft a 2-week meal plan for this recipe", "Explain this in simpler terms".
    - \`prefill_chat\` (actionParams.text) — drop a ready-to-edit prompt into the chat box.
    - \`copy_text\` (actionParams.text) — copy a snippet, recipe, command, or summary.
    - \`setState\` — let the user pick/compare/select an option in-place (e.g. mark a
      favorite, toggle a tab), paired with \`toggle_visible\` to reveal detail.
    - \`explore_into\` — a focused drill-down attached to a specific card/item.
  Give each CTA a clear label + \`icon\`. Match the CTA to the content: a recipe card
  gets "Copy ingredients" / "Make a shopping list"; a product gets "Compare" /
  "See alternatives"; a concept gets "Explain simply" / "Quiz me".

## Stay inside Explore — web is for GROUNDING, not redirecting

Live web data (when present) is here to make your view ACCURATE and RICH with
real facts and images. It is NOT a reason to send the user out to websites.
- Keep the user INSIDE Explore. The primary way forward is always \`explore_into\`
  (drill into a sub-topic) or a form/\`send_prompt\` for actions.
- Do NOT add an \`open_url\` button for every source, and do NOT make sources,
  titles, or list items into \`open_url\` links. Present the web facts as content
  (Text, Stat, List, Table, Cards, Images) — synthesized, not as a link farm.
- \`open_url\` is allowed ONLY sparingly: at most ONE small "View source" / "Open
  official site" affordance for the whole view, and only when genuinely useful.
  When in doubt, omit it and offer an \`explore_into\` instead.

## Use real images (IMPORTANT — don't ship text-only layouts)

Most topics have a visual dimension — products, places, people, animals, food,
hardware, brands, media, art, UI. When they do, you MUST include images:
- Use \`Image\` (\`src\`, \`alt\`) inside Cards/Grids to lead product/place/person
  entries with a thumbnail; use a \`Carousel\` of \`Image\` children or a \`Playlist\`
  with \`type:"image"\` items for galleries.
- \`Image\` can be made CLICKABLE by adding an \`action\`+\`actionParams\` (same
  actions as \`Button\`). Prefer \`explore_into\` (drill into that product/entry)
  or \`setState\` (mark it as the user's selected/preferred option in a
  comparison) — NOT \`open_url\`. This lets the user tap an image to choose or
  dive deeper while staying inside Explore.
- **Only use real, absolute http(s) image URLs.** Take them from the "Images
  found" list and the \`![alt](src)\` markdown in the LIVE WEB DATA below. NEVER
  invent, guess, or placeholder an image URL. If no real image URL is available
  for an item, omit the image for that item rather than fabricating one.
- Do NOT construct plausible-looking URLs from memory (e.g. \`upload.wikimedia.org/...\`,
  blog \`/images/...\` paths, CDN guesses). If a URL does not appear VERBATIM in the
  data below, you may not use it. A view with fewer real images is better than one
  with broken links.
- NEVER emit an \`Image\` with an empty/missing \`src\`, a "placeholder"/"example"/"sample"
  value, or a placeholder service (via.placeholder, dummyimage, placehold.co, picsum,
  loremflickr). An \`Image\` element must carry a real URL from the data, or you must
  leave it out entirely — empty image slots render as ugly broken boxes.
- When live web data is present and contains images, include at least 2–4 of
  them, matched to the most relevant cards/items.

## Collecting information from the user (forms)

When the prompt is a TASK that needs details from the user — e.g. "register me
on <site>", "open an account", "sign me up", "fill this application", "book X",
"create a profile" — render an interactive FORM instead of (or in addition to)
the journey map:
- Use \`Input\`, \`Textarea\`, \`Select\`, \`RadioGroup\`, and \`Checkbox\` elements. Bind
  each to state with \`"value": { "$bindState": "/fieldName" }\` so typed values
  are captured live.
- **Prefill what you already know.** Use the "Relevant context" and any user
  preferences provided to pre-populate fields: seed them in the top-level
  \`"state"\` object (e.g. \`"state": { "fullName": "...", "email": "...", "country": "..." }\`)
  and bind the same paths. Only leave fields blank when you genuinely lack the
  value. Mark clearly which fields you prefilled (e.g. a \`hint: "from your profile"\`).
- Group related fields in a \`Card\`; use \`Heading\`/\`Text\` to explain what's being
  collected and why. Add validation \`hint\`/\`error\` text where useful.
- Add a primary "Continue" / "Submit" \`Button\` that hands the collected values to
  the main chat so an agent (with browser/tools) can actually act on them. Build
  its text with a \`$template\` so the live field values are interpolated at click
  time:
    "action": "send_prompt",
    "actionParams": { "text": { "$template": "Register me on example.com with name \${/fullName}, email \${/email}, country \${/country}. Use these details to complete the signup." } }
  You may instead use \`explore_into\` (with a \`$template\` prompt) to advance to a
  confirmation/next-step view inside Explore.
- Never invent credentials, card numbers, or secrets. Ask the user for sensitive
  values via fields (e.g. \`type: "password"\`) — do NOT prefill them.

## GROUNDING-FIRST — never fabricate private, live, or project-specific data (CRITICAL)

You do NOT have access to the user's real project data, task lists, metrics,
analytics, files, calendars, accounts, or any private/live numbers UNLESS they
appear VERBATIM in the "Relevant context", "Available Fauna projects", or LIVE
WEB DATA sections below. When a prompt asks about such data — e.g. "project
status", "my/our project", "progress", "team metrics", "open risks", "what's
left to do", "sprint/board status", "how is X going", roadmap, burndown, account
balances, inbox, or calendar — you MUST NOT invent it.

NEVER fabricate Stats, KPIs, percentages, sparkline/chart data, gauges, task or
risk counts, timelines, statuses ("On Track"), highlights, or list entries to
fill such a view. A plausible-looking dashboard built from made-up numbers is a
HALLUCINATION and is strictly forbidden — even if it looks polished.

Instead, when the real data is missing, render a GROUNDING view that asks for
the right source before showing anything:
- Lead with a Heading + short Text that honestly says you need to know which
  source to pull real data from (do NOT pretend you already have it).
- Offer the user's real projects as choices: render ONE \`explore_into\` Button
  per entry in "Available Fauna projects", each with an \`actionParams.prompt\`
  that names the chosen project and asks to GROUND on it, e.g.
    { "action": "explore_into", "actionParams": { "prompt": "Show the status of the Fauna project \\"<name>\\". Use its real tasks, progress, and notes as grounding — do not invent data; if something is missing, say so and ask to connect it.", "title": "<name>" } }
  If no projects are listed, skip this and go straight to the form below.
- Add an "Other / external project" path: a small form (\`Input\`/\`Textarea\` bound
  to state) for the user to name or paste a link/details of another project, with
  a \`send_prompt\` or \`explore_into\` Button whose \`$template\` text forwards what
  they typed so an agent/tool can fetch the real context.
- If public web data could help (open-source repos, public docs/sites), offer an
  \`explore_into\` that re-frames the prompt as a web search to ground on.
- Keep this grounding view focused. Do NOT pad it with invented metrics to look
  richer — a short, honest "pick a source" view is the correct output here.

Render a populated, metric-rich dashboard ONLY when the underlying numbers are
actually present in the provided context/web data. If you have SOME real data
but not all, show only what's grounded and clearly mark the rest as "not
connected yet" with an action to provide it — never backfill gaps with guesses.

## Other rules
- Never invent actions beyond: explore_into, send_prompt, prefill_chat, open_url,
  setState, toggle_visible, copy_text.
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

// Collect real, absolute image URLs from markdown image syntax `![alt](src)`.
// Turndown keeps img tags but does NOT absolutize their src, so resolve each
// against the page URL and drop icons/sprites/svg/data URIs.
function collectImages(md, baseUrl, max) {
  const out = [];
  const seen = new Set();
  const re = /!\[[^\]]*\]\(([^)\s]+)\)/g;
  let m;
  while ((m = re.exec(md)) && out.length < max) {
    let src = m[1];
    try { src = new URL(src, baseUrl || 'https://duckduckgo.com').href; } catch (_) { continue; }
    if (!/^https?:\/\//i.test(src)) continue;
    if (/sprite|\bicon\b|favicon|logo|\.svg(\?|$)|data:|1x1|pixel|spacer/i.test(src)) continue;
    // DuckDuckGo's proxy/redirect image URLs (external-content / //duckduckgo.com/i/)
    // and other tracking beacons routinely 404 through our fetch proxy — skip them.
    if (/duckduckgo\.com\/(i|iu)\b|external-content\.duckduckgo|\/(track|beacon|analytics|pixel)\b/i.test(src)) continue;
    // Ephemeral / signed / dynamic URLs that expire or 502 through the proxy:
    //  - GitHub signed user-content (private-user-images / camo) carry short-lived JWTs → 404 in minutes.
    //  - Any URL bearing a signature/expiry query token (S3 X-Amz-*, jwt, sig, token, expires).
    //  - Dynamic Open-Graph image endpoints (opengraph-image / og-image / /api/og) frequently 502.
    if (/private-user-images\.githubusercontent|camo\.githubusercontent/i.test(src)) continue;
    if (/[?&](jwt|x-amz-signature|x-amz-credential|signature|sig|token|expires)=/i.test(src)) continue;
    if (/\b(opengraph-image|og-image)\b|\/api\/og(\/|\?|$)/i.test(src)) continue;
    if (seen.has(src)) continue;
    seen.add(src);
    out.push(src);
  }
  return out;
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
  const images = collectImages(String(search.content), searchUrl, 8);
  const urls = pickResultUrls(String(search.content), 2);
  for (const u of urls) {
    const page = await browseExtract(manager, u, 5000);
    if (page && page.content) {
      grounding += `\n### Source: ${u}\n${page.title ? page.title + '\n' : ''}${String(page.content).slice(0, 5000)}\n`;
      collectImages(String(page.content), u, 6).forEach((src) => { if (!images.includes(src)) images.push(src); });
    }
  }
  if (images.length) {
    grounding += `\n### Images found (real, absolute URLs — use these for Image \`src\`)\n` +
      images.slice(0, 12).map((u) => `- ${u}`).join('\n') + '\n';
  }
  return grounding;
}

// Decide whether a prompt actually warrants a live web lookup. Explore is
// contextual by default: prompts about the user's OWN projects, tasks, status,
// progress, or other private/local data must NOT hit the internet (there is
// nothing to find and it just adds latency + risks link-farm views), while
// general-knowledge, comparison, or current-events topics genuinely benefit
// from web grounding. This keeps "project health" fast and grounded on local
// context instead of scraping the web. Returns true when web grounding helps.
function promptNeedsWeb(prompt, projects) {
  const p = String(prompt || '').toLowerCase().trim();
  if (!p) return false;

  // Prompt names one of the user's real projects → it's about local data.
  if (Array.isArray(projects)) {
    for (const proj of projects) {
      const name = proj && proj.name ? String(proj.name).toLowerCase().trim() : '';
      if (name.length >= 3 && p.includes(name)) return false;
    }
  }

  // "my/our/this/the <project|task|board|sprint|repo|codebase|team>" — local.
  const OWNED = /\b(my|our|this|the)\b[^.?!]{0,40}\b(project|projects|task|tasks|to-?dos?|board|sprint|backlog|roadmap|burndown|milestone|team|repo|repository|codebase|workspace)\b/;
  // Status / health / progress language — about the user's own work.
  const STATUS = /\b(project\s+health|health\s+of|status\s+of|at\s+a\s+glance|what'?s\s+left|whats\s+left|open\s+risks?|blockers?|what\s+should\s+i\s+work\s+on|how'?s?\s+(it|things|the\s+\w+|my|our)\b[^?]*\b(going|doing|coming|progressing)|(my|our)\s+progress)\b/;
  // Personal/private surfaces that live inside Fauna, never on the open web.
  const PERSONAL = /\b(my|our)\b[^.?!]{0,40}\b(metrics|kpis?|analytics|calendar|inbox|emails?|schedule|files?|notes?|account|dashboard|activity|standup|stand-up)\b/;
  if (OWNED.test(p) || STATUS.test(p) || PERSONAL.test(p)) return false;

  // Everything else is treated as a general topic where web grounding helps.
  return true;
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
    // `body.web` means "web grounding is allowed". Whether we actually fetch is
    // decided contextually below (promptNeedsWeb) once we know the projects, so
    // local/status prompts like "project health" never hit the internet.
    const webAllowed = body.web === true;
    const agentPrompt = typeof body.agentPrompt === 'string' ? body.agentPrompt.slice(0, 6000) : '';
    const agentName = typeof body.agentName === 'string' ? body.agentName.slice(0, 80) : '';

    // The user's real Fauna projects, offered to the model as grounding choices
    // so status/data prompts ask which project to pull from instead of inventing
    // a dashboard.
    const projects = Array.isArray(body.projects)
      ? body.projects
          .map((p) => {
            if (!p || typeof p !== 'object') return null;
            const name = typeof p.name === 'string' ? p.name.slice(0, 120).trim() : '';
            if (!name) return null;
            const description = typeof p.description === 'string' ? p.description.slice(0, 200).trim() : '';
            return { name, description };
          })
          .filter(Boolean)
          .slice(0, 30)
      : [];

    if (!prompt) return res.status(400).json({ ok: false, error: 'prompt required' });

    const trail = path.length ? `\n\n## Journey so far (breadcrumb)\n${path.join(' → ')}` : '';
    const ctx = context ? `\n\n## Relevant context\n${context}` : '';
    const projectsBlock = projects.length
      ? `\n\n## Available Fauna projects (the user's REAL projects — offer these as grounding choices for status/data prompts)\n` +
        projects.map((p) => `- ${p.name}${p.description ? ' — ' + p.description : ''}`).join('\n')
      : `\n\n## Available Fauna projects\n(none found — for status/data prompts, ask the user to name, link, or describe the project/source instead of inventing data)`;

    // Optional live-web grounding via the Playwright browse manager. Only fetch
    // when web is allowed AND the prompt actually calls for external data —
    // status/progress/project prompts stay grounded on local context instead.
    const useWeb = webAllowed && promptNeedsWeb(prompt, projects);
    let grounding = '';
    if (useWeb && typeof getBrowseManager === 'function') {
      try { grounding = await gatherWebGrounding(getBrowseManager(), prompt); } catch (_) {}
    }

    let system = GEN_UI_CATALOG_PROMPT + '\n' + EXPLORE_RULES;
    if (agentPrompt) {
      system = `## Active agent persona\nYou are acting as the "${agentName || 'custom'}" agent. Adopt its expertise, focus, and voice when building the view:\n${agentPrompt}\n\n` + system;
    }

    let userContent = `Explore this for me and return one interactive gen-ui spec:\n\n${prompt}${trail}${ctx}${projectsBlock}`;
    if (grounding) {
      userContent += `\n\n## LIVE WEB DATA (fetched just now — current)\n${grounding}\n` +
        'Use this live data to GROUND the view with real facts and images — synthesize it into rich content (Text, Stat, List, Table, Cards, Images). Use ONLY URLs that appear above for Image `src` — never invent URLs. Do NOT turn the view into outbound links: keep the user inside Explore via `explore_into` buttons. Add an `open_url` button only sparingly (at most one "View source" affordance), not one per source.';
    }

    // Derive a title: root props.title → first Heading → prompt slice.
    const deriveTitle = (s) => {
      let t = '';
      const rootEl = s.elements[s.root];
      if (rootEl && rootEl.props && rootEl.props.title) t = String(rootEl.props.title);
      if (!t) {
        for (const k of Object.keys(s.elements)) {
          const el = s.elements[k];
          if (el && el.type === 'Heading' && el.props && el.props.text) { t = String(el.props.text); break; }
        }
      }
      return t || prompt.slice(0, 60);
    };

    try {
      const client = getCopilotClient();
      // Try the requested model, then a known-reliable JSON fallback.
      const fallback = 'gpt-4.1';
      const messagesFor = () => ([
        { role: 'system', content: system },
        { role: 'user', content: userContent },
      ]);

      // ── Streaming path (SSE) ──────────────────────────────────────────────
      // Paint the Explore view progressively as the spec JSON arrives, instead
      // of blocking on the whole completion. The client parses the accumulated
      // partial JSON, closes open structures, and re-renders as it grows.
      if (body.stream === true) {
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        if (typeof res.flushHeaders === 'function') res.flushHeaders();
        const sse = (obj) => { try { res.write('data: ' + JSON.stringify(obj) + '\n\n'); } catch (_) {} };
        let raw = '';
        try {
          const stream = await client.chat.completions.create({
            model, max_tokens: 8000, stream: true, messages: messagesFor(),
          });
          for await (const chunk of stream) {
            const piece = chunk?.choices?.[0]?.delta?.content || '';
            if (piece) { raw += piece; sse({ type: 'delta', text: piece }); }
          }
        } catch (e) {
          console.warn('[genui-explore] stream error:', (e && e.message) || e);
        }
        let spec = extractSpecJson(raw);
        // Fall back to a reliable JSON model if the streamed output didn't parse.
        if (!(spec && spec.root && spec.elements) && fallback !== model) {
          try {
            const resp = await client.chat.completions.create({
              model: fallback, max_tokens: 8000, messages: messagesFor(),
            });
            const rawOut = resp?.choices?.[0]?.message?.content || '';
            const parsed = extractSpecJson(rawOut);
            if (parsed && parsed.root && parsed.elements) spec = parsed;
          } catch (_) {}
        }
        if (!(spec && spec.root && spec.elements)) {
          sse({ type: 'error', error: 'Model did not return a valid gen-ui spec' });
          return res.end();
        }
        sse({ type: 'done', ok: true, title: deriveTitle(spec), spec, grounded: !!grounding });
        return res.end();
      }

      // ── Non-streaming path ────────────────────────────────────────────────
      const chain = [model];
      if (fallback !== model) chain.push(fallback);

      let spec = null;
      let lastRaw = '';
      let lastErr = '';
      for (const m of chain) {
        let response;
        try {
          response = await client.chat.completions.create({
            model: m,
            max_tokens: 8000,
            messages: messagesFor(),
          });
        } catch (e) {
          lastErr = (e && e.message) || 'request failed';
          console.warn('[genui-explore] model', m, 'request error:', lastErr);
          continue;
        }
        const rawOut = response.choices?.[0]?.message?.content || '';
        lastRaw = rawOut;
        const parsed = extractSpecJson(rawOut);
        if (parsed && parsed.root && parsed.elements) { spec = parsed; break; }
        console.warn('[genui-explore] model', m, 'returned unparseable spec (', rawOut.length, 'chars):', rawOut.slice(0, 200).replace(/\s+/g, ' '));
      }

      if (!spec) {
        return res.status(502).json({
          ok: false,
          error: 'Model did not return a valid gen-ui spec',
          detail: lastErr || (lastRaw ? lastRaw.slice(0, 300) : 'empty response'),
        });
      }
      res.json({ ok: true, title: deriveTitle(spec), spec, grounded: !!grounding });
    } catch (e) {
      console.warn('[genui-explore] generation failed:', e && e.message);
      if (res.headersSent) {
        try { res.write('data: ' + JSON.stringify({ type: 'error', error: e.message || 'generation failed' }) + '\n\n'); } catch (_) {}
        try { res.end(); } catch (_) {}
      } else {
        res.status(500).json({ ok: false, error: e.message || 'generation failed' });
      }
    }
  });
}
