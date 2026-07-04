// lib/personas.js
// Feature B5 — "unstuck" lateral-thinking personas (ouroboros "Nine Minds").
//
// When the autonomous loop stalls (Fauna already detects narration-repeat /
// half-stop), it invokes a short rotation of divergent personas to break the
// rut — each reframes the problem from a different angle for ONE pass, rather
// than the loop retrying the same failed approach.
//
// Pure data + selection logic; no deps. The caller injects each persona's
// `prompt` into a single model turn.

// The full persona roster. `unstuck` selects the lateral-thinking subset.
export const PERSONAS = Object.freeze([
  {
    id: 'socratic-interviewer',
    role: 'Socratic Interviewer',
    lateral: false,
    prompt: 'Ask the questions that expose the hidden assumption behind the current approach. What are we taking for granted that might be false?',
  },
  {
    id: 'ontologist',
    role: 'Ontologist',
    lateral: false,
    prompt: 'Name the key entities and their relationships precisely. Is the current model of the problem even correct?',
  },
  {
    id: 'contrarian',
    role: 'Contrarian',
    lateral: true,
    prompt: 'Argue that the current plan is wrong. What is the strongest case that we are solving the wrong problem or in the wrong way?',
  },
  {
    id: 'simplifier',
    role: 'Simplifier',
    lateral: true,
    prompt: 'What is the simplest possible thing that could work? Delete a requirement, remove an abstraction, or cut scope until the path is obvious.',
  },
  {
    id: 'researcher',
    role: 'Researcher',
    lateral: true,
    prompt: 'What do we not know yet? Identify the single missing fact or file that, once known, would unblock this — then go find it.',
  },
  {
    id: 'hacker',
    role: 'Hacker',
    lateral: true,
    prompt: 'Find the unconventional shortcut. Is there an existing tool, cached result, or side door that bypasses the blocker entirely?',
  },
  {
    id: 'architect',
    role: 'Architect',
    lateral: true,
    prompt: 'Step back to the system boundary. Is the blocker a symptom of a structural problem that a different decomposition would eliminate?',
  },
  {
    id: 'evaluator',
    role: 'Evaluator',
    lateral: false,
    prompt: 'Define exactly what "done" looks like for this step and check the current state against it. What concrete evidence is missing?',
  },
  {
    id: 'seed-architect',
    role: 'Seed Architect',
    lateral: false,
    prompt: 'Re-read the frozen spec. Are we still building what was agreed, or has the work drifted from the acceptance criteria?',
  },
]);

// Return an ordered rotation of lateral-thinking personas to break a stall.
//   opts: { count?, exclude?:string[], seed?:number }
export function unstuck(context = '', opts = {}) {
  const count = Math.max(1, Math.min(5, opts.count || 5));
  const exclude = new Set(opts.exclude || []);
  const lateral = PERSONAS.filter((p) => p.lateral && !exclude.has(p.id));
  const picked = lateral.slice(0, count);
  return {
    context: String(context || '').slice(0, 500),
    personas: picked.map((p) => ({ id: p.id, role: p.role, prompt: p.prompt })),
    instruction: 'Take ONE divergent pass per persona below, in order. Stop as soon as one produces a concrete new next action, then execute it.',
  };
}

export function getPersona(id) {
  return PERSONAS.find((p) => p.id === id) || null;
}

export default { PERSONAS, unstuck, getPersona };
