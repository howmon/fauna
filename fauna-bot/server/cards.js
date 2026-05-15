/**
 * Adaptive Card builders for the Fauna Teams bot.
 * All cards use Adaptive Cards schema v1.5 (supported in Teams web, mobile, desktop).
 */

// ── Status Card ────────────────────────────────────────────────────────────

export function statusCard({ connected, version, model, error } = {}) {
  const statusColor = connected ? 'Good' : 'Attention';
  const statusText  = connected ? '● Connected' : '○ Disconnected';
  const body = [
    {
      type: 'TextBlock',
      text: '🌿 Fauna Desktop Status',
      weight: 'Bolder',
      size: 'Medium',
    },
    {
      type: 'FactSet',
      facts: [
        { title: 'Status', value: statusText },
        ...(version ? [{ title: 'Version', value: version }] : []),
        ...(model   ? [{ title: 'Active Model', value: model }] : []),
        ...(error   ? [{ title: 'Error', value: error }] : []),
      ],
    },
  ];

  if (!connected) {
    body.push({
      type: 'TextBlock',
      text: 'Make sure the Fauna desktop app is running, then type `/pair` to reconnect.',
      wrap: true,
      isSubtle: true,
      size: 'Small',
    });
  }

  return _wrap(body);
}

// ── Help Card ──────────────────────────────────────────────────────────────

export function helpCard() {
  const commands = [
    { cmd: '/help',            desc: 'Show this help' },
    { cmd: '/status',          desc: 'Check desktop connection' },
    { cmd: '/shell <cmd>',     desc: 'Run a shell command on your desktop' },
    { cmd: '/browse <url>',    desc: 'Navigate to a URL in Fauna browser' },
    { cmd: '/screenshot',      desc: 'Capture your desktop screen' },
    { cmd: '/agents',          desc: 'List installed agents' },
    { cmd: '/task <desc>',     desc: 'Create a background task' },
    { cmd: '/search <query>',  desc: 'Web search via Fauna' },
    { cmd: '/models',          desc: 'List available AI models' },
    { cmd: '/playbook',        desc: 'View your playbook instructions' },
    { cmd: '/pair',            desc: 'Get QR code to pair with desktop' },
  ];

  return _wrap([
    {
      type: 'TextBlock',
      text: '🌿 Fauna — AI Assistant',
      weight: 'Bolder',
      size: 'Large',
    },
    {
      type: 'TextBlock',
      text: 'Send any message to chat with AI, or use these commands:',
      wrap: true,
      isSubtle: true,
    },
    {
      type: 'ColumnSet',
      columns: [
        {
          type: 'Column',
          width: 'auto',
          items: commands.map(c => ({
            type: 'TextBlock',
            text: `\`${c.cmd}\``,
            fontType: 'Monospace',
            size: 'Small',
          })),
        },
        {
          type: 'Column',
          width: 'stretch',
          items: commands.map(c => ({
            type: 'TextBlock',
            text: c.desc,
            size: 'Small',
            isSubtle: true,
            wrap: true,
          })),
        },
      ],
    },
    {
      type: 'TextBlock',
      text: 'Or just type naturally — Fauna will understand.',
      wrap: true,
      isSubtle: true,
      size: 'Small',
      spacing: 'Medium',
    },
  ]);
}

// ── AI Response Card ───────────────────────────────────────────────────────

export function responseCard(text, { model = '', title = '' } = {}) {
  const body = [];

  if (title) {
    body.push({
      type: 'TextBlock',
      text: title,
      weight: 'Bolder',
      size: 'Medium',
    });
  }

  // Split into paragraphs for better rendering
  const paragraphs = text.split(/\n{2,}/);
  for (const para of paragraphs) {
    body.push({
      type: 'TextBlock',
      text: para,
      wrap: true,
    });
  }

  if (model) {
    body.push({
      type: 'TextBlock',
      text: `via ${model}`,
      isSubtle: true,
      size: 'Small',
      spacing: 'Medium',
    });
  }

  return _wrap(body);
}

// ── Shell Output Card ──────────────────────────────────────────────────────

export function shellCard(command, output, exitCode) {
  const success = exitCode === 0;
  const truncated = output.length > 1800 ? output.slice(0, 1800) + '\n…(truncated)' : output;

  return _wrap([
    {
      type: 'TextBlock',
      text: `💻 \`${command}\``,
      weight: 'Bolder',
      fontType: 'Monospace',
      wrap: true,
    },
    {
      type: 'TextBlock',
      text: truncated || '(no output)',
      fontType: 'Monospace',
      wrap: true,
      size: 'Small',
    },
    {
      type: 'TextBlock',
      text: `Exit code: ${exitCode}`,
      color: success ? 'Good' : 'Attention',
      size: 'Small',
      isSubtle: true,
      spacing: 'Small',
    },
  ]);
}

// ── Agent List Card ────────────────────────────────────────────────────────

