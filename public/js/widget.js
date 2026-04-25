// ── Task Widget — Floating task list with live updates ────────────────────
// Loaded in widget.html inside a small BrowserWindow.
// Communicates with the Fauna server via REST + SSE on localhost:3737.

const API = 'http://localhost:3737/api/tasks';

// ── State ────────────────────────────────────────────────────────────────

let tasks = [];
let eventSource = null;

// ── DOM refs ─────────────────────────────────────────────────────────────

const $list     = document.getElementById('task-list');
const $empty    = document.getElementById('empty-state');
const $quickAdd = document.getElementById('quick-add');
const $qaTitle  = document.getElementById('qa-title');
const $qaDesc   = document.getElementById('qa-desc');
const $qaSched  = document.getElementById('qa-sched');
const $qaAt     = document.getElementById('qa-at');
const $qaCron   = document.getElementById('qa-cron');

// ── Helpers ──────────────────────────────────────────────────────────────

const STATUS_ICON = {
  pending:   '○',
  scheduled: '◉',
  running:   '⟳',
  completed: '✓',
  failed:    '✗',
  paused:    '⏸',
};

function timeAgo(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
  if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
  return Math.floor(diff / 86400000) + 'd ago';
}

function scheduleLabel(sched) {
  if (!sched) return '';
  if (sched.type === 'once' && sched.at) {
    return new Date(sched.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  if (sched.type === 'recurring' && sched.cron) return sched.cron;
  return sched.type;
}

// ── Rendering ────────────────────────────────────────────────────────────

const STATUS_ORDER = { running: 0, scheduled: 1, pending: 2, paused: 3, failed: 4, completed: 5 };

function render() {
  tasks.sort((a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9));
  $list.innerHTML = '';

  if (tasks.length === 0) {
    $empty.classList.remove('hidden');
    return;
  }
  $empty.classList.add('hidden');

  for (const t of tasks) {
    const item = document.createElement('div');
    item.className = 'task-item';
    item.dataset.id = t.id;

    const running = t._running;
    const step = running ? `Step ${running.step || 0}/${running.maxSteps || 20}` : '';
    const pct = running ? Math.round(((running.step || 0) / (running.maxSteps || 20)) * 100) : 0;

    item.innerHTML = `
      <div class="task-status ${t.status}">${STATUS_ICON[t.status] || '○'}</div>
      <div class="task-info">
        <div class="task-title">${esc(t.title)}</div>
        <div class="task-meta">${scheduleLabel(t.schedule)}${step ? ' · ' + step : ''} · ${timeAgo(t.updatedAt)}</div>
        ${t.status === 'running' ? `<div class="task-progress"><div class="task-progress-bar" style="width:${pct}%"></div></div>` : ''}
      </div>
      <div class="task-actions">
        ${t.status === 'running'
          ? `<button class="task-action" data-act="pause" title="Pause">⏸</button>`
          : `<button class="task-action" data-act="run" title="Run">▶</button>`}
        <button class="task-action" data-act="delete" title="Delete">🗑</button>
      </div>
    `;
    $list.appendChild(item);
  }
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// ── Task actions ─────────────────────────────────────────────────────────

$list.addEventListener('click', async (e) => {
  const btn = e.target.closest('.task-action');
  if (!btn) return;
  const item = btn.closest('.task-item');
  const id = item?.dataset.id;
  if (!id) return;

  const act = btn.dataset.act;
  if (act === 'run')    await fetch(`${API}/${id}/run`, { method: 'POST' });
  if (act === 'pause')  await fetch(`${API}/${id}/pause`, { method: 'POST' });
  if (act === 'delete') await fetch(`${API}/${id}`, { method: 'DELETE' });

  await fetchTasks();
});

// ── Quick-add ────────────────────────────────────────────────────────────

document.getElementById('btn-add').addEventListener('click', () => {
  $quickAdd.classList.toggle('hidden');
  if (!$quickAdd.classList.contains('hidden')) $qaTitle.focus();
});

$qaSched.addEventListener('change', () => {
  $qaAt.classList.toggle('hidden', $qaSched.value !== 'once');
  $qaCron.classList.toggle('hidden', $qaSched.value !== 'recurring');
});

document.getElementById('qa-submit').addEventListener('click', async () => {
  const title = $qaTitle.value.trim();
  if (!title) return;

  const body = {
    title,
    description: $qaDesc.value.trim(),
    schedule: { type: $qaSched.value },
  };
  if ($qaSched.value === 'once')      body.schedule.at = $qaAt.value ? new Date($qaAt.value).toISOString() : null;
  if ($qaSched.value === 'recurring') body.schedule.cron = $qaCron.value.trim() || null;

  await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  // Reset form
  $qaTitle.value = '';
  $qaDesc.value = '';
  $qaSched.value = 'manual';
  $qaAt.classList.add('hidden');
  $qaCron.classList.add('hidden');
  $quickAdd.classList.add('hidden');

  await fetchTasks();
});

// Also submit on Enter in the title field
$qaTitle.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('qa-submit').click();
});

// ── Pin / Close ──────────────────────────────────────────────────────────

document.getElementById('btn-pin').addEventListener('click', () => {
  // Communicate with the main process via the preload bridge
  if (window.widgetAPI?.togglePin) window.widgetAPI.togglePin();
});

document.getElementById('btn-close').addEventListener('click', () => {
  if (window.widgetAPI?.hide) window.widgetAPI.hide();
});

// ── Fetching ─────────────────────────────────────────────────────────────

async function fetchTasks() {
  try {
    const res = await fetch(API);
    if (res.ok) {
      tasks = await res.json();
      render();
    }
  } catch (_) { /* server not ready yet */ }
}

// ── SSE live updates ─────────────────────────────────────────────────────

function connectSSE() {
  if (eventSource) { eventSource.close(); eventSource = null; }
  try {
    eventSource = new EventSource(`${API}/stream`);
    eventSource.onmessage = (e) => {
      try {
        const evt = JSON.parse(e.data);
        if (['completed', 'failed', 'started', 'paused', 'step', 'created', 'deleted'].includes(evt.event)) {
          fetchTasks();
        }
      } catch (_) {}
    };
    eventSource.onerror = () => {
      eventSource.close();
      eventSource = null;
      // Retry after a few seconds
      setTimeout(connectSSE, 5000);
    };
  } catch (_) {
    setTimeout(connectSSE, 5000);
  }
}

// ── Init ─────────────────────────────────────────────────────────────────

fetchTasks();
connectSSE();

// Also poll every 30s as a fallback
setInterval(fetchTasks, 30000);

// Listen for pin state updates from main process
if (window.widgetAPI?.onPinChanged) {
  window.widgetAPI.onPinChanged((pinned) => {
    document.getElementById('btn-pin').classList.toggle('pinned', pinned);
  });
}
