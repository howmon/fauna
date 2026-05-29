// Video Studio widget bundle — generates the HTML/JS/CSS for the chat-embedded
// preview & iteration UI. Returned from `fauna_video_create` via packWidgetResult
// so it mounts as a sandboxed iframe in the chat, then registers widget-scoped
// tools (rerender, swap_clip, set_voice, etc.) the model can call back into.

export function buildVideoStudioWidget(job) {
  const port = 3737;
  const jobId = job.id;
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>Video Studio</title>
<style>
  :root {
    --bg:#1b1b1b; --surface:#242424; --surface2:#2e2e2e; --border:#404040;
    --accent:#789996; --text:#f5f5f5; --dim:#b4b4b4; --mut:#7a7a7a;
    --ok:#6ccb5f; --err:#f36e6e; --warn:#f2c661;
    --font:'Segoe UI Variable','Segoe UI',-apple-system,BlinkMacSystemFont,system-ui,sans-serif;
  }
  * { box-sizing: border-box; }
  body { margin:0; padding:12px; background:var(--bg); color:var(--text); font:13px/1.4 var(--font); }
  .wrap { display:flex; flex-direction:column; gap:10px; max-width:520px; }
  .preview { background:#000; border-radius:8px; overflow:hidden; aspect-ratio:9/16; max-height:520px; display:flex; align-items:center; justify-content:center; }
  .preview video { width:100%; height:100%; object-fit:contain; }
  .preview.placeholder { color:var(--mut); font-size:12px; aspect-ratio:9/16; }
  .preview.landscape { aspect-ratio:16/9; max-height:360px; }
  .steps { display:flex; gap:4px; flex-wrap:wrap; }
  .step { flex:1; min-width:60px; padding:6px 8px; border-radius:6px; background:var(--surface); color:var(--dim); font-size:11px; text-align:center; border:1px solid var(--border); }
  .step.done { color:var(--ok); border-color:#3a5a35; }
  .step.running { color:var(--accent); border-color:var(--accent); background:var(--surface2); }
  .step.failed { color:var(--err); border-color:#5a3535; }
  .tabs { display:flex; gap:2px; border-bottom:1px solid var(--border); }
  .tab { padding:6px 10px; background:transparent; border:none; color:var(--dim); cursor:pointer; font:inherit; border-bottom:2px solid transparent; }
  .tab.active { color:var(--text); border-bottom-color:var(--accent); }
  .panel { background:var(--surface); border:1px solid var(--border); border-radius:6px; padding:10px; min-height:80px; }
  .panel.hidden { display:none; }
  textarea, input[type=text] { width:100%; background:var(--bg); color:var(--text); border:1px solid var(--border); border-radius:4px; padding:6px 8px; font:inherit; resize:vertical; }
  textarea { min-height:120px; font-family:ui-monospace, 'SF Mono', monospace; font-size:12px; }
  .chips { display:flex; gap:6px; flex-wrap:wrap; }
  .chip { padding:4px 8px; background:var(--surface2); border:1px solid var(--border); border-radius:12px; font-size:11px; color:var(--dim); }
  .actions { display:flex; gap:6px; flex-wrap:wrap; }
  button.primary { background:var(--accent); color:#fff; border:none; padding:8px 14px; border-radius:6px; cursor:pointer; font:inherit; }
  button.primary:disabled { opacity:0.5; cursor:not-allowed; }
  button.ghost { background:transparent; color:var(--text); border:1px solid var(--border); padding:8px 12px; border-radius:6px; cursor:pointer; font:inherit; }
  .meta { font-size:11px; color:var(--mut); display:flex; gap:10px; flex-wrap:wrap; }
  .progress { font-size:11px; color:var(--accent); min-height:14px; }
  .err { color:var(--err); font-size:12px; }
  select { background:var(--bg); color:var(--text); border:1px solid var(--border); border-radius:4px; padding:4px 6px; font:inherit; }
</style>
</head><body>
<div class="wrap">
  <div id="preview" class="preview placeholder"><span id="preview-msg">No video yet — run the pipeline.</span></div>
  <div class="meta">
    <span id="meta-job">job ${jobId.slice(-6)}</span>
    <span id="meta-aspect"></span>
    <span id="meta-dur"></span>
    <span id="meta-src"></span>
  </div>
  <div class="steps" id="steps"></div>
  <div class="progress" id="progress"></div>
  <div class="err" id="err"></div>
  <div class="actions">
    <button class="primary" id="btn-run">Generate Video</button>
    <button class="ghost" id="btn-regen-script">Regenerate script</button>
    <button class="ghost" id="btn-rerender">Re-render only</button>
    <button class="ghost" id="btn-save-script">Save script</button>
    <button class="ghost" id="btn-open">Open file</button>
  </div>
  <div class="tabs">
    <button class="tab active" data-tab="script">Script</button>
    <button class="tab" data-tab="terms">Terms</button>
    <button class="tab" data-tab="settings">Settings</button>
  </div>
  <div class="panel" id="panel-script">
    <textarea id="script-text" placeholder="Click 'Generate' to write the script…"></textarea>
  </div>
  <div class="panel hidden" id="panel-terms">
    <div class="chips" id="terms-chips"></div>
  </div>
  <div class="panel hidden" id="panel-settings">
    <label>Aspect <select id="set-aspect"><option value="9:16">9:16 vertical</option><option value="16:9">16:9 landscape</option><option value="1:1">1:1 square</option></select></label>
    <br><br>
    <label>Voice <select id="set-voice">
      <optgroup label="Kokoro — neural (bundled)">
        <option value="kokoro:af_bella">Bella (US, female)</option>
        <option value="kokoro:af_heart">Heart (US, female)</option>
        <option value="kokoro:af_nicole">Nicole (US, female)</option>
        <option value="kokoro:af_sarah">Sarah (US, female)</option>
        <option value="kokoro:af_nova">Nova (US, female)</option>
        <option value="kokoro:am_michael">Michael (US, male)</option>
        <option value="kokoro:am_fenrir">Fenrir (US, male)</option>
        <option value="kokoro:am_puck">Puck (US, male)</option>
        <option value="kokoro:bf_emma">Emma (UK, female)</option>
        <option value="kokoro:bf_isabella">Isabella (UK, female)</option>
        <option value="kokoro:bm_george">George (UK, male)</option>
        <option value="kokoro:bm_fable">Fable (UK, male)</option>
      </optgroup>
      <optgroup label="System (lower quality, no download)">
        <option value="">OS default</option>
      </optgroup>
    </select></label>
    <br><br>
    <label>Duration (s) <input type="text" id="set-duration"></label>
  </div>
</div>`;

  return {
    bundle: { html, js: widgetScript(port, jobId) },
    title: 'Video Studio · ' + (job.params.subject || 'untitled'),
    tools: [
      { name: 'run_all',       description: 'Run the full pipeline (script → terms → audio → subtitle → footage → render).', parameters: { type: 'object', properties: {} } },
      { name: 'rerender',      description: 'Re-render only (re-uses existing script/audio/footage).', parameters: { type: 'object', properties: {} } },
      { name: 'set_script',    description: 'Replace the script and invalidate downstream steps.', parameters: { type: 'object', properties: { script: { type: 'string' } }, required: ['script'] } },
      { name: 'set_voice',     description: 'Change the TTS voice name (re-runs audio + subs + render).', parameters: { type: 'object', properties: { voice: { type: 'string' } }, required: ['voice'] } },
      { name: 'set_aspect',    description: 'Change aspect ratio (re-runs footage + render).', parameters: { type: 'object', properties: { aspect: { type: 'string', enum: ['9:16', '16:9', '1:1'] } }, required: ['aspect'] } },
      { name: 'set_duration',  description: 'Change target duration in seconds (re-runs script + everything).', parameters: { type: 'object', properties: { durationSec: { type: 'number' } }, required: ['durationSec'] } },
      { name: 'get_state',     description: 'Return current job state and artifact paths.', parameters: { type: 'object', properties: {} } },
    ],
  };
}

function widgetScript(port, jobId) {
  return `
const PORT = ${JSON.stringify(port)};
const JOB_ID = ${JSON.stringify(jobId)};
const BASE = 'http://localhost:' + PORT;
const STEPS = ['script','terms','audio','subtitle','materials','render'];

const $ = id => document.getElementById(id);
const stepsEl = $('steps');
STEPS.forEach(s => {
  const d = document.createElement('div');
  d.className = 'step'; d.id = 'step-' + s; d.textContent = s;
  stepsEl.appendChild(d);
});

let state = null;
async function refresh() {
  const r = await fetch(BASE + '/api/video/jobs/' + JOB_ID);
  if (!r.ok) return;
  state = await r.json();
  paint();
}
function paint() {
  if (!state) return;
  const a = state.artifacts || {};
  const p = state.params || {};
  $('meta-aspect').textContent = p.aspect || '';
  $('meta-dur').textContent = (a.audioDurationSec ? a.audioDurationSec.toFixed(1) + 's' : (p.durationSec + 's target'));
  $('meta-src').textContent = a.footageSource || '';
  STEPS.forEach(s => {
    const el = $('step-' + s);
    el.classList.remove('done','running','failed');
    if ((state.stepsDone||[]).includes(s)) el.classList.add('done');
    if (state.state === 'running:' + s) el.classList.add('running');
    if (state.error && state.error.step === s) el.classList.add('failed');
  });
  const isRunning = typeof state.state === 'string' && state.state.startsWith('running:');
  $('btn-run').disabled = isRunning;
  $('btn-run').textContent = isRunning ? 'Generating…' : 'Generate Video';
  // Don't clobber the textarea while the user is editing it. We still update
  // when the panel is unfocused so streamed refreshes (e.g. after Regenerate
  // script) bring in fresh copy.
  if (a.script != null && document.activeElement !== $('script-text')) {
    $('script-text').value = a.script;
  }
  if (Array.isArray(a.terms)) {
    const c = $('terms-chips'); c.innerHTML = '';
    a.terms.forEach(t => { const d = document.createElement('span'); d.className = 'chip'; d.textContent = t; c.appendChild(d); });
  }
  $('set-aspect').value = p.aspect || '9:16';
  $('set-voice').value = p.voice || '';
  $('set-duration').value = p.durationSec || 30;
  const prev = $('preview');
  prev.className = 'preview' + (p.aspect === '16:9' ? ' landscape' : '');
  if (a.finalPath) {
    // Cache-bust on every render completion so the <video> doesn't keep
    // showing the previous mp4 (same URL, identical bytes from the browser
    // cache's perspective).
    const bust = encodeURIComponent(state.updatedAt || Date.now());
    const newSrc = BASE + '/api/video/jobs/' + JOB_ID + '/file?path=final&v=' + bust;
    let v = prev.querySelector('video');
    if (!v) {
      prev.classList.remove('placeholder');
      prev.innerHTML = '';
      v = document.createElement('video');
      v.controls = true; v.preload = 'metadata';
      prev.appendChild(v);
    }
    if (v.dataset.src !== newSrc) {
      v.dataset.src = newSrc;
      v.src = newSrc;
      v.load();
    }
  } else {
    prev.classList.add('placeholder');
    prev.innerHTML = '<span>No video yet — run the pipeline.</span>';
  }
  $('err').textContent = state.error ? (state.error.step + ': ' + state.error.message) : '';
}

// Tabs
document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === t));
  ['script','terms','settings'].forEach(name => {
    $('panel-' + name).classList.toggle('hidden', name !== t.dataset.tab);
  });
}));

