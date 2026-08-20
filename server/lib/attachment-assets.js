import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const MIME_EXTENSIONS = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/avif': '.avif',
};

function safeSegment(value, fallback = 'image') {
  const normalized = String(value || '')
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return normalized || fallback;
}

function sourcePathForImage(image) {
  const direct = typeof image?.path === 'string' ? image.path.trim() : '';
  if (direct && path.isAbsolute(direct)) return direct;
  const uri = typeof image?.sourceUri === 'string' ? image.sourceUri.trim() : '';
  if (uri.startsWith('file://')) {
    try { return fileURLToPath(uri); } catch (_) {}
  }
  return '';
}

function imageBytes(image) {
  const sourcePath = sourcePathForImage(image);
  if (sourcePath) {
    try {
      const stat = fs.statSync(sourcePath);
      if (stat.isFile()) return { bytes: fs.readFileSync(sourcePath), sourcePath };
    } catch (_) {}
  }
  if (typeof image?.base64 !== 'string' || !image.base64) return null;
  try {
    return { bytes: Buffer.from(image.base64, 'base64'), sourcePath: '' };
  } catch (_) {
    return null;
  }
}

function assetRoot({ projectRoot, conversationId } = {}) {
  if (projectRoot && path.isAbsolute(projectRoot)) {
    return path.join(projectRoot, '.fauna', 'assets', 'uploads');
  }
  return path.join(
    os.homedir(),
    '.config',
    'fauna',
    'assets',
    safeSegment(conversationId, 'unscoped'),
  );
}

export function persistConversationImageAssets(messages, options = {}) {
  const root = assetRoot(options);
  const assets = [];
  const seen = new Set();

  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.role !== 'user' || !Array.isArray(message.images)) continue;
    for (const image of message.images) {
      const payload = imageBytes(image);
      if (!payload?.bytes?.length) continue;
      const hash = crypto.createHash('sha256').update(payload.bytes).digest('hex').slice(0, 12);
      if (seen.has(hash)) continue;
      seen.add(hash);

      const originalName = safeSegment(image.name, 'image');
      const parsed = path.parse(originalName);
      const extension = parsed.ext || MIME_EXTENSIONS[String(image.mime || '').toLowerCase()] || '.png';
      const filename = `${safeSegment(parsed.name, 'image')}-${hash}${extension.toLowerCase()}`;
      const absolutePath = path.join(root, filename);
      fs.mkdirSync(root, { recursive: true });
      if (!fs.existsSync(absolutePath)) fs.writeFileSync(absolutePath, payload.bytes);

      assets.push({
        name: image.name || filename,
        mime: image.mime || 'image/png',
        absolutePath,
        relativePath: options.projectRoot && path.isAbsolute(options.projectRoot)
          ? path.relative(options.projectRoot, absolutePath)
          : null,
        sourcePath: payload.sourcePath || null,
        sha256: hash,
      });
    }
  }
  return assets;
}

export function formatImageAssetContext(assets) {
  if (!Array.isArray(assets) || !assets.length) return '';
  const rows = assets.map((asset, index) => {
    const relative = asset.relativePath ? `; project-relative: ${asset.relativePath}` : '';
    return `${index + 1}. ${asset.name}: ${asset.absolutePath}${relative}`;
  }).join('\n');
  return `\n## User Image Assets\n${rows}\n\n` +
    'These are durable local files, not disposable visual hints. For personal posters, invitations, covers, and similar compositions, treat an attached photo as an EXACT ASSET by default: use the listed file in the final artifact and preserve the person\'s identity. Do not redraw, regenerate, replace, or omit it unless the user explicitly calls it a style reference. When the user says an image is visual direction or inspiration, use it only as a reference. Before claiming completion, verify the rendered artifact visibly contains every required exact asset.';
}