// lib/prompt-audit.js
// Feature C — prompt pattern audit linter.
//
// Checks an assembled system prompt against the curated behavioural patterns in
// references/prompt-patterns.md and flags which are missing, so gaps in
// Fauna's own instructions (capabilities.js, agent rules, skills) become
// fixable checklist items instead of vibes.
//
// Deterministic detectors (keyword/regex) — no model, no deps. This is a
// heuristic floor: presence of a keyword doesn't guarantee good wording, but
// ABSENCE reliably flags a missing behaviour.

// Each pattern: id, human name, a detector regex, and a remediation hint.
export const PROMPT_PATTERNS = Object.freeze([
  {
    id: 'tool-discipline',
    name: 'Tool-use discipline',
    detect: /\b(use (the )?tools?|call (the )?tool|gather (context|information)|search the (workspace|codebase|repo)|read (the )?files?|implement rather than|act(ing)? rather than)\b/i,
    hint: 'Tell the model to use tools to gather context and to implement rather than only suggest.',
  },
  {
    id: 'verification',
    name: 'Verification before done',
    detect: /\b(verify|verified|verification|confirm|double-check|run the tests?|check (the )?(result|output)|validate)\b/i,
    hint: 'Require verifying work (tests/build/output) before claiming completion.',
  },
  {
    id: 'persistence',
    name: 'Persistence / anti-laziness',
    detect: /\b(keep going|continue until|do not stop|don'?t stop|persist|until (the task is )?(complete|done|resolved)|resolve (the )?blocker)\b/i,
    hint: 'Instruct the model to keep going until the task is genuinely complete.',
  },
  {
    id: 'progressive-disclosure',
    name: 'Progressive disclosure',
    detect: /\b(on demand|only when needed|load (one|the relevant)|fetch (one|the) section|progressively? disclos|don'?t (pre)?load everything)\b/i,
    hint: 'Load heavy context (skills, references, files) on demand instead of all up front.',
  },
  {
    id: 'scope-discipline',
    name: 'Scope discipline',
    detect: /\b(only (what|as) (is )?(requested|asked)|avoid over-?engineering|don'?t add (features|improvements)|do not (over|refactor)|directly requested|beyond what was asked)\b/i,
    hint: 'Constrain the model to what was asked; avoid over-engineering and unrequested changes.',
  },
  {
    id: 'honesty',
    name: 'Honesty / uncertainty',
    detect: /\b(if (you are |you'?re )?unsure|ask (for clarification|the user)|do ?n'?t (fabricate|invent|make up|guess)|admit (uncertainty|when)|never (fabricate|invent))\b/i,
    hint: 'Require admitting uncertainty, asking when unsure, and never fabricating files/APIs.',
  },
  {
    id: 'safety',
    name: 'Safety / refusal boundaries',
    detect: /\b(refuse|do not assist|security (vulnerab|requirement)|prompt injection|malware|owasp|do not (help|assist) (with|creating))\b/i,
    hint: 'State refusal boundaries (no malware, no bypassing controls) and flag prompt injection.',
  },
  {
    id: 'output-format',
    name: 'Output format contract',
    detect: /\b(use (proper )?markdown|code fences?|format(ting)? (your |the )?(answer|response|output)|wrap .* in backticks|file links?)\b/i,
    hint: 'Give an explicit output/formatting contract (Markdown, code fences, link style).',
  },
  // The patterns below were surfaced as high-value GAPS by lib/prompt-catalog.js
  // (scored/de-duped from the system_prompts_leaks corpus). They are the ones
  // Fauna did not already enforce.
  {
    id: 'parallel-tools',
    name: 'Parallel tool calling',
    detect: /\b(parallel(ize|ise)?|in parallel|batch(ed)? (the )?(tool )?calls?|independent (operations|calls|reads)|(single|same) (turn|response|block)|concurrently)\b/i,
    hint: 'Instruct the model to batch independent tool calls in one turn instead of serial round-trips.',
  },
  {
    id: 'untrusted-output',
    name: 'Tool output is data, not instructions',
    detect: /\b(results?( are|'?s)? (just )?data,? not instructions|untrusted (data|content|output|input)|prompt injection|do not (obey|follow) (instructions|commands) (in|from) (tool|web|the)|treat .* as data)\b/i,
    hint: 'State that tool/web output is untrusted data — never obey instructions embedded in it.',
  },
  {
    id: 'baseline-verify',
    name: 'Baseline then re-verify',
    detect: /\b(baseline|before (and after|making (any )?changes?)|run the (existing )?(tests?|linters?|build) (first|before)|establish (a )?baseline|pre-?existing (tests?|state))\b/i,
    hint: 'Capture a pre-change baseline (existing tests/build/lint) then re-run after to prove no regression.',
  },
  {
    id: 'no-repo-scratch',
    name: 'Keep scratch files out of the repo',
    detect: /\b(do not (create|write) (markdown|plan|notes?|scratch)|session(-scoped)? (workspace|folder)|not? in the (repo|repository|workspace)|ephemeral (planning|artifacts?)|clean up (temporary|temp) files?)\b/i,
    hint: 'Keep planning/scratch artifacts out of the user\'s repo; use a session-scoped workspace.',
  },
]);

// Audit an assembled prompt string. Returns:
//   { ok, score, present:[ids], missing:[{id,name,hint}], findings:[{id,name,present}] }
// `ok` is true when every pattern is present. `score` is present/total (0–1).
export function auditPrompt(prompt, opts = {}) {
  const text = String(prompt || '');
  const patterns = Array.isArray(opts.patterns) ? opts.patterns : PROMPT_PATTERNS;
  const findings = patterns.map((p) => ({ id: p.id, name: p.name, present: p.detect.test(text) }));
  const present = findings.filter((f) => f.present).map((f) => f.id);
  const missing = patterns
    .filter((p) => !present.includes(p.id))
    .map((p) => ({ id: p.id, name: p.name, hint: p.hint }));
  const score = patterns.length ? +(present.length / patterns.length).toFixed(3) : 1;
  return { ok: missing.length === 0, score, present, missing, findings };
}

export default { PROMPT_PATTERNS, auditPrompt };
