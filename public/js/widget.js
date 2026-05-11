// ── Fauna Automations Widget ───────────────────────────────────────────────
// Floating BrowserWindow that shows the automations list with full kind support.

const API  = 'http://localhost:3737/api/tasks';
const BASE = 'http://localhost:3737';

// ── State ─────────────────────────────────────────────────────────────────

let _tasks    = [];
let _tab      = 'active';   // 'active' | 'recent'
let _qaKind   = 'cron';
let _evsrc    = null;
let _pollTimer = null;

// ── DOM refs ──────────────────────────────────────────────────────────────

const $list     = document.getElementById('task-list');
const $empty    = document.getElementById('empty-state');
const $quickAdd = document.getElementById('quick-add');
const $qaTitle  = document.getElementById('qa-title');
const $qaDesc   = document.getElementById('qa-desc');
const $qaSched  = document.getElementById('qa-sched');
const $qaAt     = document.getElementById('qa-at');
const $qaCron   = document.getElementById('qa-cron');
const $qaSchedRow = document.getElementById('qa-sched-row');

// ── Helpers ───────────────────────────────────────────────────────────────

function esc(s) {
  const d = document.createElement('div');
  d.textContent = String(s || '');
  return d.innerHTML;
}

function timeAgo(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60e3)   return 'just now';
  if (diff < 3600e3) return Math.floor(diff / 60e3)   + 'm ago';
  if (diff < 86400e3) return Math.floor(diff / 3600e3) + 'h ago';
  return Math.floor(diff / 86400e3) + 'd ago';
}

function formatCountdown(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60)   return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60)   return m + 'm';
  const h = Math.floor(m / 60);
  return h + 'h ' + (m % 60 ? m % 60 + 'm' : '');
}

