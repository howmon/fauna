// Memory categories + user preferences + structured facts routes.
// Extracted from server.js. Returns `{ loadPrefs }` so server.js can read
// preferences for system-prompt assembly without re-defining the helper.

import fs from 'fs';
import path from 'path';

import {
  remember as factsRemember, recall as factsRecall, forget as factsForget,
  listFacts, runDecay, exportFacts, importFacts, getStats as factsGetStats,
} from '../../memory-store.js';
import {
  listProposals, approveProposal, rejectProposal, getProposalStats,
} from '../lib/memory-extractor.js';

export function registerMemoryPrefsFactsRoutes(app, { configDir }) {
  const MEMORY_FILE = path.join(configDir, 'memory.json');
  const PREFS_FILE  = path.join(configDir, 'preferences.json');

  function loadPrefs() {
    try { return JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8')); }
    catch (_) { return { playbook: [], agentRules: [], systemPrompt: '' }; }
  }
  function savePrefs(patch) {
    const current = loadPrefs();
    fs.writeFileSync(PREFS_FILE, JSON.stringify({ ...current, ...patch }, null, 2));
  }

  function defaultFigmaGroups() {
    return [];
  }

  // Original built-in Figma spec groups (kept for reference / manual restore via Reset Built-in)
  function _builtInFigmaGroupsRef() {
    return [
      { id: 'workflow',           title: 'Workflow — When User Asks to Create a Spec', body: 'When the user asks to create a design/component spec:\n1. **Resolve component instance first**: Before generating any spec, determine if you have a component key or node ID for the target component. Check if the user provided one, or if you can find it via `get_design_context`/`get_metadata`. **If the component instance is NOT available**, prompt the user: _"Please select the component in Figma (or provide the component key/node ID) so I can include live instances in the anatomy, variants, and examples sections."_ Do NOT proceed until the component reference is resolved.\n2. **If Figma MCP is enabled**: Ask the user whether they want the spec created **in Figma** or **as a markdown artifact**.\n3. **If Figma MCP is not enabled**: Generate the spec as a markdown artifact using the markdown format below.\n4. **ALWAYS use the `figma_execute` MCP tool** for Figma output — never use `figma-exec` fenced blocks for spec creation.', enabled: true },
      { id: 'build-sequence',     title: 'Figma Build Sequence', body: '1. **Create page**: `figma.createPage()` → set name → `figma.currentPage = page`\n2. **Splash card** at x=-1300: import splash key, set properties (Guidance Checklist#12857:0=false, Contact list#357:0=false, Resource list#357:1=false, Custom#10144:1=true), override text nodes ("Component name", description, kind label)\n3. **6 sections** side-by-side: each at x = index * 1300 (1200px + 100px gap)\n   - Root frame: 1200px wide, VERTICAL, primaryAxisSizingMode=AUTO, counterAxisSizingMode=FIXED, itemSpacing=0, fills=[white], cornerRadius=32\n   - GuidanceHeader instance: layoutAlign=STRETCH, find TEXT nodes named "Title" → [0]=number, [1]=title\n   - Page frame: 1200px, VERTICAL, itemSpacing=32, padding 64/88/64/88, fills=[#FAFAFA], layoutAlign=STRETCH\n   - Content blocks inside Page frame\n4. **Zoom to fit**: `figma.viewport.scrollAndZoomIntoView(allFrames)`', enabled: true },
      { id: 'instance-placement', title: 'Component Instance Placement', body: '### Anatomy (Overview section)\n1. Import the target component via `figma.importComponentByKeyAsync(componentKey)` and create an instance.\n2. Place the instance inside the Overview page frame, below the anatomy text descriptions.\n3. Add numbered annotation markers (small circles with numbers) positioned over each anatomy part.\n4. Cap width to 1024px: `if (inst.width > 1024) inst.rescale(1024 / inst.width)`\n\n### Variants (Overview section)\n1. Retrieve all variant properties from the component set.\n2. For each meaningful variant combination, create an instance and set its variant properties via `inst.setProperties({...})`.\n3. Label each instance with a text node showing the variant/config name.\n4. Arrange instances in a grid or vertical stack inside the Overview page frame.\n5. If variant properties are not discoverable, prompt the user.\n\n### Examples section\n1. For each example entry, create a component instance configured to match the described state/scenario.\n2. Set variant properties to reflect the example\'s state.\n3. Place the instance adjacent to or below the example\'s text description.\n4. If the component key is unavailable, prompt the user before generating this section.\n\n### Fallback: Prompting the User\nIf the component key, node ID, or variant information is not available:\n- **Do NOT skip** the instance — pause and ask the user.\n- Resume spec generation only after the component reference is resolved.', enabled: true },
      { id: 'font-loading',       title: 'Font Loading Helper', body: 'REQUIRED before setting .characters — use this exact helper:\n```js\nasync function loadFont(textNode) {\n    const fn = textNode.fontName;\n    try { await figma.loadFontAsync(fn); return; } catch(_) {}\n    const parts = fn.style.split(\' \');\n    if (parts.length >= 2) {\n        const reversed = { family: fn.family, style: parts.reverse().join(\' \') };\n        try { await figma.loadFontAsync(reversed); textNode.fontName = reversed; return; } catch(_) {}\n    }\n    const synonyms = {Demibold:\'Semibold\', Semibold:\'Demibold\', Medium:\'Regular\', Heavy:\'Bold\', Black:\'Bold\', ExtraBold:\'Bold\'};\n    for (const [from, to] of Object.entries(synonyms)) {\n        if (fn.style.includes(from)) {\n            const alt = { family: fn.family, style: fn.style.replace(from, to) };\n            try { await figma.loadFontAsync(alt); textNode.fontName = alt; return; } catch(_) {}\n        }\n    }\n    const s = fn.style.toLowerCase();\n    const w = s.includes(\'bold\') ? \'Bold\' : s.includes(\'semi\') || s.includes(\'demi\') ? \'Semibold\' : \'Regular\';\n    const fb = { family: \'Segoe UI\', style: w };\n    await figma.loadFontAsync(fb); textNode.fontName = fb;\n}\n```', enabled: true },
      { id: 'text-overrides',     title: 'Text Block Overrides', body: 'CRITICAL: No placeholder text may remain.\n- After creating ANY component instance, MUST find ALL text nodes and override them:\n  `const texts = inst.findAll(n => n.type === \'TEXT\');`\n- texts[0] = title, texts[1] = body — ALWAYS call `loadFont(texts[N])` then set `.characters`\n- If no title needed: `texts[0].characters = \'\'` and `inst.setProperties({\'Show title#10151:2\': false})`\n- If no body needed: `texts[1].characters = \'\'` and `inst.setProperties({\'Show body#10151:8\': false})`\n- Default placeholders like "Section title L", "Body text M", "Heading XXL" WILL show if you skip this', enabled: true },
      { id: 'component-blocks',   title: 'Component Instance Blocks', body: '- Import via `figma.importComponentByKeyAsync(component_key)`, call `.createInstance()`\n- Set `layoutAlign = \'CENTER\'`, set name if provided\n- Toggle boolean properties: `inst.setProperties({ \'PropertyName#id\': true/false })`\n- Cap width: `if (inst.width > 1024) inst.rescale(1024 / inst.width)`', enabled: true },
      { id: 'data-model',         title: 'Spec Data Model (6 Sections)', body: '### 1. Overview\n- `component_name`: string\n- `description`: 1-3 sentence description\n- `anatomy_parts`: list of `{number, name, description}`\n- `anatomy_instance`: **REQUIRED** — annotated live instance with numbered annotation markers\n- `variants`: list of variant/state names\n- `variant_instances`: **REQUIRED** — live instances for EVERY variant and configuration\n- `live_preview`: optional component instance reference\n\n### 2. Content\n- `guidance`: `{date_format, punctuation, heading_text, capitalization, overflow_menu_suggestions[], footer_button_suggestions[]}`\n- `examples`: list of `{context, annotations[], guidelines[], live_preview?}`\n\n### 3. Usage\n- `when_to_use`: list of strings\n- `when_not_to_use`: list of strings\n- `dos`: list of `{label, description}`\n- `donts`: list of `{label, description}`\n- `placement`: string\n\n### 4. Accessibility\n- `guidelines`: prose string\n- `keyboard_interactions`: list of `{key, action}`\n- `tab_order`: ordered list of tab stop strings\n- `narration_entries`: list of `{number, key, state, narrator_string}`\n\n### 5. Examples\n- `examples`: list of `{title, description, state, live_preview?}`\n- `example_instances`: **REQUIRED** — live component instance per example\n\n### 6. RAI (Responsible AI)\n- `citations_and_references`: string\n- `ai_disclaimer`: string\n- `principles`: list of `{name, description}`', enabled: true },
      { id: 'component-keys',     title: 'Component Keys (KEYS dict)', body: '- `header`: `c92557049724bf0d8726c1a34563ef7a3b5b6e70` — UTIL-GuidanceHeader\n- `text_xxl`: `b7aef3e443b5804c628d08afb00dc43d9cb871f8` — UTIL-GuidanceTextBlock Style=XXL\n- `text_l`: `3e8e9cfe13596cd04f09d8dce37d0fbfc8a63644` — UTIL-GuidanceTextBlock Style=L\n- `text_m`: `196ec978c2bbad76accfce02b7da49e531779de5` — UTIL-GuidanceTextBlock Style=M\n- `text_s`: `7ebd43d5387e9597987dfa86ac4306e76d4b468d` — UTIL-GuidanceTextBlock Style=S\n- `buffer`: `e6adb6c3061e04f438d8aacd23252882b3bda616` — Blocks / Buffer (divider)\n- `best_do_header`: `ec326f63f5ea0c33b6cf941857ef16e368484327` — Do header\n- `best_dont_header`: `8a1b46b982d9f69f3b564c0b68160db5cbd157c4` — Don\'t header\n- `best_do_bullet`: `afee6ebe1fd335e8a4380aa58b1de282abb794bc` — Do bullet\n- `best_dont_bullet`: `fb2df191ed6cd41418d85550e1a22a90a47f5562` — Don\'t bullet\n- `splash`: `076bea735b162eaa152d9df6b37b75ec2bed315b` — UTIL-GuidanceComponentSplash (cover card)\n- `footer`: `324a9470b9d637ed69401111ab277e01346d606a` — UTIL-GuidanceFooter', enabled: true },
      { id: 'design-tokens',      title: 'Design Token Variable Keys', body: '### Backgrounds\n- `bg1`: `4a08218e9cddb87bafa9b83f73e6ee40f5e15e3e` — Neutral/Background/1/Rest (#fff)\n- `bg2`: `0fa4c8c8fc13d3e98f827a96f25168a46cf5adc9` — Neutral/Background/2/Rest\n- `bg3`: `16a0b41baa19d91b71f810dbce608a7b86bde49f` — Neutral/Background/3/Rest\n- `bg4`: `97aa51374458940b6d7b66c1a8e91186e386bf15` — Neutral/Background/4/Rest\n### Foregrounds\n- `fg1`: `fbc35e3f43dd8dad7a0c8b48e7c547058ecc651c` — Neutral/Foreground/1 (#242424)\n- `fg2`: `42e6c2df6cd2a75d6aa36c4e56b3b38ea0d3f4c0` — Neutral/Foreground/2 (#424242)\n- `fg3`: `af92c07f44a2bcab9ee3d6d87c1fffc9a3fb0c35` — Neutral/Foreground/3 (#616161)\n### Spacing\n- `spacing_s`: `2cfecff21b7f4aa80cac71e6f13a1f79e6e3d85a` — 8px\n- `spacing_m`: `a15a3dae66bae06f1c0f7d5f88c02d8cca3adac0` — 12px\n- `spacing_l`: `d80ff8c9f6ad5e92c18f0c1a1b9d2aef9b736ef6` — 16px\n- `spacing_xxl`: `f55b0ced58de9daba5d5e66e0e3b85dc6deab53a` — 24px\n### Corner Radius\n- `corner_section`: `1cc316818f4f64417e936f0d49cc6288620a347f` — 12px', enabled: true },
      { id: 'font-presets',       title: 'Font Presets (TYPO dict)', body: '- `heading_large`: Segoe UI, 32px, 40px, Bold\n- `heading_medium`: Segoe UI, 24px, 32px, Semibold\n- `heading_small`: Segoe UI, 20px, 28px, Semibold\n- `subtitle`: Segoe UI, 16px, 22px, Semibold\n- `body1`: Segoe UI, 14px, 20px, Regular\n- `body1_strong`: Segoe UI, 14px, 20px, Semibold\n- `caption1`: Segoe UI, 12px, 16px, Regular\n- `caption2_strong`: Segoe UI, 10px, 14px, Semibold', enabled: true },
      { id: 'rendering-format',   title: 'Rendering Format (Figma & Markdown)', body: '### Figma Rendering\n- Each section is a 1200px-wide vertical auto-layout frame with rounded corners (32px)\n- Sections placed side-by-side with 100px gaps\n- Cover card (UTIL-GuidanceComponentSplash) placed at x=-1300\n- Each section has: UTIL-GuidanceHeader (number + title) → "Page" content frame (88px padding, 32px item spacing, #FAFAFA bg)\n- Content blocks use these component types: text_xxl, text_l, text_m, text_s, buffer (divider), do_header, dont_header, do_bullet, dont_bullet, component_instance\n- Section order: Overview → Usage → Examples → Accessibility → Content → RAI\n- Font loading: use `figma.loadFontAsync(textNode.fontName)` with fallback to reversed style names, then Segoe UI Bold/Semibold/Regular\n\n### Markdown Rendering\n```\n# ComponentName\n> Description\n\n## Anatomy (table: #, Part, Description)\n## Anatomy Instance (annotated live component)\n## Variants (bullet list + live instances)\n---\n# Content\n## Additional guidance\n## Examples of content\n---\n# Usage\n## When to use / When not to use\n## Do / Don\'t\n## Placement\n---\n# Accessibility\n## Accessibility guidelines\n## Keyboarding\n### Tab order\n## Narration\n---\n# Examples (title, description, live instance)\n---\n# RAI\n## Citations and references\n## AI disclaimer\n## RAI Principles\n```', enabled: true },
    ];
  }
  // Reference unused helpers so linters/tooling don't flag them; preserved
  // verbatim for "Reset Built-in" feature parity with previous server.js.
  void _builtInFigmaGroupsRef;
  void defaultFigmaGroups;

  function defaultMemoryCategories() {
    return [];
  }

  // Migration: if saved data is flat array of groups (old format), wrap into category
  function migrateMemoryData(data) {
    if (!Array.isArray(data) || data.length === 0) return defaultMemoryCategories();
    // Old format: [{id, title, body, enabled}] — no "groups" key on first element
    if (data[0] && !data[0].groups && data[0].body !== undefined) {
      return [{ id: 'figma-spec-design', name: 'Figma Spec Design', icon: 'brand-figma', enabled: true, builtIn: true, groups: data }];
    }
    return data;
  }

  function loadMemoryCategories() {
    try {
      const raw = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
      return migrateMemoryData(raw);
    } catch (_) {}
    return defaultMemoryCategories();
  }

  function saveMemoryCategories(categories) {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(categories, null, 2));
  }

  // GET — return all categories
  app.get('/api/memory', (req, res) => {
    res.json(loadMemoryCategories());
  });

  // ── Preferences (playbook + agent rules + system prompt) ────────────────
  app.get('/api/preferences', (req, res) => {
    res.json(loadPrefs());
  });

  app.put('/api/preferences', (req, res) => {
    const patch = req.body;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch))
      return res.status(400).json({ error: 'Expected object' });
    savePrefs(patch);
    res.json({ ok: true });
  });

  // PUT — save all categories (full replace)
  app.put('/api/memory', (req, res) => {
    const cats = req.body;
    if (!Array.isArray(cats)) return res.status(400).json({ error: 'Expected array of categories' });
    saveMemoryCategories(cats);
    res.json({ ok: true });
  });

  // POST — create a new category
  app.post('/api/memory/category', (req, res) => {
    const { name, icon } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Category name required' });
    const cats = loadMemoryCategories();
    const id = 'cat-' + Date.now();
    const keywords = Array.isArray(req.body.keywords) ? req.body.keywords : [];
    const cat = { id, name: name.trim(), icon: icon || 'tools', enabled: true, builtIn: false, keywords, groups: [] };
    cats.push(cat);
    saveMemoryCategories(cats);
    res.json({ ok: true, category: cat });
  });

  // DELETE — delete a category by id
  app.delete('/api/memory/category/:catId', (req, res) => {
    const cats = loadMemoryCategories();
    const idx = cats.findIndex(c => c.id === req.params.catId);
    if (idx === -1) return res.status(404).json({ error: 'Category not found' });
    cats.splice(idx, 1);
    saveMemoryCategories(cats);
    res.json({ ok: true });
  });

  // PATCH — update a category (name, icon, enabled) or a group within it
  app.patch('/api/memory/category/:catId', (req, res) => {
    const cats = loadMemoryCategories();
    const cat = cats.find(c => c.id === req.params.catId);
    if (!cat) return res.status(404).json({ error: 'Category not found' });
    const { name, icon, enabled, keywords } = req.body;
    if (name !== undefined) cat.name = name;
    if (icon !== undefined) cat.icon = icon;
    if (enabled !== undefined) cat.enabled = enabled;
    if (keywords !== undefined) cat.keywords = Array.isArray(keywords) ? keywords : [];
    saveMemoryCategories(cats);
    res.json({ ok: true, category: cat });
  });

  // POST — add a skill group to a category
  app.post('/api/memory/category/:catId/group', (req, res) => {
    const cats = loadMemoryCategories();
    const cat = cats.find(c => c.id === req.params.catId);
    if (!cat) return res.status(404).json({ error: 'Category not found' });
    const { title, body } = req.body;
    if (!title || !title.trim()) return res.status(400).json({ error: 'Group title required' });
    const group = { id: 'grp-' + Date.now(), title: title.trim(), body: body || '', enabled: true };
    cat.groups.push(group);
    saveMemoryCategories(cats);
    res.json({ ok: true, group });
  });

  // PATCH — update a group within a category
  app.patch('/api/memory/category/:catId/group/:grpId', (req, res) => {
    const cats = loadMemoryCategories();
    const cat = cats.find(c => c.id === req.params.catId);
    if (!cat) return res.status(404).json({ error: 'Category not found' });
    const grp = cat.groups.find(g => g.id === req.params.grpId);
    if (!grp) return res.status(404).json({ error: 'Group not found' });
    Object.assign(grp, req.body);
    saveMemoryCategories(cats);
    res.json({ ok: true, group: grp });
  });

  // DELETE — remove a group from a category
  app.delete('/api/memory/category/:catId/group/:grpId', (req, res) => {
    const cats = loadMemoryCategories();
    const cat = cats.find(c => c.id === req.params.catId);
    if (!cat) return res.status(404).json({ error: 'Category not found' });
    const idx = cat.groups.findIndex(g => g.id === req.params.grpId);
    if (idx === -1) return res.status(404).json({ error: 'Group not found' });
    cat.groups.splice(idx, 1);
    saveMemoryCategories(cats);
    res.json({ ok: true });
  });

  // POST — reset built-in categories to defaults (preserves user-created categories)
  app.post('/api/memory/reset', (req, res) => {
    const cats = loadMemoryCategories();
    const defaults = defaultMemoryCategories();
    // Replace built-in categories with defaults, keep user-created ones
    const userCats = cats.filter(c => !c.builtIn);
    const result = [...defaults, ...userCats];
    saveMemoryCategories(result);
    res.json({ ok: true, categories: result, defaults });
  });

  // ── Structured Facts Memory ─────────────────────────────────────────────
  // Individual facts the AI learns about the user, with decay and recall scoring.

  app.get('/api/facts', (req, res) => {
    const category = req.query.category || null;
    res.json(listFacts(category));
  });

  app.get('/api/facts/stats', (req, res) => {
    res.json(factsGetStats());
  });

  app.post('/api/facts', (req, res) => {
    const { text, category } = req.body || {};
    const result = factsRemember(text, category);
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  });

  app.post('/api/facts/recall', (req, res) => {
    const { keywords } = req.body || {};
    const results = factsRecall(keywords);
    res.json(results);
  });

  app.delete('/api/facts/:id', (req, res) => {
    const result = factsForget(req.params.id);
    if (!result.ok) return res.status(404).json(result);
    res.json(result);
  });

  app.post('/api/facts/decay', (req, res) => {
    const maxAgeDays = req.body?.maxAgeDays || undefined;
    const result = runDecay(maxAgeDays);
    res.json(result);
  });

  app.get('/api/facts/export', (req, res) => {
    res.json(exportFacts());
  });

  app.post('/api/facts/import', (req, res) => {
    const facts = req.body;
    if (!Array.isArray(facts)) return res.status(400).json({ error: 'Expected array of facts' });
    const result = importFacts(facts);
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  });

  // ── Memory proposals (Phase 1 auto-extraction queue) ────────────────────

  app.get('/api/memory/proposals', (req, res) => {
    const status = req.query.status ? String(req.query.status) : null;
    const projectId = req.query.projectId ? String(req.query.projectId) : null;
    const limit = req.query.limit ? Math.max(1, Math.min(500, parseInt(req.query.limit, 10) || 100)) : 100;
    res.json({
      proposals: listProposals({ status, projectId, limit }),
      stats: getProposalStats(),
    });
  });

  app.post('/api/memory/proposals/:id/approve', (req, res) => {
    const r = approveProposal(req.params.id);
    if (!r.ok) return res.status(400).json(r);
    res.json(r);
  });

  app.post('/api/memory/proposals/:id/reject', (req, res) => {
    const r = rejectProposal(req.params.id, req.body?.reason);
    if (!r.ok) return res.status(400).json(r);
    res.json(r);
  });

  return { loadPrefs };
}
