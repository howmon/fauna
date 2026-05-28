// Footage — resolves stock video clips for the requested search terms.
//
// Tiered resolution, first match wins:
//   1. Pexels API    (free tier, requires key)
//   2. Pixabay API   (free tier, requires key)
//   3. Unsplash API  (photos only, ken-burns'd into 5s clips via ffmpeg)
//   4. Browser-extension scrape (zero key required — drives the user's browser
//      to pexels.com / pixabay.com and harvests <video> URLs from the DOM)
//   5. Local folder  (point at any directory of mp4s)
//
// Each tier emits the same {url, duration, width, height, source} shape.
// Downloaded clips are saved under <jobDir>/materials/ as mp4.

import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import { pipeline } from 'stream/promises';
import { FFMPEG_PATH } from './ffmpeg-path.js';

const PEXELS_KEYS_FILE = path.join(os.homedir(), '.config', 'fauna', 'provider-keys.json');

function _loadKey(provider) {
  try {
    const j = JSON.parse(fs.readFileSync(PEXELS_KEYS_FILE, 'utf8'));
    return j?.[provider] || j?.keys?.[provider] || null;
  } catch (_) { return null; }
}

function _aspectFor(target) {
  // target like '9:16' (portrait) or '16:9' (landscape)
  if (target === '9:16') return { orient: 'portrait', minW: 1080, minH: 1920 };
  if (target === '16:9') return { orient: 'landscape', minW: 1920, minH: 1080 };
  if (target === '1:1')  return { orient: 'square', minW: 1080, minH: 1080 };
  return { orient: 'landscape', minW: 1280, minH: 720 };
}

// ── Tier 1: Pexels API ────────────────────────────────────────────────────
export async function searchPexels(term, { aspect = '9:16', perPage = 15, apiKey } = {}) {
  const key = apiKey || _loadKey('pexels');
  if (!key) return null;
  const { orient, minW, minH } = _aspectFor(aspect);
  const url = `https://api.pexels.com/videos/search?query=${encodeURIComponent(term)}&per_page=${perPage}&orientation=${orient}`;
  const r = await fetch(url, { headers: { Authorization: key } });
  if (!r.ok) return null;
  const data = await r.json();
  const items = [];
  for (const v of data.videos || []) {
    // Pexels returns multiple renditions per video; pick the smallest that meets min.
    const candidates = (v.video_files || [])
      .filter(f => f.width >= minW && f.height >= minH && /mp4/i.test(f.file_type || ''))
      .sort((a, b) => (a.width * a.height) - (b.width * b.height));
    if (!candidates.length) continue;
    const pick = candidates[0];
    items.push({
      url: pick.link,
      duration: v.duration || 0,
      width: pick.width,
      height: pick.height,
      source: 'pexels-api',
    });
  }
  return items;
}

// ── Tier 2: Pixabay API ───────────────────────────────────────────────────
export async function searchPixabay(term, { aspect = '9:16', perPage = 15, apiKey } = {}) {
  const key = apiKey || _loadKey('pixabay');
  if (!key) return null;
  const { minW, minH } = _aspectFor(aspect);
  const url = `https://pixabay.com/api/videos/?key=${encodeURIComponent(key)}&q=${encodeURIComponent(term)}&per_page=${perPage}&video_type=film`;
  const r = await fetch(url);
  if (!r.ok) return null;
  const data = await r.json();
  const items = [];
  for (const v of data.hits || []) {
    const tiers = v.videos || {};
    const order = ['large', 'medium', 'small', 'tiny'];
    let pick = null;
    for (const k of order) {
      const t = tiers[k];
      if (!t || !t.url) continue;
      if (t.width >= minW && t.height >= minH) { pick = t; break; }
    }
    if (!pick) pick = tiers.large || tiers.medium || tiers.small || null;
    if (!pick) continue;
    items.push({
      url: pick.url,
      duration: v.duration || 0,
      width: pick.width,
      height: pick.height,
      source: 'pixabay-api',
    });
  }
  return items;
}

// ── Tier 3: Unsplash API (photos → ken-burns clips) ─────────────────────
export async function searchUnsplash(term, { aspect = '9:16', perPage = 15, apiKey } = {}) {
  const key = apiKey || _loadKey('unsplash');
  if (!key) return null;
  const { orient } = _aspectFor(aspect);
  const orientation = orient === 'square' ? 'squarish' : orient;
  const url = `https://api.unsplash.com/search/photos?query=${encodeURIComponent(term)}&per_page=${perPage}&orientation=${orientation}`;
  const r = await fetch(url, { headers: { Authorization: `Client-ID ${key}` } });
  if (!r.ok) return null;
  const data = await r.json();
  const items = [];
  for (const p of data.results || []) {
    const src = p.urls?.full || p.urls?.regular;
    if (!src) continue;
    items.push({
      url: src,
      duration: 0,
      width: p.width || 0,
      height: p.height || 0,
      source: 'unsplash-api',
      _photo: true,        // signals downloadClip to ken-burns into mp4
    });
  }
  return items;
}

