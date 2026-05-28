// Stock image search + download — shared by every generator (websites, slide
// decks, docs, social posts, etc.) so any time the model wants imagery it can
// reach for whichever provider key the user has configured.
//
// Tiered fallback (first hit wins, but caller can ask to merge all):
//   1. Pexels   photos API   (free, requires key)
//   2. Unsplash photos API   (free, requires key)
//   3. Pixabay  photos API   (free, requires key)
//
// All providers return the same shape:
//   { url, thumb, width, height, photographer, sourceUrl, source, query }

import fs from 'fs';
import path from 'path';
import os from 'os';
import { pipeline } from 'stream/promises';

const KEYS_FILE = path.join(os.homedir(), '.config', 'fauna', 'provider-keys.json');

function _loadKey(provider) {
  try {
    const j = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));
    return j?.[provider] || j?.keys?.[provider] || null;
  } catch (_) { return null; }
}

function _orient(aspect) {
  if (aspect === 'portrait' || aspect === '9:16' || aspect === '3:4') return 'portrait';
  if (aspect === 'square'   || aspect === '1:1')                       return 'square';
  return 'landscape';
}

// ── Pexels ────────────────────────────────────────────────────────────────
export async function searchPexelsPhotos(query, { aspect = 'landscape', perPage = 12 } = {}) {
  const key = _loadKey('pexels');
  if (!key) return null;
  const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=${perPage}&orientation=${_orient(aspect)}`;
  const r = await fetch(url, { headers: { Authorization: key } });
  if (!r.ok) return null;
  const data = await r.json();
  return (data.photos || []).map(p => ({
    url:          p.src?.large2x || p.src?.large || p.src?.original,
    thumb:        p.src?.medium  || p.src?.small,
    width:        p.width  || 0,
    height:       p.height || 0,
    photographer: p.photographer || '',
    sourceUrl:    p.url || '',
    source:       'pexels',
    query,
  })).filter(x => x.url);
}

// ── Unsplash ──────────────────────────────────────────────────────────────
export async function searchUnsplashPhotos(query, { aspect = 'landscape', perPage = 12 } = {}) {
  const key = _loadKey('unsplash');
  if (!key) return null;
  const orient = _orient(aspect) === 'square' ? 'squarish' : _orient(aspect);
  const url = `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&per_page=${perPage}&orientation=${orient}`;
  const r = await fetch(url, { headers: { Authorization: `Client-ID ${key}` } });
  if (!r.ok) return null;
  const data = await r.json();
  return (data.results || []).map(p => ({
    url:          p.urls?.full    || p.urls?.regular,
    thumb:        p.urls?.small   || p.urls?.thumb,
    width:        p.width  || 0,
    height:       p.height || 0,
    photographer: p.user?.name || '',
    sourceUrl:    p.links?.html  || '',
    source:       'unsplash',
    query,
  })).filter(x => x.url);
}

// ── Pixabay ───────────────────────────────────────────────────────────────
export async function searchPixabayPhotos(query, { aspect = 'landscape', perPage = 12 } = {}) {
  const key = _loadKey('pixabay');
  if (!key) return null;
  const orient = _orient(aspect) === 'square' ? 'all'
               : _orient(aspect) === 'portrait' ? 'vertical' : 'horizontal';
  const url = `https://pixabay.com/api/?key=${encodeURIComponent(key)}&q=${encodeURIComponent(query)}&per_page=${perPage}&orientation=${orient}&image_type=photo&safesearch=true`;
  const r = await fetch(url);
  if (!r.ok) return null;
  const data = await r.json();
  return (data.hits || []).map(p => ({
    url:          p.largeImageURL || p.webformatURL,
    thumb:        p.previewURL    || p.webformatURL,
    width:        p.imageWidth  || 0,
    height:       p.imageHeight || 0,
    photographer: p.user || '',
    sourceUrl:    p.pageURL || '',
    source:       'pixabay',
    query,
  })).filter(x => x.url);
}

// ── Public: which providers does the user have keys for? ──────────────────
export function availableImageProviders() {
  const out = [];
  if (_loadKey('pexels'))   out.push('pexels');
  if (_loadKey('unsplash')) out.push('unsplash');
  if (_loadKey('pixabay'))  out.push('pixabay');
  return out;
}

// ── Public: search across providers with fallback ─────────────────────────
// mode:
//   'first' (default) — return the first provider that yields any results
//   'merge'           — concatenate results from every available provider
export async function searchStockImages(query, {
  aspect = 'landscape',
  count = 6,
  providers = null,    // explicit order; null → auto by available keys
  mode = 'first',
} = {}) {
  if (!query || typeof query !== 'string') {
    return { ok: false, error: 'query (string) required', results: [] };
  }
  const order = providers && providers.length ? providers : availableImageProviders();
  if (!order.length) {
    return {
      ok: false,
      error: 'no stock image provider key configured (Pexels, Unsplash, or Pixabay) — add one in Settings → Media Keys',
      results: [],
    };
  }
  const dispatchers = {
    pexels:   (q) => searchPexelsPhotos(q,   { aspect, perPage: Math.min(count, 80) }),
    unsplash: (q) => searchUnsplashPhotos(q, { aspect, perPage: Math.min(count, 30) }),
    pixabay:  (q) => searchPixabayPhotos(q,  { aspect, perPage: Math.min(count, 200) }),
  };
  const all = [];
  const tried = [];
  for (const name of order) {
    const fn = dispatchers[name];
    if (!fn) continue;
    tried.push(name);
    try {
      const items = await fn(query);
      if (Array.isArray(items) && items.length) {
        all.push(...items);
        if (mode === 'first') break;
      }
    } catch (_) { /* fall through to next provider */ }
  }
  return {
    ok: all.length > 0,
    providersTried: tried,
    results: all.slice(0, count),
  };
}

// ── Public: download images to a folder, return local paths ───────────────
export async function downloadStockImages(items, { destDir, prefix = 'img' } = {}) {
  if (!destDir) throw new Error('destDir required');
  fs.mkdirSync(destDir, { recursive: true });
  const out = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it?.url) continue;
    try {
      const r = await fetch(it.url);
      if (!r.ok) { out.push({ ...it, error: `HTTP ${r.status}` }); continue; }
      const ct = r.headers.get('content-type') || '';
      const ext = /png/i.test(ct) ? 'png' : /webp/i.test(ct) ? 'webp' : 'jpg';
      const safeName = `${prefix}-${String(i + 1).padStart(2, '0')}-${it.source}.${ext}`;
      const filePath = path.join(destDir, safeName);
      await pipeline(r.body, fs.createWriteStream(filePath));
      out.push({
        ...it,
        path: filePath,
        bytes: fs.statSync(filePath).size,
      });
    } catch (e) {
      out.push({ ...it, error: e.message });
    }
  }
  return out;
}
