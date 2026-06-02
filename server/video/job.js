// Video Job — stateful pipeline orchestrator for a single video generation request.
//
// Persists job state to ~/.config/fauna/video-jobs/<jobId>/job.json so users can
// resume / inspect / iterate across app restarts. Each step is idempotent: the
// pipeline checks for the output artifact on disk and skips work if it exists,
// unless invalidate() has flagged downstream steps stale.
//
// SSE / chat progress is emitted via a per-job EventEmitter — chat.js can pipe
// these through as tool_call labels, and the Video Studio widget consumes the
// same stream via /api/video/jobs/:id/events.

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { EventEmitter } from 'events';
import { generateScript, generateTerms } from './storyteller.js';
import { synthesize, writeSubtitles } from './narration.js';
import { gatherFootage } from './footage.js';
import { render } from './render.js';

const JOBS_ROOT = path.join(os.homedir(), '.config', 'fauna', 'video-jobs');
const STEPS = ['script', 'terms', 'audio', 'subtitle', 'materials', 'render'];

// Which earlier-step invalidates which later-steps.
const INVALIDATES = {
  script:    ['terms', 'audio', 'subtitle', 'materials', 'render'],
  terms:     ['materials', 'render'],
  voice:     ['audio', 'subtitle', 'render'],
  aspect:    ['materials', 'render'],
  music:     ['render'],
  duration:  ['script', 'terms', 'audio', 'subtitle', 'materials', 'render'],
};

const _emitters = new Map(); // jobId → EventEmitter

function _emitter(jobId) {
  let e = _emitters.get(jobId);
  if (!e) { e = new EventEmitter(); e.setMaxListeners(50); _emitters.set(jobId, e); }
  return e;
}

function _jobDir(jobId) {
  return path.join(JOBS_ROOT, jobId);
}

function _jobFile(jobId) {
  return path.join(_jobDir(jobId), 'job.json');
}