function schedLabel(t) {
  const s = t.schedule;
  if (!s) return 'manual';
  if (s.rrule) return humanizeRrule(s.rrule);
  if (s.type === 'once' && s.at) {
    const d = new Date(s.at);
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  if (s.type === 'recurring' && s.cron) return s.cron;
  if (t.kind === 'heartbeat') return 'heartbeat';
  if (t.kind === 'pipeline')  return 'pipeline';
  return 'manual';
}

function humanizeRrule(r) {
  if (!r) return '';
  if (r.includes('FREQ=DAILY')) {
    const h = (r.match(/BYHOUR=(\d+)/) || [])[1];
    if (h != null) {
      const hr = parseInt(h);
      return 'Daily at ' + (hr % 12 || 12) + ' ' + (hr < 12 ? 'AM' : 'PM');
    }
    return 'Daily';
  }
  if (r.includes('FREQ=WEEKLY')) return 'Weekly';
  if (r.includes('FREQ=HOURLY')) return 'Hourly';
  if (r.includes('FREQ=MONTHLY')) return 'Monthly';
  return r;
}

function dotClass(status) {
  return { pending: 'pending', scheduled: 'scheduled', running: 'running',
           completed: 'completed', failed: 'failed', paused: 'paused' }[status] || 'pending';
}

// ── Rendering ─────────────────────────────────────────────────────────────

const STATUS_ORDER = { running: 0, scheduled: 1, pending: 2, paused: 3, failed: 4, completed: 5 };

function render() {
  $list.innerHTML = '';

  const isActive = (t) => !['paused','completed','failed'].includes(t.status);

  let pool = _tab === 'active'
    ? _tasks.filter(isActive).concat(_tasks.filter(t => t.status === 'paused'))
    : _tasks.filter(t => ['completed','failed'].includes(t.status));

  pool.sort((a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9));

  if (!pool.length) {
    $empty.classList.remove('hidden');
    return;
  }
  $empty.classList.add('hidden');

  // Group rows for "active" tab
  if (_tab === 'active') {
    const running   = pool.filter(t => t.status === 'running');
    const scheduled = pool.filter(t => t.status === 'scheduled');
    const pending   = pool.filter(t => t.status === 'pending');
    const paused    = pool.filter(t => t.status === 'paused');

    if (running.length) {
      $list.innerHTML += `<div class="w-group-label">Running</div>`;
      running.forEach(t => $list.innerHTML += rowHtml(t));
    }
    if (scheduled.length) {
      $list.innerHTML += `<div class="w-group-label">Scheduled</div>`;
      scheduled.forEach(t => $list.innerHTML += rowHtml(t));
    }
    if (pending.length) {
      $list.innerHTML += `<div class="w-group-label">Pending</div>`;
      pending.forEach(t => $list.innerHTML += rowHtml(t));
    }
    if (paused.length) {
      $list.innerHTML += `<div class="w-group-label">Paused</div>`;
      paused.forEach(t => $list.innerHTML += rowHtml(t));
    }
  } else {
    pool.slice(0, 20).forEach(t => $list.innerHTML += rowHtml(t));
  }
}

function rowHtml(t) {
  const kind     = t.kind || 'cron';
  const sched    = schedLabel(t);
  const when     = timeAgo(t.updatedAt || t.createdAt);
  const running  = t._running;
  const pct      = running ? Math.min(100, Math.round(((running.step || 0) / (running.maxSteps || 20)) * 100)) : 0;

  // Next run countdown
  let nextRun = '';
  if (t.nextRunAt && t.status === 'scheduled') {
    const diff = new Date(t.nextRunAt).getTime() - Date.now();
    nextRun = diff > 0
      ? `<span class="task-sub-sep">·</span><span>in ${esc(formatCountdown(diff))}</span>`
      : `<span class="task-sub-sep">·</span><span>now</span>`;
  }

  // Pipeline info
  let pipeInfo = '';
  if (kind === 'pipeline' && t.pipeline && Array.isArray(t.pipeline.nodes)) {
    pipeInfo = `<span class="task-sub-sep">·</span><span>${t.pipeline.nodes.length} nodes</span>`;
  }

  // Result snippet
  let resultHtml = '';
  if (t.status === 'completed' && t.result) {
    const snip = (t.result.summary || t.result.output || '').slice(0, 90);
    if (snip) resultHtml = `<div class="task-result ok">${esc(snip)}</div>`;
  } else if (t.status === 'failed' && t.result) {
    const snip = (t.result.error || t.result.output || '').slice(0, 90);
    if (snip) resultHtml = `<div class="task-result fail">${esc(snip)}</div>`;
  }

  // Action buttons
  const actRun    = `<button class="task-action" data-act="run"    data-id="${t.id}" title="Run now"><i class="ti ti-player-play"></i></button>`;
  const actStop   = `<button class="task-action" data-act="stop"   data-id="${t.id}" title="Stop"><i class="ti ti-player-stop"></i></button>`;
  const actPause  = `<button class="task-action" data-act="pause"  data-id="${t.id}" title="Pause"><i class="ti ti-player-pause"></i></button>`;
  const actResume = `<button class="task-action" data-act="resume" data-id="${t.id}" title="Resume"><i class="ti ti-player-play"></i></button>`;
  const actDel    = `<button class="task-action danger" data-act="delete" data-id="${t.id}" title="Delete"><i class="ti ti-trash"></i></button>`;

  const s = t.status;
  let actBtns = '';
  if (s === 'running')   actBtns = actStop + actPause + actDel;
  else if (s === 'paused')    actBtns = actResume + actDel;
  else if (s === 'scheduled') actBtns = actRun + actPause + actDel;
  else                        actBtns = actRun + actDel;

  return `
<div class="task-item" data-id="${t.id}">
  <div class="task-dot ${dotClass(s)}"></div>
  <div class="task-body">
    <div class="task-top">
      <span class="task-title">${esc(t.title)}</span>
      <span class="task-kind-badge ${esc(kind)}">${esc(kind)}</span>
    </div>
    <div class="task-sub">
      <span>${esc(sched)}</span>
      ${nextRun}
      ${pipeInfo}
      ${when ? `<span class="task-sub-sep">·</span><span>${esc(when)}</span>` : ''}
    </div>
    ${running ? `<div class="task-progress"><div class="task-progress-bar" style="width:${pct}%"></div></div>` : ''}
    ${s === 'running' ? `<div class="task-steer-row"><input class="steer-input" placeholder="Steer…" data-id="${t.id}"><button class="steer-btn" data-id="${t.id}"><i class="ti ti-send"></i></button></div>` : ''}
    ${resultHtml}
  </div>
  <div class="task-actions">${actBtns}</div>
</div>`;
}

// ── Task actions ──────────────────────────────────────────────────────────

$list.addEventListener('click', async (e) => {
  // Action buttons
  const btn = e.target.closest('.task-action');
  if (btn) {
    const act = btn.dataset.act;
    const id  = btn.dataset.id;
    if (!id) return;
    if (act === 'run')    await fetch(`${API}/${id}/run`,    { method: 'POST' }).catch(() => {});
    if (act === 'stop')   await fetch(`${API}/${id}/stop`,   { method: 'POST' }).catch(() => {});
    if (act === 'pause')  await fetch(`${API}/${id}/pause`,  { method: 'POST' }).catch(() => {});
    if (act === 'resume') await fetch(`${API}/${id}/resume`, { method: 'POST' }).catch(() => {});
    if (act === 'delete') {
      const row = $list.querySelector(`.task-item[data-id="${id}"]`);
      if (row) row.style.opacity = '0.4';
      await fetch(`${API}/${id}`, { method: 'DELETE' }).catch(() => {});
    }
    await fetchTasks();
    return;
  }

  // Steer send button
  const steerBtn = e.target.closest('.steer-btn');
  if (steerBtn) {
    const id    = steerBtn.dataset.id;
    const input = $list.querySelector(`.steer-input[data-id="${id}"]`);
    if (input) await sendSteer(id, input);
    return;
  }
});

$list.addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter') return;
  const input = e.target.closest('.steer-input');
  if (input) await sendSteer(input.dataset.id, input);
});

