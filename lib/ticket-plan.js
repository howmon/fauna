const VALID_PRIORITIES = new Set(['p0', 'p1', 'p2', 'p3']);

function textList(value) {
  const values = Array.isArray(value) ? value : String(value || '').split('\n');
  return values.map(item => String(item).trim()).filter(Boolean);
}

function findCycle(graph) {
  const visited = new Set();
  const active = new Set();
  const path = [];

  function visit(node) {
    if (active.has(node)) {
      const start = path.indexOf(node);
      return [...path.slice(start), node];
    }
    if (visited.has(node)) return null;
    visited.add(node);
    active.add(node);
    path.push(node);
    for (const dependency of graph.get(node) || []) {
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }
    path.pop();
    active.delete(node);
    return null;
  }

  for (const node of graph.keys()) {
    const cycle = visit(node);
    if (cycle) return cycle;
  }
  return null;
}

function dependencyOrder(tickets) {
  const byKey = new Map(tickets.map(ticket => [ticket.key, ticket]));
  const visited = new Set();
  const ordered = [];

  function visit(ticket) {
    if (visited.has(ticket.key)) return;
    visited.add(ticket.key);
    for (const dependency of ticket.blockedBy) {
      const local = byKey.get(dependency);
      if (local) visit(local);
    }
    ordered.push(ticket);
  }

  for (const ticket of tickets) visit(ticket);
  return ordered;
}

export function validateTicketPlan({ tickets, existingItems = [] } = {}) {
  const errors = [];
  if (!Array.isArray(tickets) || tickets.length === 0) {
    return { ok: false, errors: ['tickets must contain at least one ticket'], tickets: [], readyFrontier: [] };
  }
  if (tickets.length > 50) errors.push('tickets cannot contain more than 50 entries');

  const existing = new Map(
    (Array.isArray(existingItems) ? existingItems : [])
      .filter(item => item && item.id)
      .map(item => [String(item.id), item]),
  );
  const normalized = tickets.slice(0, 50).map((ticket, index) => ({
    key: String(ticket?.key || '').trim(),
    title: String(ticket?.title || '').trim(),
    body: String(ticket?.body || '').trim(),
    acceptanceCriteria: textList(ticket?.acceptanceCriteria),
    verifyCommand: String(ticket?.verifyCommand || '').trim(),
    blockedBy: [...new Set(textList(ticket?.blockedBy))],
    fileScope: [...new Set(textList(ticket?.fileScope))],
    priority: VALID_PRIORITIES.has(ticket?.priority) ? ticket.priority : 'p2',
    estimateMinutes: Number.isFinite(ticket?.estimateMinutes) ? ticket.estimateMinutes : null,
    index,
  }));

  const keys = new Set();
  for (const ticket of normalized) {
    const label = ticket.key || `ticket ${ticket.index + 1}`;
    if (!ticket.key) errors.push(`ticket ${ticket.index + 1} requires a stable key`);
    else if (keys.has(ticket.key)) errors.push(`duplicate ticket key "${ticket.key}"`);
    else keys.add(ticket.key);
    if (!ticket.title) errors.push(`${label} requires a title`);
    if (ticket.acceptanceCriteria.length === 0) errors.push(`${label} requires acceptance criteria`);
    if (!ticket.verifyCommand) errors.push(`${label} requires a verification command`);
    if (ticket.blockedBy.includes(ticket.key)) errors.push(`${label} cannot block itself`);
  }

  for (const ticket of normalized) {
    for (const dependency of ticket.blockedBy) {
      if (!keys.has(dependency) && !existing.has(dependency)) {
        errors.push(`${ticket.key || `ticket ${ticket.index + 1}`} references unknown blocker "${dependency}"`);
      }
    }
  }

  const graph = new Map();
  for (const item of existing.values()) {
    graph.set(String(item.id), textList(item.blockedBy).filter(id => existing.has(id) || keys.has(id)));
  }
  for (const ticket of normalized) graph.set(ticket.key, ticket.blockedBy);
  const cycle = findCycle(graph);
  if (cycle) errors.push(`dependency cycle: ${cycle.join(' -> ')}`);

  const readyFrontier = normalized
    .filter(ticket => ticket.blockedBy.every(dependency => {
      if (keys.has(dependency)) return false;
      const item = existing.get(dependency);
      return item && (item.column === 'done' || item.column === 'archived');
    }))
    .map(ticket => ticket.key);

  return {
    ok: errors.length === 0,
    errors,
    tickets: errors.length === 0 ? dependencyOrder(normalized) : normalized,
    readyFrontier,
  };
}
