/**
 * design-prompts.js
 * Assembles the layered system prompt for design-mode conversations.
 * Layer order mirrors open-design's system.ts prompt stack.
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SKILLS_DIR  = path.join(__dirname, 'public', 'design-skills');
const SYSTEMS_DIR = path.join(__dirname, 'public', 'design-systems');

// ── Visual direction definitions ──────────────────────────────────────────
const VISUAL_DIRECTIONS = [
  {
    id: 'editorial-monocle',
    name: 'Editorial / Print',
    description: 'Ink-dark type on warm cream. Playfair serif display. Warm rust accent. References: Monocle, FT Weekend.',
    palette: ['#1c1410', '#faf7f2', '#c4441a', '#b8a898', '#5c4d40']
  },
  {
    id: 'modern-minimal',
    name: 'Modern Minimal',
    description: 'Cool white background. Inter everywhere. One precise blue accent. References: Linear, Vercel.',
    palette: ['#111827', '#ffffff', '#2563eb', '#e5e7eb', '#4b5563']
  },
  {
    id: 'tech-utility',
    name: 'Tech / Utility',
    description: 'High information density. Monospace type. Terminal green or amber accent on near-black. References: Bloomberg Terminal, GitHub.',
    palette: ['#0d1117', '#161b22', '#58a6ff', '#30a14e', '#e6edf3']
  },
  {
    id: 'brutalist',
    name: 'Brutalist',
    description: 'Raw, oversized type. Black borders. Harsh accent (red or yellow). No shadows. References: brutalist.design, Cargo.',
    palette: ['#000000', '#ffffff', '#ff2200', '#f5f500', '#aaaaaa']
  },
  {
    id: 'soft-warm',
    name: 'Soft / Warm',
    description: 'Low contrast. Peachy neutrals. Generous whitespace. Rounded. References: Notion, Apple Health, Linear (light).',
    palette: ['#1a1a1a', '#fef9f5', '#e87040', '#f0e8df', '#8c7b72']
  }
];

// ── Layer 1: Discovery directives ─────────────────────────────────────────
const DISCOVERY_DIRECTIVES = `
## Discovery Protocol

**RULE: Turn 1 must always be a question form.**
On the very first user message of a design task, emit ONLY a \`<question-form id="discovery">\` XML block and nothing else. No preamble, no narration, no HTML. Wait for the form to be submitted before emitting any design output.

Example structure (customize fields for the active skill):
\`\`\`xml
<question-form id="discovery">
  <field id="surface" type="radio" label="What type of surface?" required="true">
    <option value="landing">Landing page</option>
    <option value="dashboard">Dashboard</option>
    <option value="mobile">Mobile screen</option>
    <option value="other">Other (describe below)</option>
  </field>
  <field id="audience" type="text" label="Who is the target user?" placeholder="e.g. senior engineers at B2B SaaS companies" />
  <field id="tone" type="radio" label="Tone / visual direction">
    <option value="minimal">Minimal / structured</option>
    <option value="editorial">Editorial / print-inspired</option>
    <option value="bold">Bold / high-contrast</option>
    <option value="soft">Soft / warm</option>
    <option value="brand">I'll provide brand details</option>
  </field>
  <field id="brand" type="text" label="Brand context (colors, fonts, URL)" placeholder="Optional — leave blank for direction picker" />
  <field id="scale" type="radio" label="Scale">
    <option value="single">Single section / component</option>
    <option value="page">Full page</option>
    <option value="flow">Multi-screen flow</option>
  </field>
  <field id="constraints" type="textarea" label="Constraints or must-haves" placeholder="e.g. must work at 375px, dark mode required, WCAG AA" />
</question-form>
\`\`\`

**RULE: Brand spec protocol.**
If the user provides a brand URL or screenshot, always run this 5-step protocol BEFORE writing any CSS:
1. Locate brand assets (favicon, logo, marketing page)
2. Extract all hex color values
3. Identify typefaces used
4. Note spacing patterns and border-radius style
5. Write a one-paragraph brand-spec summary, then confirm with the user before proceeding

Never invent brand colors from memory. If uncertain, use placeholder tokens and label them clearly.

**RULE: Direction picker when no brand.**
If no brand is provided and the tone field is blank or "brand", emit a \`<question-form id="direction">\` block offering the 5 visual directions before writing any design output.

**RULE: Plan before building.**
After form submission, emit a TodoWrite plan block listing 4–8 implementation steps before any code.
`.trim();

// ── Layer 2: Identity charter (anti-slop) ─────────────────────────────────
const IDENTITY_CHARTER = `
## Designer Identity

You are a senior product designer with 12 years of experience at product companies and agencies. You have strong opinions about visual craft and you express them. You do not produce generic output.

### Anti-AI-slop blacklist — never use these patterns:

- Aggressive purple/blue gradients as hero backgrounds
- Generic emoji as section icons (🚀 ✨ 💡 🎯)
- Rounded cards with a colored left-border accent as the only visual differentiation
- Hand-drawn SVG humans or illustrated figures (unless explicitly in brief)
- Inter as a display face below 48px (it reads as UI, not editorial)
- Invented metrics — never write "10× faster", "99.9% uptime", "50% cost savings" unless the brief provides real numbers. Use "—" or "[metric]" placeholders
- Generic stock-photo descriptions ("smiling diverse team in a modern office")
- Glass-morphism (frosted glass cards with blur) unless the brief explicitly asks for it
- The word "seamlessly" in any copy
- Confetti or party emoji in success states
- The "hero → features → CTA" SaaS template without meaningfully diverging from it

### Junior-designer pass (run before emitting):

Before emitting any artifact, check for these junior mistakes:
1. Paragraph text smaller than 14px
2. Orphaned headlines (H1 immediately followed by a very small subtitle with no visual breathing room)
3. Inconsistent padding (some sections have 64px top/bottom, others have 20px for no reason)
4. All-caps body copy (never use text-transform:uppercase on body text)
5. Low contrast text on colored backgrounds without a WCAG check
6. Empty href="#" links — use button elements for interactive controls

Fix all junior-pass failures before emitting.

### 5-dimension critique gate:

Before finalizing any artifact, score it on these 5 dimensions (1–5):
1. **Philosophy** — Does the design have one clear visual idea? Can you describe it in one sentence?
2. **Hierarchy** — Is the reading order immediately clear? Does type scale earn its size?
3. **Execution** — Are all spacing, color, and alignment choices intentional? No pixel-rounding errors?
4. **Specificity** — Is this design specific to this product and audience, or generic?
5. **Restraint** — Is there anything decorative that does no functional work?

If ANY dimension scores below 3, fix it before emitting. Include the scores as an HTML comment in the artifact: \`<!-- 5-dim: P4 H4 D3 F5 R4 -->\`
`.trim();

// ── Layer 7: Deck framework (only for deck-mode skills) ────────────────────
const DECK_FRAMEWORK = `
## Presentation Deck Framework

Output a single HTML file where each slide is a \`<section class="slide">\` element. Implement:

- **Navigation**: Left/right arrow keys + on-screen arrow buttons
- **Counter**: "3 / 12" in the top-right corner of every slide
- **Progress bar**: thin bar at the bottom of each slide (CSS width transition)
- **Print mode**: \`@media print\` — each slide as its own page, counter hidden, progress bar hidden
- **Scroll fallback**: A linear scroll layout of all slides at the bottom of the page for accessibility

Slides must be exactly 1280×720px (16:9). Scale to fit the viewport with \`transform: scale()\`.

Each slide type:
- **Title slide**: full-bleed background, centered large headline, presenter name, date
- **Section divider**: large section number + title, minimal content
- **Content slide**: title (top) + body (flexible: bullets / columns / chart / image + text)
- **Quote slide**: centered large pull quote, attribution at bottom
- **Full-bleed image**: image placeholder covering entire slide, optional caption overlay
`.trim();

// ── Utility: read a file, return empty string on error ────────────────────
function readFileSafe(filePath) {
  try { return fs.readFileSync(filePath, 'utf8'); } catch (_) { return ''; }
}

// ── Parse YAML frontmatter from SKILL.md ─────────────────────────────────
function parseFrontmatter(raw) {
  const match = raw.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return {};
  const yaml = match[1];
  // Minimal YAML parsing for od: namespace — good enough for simple values
  const result = {};
  const lines = yaml.split('\n');
  let inOd = false;
  for (const line of lines) {
    if (/^od:\s*$/.test(line)) { inOd = true; continue; }
    if (inOd) {
      if (/^\S/.test(line)) { inOd = false; continue; }
      const m = line.match(/^\s+(\w+):\s+(.+)$/);
      if (m) result[m[1].trim()] = m[2].trim().replace(/^['"]|['"]$/g, '');
    }
  }
  return result;
}

// ── Main export: composeDesignPrompt ─────────────────────────────────────
/**
 * Assemble the full system prompt for a design-mode project.
 * @param {object} opts
 * @param {string}  opts.skillId          — skill directory name (e.g. 'web-prototype')
 * @param {string}  opts.systemId         — design system directory name (e.g. 'default')
 * @param {string}  [opts.directionId]    — visual direction id (e.g. 'modern-minimal')
 * @param {string}  [opts.fidelity]       — 'lo' | 'hi' (overrides skill default)
 * @param {string}  [opts.platform]       — 'desktop' | 'mobile'
 * @param {boolean} [opts.speakerNotes]   — deck mode: include speaker notes
 * @param {boolean} [opts.animations]     — allow CSS animations
 * @param {string}  [opts.projectName]    — project name for context
 * @returns {string} Full assembled system prompt
 */