// ── Tier 4: Browser-extension scrape ─────────────────────────────────────────────
// Uses the /api/ext/command endpoint to drive an already-connected extension.
// Returns null if no extension is connected — caller falls through to tier 4.

const PEXELS_EXTRACT_JS = `
(() => {
  const urls = new Set();
  const items = [];
  // Pexels embeds preview/source URLs in <video> tags + JSON in __NEXT_DATA__.
  document.querySelectorAll('video source, video').forEach(v => {
    const src = v.src || v.getAttribute('src') || (v.querySelector && v.querySelector('source')?.src);
    if (src && src.includes('.mp4') && !urls.has(src)) {
      urls.add(src);
      items.push({ url: src, duration: 0, width: parseInt(v.videoWidth)||0, height: parseInt(v.videoHeight)||0 });
    }
  });
  // Best-effort: read Next.js initial props for additional candidates.
  try {
    const nd = document.getElementById('__NEXT_DATA__');
    if (nd) {
      const j = JSON.parse(nd.textContent);
      const stack = [j]; let depth = 0;
      while (stack.length && depth < 500) {
        const n = stack.pop(); depth++;
        if (!n || typeof n !== 'object') continue;
        if (typeof n.link === 'string' && n.link.includes('.mp4') && !urls.has(n.link)) {
          urls.add(n.link);
          items.push({ url: n.link, duration: n.duration || 0, width: n.width || 0, height: n.height || 0 });
        }
        for (const k of Object.keys(n)) {
          const v = n[k]; if (v && typeof v === 'object') stack.push(v);
        }
      }
    }
  } catch (e) {}
  return items.slice(0, 20);
})()
`;

async function _extEval({ port = 3737, script, navigateUrl, timeout = 25000 }) {
  if (navigateUrl) {
    const navRes = await fetch(`http://localhost:${port}/api/ext/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'navigate', params: { url: navigateUrl }, timeout: 15000 }),
    });
    const nav = await navRes.json();
    if (!nav?.ok) return null;
    // Give the SPA a moment to hydrate <video> tags.
    await new Promise(r => setTimeout(r, 2500));
  }
  const r = await fetch(`http://localhost:${port}/api/ext/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'eval', params: { script }, timeout }),
  });
  const data = await r.json();
  if (!data?.ok) return null;
  return data.result ?? data.value ?? data;
}

export async function searchExtensionScrape(term, { aspect = '9:16', port = 3737 } = {}) {
  const { orient } = _aspectFor(aspect);
  const url = `https://www.pexels.com/search/videos/${encodeURIComponent(term)}/?orientation=${orient}`;
  try {
    const items = await _extEval({ port, navigateUrl: url, script: PEXELS_EXTRACT_JS });
    if (!Array.isArray(items) || !items.length) return null;
    return items.map(i => ({ ...i, source: 'ext-scrape' }));
  } catch (_) { return null; }
}

// ── Tier 5: Local folder ──────────────────────────────────────────────────────
export function searchLocal(_term, { folder } = {}) {
  if (!folder) return null;
  try {
    const files = fs.readdirSync(folder)
      .filter(f => /\.(mp4|mov|webm|mkv)$/i.test(f))
      .map(f => ({ url: 'file://' + path.join(folder, f), duration: 0, width: 0, height: 0, source: 'local' }));
    return files.length ? files : null;
  } catch (_) { return null; }
}

// ── Resolver — find the first working tier ────────────────────────────────
export async function resolveTier({ aspect = '9:16', localFolder, port = 3737 } = {}) {
  if (_loadKey('pexels')) return { name: 'pexels-api', search: (t) => searchPexels(t, { aspect }) };
  if (_loadKey('pixabay')) return { name: 'pixabay-api', search: (t) => searchPixabay(t, { aspect }) };  if (_loadKey('unsplash')) return { name: 'unsplash-api', search: (t) => searchUnsplash(t, { aspect }) };  // Probe extension availability.
  try {
    const r = await fetch(`http://localhost:${port}/api/ext/status`);
    const j = await r.json();
    if (j?.browsers?.length) return { name: 'ext-scrape', search: (t) => searchExtensionScrape(t, { aspect, port }) };
  } catch (_) {}
  if (localFolder) return { name: 'local', search: (t) => searchLocal(t, { folder: localFolder }) };
  return null;
}