export function agentListCard(agents = []) {
  if (!agents.length) {
    return _wrap([{
      type: 'TextBlock',
      text: '🤖 No agents installed yet. Use Fauna desktop to create or install agents.',
      wrap: true,
    }]);
  }

  return _wrap([
    {
      type: 'TextBlock',
      text: `🤖 Your Agents (${agents.length})`,
      weight: 'Bolder',
      size: 'Medium',
    },
    {
      type: 'FactSet',
      facts: agents.slice(0, 20).map(a => ({
        title: a.name || a.id,
        value: a.description || a.systemPrompt?.slice(0, 80) || '—',
      })),
    },
    ...(agents.length > 20 ? [{
      type: 'TextBlock',
      text: `…and ${agents.length - 20} more. Open Fauna desktop to see all.`,
      isSubtle: true,
      size: 'Small',
    }] : []),
  ]);
}

// ── Task Created Card ──────────────────────────────────────────────────────

export function taskCard(task = {}) {
  return _wrap([
    {
      type: 'TextBlock',
      text: '✅ Task Created',
      weight: 'Bolder',
      color: 'Good',
    },
    {
      type: 'FactSet',
      facts: [
        { title: 'ID',          value: task.id || '—' },
        { title: 'Description', value: task.description || task.name || '—' },
        { title: 'Status',      value: task.status || 'pending' },
      ],
    },
  ]);
}

// ── Screenshot Card ────────────────────────────────────────────────────────

export function screenshotCard(dataUrl) {
  if (!dataUrl) {
    return errorCard('Screenshot could not be captured. Make sure Fauna desktop is running.');
  }
  return _wrap([
    {
      type: 'TextBlock',
      text: '📸 Desktop Screenshot',
      weight: 'Bolder',
    },
    {
      type: 'Image',
      url: dataUrl,
      size: 'Stretch',
      altText: 'Desktop screenshot',
    },
  ]);
}

// ── Models Card ────────────────────────────────────────────────────────────

export function modelsCard(models = []) {
  if (!models.length) {
    return errorCard('Could not fetch model list from Fauna desktop.');
  }

  const grouped = {};
  for (const m of models) {
    const provider = m.provider || 'Other';
    if (!grouped[provider]) grouped[provider] = [];
    grouped[provider].push(m.id || m.name || m);
  }

  const body = [
    {
      type: 'TextBlock',
      text: '🧠 Available Models',
      weight: 'Bolder',
      size: 'Medium',
    },
  ];

  for (const [provider, ids] of Object.entries(grouped)) {
    body.push({ type: 'TextBlock', text: `**${provider}**`, weight: 'Bolder', size: 'Small', spacing: 'Medium' });
    body.push({ type: 'TextBlock', text: ids.join(', '), wrap: true, size: 'Small', isSubtle: true });
  }

  return _wrap(body);
}

// ── Playbook Card ──────────────────────────────────────────────────────────

export function playbookCard(instructions = '') {
  const text = instructions.trim() || 'Your playbook is empty. Add instructions in Fauna desktop → Settings → Playbook.';
  return _wrap([
    {
      type: 'TextBlock',
      text: '📖 Fauna Playbook',
      weight: 'Bolder',
      size: 'Medium',
    },
    {
      type: 'TextBlock',
      text: text.slice(0, 2000),
      wrap: true,
    },
  ]);
}

// ── QR Pair Card ───────────────────────────────────────────────────────────

export function pairCard(qrDataUrl, pairingUrl) {
  const body = [
    {
      type: 'TextBlock',
      text: '🔗 Pair with Fauna Desktop',
      weight: 'Bolder',
      size: 'Medium',
    },
    {
      type: 'TextBlock',
      text: 'Scan this QR code in the Fauna desktop app, or click the button below to open the pairing URL.',
      wrap: true,
    },
  ];

  if (qrDataUrl) {
    body.push({
      type: 'Image',
      url: qrDataUrl,
      size: 'Medium',
      altText: 'Pairing QR code',
    });
  }

  if (pairingUrl) {
    body.push({
      type: 'ActionSet',
      actions: [
        {
          type: 'Action.OpenUrl',
          title: 'Open Pairing URL',
          url: pairingUrl,
        },
      ],
    });
  }

  return _wrap(body);
}

// ── Error Card ─────────────────────────────────────────────────────────────

export function errorCard(message) {
  return _wrap([
    {
      type: 'TextBlock',
      text: `⚠️ ${message}`,
      wrap: true,
      color: 'Attention',
    },
  ]);
}

// ── Disconnected Card ──────────────────────────────────────────────────────

export function disconnectedCard() {
  return errorCard(
    'Fauna desktop is not connected. Make sure the Fauna app is running on your computer, then type `/pair` or `/status` to reconnect.'
  );
}

// ── Internal ───────────────────────────────────────────────────────────────

function _wrap(body) {
  return {
    contentType: 'application/vnd.microsoft.card.adaptive',
    content: {
      $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
      type: 'AdaptiveCard',
      version: '1.5',
      body,
    },
  };
}
