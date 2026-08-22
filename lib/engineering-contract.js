const REQUIRED_TRACKER_OPERATIONS = ['search', 'create', 'update', 'comment', 'close'];

function clean(value) {
  return String(value || '').trim();
}

function tableCell(value) {
  return clean(value).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

export function buildEngineeringContract(profile = {}) {
  const errors = [];
  const projectName = clean(profile.projectName);
  const tracker = {
    name: clean(profile.tracker?.name),
    url: clean(profile.tracker?.url),
    operations: {},
  };
  for (const operation of REQUIRED_TRACKER_OPERATIONS) {
    tracker.operations[operation] = clean(profile.tracker?.operations?.[operation]);
    if (!tracker.operations[operation]) errors.push(`tracker.operations.${operation} is required`);
  }
  if (!projectName) errors.push('projectName is required');
  if (!tracker.name) errors.push('tracker.name is required');

  const triageRoles = Array.isArray(profile.triageRoles)
    ? profile.triageRoles.map(role => ({
        role: clean(role?.role),
        when: clean(role?.when),
        trackerValue: clean(role?.trackerValue),
      }))
    : [];
  if (triageRoles.length === 0) errors.push('triageRoles must contain at least one role mapping');
  for (const [index, role] of triageRoles.entries()) {
    if (!role.role || !role.when || !role.trackerValue) errors.push(`triageRoles[${index}] requires role, when, and trackerValue`);
  }

  const domain = {
    summary: clean(profile.domain?.summary),
    terms: Array.isArray(profile.domain?.terms)
      ? profile.domain.terms.map(term => ({ term: clean(term?.term), meaning: clean(term?.meaning) }))
      : [],
  };
  if (!domain.summary) errors.push('domain.summary is required');
  if (domain.terms.length === 0) errors.push('domain.terms must contain at least one definition');
  for (const [index, term] of domain.terms.entries()) {
    if (!term.term || !term.meaning) errors.push(`domain.terms[${index}] requires term and meaning`);
  }

  const context = {
    overview: clean(profile.context?.overview),
    entryPoints: Array.isArray(profile.context?.entryPoints)
      ? profile.context.entryPoints.map(entry => ({ path: clean(entry?.path), purpose: clean(entry?.purpose) }))
      : [],
    commands: Array.isArray(profile.context?.commands)
      ? profile.context.commands.map(command => ({ purpose: clean(command?.purpose), command: clean(command?.command) }))
      : [],
    boundaries: Array.isArray(profile.context?.boundaries)
      ? profile.context.boundaries.map(clean).filter(Boolean)
      : [],
  };
  if (!context.overview) errors.push('context.overview is required');
  if (context.entryPoints.length === 0) errors.push('context.entryPoints must contain at least one entry point');
  if (context.commands.length === 0) errors.push('context.commands must contain at least one command');
  if (context.boundaries.length === 0) errors.push('context.boundaries must contain at least one boundary');
  for (const [index, entry] of context.entryPoints.entries()) {
    if (!entry.path || !entry.purpose) errors.push(`context.entryPoints[${index}] requires path and purpose`);
  }
  for (const [index, command] of context.commands.entries()) {
    if (!command.purpose || !command.command) errors.push(`context.commands[${index}] requires purpose and command`);
  }

  if (errors.length) return { ok: false, errors, files: [] };

  const files = [
    {
      path: 'CONTEXT.md',
      content: `# ${projectName} Context\n\n${context.overview}\n\n## Entry Points\n\n| Path | Purpose |\n|---|---|\n${context.entryPoints.map(entry => `| \`${tableCell(entry.path)}\` | ${tableCell(entry.purpose)} |`).join('\n')}\n\n## Commands\n\n| Purpose | Command |\n|---|---|\n${context.commands.map(command => `| ${tableCell(command.purpose)} | \`${tableCell(command.command)}\` |`).join('\n')}\n\n## Boundaries\n\n${context.boundaries.map(boundary => `- ${boundary}`).join('\n')}\n`,
    },
    {
      path: 'docs/agents/issue-tracker.md',
      content: `# Issue Tracker Operations\n\nTracker: ${tracker.name}${tracker.url ? `\n\nProject URL: ${tracker.url}` : ''}\n\nThis contract describes operations rather than a provider-specific API. Update the instructions when the tracker workflow changes.\n\n| Operation | Project Instruction |\n|---|---|\n${REQUIRED_TRACKER_OPERATIONS.map(operation => `| ${operation} | ${tableCell(tracker.operations[operation])} |`).join('\n')}\n`,
    },
    {
      path: 'docs/agents/triage-labels.md',
      content: `# Triage Role Mappings\n\nThese semantic roles are stable even when tracker labels or fields change.\n\n| Role | Use When | Tracker Mapping |\n|---|---|---|\n${triageRoles.map(role => `| ${tableCell(role.role)} | ${tableCell(role.when)} | ${tableCell(role.trackerValue)} |`).join('\n')}\n`,
    },
    {
      path: 'docs/agents/domain.md',
      content: `# Domain Language\n\n${domain.summary}\n\n| Term | Meaning |\n|---|---|\n${domain.terms.map(term => `| ${tableCell(term.term)} | ${tableCell(term.meaning)} |`).join('\n')}\n`,
    },
    {
      path: 'docs/adr/README.md',
      content: '# Architecture Decision Records\n\nRecord durable architectural decisions in this directory. Use names like `0001-short-decision-title.md`.\n\nEach ADR should contain:\n\n1. Context and constraints\n2. Decision\n3. Alternatives considered\n4. Consequences\n5. Status and date\n',
    },
  ];

  return { ok: true, errors: [], version: 1, files };
}