// SSE progress
function streamProgress() {
  const es = new EventSource(BASE + '/api/video/jobs/' + JOB_ID + '/events');
  es.onmessage = (e) => {
    try {
      const evt = JSON.parse(e.data);
      $('progress').textContent = evt.message || (evt.step + ' ' + evt.status);
      // Refresh on every event so step chips + script panel reflect live state.
      refresh();
    } catch (_) {}
  };
}
streamProgress();
refresh();

async function runAll() {
  $('btn-run').disabled = true;
  $('progress').textContent = 'Starting…';
  try {
    // If the user edited the script textarea but didn't click Save, persist
    // it first so the pipeline picks up the new copy (and invalidates audio /
    // subtitle / render downstream).
    await syncScriptIfDirty();
    const r = await fetch(BASE + '/api/video/jobs/' + JOB_ID + '/run-all', { method: 'POST' });
    const j = await r.json();
    if (!j.ok) $('err').textContent = j.error || 'Run failed';
  } finally {
    $('btn-run').disabled = false;
    refresh();
  }
}
async function rerender() {
  await syncScriptIfDirty();
  await fetch(BASE + '/api/video/jobs/' + JOB_ID + '/step/render', { method: 'POST' });
  refresh();
}

// If the script textarea has unsaved edits, patch the job so downstream
// steps (audio/subtitle/render) are invalidated before we kick off work.
async function syncScriptIfDirty() {
  const current = $('script-text').value;
  const saved = state?.artifacts?.script;
  if (current == null || current === saved) return;
  await fetch(BASE + '/api/video/jobs/' + JOB_ID + '/patch', {
    method: 'POST', headers: { 'Content-Type':'application/json' },
    body: JSON.stringify({ script: current }),
  });
  // Refresh local state so subsequent calls see the new artifact + cleared
  // stepsDone.
  const r = await fetch(BASE + '/api/video/jobs/' + JOB_ID);
  if (r.ok) state = await r.json();
}
async function regenerateScript() {
  $('btn-regen-script').disabled = true;
  $('btn-regen-script').textContent = 'Regenerating…';
  try {
    const r = await fetch(BASE + '/api/video/jobs/' + JOB_ID + '/step/script?force=1', {
      method: 'POST', headers: { 'Content-Type':'application/json' },
      body: JSON.stringify({ force: true }),
    });
    const j = await r.json();
    if (!j.ok) {
      $('err').textContent = j.error || 'Regenerate failed';
    } else if (j.job?.artifacts?.script) {
      // Overwrite the textarea immediately so the user sees the new copy
      // even if a subsequent refresh races.
      $('script-text').value = j.job.artifacts.script;
      state = j.job;
      paint();
    }
  } catch (e) {
    $('err').textContent = String(e.message || e);
  } finally {
    $('btn-regen-script').disabled = false;
    $('btn-regen-script').textContent = 'Regenerate script';
    refresh();
  }
}
async function saveScript() {
  await fetch(BASE + '/api/video/jobs/' + JOB_ID + '/patch', {
    method: 'POST', headers: { 'Content-Type':'application/json' },
    body: JSON.stringify({ script: $('script-text').value }),
  });
  refresh();
}
async function openFile() {
  if (!state?.artifacts?.finalPath) return;
  await fetch(BASE + '/api/open-folder', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ path: state.artifacts.finalPath, reveal: true }),
  });
}

