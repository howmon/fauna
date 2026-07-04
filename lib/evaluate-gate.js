// lib/evaluate-gate.js
// Feature B4 — 3-stage evaluation gate (ouroboros-inspired).
//
// Graduated verification that replaces a single trust-based "looks done" check
// with three escalating stages, cheapest first:
//
//   1. Mechanical ($0)  — tests / lint / build via the work-item verifier.
//                         Objective, no model tokens. If this fails, stop here.
//   2. Semantic         — one LLM hop checks the diff against the Seed's
//                         acceptance criteria + the active skill's Verification
//                         section. Must cite evidence.
//   3. Consensus        — (opt-in, high-stakes only) fan out to 2–3 models and
//                         require agreement. Fauna is multi-provider so this is
//                         essentially free to wire.
//
// The orchestrator is dependency-injected: each stage is an async function that
// returns a verdict `{ ok, reason?, evidence?, ... }`. That keeps the module
// pure and unit-testable with mock stages — no real shell or LLM needed in CI.
// Builder helpers (makeMechanicalStage / makeSemanticStage / makeConsensusStage)
// wire the real dependencies when running for real.

// ── Verdict parsing ─────────────────────────────────────────────────────────

// Parse a model's evaluation reply into a structured verdict. Accepts either a
// JSON object `{ pass, reason, evidence }` embedded anywhere in the text, or a
// plain PASS/FAIL keyword verdict. Defaults to a FAIL (fail-closed) when the
// reply can't be interpreted — an unparseable evaluator must never wave a
// change through.
export function parseVerdict(text) {
  const t = String(text || '').trim();
  if (!t) return { ok: false, reason: 'Empty evaluator reply.', evidence: [] };

  // Prefer an explicit JSON verdict.
  const jsonMatch = t.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const o = JSON.parse(jsonMatch[0]);
      if (typeof o.pass === 'boolean') {
        return {
          ok: o.pass,
          reason: String(o.reason || o.summary || '').slice(0, 500),
          evidence: Array.isArray(o.evidence) ? o.evidence.slice(0, 10) : [],
        };
      }
    } catch (_) { /* fall through to keyword parsing */ }
  }

  const hasPass = /\bPASS(?:ED|ES)?\b/i.test(t);
  const hasFail = /\b(?:FAIL(?:ED|S|URE)?|REJECT(?:ED)?)\b/i.test(t);
  const firstLine = t.split('\n').map((l) => l.trim()).filter(Boolean)[0] || '';
  if (hasFail) return { ok: false, reason: firstLine.slice(0, 500), evidence: [] };
  if (hasPass) return { ok: true, reason: firstLine.slice(0, 500), evidence: [] };
  return { ok: false, reason: 'Could not parse a PASS/FAIL verdict from evaluator reply.', evidence: [] };
}

// ── Orchestrator ─────────────────────────────────────────────────────────────

async function _safe(fn, name) {
  try {
    const r = await fn();
    if (r && typeof r.ok === 'boolean') return r;
    return { ok: false, reason: `${name} stage returned no verdict.` };
  } catch (e) {
    // A crashing evaluator fails closed.
    return { ok: false, reason: `${name} stage threw: ${e?.message || String(e)}` };
  }
}

// Run the gate. `stages` is `{ mechanical?, semantic?, consensus? }` where each
// value is an async () => verdict. Stages run in order and short-circuit on the
// first failure (cheapest-first). Returns:
//   { ok, failedStage, summary, stages: [{ stage, ok, reason, evidence }] }
export async function runGate(stages = {}, opts = {}) {
  const results = [];
  const order = ['mechanical', 'semantic', 'consensus'];

  for (const name of order) {
    const fn = stages[name];
    if (!fn) continue;
    if (name === 'consensus' && opts.consensus === false) continue;
    const res = await _safe(fn, name);
    results.push({ stage: name, ok: res.ok, reason: res.reason || '', evidence: res.evidence || [], detail: res.detail });
    if (!res.ok) {
      return {
        ok: false,
        failedStage: name,
        summary: `Evaluation failed at the ${name} stage: ${res.reason || '(no reason given)'}`,
        stages: results,
      };
    }
  }

  if (!results.length) {
    return { ok: true, failedStage: null, summary: 'No evaluation stages configured (nothing to check).', stages: results };
  }
  return {
    ok: true,
    failedStage: null,
    summary: `All ${results.length} evaluation stage(s) passed: ${results.map((r) => r.stage).join(' → ')}.`,
    stages: results,
  };
}