async function sendSteer(id, input) {
  const msg = (input.value || '').trim();
  if (!msg) return;
  input.value = '';
  input.disabled = true;
  try {
    await fetch(`${API}/${id}/steer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg }),
    });
  } catch (_) {}
  input.disabled = false;
  input.focus();
}

// ── Tab bar ───────────────────────────────────────────────────────────────

document.getElementById('tab-bar').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab-btn');
  if (!btn) return;
  _tab = btn.dataset.tab;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === _tab));
  render();
});

// ── Quick-add ─────────────────────────────────────────────────────────────

function openQuickAdd() {
  $quickAdd.classList.remove('hidden');
  setTimeout(() => $qaTitle && $qaTitle.focus(), 50);
}

function closeQuickAdd() {
  $quickAdd.classList.add('hidden');
  $qaTitle.value  = '';
  $qaDesc.value   = '';
  $qaSched.value  = 'manual';
  $qaAt.classList.add('hidden');
  $qaCron.classList.add('hidden');
  // Reset kind
  setKind('cron');
}

document.getElementById('btn-new').addEventListener('click', openQuickAdd);
document.getElementById('btn-empty-new').addEventListener('click', openQuickAdd);
document.getElementById('qa-cancel').addEventListener('click', closeQuickAdd);

// Kind tabs
document.querySelectorAll('.qa-kind-tab').forEach(btn => {
  btn.addEventListener('click', () => setKind(btn.dataset.kind));
});

function setKind(kind) {
  _qaKind = kind;
  document.querySelectorAll('.qa-kind-tab').forEach(b => b.classList.toggle('active', b.dataset.kind === kind));
  // Show schedule row only for cron kind
  $qaSchedRow.style.display = (kind === 'cron') ? '' : 'none';
}

// Init kind
setKind('cron');

$qaSched.addEventListener('change', () => {
  $qaAt.classList.toggle('hidden', $qaSched.value !== 'once');
  $qaCron.classList.toggle('hidden', $qaSched.value !== 'recurring');
});

document.getElementById('qa-submit').addEventListener('click', async () => {
  const title = ($qaTitle.value || '').trim();
  if (!title) { $qaTitle.focus(); return; }

  const body = {
    title,
    description: ($qaDesc.value || '').trim(),
    kind: _qaKind,
    permissions: {
      shell:   document.getElementById('qa-perm-shell').checked,
      browser: document.getElementById('qa-perm-browser').checked,
      figma:   document.getElementById('qa-perm-figma').checked,
    },
    schedule: { type: 'manual' },
  };

  if (_qaKind === 'cron') {
    body.schedule.type = $qaSched.value;
    if ($qaSched.value === 'once' && $qaAt.value) {
      body.schedule.at = new Date($qaAt.value).toISOString();
    }
    if ($qaSched.value === 'recurring' && $qaCron.value.trim()) {
      body.schedule.cron = $qaCron.value.trim();
    }
  }

  const btn = document.getElementById('qa-submit');
  btn.disabled = true;
  btn.textContent = 'Creating…';
  try {
    await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    closeQuickAdd();
    await fetchTasks();
  } catch (err) {
    console.error('[widget] create error:', err);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Create';
  }
});

$qaTitle.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('qa-submit').click();
  if (e.key === 'Escape') closeQuickAdd();
});

// ── Pin / Close / Open in app ─────────────────────────────────────────────

document.getElementById('btn-pin').addEventListener('click', () => {
  if (window.widgetAPI?.togglePin) window.widgetAPI.togglePin();
});

document.getElementById('btn-close').addEventListener('click', () => {
  if (window.widgetAPI?.hide) window.widgetAPI.hide();
});

document.getElementById('btn-open-app').addEventListener('click', () => {
  if (window.widgetAPI?.openInApp) window.widgetAPI.openInApp();
});

if (window.widgetAPI?.onPinChanged) {
  window.widgetAPI.onPinChanged((pinned) => {
    document.getElementById('btn-pin').classList.toggle('pinned', pinned);
  });
}

// ── Fetch ─────────────────────────────────────────────────────────────────

async function fetchTasks() {
  try {
    const res = await fetch(API);
    if (res.ok) {
      _tasks = await res.json();
      render();
    }
  } catch (_) { /* server not ready yet */ }
}

// ── SSE live updates ──────────────────────────────────────────────────────

function connectSSE() {
  if (_evsrc) { _evsrc.close(); _evsrc = null; }
  try {
    _evsrc = new EventSource(`${API}/stream`);
    _evsrc.onmessage = (e) => {
      try {
        const evt = JSON.parse(e.data);
        if (['completed','failed','started','paused','step','created','deleted','resumed'].includes(evt.event)) {
          fetchTasks();
        }
      } catch (_) {}
    };
    _evsrc.onerror = () => {
      _evsrc.close();
      _evsrc = null;
      setTimeout(connectSSE, 5000);
    };
  } catch (_) {
    setTimeout(connectSSE, 5000);
  }
}

// ── Init ──────────────────────────────────────────────────────────────────

fetchTasks();
connectSSE();
// Fallback poll every 30s for missed SSE events
_pollTimer = setInterval(fetchTasks, 30000);