$('btn-run').addEventListener('click', runAll);
$('btn-regen-script').addEventListener('click', regenerateScript);
$('btn-rerender').addEventListener('click', rerender);
$('btn-save-script').addEventListener('click', saveScript);
$('btn-open').addEventListener('click', openFile);

// Settings change → patch job
['set-aspect','set-voice','set-duration'].forEach(id => {
  $(id).addEventListener('change', async () => {
    const patch = {};
    patch.aspect = $('set-aspect').value;
    patch.voice = $('set-voice').value || null;
    patch.durationSec = Number($('set-duration').value) || 30;
    await fetch(BASE + '/api/video/jobs/' + JOB_ID + '/patch', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify(patch),
    });
    refresh();
  });
});

// Widget RPC (model → widget) — respond to widget-scoped tool calls.
window.addEventListener('message', async (ev) => {
  const msg = ev.data || {};
  if (msg.type !== 'widget:rpc') return;
  const { id, tool, args } = msg;
  let result = { ok: true };
  try {
    if (tool === 'run_all') { await runAll(); result.message = 'pipeline started'; }
    else if (tool === 'rerender') { await rerender(); }
    else if (tool === 'set_script') {
      $('script-text').value = args.script;
      await saveScript();
    }
    else if (tool === 'set_voice') {
      $('set-voice').value = args.voice; $('set-voice').dispatchEvent(new Event('change'));
    }
    else if (tool === 'set_aspect') {
      $('set-aspect').value = args.aspect; $('set-aspect').dispatchEvent(new Event('change'));
    }
    else if (tool === 'set_duration') {
      $('set-duration').value = args.durationSec; $('set-duration').dispatchEvent(new Event('change'));
    }
    else if (tool === 'get_state') { result.state = state; }
    else { result.ok = false; result.error = 'unknown tool: ' + tool; }
  } catch (e) { result.ok = false; result.error = e.message; }
  parent.postMessage({ type: 'widget:rpc:response', id, result }, '*');
});
`;
}
