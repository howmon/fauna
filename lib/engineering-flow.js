import fs from 'node:fs';

const DEFAULT_FLOW_URL = new URL('../skills/engineering-flow.json', import.meta.url);

function normalizeText(value) {
  return String(value || '').trim().toLowerCase();
}

function hasPhrase(text, phrase) {
  return text.includes(normalizeText(phrase));
}

function hasTerm(text, term) {
  const escaped = normalizeText(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return escaped ? new RegExp(`\\b${escaped}\\w*\\b`, 'i').test(text) : false;
}

export function loadEngineeringFlow(fileUrl = DEFAULT_FLOW_URL) {
  const graph = JSON.parse(fs.readFileSync(fileUrl, 'utf8'));
  const validation = validateEngineeringFlow(graph);
  if (!validation.ok) {
    throw new Error(`Invalid engineering flow: ${validation.errors.join(' ')}`);
  }
  return graph;
}

export function validateEngineeringFlow(graph, options = {}) {
  const errors = [];
  const warnings = [];
  if (!graph || typeof graph !== 'object') return { ok: false, errors: ['Flow graph must be an object.'], warnings };
  if (graph.version !== 1) errors.push('Flow graph `version` must be 1.');
  if (!Array.isArray(graph.flows) || !graph.flows.length) errors.push('Flow graph must contain at least one flow.');

  const flowIds = new Set();
  for (const flow of graph.flows || []) {
    if (!flow?.id) { errors.push('Every flow requires an `id`.'); continue; }
    if (flowIds.has(flow.id)) errors.push(`Duplicate flow id "${flow.id}".`);
    flowIds.add(flow.id);
    if (!Array.isArray(flow.phases) || !flow.phases.length) {
      errors.push(`Flow "${flow.id}" must contain phases.`);
      continue;
    }

    const byId = new Map();
    for (const phase of flow.phases) {
      if (!phase?.id) { errors.push(`Flow "${flow.id}" has a phase without an id.`); continue; }
      if (byId.has(phase.id)) errors.push(`Flow "${flow.id}" has duplicate phase "${phase.id}".`);
      byId.set(phase.id, phase);
      if (!Array.isArray(phase.skills) || !phase.skills.length) errors.push(`Phase "${flow.id}/${phase.id}" requires at least one skill.`);
    }
    if (!byId.has(flow.entryPhase)) errors.push(`Flow "${flow.id}" entry phase "${flow.entryPhase}" does not exist.`);
    for (const phase of flow.phases) {
      if (phase.next !== null && phase.next !== undefined && !byId.has(phase.next)) {
        errors.push(`Phase "${flow.id}/${phase.id}" points to missing phase "${phase.next}".`);
      }
    }

    const visited = new Set();
    let cursor = flow.entryPhase;
    while (cursor && byId.has(cursor)) {
      if (visited.has(cursor)) {
        errors.push(`Flow "${flow.id}" contains a cycle at phase "${cursor}".`);
        break;
      }
      visited.add(cursor);
      cursor = byId.get(cursor).next;
    }
    for (const phaseId of byId.keys()) {
      if (!visited.has(phaseId)) warnings.push(`Flow "${flow.id}" phase "${phaseId}" is unreachable from its entry phase.`);
    }
  }

  if (options.availableSkills) {
    const available = new Set(options.availableSkills);
    for (const flow of graph.flows || []) {
      for (const phase of flow.phases || []) {
        for (const skill of phase.skills || []) {
          if (!available.has(skill)) warnings.push(`Flow "${flow.id}/${phase.id}" references unavailable skill "${skill}".`);
        }
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

function scoreFlow(flow, situation) {
  const text = normalizeText(situation);
  let score = 0;
  const evidence = [];
  for (const phrase of flow.signals?.phrases || []) {
    if (hasPhrase(text, phrase)) {
      score += 4;
      evidence.push(`phrase: ${phrase}`);
    }
  }
  for (const term of flow.signals?.terms || []) {
    if (hasTerm(text, term)) {
      score += 1;
      evidence.push(`term: ${term}`);
    }
  }
  return { score, evidence };
}

function describePhase(flow, phase) {
  const next = phase.next ? flow.phases.find((candidate) => candidate.id === phase.next) : null;
  return {
    flow: { id: flow.id, label: flow.label },
    phase: {
      id: phase.id,
      label: phase.label,
      nextAction: phase.nextAction,
      humanDecision: phase.humanDecision === true,
      skills: phase.skills,
      requires: phase.requires || [],
      produces: phase.produces || [],
      context: phase.context || 'continue',
    },
    nextPhase: next ? { id: next.id, label: next.label } : null,
  };
}

const TASK_STATES = new Set(['active', 'phase-complete', 'blocked']);
const DESTINATIONS = new Set(['same-session', 'new-ticket', 'new-workspace', 'new-harness', 'new-owner', 'side-task']);
const HANDOFF_DESTINATIONS = new Set(['new-workspace', 'new-harness', 'new-owner']);

function contextPressure(contextBudget = {}) {
  const usedTokens = Number(contextBudget.usedTokens);
  const bodyTokenLimit = Number(contextBudget.bodyTokenLimit);
  const valid = Number.isFinite(usedTokens) && usedTokens >= 0 && Number.isFinite(bodyTokenLimit) && bodyTokenLimit > 0;
  const ratio = valid ? usedTokens / bodyTokenLimit : null;
  return {
    known: valid,
    usedTokens: valid ? usedTokens : null,
    bodyTokenLimit: valid ? bodyTokenLimit : null,
    ratio: valid ? Number(ratio.toFixed(3)) : null,
    approachingLimit: valid && ratio >= 0.9,
  };
}

export function recommendPhaseBoundary(input = {}, graph = loadEngineeringFlow()) {
  const flow = graph.flows.find((candidate) => candidate.id === input.flow);
  if (!flow) return { ok: false, error: `Unknown engineering flow "${input.flow || ''}".` };
  const phase = flow.phases.find((candidate) => candidate.id === input.phase);
  if (!phase) return { ok: false, error: `Unknown phase "${input.phase || ''}" in flow "${flow.id}".` };

  const taskState = input.taskState || 'active';
  const destination = input.destination || 'same-session';
  if (!TASK_STATES.has(taskState)) return { ok: false, error: `Unknown task state "${taskState}".` };
  if (!DESTINATIONS.has(destination)) return { ok: false, error: `Unknown destination "${destination}".` };

  const nextPhase = phase.next ? flow.phases.find((candidate) => candidate.id === phase.next) : null;
  const guidance = nextPhase?.context || phase.context || 'continue';
  const pressure = contextPressure(input.contextBudget);
  const isExternalBoundary = HANDOFF_DESTINATIONS.has(destination);
  const isSideTask = destination === 'side-task';
  const isTransition = taskState === 'phase-complete';
  const shouldRecommend = isTransition || taskState === 'blocked' || isExternalBoundary || isSideTask || pressure.approachingLimit;
  const inferredNeedsContext = guidance !== 'fresh-ticket';
  const nextNeedsCurrentContext = typeof input.nextNeedsCurrentContext === 'boolean'
    ? input.nextNeedsCurrentContext
    : inferredNeedsContext;

  const base = {
    ok: true,
    action: 'none',
    triggered: shouldRecommend,
    taskState,
    destination,
    flow: flow.id,
    phase: phase.id,
    nextPhase: nextPhase?.id || null,
    graphGuidance: guidance,
    contextPressure: pressure,
  };
  if (!shouldRecommend) {
    return { ...base, reason: 'No phase transition, boundary crossing, blockage, or context pressure requires a recommendation.' };
  }
  if (taskState === 'blocked') {
    return {
      ...base,
      action: 'handoff',
      reason: 'The task is blocked; preserve evidence and transfer the unresolved decision to a human owner.',
      handoffRequires: ['current phase', 'blocking decision', 'attempted evidence', 'next requested action'],
    };
  }
  if (isExternalBoundary) {
    return {
      ...base,
      action: 'handoff',
      reason: `The next work crosses to a ${destination.replace('new-', '')}; package the necessary context explicitly.`,
      handoffRequires: ['objective', 'accepted artifacts', 'current state', 'verification evidence', 'next action'],
    };
  }
  if (isSideTask && input.unattended === true) {
    return { ...base, action: 'subagent', reason: 'The side task is tightly scoped and can run unattended without replacing the active workflow.' };
  }
  if (!nextPhase || nextNeedsCurrentContext === false || destination === 'new-ticket') {
    return { ...base, action: 'clear', reason: 'The next work does not need the current conversation as a primary source.' };
  }
  if (pressure.approachingLimit) {
    return { ...base, action: 'compact', reason: 'Relevant context must continue, but usage is approaching the model-specific compaction threshold.' };
  }
  return { ...base, action: 'continue', reason: 'The next phase needs the current conversation and sufficient context budget remains.' };
}

function withBoundaryRecommendation(result, input, graph) {
  if (!result?.phase || typeof input !== 'object' || !input.boundary) return result;
  return {
    ...result,
    contextRecommendation: recommendPhaseBoundary({
      ...input.boundary,
      flow: result.flow.id,
      phase: result.phase.id,
    }, graph),
  };
}

export function routeEngineeringFlow(input, graph = loadEngineeringFlow()) {
  const situation = typeof input === 'string' ? input : input?.situation;
  const requestedFlow = typeof input === 'object' ? input?.flow : null;
  const requestedPhase = typeof input === 'object' ? input?.phase : null;

  if (requestedFlow) {
    const flow = graph.flows.find((candidate) => candidate.id === requestedFlow);
    if (!flow) return { ok: false, error: `Unknown engineering flow "${requestedFlow}".` };
    const phaseId = requestedPhase || flow.entryPhase;
    const phase = flow.phases.find((candidate) => candidate.id === phaseId);
    if (!phase) return { ok: false, error: `Unknown phase "${phaseId}" in flow "${requestedFlow}".` };
    return withBoundaryRecommendation(
      { ok: true, confidence: 1, reason: flow.reason, ...describePhase(flow, phase) },
      input,
      graph,
    );
  }

  if (!normalizeText(situation)) {
    return { ok: true, confidence: 0, clarify: 'What situation are you in: building selected work, fixing one hard failure, or qualifying incoming reports and requests?' };
  }

  const ranked = graph.flows
    .map((flow) => ({ flow, ...scoreFlow(flow, situation) }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.flow.id.localeCompare(right.flow.id));

  if (!ranked.length || (ranked[1] && ranked[0].score === ranked[1].score)) {
    return {
      ok: true,
      confidence: 0,
      clarify: 'Is this selected feature work, one concrete failure to diagnose, or a queue of incoming reports and requests to qualify?',
      candidates: ranked.slice(0, 3).map((candidate) => ({ id: candidate.flow.id, label: candidate.flow.label, score: candidate.score })),
    };
  }

  const winner = ranked[0];
  const secondScore = ranked[1]?.score || 0;
  const confidence = Math.min(0.99, Number((0.6 + ((winner.score - secondScore) / (winner.score + 2)) * 0.35).toFixed(3)));
  const phase = winner.flow.phases.find((candidate) => candidate.id === winner.flow.entryPhase);
  return withBoundaryRecommendation({
    ok: true,
    confidence,
    reason: winner.flow.reason,
    evidence: winner.evidence,
    whyNot: ranked.slice(1, 3).map((candidate) => ({
      flow: candidate.flow.id,
      reason: candidate.flow.notWhen,
    })),
    ...describePhase(winner.flow, phase),
  }, input, graph);
}

export default { loadEngineeringFlow, validateEngineeringFlow, routeEngineeringFlow, recommendPhaseBoundary };