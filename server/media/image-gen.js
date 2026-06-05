// AI image generation + editing via OpenAI's GPT Image models (Images API).
//
// Mirrors the structure of stock-images.js: the OpenAI key lives in the shared
// ~/.config/fauna/provider-keys.json (same place the LLM/Settings page writes
// it), and every generator can reach for this whenever it needs *original*
// imagery rather than stock photos.
//
// Unlike stock images these are model-generated, so results are written to disk
// as PNGs (the API returns base64) and surfaced via /api/serve-media?path=…
//
//   generateImage(prompt, opts)  → POST /v1/images/generations
//   editImage(opts)              → POST /v1/images/edits
//   availableImageGen()          → is the OpenAI key configured?

import fs from 'fs';
import path from 'path';
import os from 'os';
import OpenAI from 'openai';

const KEYS_FILE = path.join(os.homedir(), '.config', 'fauna', 'provider-keys.json');
const GLOBAL_OUT_DIR = path.join(os.homedir(), '.config', 'fauna', 'generated_images');

// gpt-image-1 is the default: it supports native transparent backgrounds, the
// low/medium/high/auto quality tiers, and 1024² / portrait / landscape sizes.
const DEFAULT_MODEL = 'gpt-image-1';
const ALLOWED_SIZES = ['1024x1024', '1536x1024', '1024x1536', 'auto'];
const ALLOWED_QUALITY = ['low', 'medium', 'high', 'auto'];
const ALLOWED_BACKGROUND = ['transparent', 'opaque', 'auto'];

function _loadKey(provider) {
  try {
    const j = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));
    return j?.[provider] || j?.keys?.[provider] || null;
  } catch (_) { return null; }
}

function _client() {
  const key = _loadKey('openai');
  if (!key) return null;
  return new OpenAI({ apiKey: key, timeout: 5 * 60 * 1000 });
}

// ── Public: is the OpenAI key configured? ─────────────────────────────────
export function availableImageGen() {
  return !!_loadKey('openai');
}

function _slug(s) {
  return String(s || 'image')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'image';
}

function _normSize(size) {
  if (!size) return 'auto';
  const s = String(size).toLowerCase();
  return ALLOWED_SIZES.includes(s) ? s : 'auto';
}
function _normQuality(q) {
  if (!q) return 'auto';
  const s = String(q).toLowerCase();
  return ALLOWED_QUALITY.includes(s) ? s : 'auto';
}
function _normBackground(b) {
  if (!b) return 'auto';
  const s = String(b).toLowerCase();
  return ALLOWED_BACKGROUND.includes(s) ? s : 'auto';
}

// Write a base64 PNG to disk and return its path + serve URL.
function _writePng(b64, destDir, baseName, index) {
  fs.mkdirSync(destDir, { recursive: true });
  const ts = Date.now();
  const name = `${ts}-${baseName}${index != null ? `-${index + 1}` : ''}.png`;
  const filePath = path.join(destDir, name);
  fs.writeFileSync(filePath, Buffer.from(b64, 'base64'));
  return {
    path: filePath,
    url: '/api/serve-media?path=' + encodeURIComponent(filePath),
    bytes: fs.statSync(filePath).size,
  };
}

function _resolveDestDir(destDir) {
  if (!destDir) return GLOBAL_OUT_DIR;
  return destDir.startsWith('~') ? path.join(os.homedir(), destDir.slice(1)) : destDir;
}

// ── Public: generate one or more images from a text prompt ────────────────
export async function generateImage(prompt, {
  model = DEFAULT_MODEL,
  size = 'auto',
  quality = 'auto',
  background = 'auto',
  count = 1,
  destDir = null,
} = {}) {
  if (!prompt || typeof prompt !== 'string') {
    return { ok: false, error: 'prompt (string) required', results: [] };
  }
  const client = _client();
  if (!client) {
    return { ok: false, error: 'no OpenAI key configured — add it in Settings → Authentication → API Keys (OpenAI)', results: [] };
  }
  const n = Math.max(1, Math.min(Number(count) || 1, 4));
  const payload = {
    model,
    prompt,
    n,
    size: _normSize(size),
    quality: _normQuality(quality),
  };
  const bg = _normBackground(background);
  if (bg === 'transparent') payload.background = 'transparent';

  let resp;
  try {
    resp = await client.images.generate(payload);
  } catch (e) {
    return { ok: false, error: e?.message || String(e), results: [] };
  }
  const dir = _resolveDestDir(destDir);
  const base = _slug(prompt);
  const results = [];
  (resp?.data || []).forEach((d, i) => {
    if (!d?.b64_json) return;
    const w = _writePng(d.b64_json, dir, base, n > 1 ? i : null);
    results.push({ ...w, revisedPrompt: d.revised_prompt || null });
  });
  return {
    ok: results.length > 0,
    model,
    size: payload.size,
    quality: payload.quality,
    background: bg,
    destDir: dir,
    results,
  };
}

// ── Public: edit / inpaint an existing image with a text prompt ───────────
export async function editImage({
  imagePath,
  prompt,
  maskPath = null,
  model = DEFAULT_MODEL,
  size = 'auto',
  quality = 'auto',
  destDir = null,
} = {}) {
  if (!imagePath || typeof imagePath !== 'string') {
    return { ok: false, error: 'imagePath (string) required', results: [] };
  }
  if (!prompt || typeof prompt !== 'string') {
    return { ok: false, error: 'prompt (string) required', results: [] };
  }
  const srcAbs = imagePath.startsWith('~') ? path.join(os.homedir(), imagePath.slice(1)) : imagePath;
  if (!fs.existsSync(srcAbs)) {
    return { ok: false, error: `image not found: ${srcAbs}`, results: [] };
  }
  const client = _client();
  if (!client) {
    return { ok: false, error: 'no OpenAI key configured — add it in Settings → Authentication → API Keys (OpenAI)', results: [] };
  }
  const payload = {
    model,
    prompt,
    image: fs.createReadStream(srcAbs),
    size: _normSize(size),
    quality: _normQuality(quality),
  };
  if (maskPath) {
    const maskAbs = maskPath.startsWith('~') ? path.join(os.homedir(), maskPath.slice(1)) : maskPath;
    if (!fs.existsSync(maskAbs)) {
      return { ok: false, error: `mask not found: ${maskAbs}`, results: [] };
    }
    payload.mask = fs.createReadStream(maskAbs);
  }

  let resp;
  try {
    resp = await client.images.edit(payload);
  } catch (e) {
    return { ok: false, error: e?.message || String(e), results: [] };
  }
  const dir = _resolveDestDir(destDir);
  const base = _slug(prompt) + '-edit';
  const results = [];
  (resp?.data || []).forEach((d, i) => {
    if (!d?.b64_json) return;
    const w = _writePng(d.b64_json, dir, base, null);
    results.push({ ...w, revisedPrompt: d.revised_prompt || null });
  });
  return {
    ok: results.length > 0,
    model,
    source: srcAbs,
    destDir: dir,
    results,
  };
}