function _readJob(jobId) {
  const f = _jobFile(jobId);
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

function _writeJob(job) {
  const d = _jobDir(job.id);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(_jobFile(job.id), JSON.stringify(job, null, 2), 'utf8');
}

function _emit(jobId, evt) {
  const e = _emitter(jobId);
  e.emit('progress', evt);
}

export function subscribe(jobId, fn) {
  const e = _emitter(jobId);
  e.on('progress', fn);
  return () => e.off('progress', fn);
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Create a new job.
 * @param {object} params
 * @param {string} params.subject
 * @param {number} [params.durationSec=30]
 * @param {string} [params.aspect='9:16']
 * @param {string} [params.voice]
 * @param {string} [params.language='en']
 * @param {string} [params.localFolder]      // overrides stock APIs if set
 * @param {string} [params.bgmFile]
 * @param {number} [params.maxClipDuration=5]
 * @param {string} [params.model='claude-sonnet-4.6']
 */
export function createJob(params = {}) {
  const id = 'v_' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex');
  const job = {
    id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    state: 'created',
    params: {
      subject: String(params.subject || '').trim(),
      durationSec: Math.max(8, Math.min(120, Number(params.durationSec) || 30)),
      aspect: ['9:16', '16:9', '1:1'].includes(params.aspect) ? params.aspect : '9:16',
      voice: params.voice || 'kokoro:af_bella',
      language: params.language || 'en',
      localFolder: params.localFolder || null,
      bgmFile: params.bgmFile || null,
      maxClipDuration: Math.max(2, Math.min(15, Number(params.maxClipDuration) || 5)),
      model: params.model || 'claude-sonnet-4.6',
    },
    artifacts: {
      script: null,            // string
      terms: null,             // string[]
      audioFile: null,         // mp3 path
      audioDurationSec: null,
      audioEngine: null,
      audioVoice: null,
      audioCues: null,         // [{index,start,end,text}] when engine produced exact timings
      subtitlePath: null,
      footageSource: null,
      clips: [],               // [{path, source, term}]
      combinedPath: null,
      finalPath: null,
    },
    stepsDone: [],
    error: null,
  };
  _writeJob(job);
  return job;
}

export function getJob(jobId) {
  return _readJob(jobId);
}

export function listJobs() {
  if (!fs.existsSync(JOBS_ROOT)) return [];
  return fs.readdirSync(JOBS_ROOT)
    .filter(id => fs.existsSync(_jobFile(id)))
    .map(id => _readJob(id))
    .filter(Boolean)
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}

export function deleteJob(jobId) {
  const d = _jobDir(jobId);
  if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
  _emitters.delete(jobId);
  return true;
}

/**
 * Patch job parameters or artifacts (e.g. edit the script manually). Marks
 * downstream steps stale so they will re-run on next runStep().
 *
 * @param {string} jobId
 * @param {object} patch — fields: subject|durationSec|aspect|voice|language|script|terms|bgmFile
 */
export function patchJob(jobId, patch = {}) {
  const job = _readJob(jobId);
  if (!job) throw new Error('job not found');
  const invalidated = new Set();

  for (const k of Object.keys(patch)) {
    const v = patch[k];
    if (['subject','durationSec','aspect','voice','language','localFolder','bgmFile','maxClipDuration','model'].includes(k)) {
      job.params[k] = v;
      if (INVALIDATES[k]) INVALIDATES[k].forEach(s => invalidated.add(s));
    } else if (k === 'script') {
      job.artifacts.script = String(v);
      // A manual script edit only invalidates artifacts derived directly
      // from the script text. Terms + materials are preserved because the
      // user typically edits the script to better fit what's already there;
      // a full regenerate (runStep('script', {force:true})) still cascades.
      ['audio', 'subtitle', 'render'].forEach(s => invalidated.add(s));
    } else if (k === 'terms') {
      job.artifacts.terms = Array.isArray(v) ? v.map(String) : null;
      INVALIDATES.terms.forEach(s => invalidated.add(s));
    }
  }
  job.stepsDone = job.stepsDone.filter(s => !invalidated.has(s));
  job.updatedAt = new Date().toISOString();
  _writeJob(job);
  return { job, invalidated: Array.from(invalidated) };
}

// ── Step runner ────────────────────────────────────────────────────────────

/**
 * @param {string} jobId
 * @param {string} step  one of STEPS
 * @param {object} [opts]
 * @param {object} [opts.client]   OpenAI-shaped client for LLM steps
 */
export async function runStep(jobId, step, opts = {}) {
  if (!STEPS.includes(step)) throw new Error(`unknown step: ${step}`);
  const job = _readJob(jobId);
  if (!job) throw new Error('job not found');

  // `force` re-runs even if the step is already done (and invalidates
  // any downstream steps that depend on it).
  if (opts.force) {
    const invalid = new Set([step, ...(INVALIDATES[step] || [])]);
    job.stepsDone = job.stepsDone.filter(s => !invalid.has(s));
    _writeJob(job);
  } else if (job.stepsDone.includes(step)) {
    _emit(jobId, { step, status: 'cached', message: `${step}: cached` });
    return job;
  }

  job.state = 'running:' + step;
  job.error = null;
  _writeJob(job);
  _emit(jobId, { step, status: 'started' });
  const onProgress = (msg) => _emit(jobId, { step, status: 'progress', message: msg });

  try {
    switch (step) {
      case 'script': {
        if (!opts.client) throw new Error('LLM client required for script step');
        const r = await generateScript({
          subject: job.params.subject,
          durationSec: job.params.durationSec,
          language: job.params.language,
          client: opts.client,
          model: job.params.model,
        });
        job.artifacts.script = r.script;
        break;
      }
      case 'terms': {
        if (!opts.client) throw new Error('LLM client required for terms step');
        if (!job.artifacts.script) throw new Error('script must be generated first');
        if (job.params.localFolder) {
          // Local source doesn't need search terms.
          job.artifacts.terms = ['local'];
        } else {
          const terms = await generateTerms({
            subject: job.params.subject,
            script: job.artifacts.script,
            client: opts.client,
            model: job.params.model,
          });
          job.artifacts.terms = terms;
        }
        break;
      }
      case 'audio': {
        if (!job.artifacts.script) throw new Error('script must be generated first');
        const audioFile = path.join(_jobDir(jobId), 'audio.mp3');
        const r = await synthesize({
          text: job.artifacts.script,
          outFile: audioFile,
          voice: job.params.voice,
          onProgress: (p) => {
            if (typeof onProgress === 'function') {
              onProgress({ step: 'audio', phase: p.phase, fraction: p.fraction });
            }
          },
        });
        job.artifacts.audioFile = r.audioFile;
        job.artifacts.audioDurationSec = r.durationSec;
        job.artifacts.audioEngine = r.engine;
        job.artifacts.audioVoice = r.voice;
        // Per-sentence engines (Kokoro) return exact cue timings; stash them
        // so the subtitle step doesn't have to re-estimate from char counts.
        job.artifacts.audioCues = Array.isArray(r.cues) ? r.cues : null;
        break;
      }
      case 'subtitle': {
        if (!job.artifacts.audioFile) throw new Error('audio must be generated first');
        const subFile = path.join(_jobDir(jobId), 'subtitles.srt');
        writeSubtitles({
          script: job.artifacts.script,
          audioDurationSec: job.artifacts.audioDurationSec,
          outFile: subFile,
          cues: job.artifacts.audioCues || undefined,
        });
        job.artifacts.subtitlePath = subFile;
        break;
      }
      case 'materials': {
        if (!job.artifacts.terms || !job.artifacts.terms.length) throw new Error('terms must be generated first');
        if (!job.artifacts.audioDurationSec) throw new Error('audio duration unknown — run audio step first');
        const r = await gatherFootage({
          terms: job.artifacts.terms,
          audioDurationSec: job.artifacts.audioDurationSec,
          outDir: _jobDir(jobId),
          aspect: job.params.aspect,
          maxClipDuration: job.params.maxClipDuration,
          localFolder: job.params.localFolder,
          onProgress,
        });
        job.artifacts.footageSource = r.source;
        job.artifacts.clips = r.clips;
        break;
      }
      case 'render': {
        if (!job.artifacts.clips?.length) throw new Error('materials must be gathered first');
        if (!job.artifacts.audioFile) throw new Error('audio must be generated first');
        const finalPath = path.join(_jobDir(jobId), 'final.mp4');
        const r = await render({
          clips: job.artifacts.clips,
          jobDir: _jobDir(jobId),
          audioFile: job.artifacts.audioFile,
          audioDurationSec: job.artifacts.audioDurationSec,
          subtitlePath: job.artifacts.subtitlePath,
          bgmFile: job.params.bgmFile,
          aspect: job.params.aspect,
          maxClipDuration: job.params.maxClipDuration,
          outFile: finalPath,
          onProgress,
        });
        job.artifacts.combinedPath = r.combinedPath;
        job.artifacts.finalPath = r.finalPath;
        break;
      }
    }
    if (!job.stepsDone.includes(step)) job.stepsDone.push(step);
    job.state = 'idle';
    job.updatedAt = new Date().toISOString();
    _writeJob(job);
    _emit(jobId, { step, status: 'completed' });
    return job;
  } catch (e) {
    job.state = 'failed';
    job.error = { step, message: e.message };
    job.updatedAt = new Date().toISOString();
    _writeJob(job);
    _emit(jobId, { step, status: 'failed', error: e.message });
    throw e;
  }
}

/**
 * Run all remaining steps in sequence. Returns the final job state.
 */
export async function runAll(jobId, opts = {}) {
  for (const step of STEPS) {
    const job = _readJob(jobId);
    if (!job) throw new Error('job not found');
    if (job.stepsDone.includes(step)) continue;
    await runStep(jobId, step, opts);
  }
  return _readJob(jobId);
}

export { STEPS, INVALIDATES };