// ── Download ──────────────────────────────────────────────────────────────
export async function downloadClip(url, outFile, opts = {}) {
  if (url.startsWith('file://')) {
    const src = url.replace(/^file:\/\//, '');
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.copyFileSync(src, outFile);
    return { path: outFile, bytes: fs.statSync(outFile).size };
  }
  // Photo source (Unsplash) — download still then ken-burns into mp4.
  if (opts.photo) {
    return _downloadPhotoAsClip(url, outFile, opts);
  }
  const r = await fetch(url, { headers: { Referer: 'https://www.pexels.com/' } });
  if (!r.ok) throw new Error(`Download failed ${r.status} for ${url}`);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const ws = fs.createWriteStream(outFile);
  await pipeline(r.body, ws);
  return { path: outFile, bytes: fs.statSync(outFile).size };
}

// Ken-burns: still photo → slow-zoom mp4 clip.
// Output dims follow aspect; clip is `durationSec` long at 30fps with a subtle
// 1.0 → 1.15 zoom so the result blends seamlessly with real footage.
async function _downloadPhotoAsClip(url, outFile, { aspect = '9:16', durationSec = 5 } = {}) {
  const { minW: W, minH: H } = _aspectFor(aspect);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const tmpJpg = outFile.replace(/\.mp4$/, '') + '.src.jpg';
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Photo download failed ${r.status}`);
  await pipeline(r.body, fs.createWriteStream(tmpJpg));

  const fps = 30;
  const frames = Math.round(durationSec * fps);
  // zoompan needs a large source to avoid jitter — upscale first.
  const vf = [
    `scale=${W * 4}:${H * 4}:force_original_aspect_ratio=increase`,
    `crop=${W * 4}:${H * 4}`,
    `zoompan=z='min(zoom+0.0008,1.15)':d=${frames}:s=${W}x${H}:fps=${fps}`,
    'setsar=1',
  ].join(',');

  await new Promise((resolve, reject) => {
    const args = [
      '-y', '-loop', '1', '-framerate', String(fps),
      '-i', tmpJpg,
      '-vf', vf,
      '-t', String(durationSec),
      '-pix_fmt', 'yuv420p',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
      '-an',
      outFile,
    ];
    const p = spawn(FFMPEG_PATH, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', d => { err += d.toString(); });
    p.on('close', code => {
      try { fs.unlinkSync(tmpJpg); } catch (_) {}
      if (code === 0) resolve(); else reject(new Error('ffmpeg ken-burns failed: ' + err.slice(-400)));
    });
    p.on('error', reject);
  });
  return { path: outFile, bytes: fs.statSync(outFile).size };
}

/**
 * Top-level: given search terms + target audio duration, return a list of
 * downloaded local mp4 paths sufficient to cover the audio when concatenated.
 *
 * @param {object} args
 * @param {string[]} args.terms
 * @param {number}   args.audioDurationSec
 * @param {string}   args.outDir
 * @param {string}   [args.aspect='9:16']
 * @param {number}   [args.maxClipDuration=5]
 * @param {string}   [args.localFolder]
 * @param {number}   [args.port=3737]
 * @param {function} [args.onProgress]  (msg) => void
 */
export async function gatherFootage({ terms, audioDurationSec, outDir, aspect = '9:16', maxClipDuration = 5, localFolder, port = 3737, onProgress }) {
  const tier = await resolveTier({ aspect, localFolder, port });
  if (!tier) {
    throw new Error('No footage source available. Add a Pexels, Pixabay, or Unsplash key under Settings → BYO Keys, connect the Fauna browser extension, or set a local clips folder.');
  }
  onProgress?.(`Using ${tier.name} for footage`);

  // We need enough clip-seconds to cover audio_duration. With maxClipDuration=5,
  // a 30s video needs ~6 clips. Round up + 2 for variety.
  const needed = Math.ceil(audioDurationSec / Math.max(1, maxClipDuration)) + 2;
  const downloaded = [];
  const seenUrls = new Set();

  const matsDir = path.join(outDir, 'materials');
  fs.mkdirSync(matsDir, { recursive: true });

  let termIdx = 0;
  while (downloaded.length < needed && termIdx < terms.length * 3) {
    const term = terms[termIdx % terms.length];
    termIdx++;
    let candidates;
    try {
      candidates = await tier.search(term);
    } catch (e) {
      onProgress?.(`Search failed for "${term}": ${e.message}`);
      continue;
    }
    if (!candidates || !candidates.length) continue;
    for (const cand of candidates) {
      if (downloaded.length >= needed) break;
      if (seenUrls.has(cand.url)) continue;
      seenUrls.add(cand.url);
      const filename = `clip-${String(downloaded.length + 1).padStart(2, '0')}.mp4`;
      const outPath = path.join(matsDir, filename);
      try {
        onProgress?.(`Downloading clip ${downloaded.length + 1}/${needed} (${term})`);
        await downloadClip(cand.url, outPath, { photo: !!cand._photo, aspect, durationSec: maxClipDuration });
        downloaded.push({ path: outPath, source: cand.source, term });
      } catch (e) {
        onProgress?.(`Skipping ${cand.url}: ${e.message}`);
      }
    }
  }

  if (!downloaded.length) {
    throw new Error(`Could not download any clips (tier: ${tier.name}). Check connectivity and search terms.`);
  }
  return { source: tier.name, clips: downloaded };
}