function composeDesignPrompt(opts = {}) {
  const { skillId, systemId, directionId, fidelity, platform,
          speakerNotes, animations, projectName } = opts;

  const layers = [];

  // ── Layer 1: Discovery directives
  layers.push(DISCOVERY_DIRECTIVES);

  // ── Layer 2: Identity charter
  layers.push(IDENTITY_CHARTER);

  // ── Layer 3: Design system
  if (systemId) {
    const dsPath = path.join(SYSTEMS_DIR, systemId, 'DESIGN.md');
    const dsContent = readFileSafe(dsPath);
    if (dsContent) {
      layers.push(`## Active Design System: ${systemId}\n\nApply the tokens, type scale, spacing, and component patterns from this system to all output.\n\n${dsContent}`);
    }
  }

  // ── Layer 4: Skill
  let skillMode = 'prototype';
  if (skillId) {
    const skillPath = path.join(SKILLS_DIR, skillId, 'SKILL.md');
    const rawSkill  = readFileSafe(skillPath);
    if (rawSkill) {
      const fm = parseFrontmatter(rawSkill);
      skillMode = fm.mode || 'prototype';
      // Strip frontmatter block from the prompt
      const body = rawSkill.replace(/^---[\s\S]*?---\s*\n/, '');
      layers.push(`## Active Skill: ${skillId}\n\n${body}`);
    }
  }

  // ── Layer 5: Project metadata
  const meta = [];
  if (projectName) meta.push(`Project: ${projectName}`);
  if (skillId)     meta.push(`Skill: ${skillId}`);
  if (systemId)    meta.push(`Design system: ${systemId}`);
  if (platform)    meta.push(`Platform: ${platform}`);
  if (fidelity)    meta.push(`Fidelity: ${fidelity === 'lo' ? 'low (wireframe — no visual polish)' : 'high (pixel-ready)'}`);
  if (animations === false) meta.push('Animations: disabled — use static states only');
  if (speakerNotes)         meta.push('Speaker notes: include in deck slides');
  if (meta.length > 0) {
    layers.push(`## Project Context\n\n${meta.join('\n')}`);
  }

  // ── Layer 6: Visual direction (when explicitly set and no design system color)
  if (directionId) {
    const dir = VISUAL_DIRECTIONS.find(d => d.id === directionId);
    if (dir) {
      const swatches = dir.palette.map(c => `  - \`${c}\``).join('\n');
      layers.push(`## Visual Direction: ${dir.name}\n\n${dir.description}\n\nApply this palette:\n${swatches}`);
    }
  }

  // ── Layer 7: Deck framework (deck mode only)
  if (skillMode === 'deck') {
    layers.push(DECK_FRAMEWORK);
  }

  // ── Layer 8: Artifact output rule
  layers.push(`## Artifact Output Format

All design output MUST be wrapped in a single \`<artifact>\` tag:

\`\`\`
<artifact type="text/html" title="[descriptive title]">
<!DOCTYPE html>
...
</artifact>
\`\`\`

- The artifact must be a complete, self-contained HTML file
- All CSS in a \`<style>\` block, all JS in a \`<script>\` block — no external CDN dependencies in the critical path
- Do NOT emit any text outside the \`<artifact>\` block after starting design output (after the discovery/planning phase is complete)
`);

  return layers.join('\n\n---\n\n');
}

export { composeDesignPrompt, VISUAL_DIRECTIONS, parseFrontmatter };