// ── Stage builders (wire real dependencies) ─────────────────────────────────

// Mechanical: wraps an injected verifier (e.g. verifyWorkItem or
// runVerifyCommand). `verify` must return `{ ok, output?, skipped? }`.
export function makeMechanicalStage(verify) {
  return async () => {
    const r = await verify();
    if (!r) return { ok: false, reason: 'Mechanical verifier returned nothing.' };
    if (r.skipped) return { ok: true, reason: 'No mechanical gate configured — skipped.', detail: r };
    return {
      ok: !!r.ok,
      reason: r.ok ? 'Tests/lint/build passed.' : 'Tests/lint/build failed.',
      evidence: r.output ? [String(r.output).slice(0, 800)] : [],
      detail: r,
    };
  };
}

const SEMANTIC_SYSTEM = [
  'You are a strict code-change evaluator. You judge whether a proposed change',
  'satisfies its acceptance criteria and the skill\'s verification checklist.',
  'Be skeptical: reward evidence (file paths, command output, test names), reject',
  'hand-waving. Reply with a JSON object exactly like',
  '{"pass": true|false, "reason": "one sentence", "evidence": ["..."]}.',
].join(' ');

// Build the user prompt for the semantic stage.
export function buildSemanticPrompt({ goal, acceptanceCriteria, diff, verification } = {}) {
  const crit = Array.isArray(acceptanceCriteria) ? acceptanceCriteria : (acceptanceCriteria ? [acceptanceCriteria] : []);
  return [
    goal ? `GOAL:\n${goal}\n` : '',
    crit.length ? `ACCEPTANCE CRITERIA:\n${crit.map((c, i) => `${i + 1}. ${c}`).join('\n')}\n` : '',
    verification ? `SKILL VERIFICATION CHECKLIST:\n${String(verification).slice(0, 2000)}\n` : '',
    diff ? `PROPOSED CHANGE (diff / summary):\n${String(diff).slice(0, 6000)}\n` : '(no diff provided)',
    '\nDoes the change satisfy every acceptance criterion with evidence? Respond with the JSON verdict.',
  ].filter(Boolean).join('\n');
}

// Semantic: one LLM hop. `complete({ model, messages })` must resolve to the
// model's reply text.
export function makeSemanticStage({ complete, model, goal, acceptanceCriteria, diff, verification }) {
  return async () => {
    if (typeof complete !== 'function') return { ok: false, reason: 'No completion function for semantic stage.' };
    const text = await complete({
      model,
      messages: [
        { role: 'system', content: SEMANTIC_SYSTEM },
        { role: 'user', content: buildSemanticPrompt({ goal, acceptanceCriteria, diff, verification }) },
      ],
    });
    return parseVerdict(text);
  };
}

// Consensus: fan out the same evaluation to several models and require a
// quorum. `threshold` is the fraction (0–1) of models that must PASS
// (default: all). A model that errors counts as a FAIL vote (fail-closed).
export function makeConsensusStage({ complete, models, model, goal, acceptanceCriteria, diff, verification, threshold = 1 }) {
  return async () => {
    const list = Array.isArray(models) ? models.filter(Boolean) : [];
    if (typeof complete !== 'function' || !list.length) {
      return { ok: false, reason: 'Consensus stage needs a completion function and ≥1 model.' };
    }
    const votes = await Promise.all(list.map(async (m) => {
      try {
        const text = await complete({
          model: m,
          messages: [
            { role: 'system', content: SEMANTIC_SYSTEM },
            { role: 'user', content: buildSemanticPrompt({ goal, acceptanceCriteria, diff, verification }) },
          ],
        });
        return { model: m, ...parseVerdict(text) };
      } catch (e) {
        return { model: m, ok: false, reason: `error: ${e?.message || String(e)}` };
      }
    }));
    const passCount = votes.filter((v) => v.ok).length;
    const need = Math.max(1, Math.ceil(list.length * Math.min(1, Math.max(0, threshold))));
    const ok = passCount >= need;
    return {
      ok,
      reason: ok
        ? `${passCount}/${list.length} models agreed the change passes (needed ${need}).`
        : `Only ${passCount}/${list.length} models passed the change (needed ${need}).`,
      evidence: votes.map((v) => `${v.model}: ${v.ok ? 'PASS' : 'FAIL'} — ${v.reason || ''}`.slice(0, 200)),
      detail: votes,
    };
  };
}

export default { parseVerdict, runGate, makeMechanicalStage, makeSemanticStage, makeConsensusStage, buildSemanticPrompt };
