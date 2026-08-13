// ── AI watermark inspector + cleaner ────────────────────────────────────
// Layer A: deterministic invisible-Unicode / space-homoglyph scrub.
// Layer B (statistical rewrite) is handled by the agent via LLM — no code here.
// File metadata: text-based formats handled natively; EXIF/C2PA deferred to
// exiftool / c2patool when available on PATH.
//
// Ported from guillaumemeyer/watermarks-remover (MIT).
// inspectText(text, opts?) → TextInspectReport
// cleanText(text, opts?) → { cleaned, stats }
// inspectFile(filePath) → FileInspectReport
// cleanFile(filePath, outputPath, opts?) → FileCleanResult

import { execFile } from 'node:child_process';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

// ── Layer A codepoint tables ─────────────────────────────────────────────

// Invisible format/control characters used as steganographic carriers.
const STRIP_SET = new Set([
  0x00AD, // soft hyphen
  0x034F, // combining grapheme joiner
  0x061C, // Arabic letter mark
  0x115F, 0x1160, // Hangul fillers
  0x17B4, 0x17B5, // Khmer vowel inherent
  0x180B, 0x180C, 0x180D, // Mongolian FVS 1-3
  0x180E, // Mongolian vowel separator
  0x200B, // ZWSP
  0x200C, // ZWNJ
  0x200D, // ZWJ
  0x200E, // LRM
  0x200F, // RLM
  0x202A, 0x202B, 0x202C, 0x202D, 0x202E, // LRE/RLE/PDF/LRO/RLO
  0x2060, // word joiner
  0x2061, 0x2062, 0x2063, 0x2064, // invisible math
  0x2066, 0x2067, 0x2068, 0x2069, // LRI/RLI/FSI/PDI
  0x206A, 0x206B, 0x206C, 0x206D, 0x206E, 0x206F, // inhibit symmetric swapping
  0xFEFF, // BOM / ZWNBSP
  // FE00–FE0F variation selectors
  ...Array.from({ length: 16 }, (_, i) => 0xFE00 + i),
  // FFF9–FFFB interlinear annotation
  0xFFF9, 0xFFFA, 0xFFFB,
]);

// Space lookalikes that visually substitute for U+0020.
const SPACE_MAP = new Map([
  [0x00A0, ' '], [0x1680, ' '], [0x2000, ' '], [0x2001, ' '],
  [0x2002, ' '], [0x2003, ' '], [0x2004, ' '], [0x2005, ' '],
  [0x2006, ' '], [0x2007, ' '], [0x2008, ' '], [0x2009, ' '],
  [0x200A, ' '], [0x202F, ' '], [0x205F, ' '], [0x3000, ' '],
]);

// Cyrillic / fullwidth Latin confusables → ASCII (aggressive mode only).
const CONFUSABLE_MAP = new Map([
  [0x0410, 'A'], [0x0412, 'B'], [0x0415, 'E'], [0x041A, 'K'],
  [0x041C, 'M'], [0x041D, 'H'], [0x041E, 'O'], [0x0420, 'P'],
  [0x0421, 'C'], [0x0422, 'T'], [0x0425, 'X'],
  [0x0430, 'a'], [0x0435, 'e'], [0x043E, 'o'], [0x0440, 'p'],
  [0x0441, 'c'], [0x0443, 'y'], [0x0445, 'x'], [0x0456, 'i'],
  // fullwidth A–Z / a–z
  ...Array.from({ length: 26 }, (_, i) => [0xFF21 + i, String.fromCharCode(65 + i)]),
  ...Array.from({ length: 26 }, (_, i) => [0xFF41 + i, String.fromCharCode(97 + i)]),
]);

// Emoji presentation selectors / ZWJ: invisible when free-floating but
// structurally part of emoji sequences — preserve unless stripEmojiGlue=true.
const EMOJI_GLUE = new Set([0x200D, 0xFE0E, 0xFE0F]);

function isStripCp(cp) {
  if (STRIP_SET.has(cp)) return true;
  if (cp >= 0xE0001 && cp <= 0xE007F) return true; // Unicode tag chars
  if (cp >= 0xE0100 && cp <= 0xE01EF) return true; // VS17–VS256 supplement
  return false;
}

function isEmojiBase(cp) {
  if (cp >= 0x1F000 && cp <= 0x1FAFF) return true;
  if (cp >= 0x2600 && cp <= 0x27BF) return true;
  if (cp >= 0x2B00 && cp <= 0x2BFF) return true;
  if (cp === 0x00A9 || cp === 0x00AE || cp === 0x2122) return true;
  if (cp === 0x0023 || cp === 0x002A || (cp >= 0x0030 && cp <= 0x0039)) return true;
  return false;
}

function stripKind(cp) {
  if (cp >= 0xE0001 && cp <= 0xE007F) return 'tag_chars';
  if ((cp >= 0xE0100 && cp <= 0xE01EF) || (cp >= 0xFE00 && cp <= 0xFE0F)) return 'variation_selector';
  if ([0x061C, 0x200E, 0x200F, 0x202A, 0x202B, 0x202C, 0x202D, 0x202E, 0x2066, 0x2067, 0x2068, 0x2069].includes(cp)) return 'bidi';
  if ([0x200B, 0x200C, 0x200D, 0x2060, 0xFEFF, 0x180E].includes(cp)) return 'zwj_family';
  return 'strip';
}

function hitConfidence(kind) {
  return kind === 'space' ? 'informational' : 'probable';
}

// Classify one codepoint: returns { action: 'keep'|'strip'|'replace', out, kind }
function decideChar(cp, prevKeptCp, { normalizeSpaces = true, treatConfusables = false, stripEmojiGlue = false } = {}) {
  if (EMOJI_GLUE.has(cp) && !stripEmojiGlue) {
    if (prevKeptCp !== null && isEmojiBase(prevKeptCp)) {
      return { action: 'keep', out: String.fromCodePoint(cp), kind: null };
    }
  }
  if (isStripCp(cp)) return { action: 'strip', out: '', kind: stripKind(cp) };
  if (normalizeSpaces && SPACE_MAP.has(cp)) return { action: 'replace', out: SPACE_MAP.get(cp), kind: 'space' };
  if (treatConfusables && CONFUSABLE_MAP.has(cp)) return { action: 'replace', out: CONFUSABLE_MAP.get(cp), kind: 'confusable' };
  // Other format/control chars (Cf category) not covered above
  // We check against known ranges rather than importing unicodedata.
  // Cf chars beyond our explicit tables: skip — false-positive risk is high.
  return { action: 'keep', out: String.fromCodePoint(cp), kind: null };
}

// ── Public Layer A API ───────────────────────────────────────────────────

/**
 * Inspect text for Layer A invisible-Unicode / space-homoglyph carriers.
 * Returns { length, suspiciousTotal, hits, notes }.
 */
export function inspectText(text, { aggressive = false, stripEmojiGlue = false } = {}) {
  const buckets = new Map(); // Map<`${cp}:${kind}`, {cp, kind, offsets[]}>
  let prevKeptCp = null;

  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i);
    const charLen = cp > 0xFFFF ? 2 : 1;
    const { action, out, kind } = decideChar(cp, prevKeptCp, {
      normalizeSpaces: true,
      treatConfusables: aggressive,
      stripEmojiGlue,
    });
    if (kind !== null) {
      const key = `${cp}:${kind}`;
      if (!buckets.has(key)) buckets.set(key, { cp, kind, offsets: [] });
      buckets.get(key).offsets.push(i);
    } else if (action === 'keep' && !EMOJI_GLUE.has(cp)) {
      prevKeptCp = cp;
    }
    if (action === 'replace') prevKeptCp = cp;
    i += charLen;
  }

  const hits = [];
  let total = 0;
  for (const { cp, kind, offsets } of [...buckets.values()].sort((a, b) => b.offsets.length - a.offsets.length)) {
    hits.push({
      codepoint: `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`,
      label: `U+${cp.toString(16).toUpperCase().padStart(4, '0')} (${kind})`,
      count: offsets.length,
      kind,
      confidence: hitConfidence(kind),
      sampleOffsets: offsets.slice(0, 10),
    });
    total += offsets.length;
  }

  const notes = [
    'Layer A only: invisible/format Unicode and space homoglyphs (edit-based carriers).',
    'Statistical (token-sampling) watermarks are not detectable here; use Layer B rewrite.',
  ];
  if (!hits.length) {
    notes.push('No deterministic Layer A carriers detected. Statistical and pixel-domain marks are out of scope here.');
  }

  return { length: text.length, suspiciousTotal: total, hits, notes };
}

/**
 * Strip Layer A carriers from text.
 * Returns { cleaned, stats }.
 */
export function cleanText(text, { nfkc = false, aggressiveHomoglyphs = false, normalizeSpaces = true, stripEmojiGlue = false } = {}) {
  const removed = {};
  const replaced = {};
  const out = [];
  let prevKeptCp = null;

  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i);
    const charLen = cp > 0xFFFF ? 2 : 1;
    const { action, out: outChar, kind } = decideChar(cp, prevKeptCp, {
      normalizeSpaces,
      treatConfusables: aggressiveHomoglyphs,
      stripEmojiGlue,
    });
    if (action === 'keep') {
      out.push(outChar);
      if (!EMOJI_GLUE.has(cp)) prevKeptCp = cp;
    } else if (action === 'replace') {
      out.push(outChar);
      const label = `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
      replaced[label] = (replaced[label] || 0) + 1;
      prevKeptCp = cp;
    } else {
      const label = `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
      removed[label] = (removed[label] || 0) + 1;
    }
    i += charLen;
  }

  let result = out.join('');
  if (nfkc) result = result.normalize('NFKC');

  return {
    cleaned: result,
    stats: {
      inputLength: text.length,
      outputLength: result.length,
      removedCount: Object.values(removed).reduce((s, n) => s + n, 0),
      replacedCount: Object.values(replaced).reduce((s, n) => s + n, 0),
      removed,
      replaced,
    },
  };
}

// ── File-level inspect / clean ───────────────────────────────────────────

const TEXT_EXTS = new Set(['.txt', '.md', '.mdx', '.markdown', '.rst', '.csv', '.json', '.ts', '.js', '.py', '.java', '.c', '.cpp', '.go', '.rs', '.rb']);
const MAX_FILE_BYTES = 256 * 1024 * 1024; // 256 MiB

/**
 * Inspect a file for AI provenance marks.
 * Handles: text/md (Layer A), SVG, HTML, PNG (C2PA chunks).
 * Returns { ok, format, findings, notes }.
 */
export async function inspectFile(filePath) {
  if (!existsSync(filePath)) return { ok: false, error: `File not found: ${filePath}` };
  const ext = path.extname(filePath).toLowerCase();
  const findings = [];
  const notes = [];

  try {
    if (ext === '.png') {
      return await inspectPng(filePath, findings, notes);
    } else if (ext === '.svg') {
      const text = await readTextFile(filePath);
      if (/<metadata\b/i.test(text)) findings.push({ type: 'SVG <metadata> block', confidence: 'informational' });
      if (/x:xmpmeta|rdf:RDF|xmp:CreatorTool/i.test(text)) findings.push({ type: 'XMP packet in SVG', confidence: 'probable' });
      // Layer A on the text body
      const report = inspectText(text);
      if (report.suspiciousTotal > 0) findings.push(...report.hits.map(h => ({ type: `Layer A: ${h.label}`, confidence: h.confidence, count: h.count })));
    } else if (ext === '.html' || ext === '.htm') {
      const text = await readTextFile(filePath);
      findHtmlAiMarkers(text, findings);
      const report = inspectText(text);
      if (report.suspiciousTotal > 0) findings.push(...report.hits.map(h => ({ type: `Layer A: ${h.label}`, confidence: h.confidence, count: h.count })));
    } else if (ext === '.pdf' || ext === '.jpg' || ext === '.jpeg' || ext === '.docx' || ext === '.odt') {
      // Binary / structured formats — delegate to exiftool if available.
      await inspectWithExiftool(filePath, findings, notes);
    } else {
      // Plain text / code / markdown
      const text = await readTextFile(filePath);
      if (ext === '.md' || ext === '.mdx' || ext === '.markdown') {
        findMarkdownAiKeys(text, findings);
      }
      const report = inspectText(text);
      if (report.suspiciousTotal > 0) findings.push(...report.hits.map(h => ({ type: `Layer A: ${h.label}`, confidence: h.confidence, count: h.count })));
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }

  // Check c2patool if available (any format)
  await checkC2pa(filePath, findings, notes);

  return { ok: true, format: ext || 'text', findings, notes };
}

/**
 * Clean a file, stripping Layer A carriers and provenance metadata.
 * Returns { ok, outputPath, stats, findings }.
 */
export async function cleanFile(filePath, outputPath, opts = {}) {
  if (!existsSync(filePath)) return { ok: false, error: `File not found: ${filePath}` };
  const ext = path.extname(filePath).toLowerCase();
  const out = outputPath || filePath.replace(/(\.[^.]+)$/, '.cleaned$1');

  try {
    if (ext === '.png') {
      return await cleanPng(filePath, out);
    } else if (ext === '.svg') {
      let text = await readTextFile(filePath);
      const before = text;
      text = text.replace(/<metadata\b[\s\S]*?<\/metadata>/gi, '');
      text = stripXmpBlocks(text);
      const { cleaned, stats } = cleanText(text, opts);
      await writeFile(out, cleaned, 'utf8');
      return { ok: true, outputPath: out, stats, metadataStripped: text !== before };
    } else if (ext === '.html' || ext === '.htm') {
      let text = await readTextFile(filePath);
      text = stripHtmlAiMarkers(text);
      const { cleaned, stats } = cleanText(text, opts);
      await writeFile(out, cleaned, 'utf8');
      return { ok: true, outputPath: out, stats };
    } else if (ext === '.pdf' || ext === '.jpg' || ext === '.jpeg') {
      return await cleanWithExiftool(filePath, out);
    } else if (ext === '.docx' || ext === '.odt') {
      return await cleanDocxOdt(filePath, out);
    } else {
      // text / markdown
      let text = await readTextFile(filePath);
      if (ext === '.md' || ext === '.mdx' || ext === '.markdown') {
        text = stripMarkdownAiKeys(text);
      }
      const { cleaned, stats } = cleanText(text, opts);
      await writeFile(out, cleaned, 'utf8');
      return { ok: true, outputPath: out, stats };
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── PNG chunk-level handling ─────────────────────────────────────────────

function readU32BE(buf, offset) {
  return (buf[offset] << 24 | buf[offset + 1] << 16 | buf[offset + 2] << 8 | buf[offset + 3]) >>> 0;
}

function writeU32BE(val) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(val >>> 0, 0);
  return b;
}

// CRC-32 for PNG chunk validation/rewrite.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf, start, len) {
  let crc = 0xFFFFFFFF;
  for (let i = start; i < start + len; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// Metadata chunk types to drop (C2PA, XMP, AI provenance, text comments).
const DROP_CHUNKS = new Set(['tEXt', 'zTXt', 'iTXt', 'c2pa', 'CABX', 'JUMB', 'JUMD', 'eXIf', 'cICP', 'iCCP']);

async function inspectPng(filePath, findings, notes) {
  const buf = await readFile(filePath);
  if (buf.length < 8 || buf.slice(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    notes.push('Not a valid PNG file.');
    return { ok: true, format: '.png', findings, notes };
  }
  let pos = 8;
  while (pos + 8 <= buf.length) {
    const len = readU32BE(buf, pos);
    const type = buf.slice(pos + 4, pos + 8).toString('ascii');
    if (DROP_CHUNKS.has(type)) {
      const label = type === 'c2pa' ? 'C2PA manifest (PNG c2pa chunk)' :
                    type === 'CABX' || type === 'JUMB' || type === 'JUMD' ? 'C2PA/JUMBF chunk' :
                    type === 'eXIf' ? 'EXIF metadata' :
                    `PNG ${type} chunk (metadata/text)`;
      const confidence = (type === 'c2pa' || type === 'CABX' || type === 'JUMB') ? 'confirmed' : 'probable';
      findings.push({ type: label, confidence });
    }
    if (type === 'IEND') break;
    pos += 12 + len;
  }
  return { ok: true, format: '.png', findings, notes };
}

async function cleanPng(filePath, outputPath) {
  const buf = await readFile(filePath);
  if (buf.length < 8) return { ok: false, error: 'Too short to be a PNG' };

  const sig = buf.slice(0, 8);
  const chunks = [];
  let pos = 8;
  let dropped = 0;

  while (pos + 8 <= buf.length) {
    const len = readU32BE(buf, pos);
    const type = buf.slice(pos + 4, pos + 8).toString('ascii');
    const data = buf.slice(pos + 8, pos + 8 + len);
    if (DROP_CHUNKS.has(type)) {
      dropped++;
    } else {
      // Recompute CRC for safety (in case we strip adjacent chunks).
      const typeBuf = buf.slice(pos + 4, pos + 8);
      const crc = crc32(Buffer.concat([typeBuf, data]), 0, 4 + len);
      chunks.push(writeU32BE(len), typeBuf, data, writeU32BE(crc));
    }
    if (type === 'IEND') break;
    pos += 12 + len;
  }

  await writeFile(outputPath, Buffer.concat([sig, ...chunks]));
  return { ok: true, outputPath, stats: { droppedChunks: dropped } };
}

// ── HTML helpers ─────────────────────────────────────────────────────────

const HTML_AI_META_RE = /<meta\s[^>]*(?:name|property)="(?:generator|ai:[^"]*|robots)"[^>]*>/gi;
const HTML_JSONLD_AI_RE = /<script\s[^>]*type="application\/ld\+json"[\s\S]*?<\/script>/gi;
const HTML_DATAAI_RE = /\s+data-ai(?:-[a-z0-9_-]+)?="[^"]*"/gi;

function findHtmlAiMarkers(text, findings) {
  if (HTML_AI_META_RE.test(text)) findings.push({ type: 'HTML <meta> generator/AI tag', confidence: 'probable' });
  if (/<script[^>]*type="application\/ld\+json"/i.test(text)) findings.push({ type: 'JSON-LD block', confidence: 'informational' });
  if (/data-ai(?:-[a-z0-9_-]+)?=/i.test(text)) findings.push({ type: 'data-ai* attribute', confidence: 'probable' });
  HTML_AI_META_RE.lastIndex = 0;
}

function stripHtmlAiMarkers(text) {
  return text
    .replace(HTML_AI_META_RE, '')
    .replace(HTML_JSONLD_AI_RE, '')
    .replace(HTML_DATAAI_RE, '');
}

// ── Markdown helpers ──────────────────────────────────────────────────────

// AI-related YAML frontmatter keys to strip.
const AI_FRONTMATTER_KEYS = /^(generator|ai[_-].*|generated[_-]by|model|llm|ai_version|ai_tool|watermark|provenance|c2pa|synthid)\s*:/im;

function findMarkdownAiKeys(text, findings) {
  if (/^---\r?\n/.test(text) && AI_FRONTMATTER_KEYS.test(text.slice(0, text.indexOf('\n---', 3) + 4))) {
    findings.push({ type: 'Markdown YAML frontmatter AI key', confidence: 'probable' });
  }
}

function stripMarkdownAiKeys(text) {
  const match = text.match(/^(---\r?\n)([\s\S]*?)\r?\n---(\r?\n|$)/);
  if (!match) return text;
  const cleaned = match[2]
    .split('\n')
    .filter(line => !AI_FRONTMATTER_KEYS.test(line))
    .join('\n');
  return `---\n${cleaned}\n---${match[3]}${text.slice(match[0].length)}`;
}

// ── SVG XMP strip ────────────────────────────────────────────────────────

function stripXmpBlocks(text) {
  return text
    .replace(/<!--\s*<\?xpacket[^>]*>[\s\S]*?<\?xpacket[^>]*end[^>]*>\s*-->/gi, '')
    .replace(/<\?xpacket[\s\S]*?<\?xpacket[^>]*end[^>]*\?>/gi, '');
}

// ── exiftool / c2patool integration ──────────────────────────────────────

async function toolAvailable(name) {
  try {
    await execFileP(name, ['--version'], { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

async function inspectWithExiftool(filePath, findings, notes) {
  if (!await toolAvailable('exiftool')) {
    notes.push('exiftool not found — install with `brew install exiftool` for EXIF/XMP inspection of JPEG/PDF/DOCX.');
    return;
  }
  try {
    const { stdout } = await execFileP('exiftool', ['-json', filePath], { timeout: 10000 });
    const meta = JSON.parse(stdout)[0] || {};
    const AI_KEYS = ['Creator', 'Producer', 'Software', 'CreatorTool', 'DigitalSourceType', 'TrainedAlgorithmicMedia'];
    for (const key of AI_KEYS) {
      if (meta[key] && /claude|openai|gemini|gpt|dall.?e|stable.?diffusion|midjourney|synthid|c2pa/i.test(String(meta[key]))) {
        findings.push({ type: `EXIF/XMP ${key}: ${meta[key]}`, confidence: 'confirmed' });
      }
    }
    if (meta.CreatorTool || meta.Software) {
      findings.push({ type: `Metadata tool: ${meta.CreatorTool || meta.Software}`, confidence: 'informational' });
    }
  } catch (e) {
    notes.push(`exiftool error: ${e.message}`);
  }
}

async function checkC2pa(filePath, findings, notes) {
  if (!await toolAvailable('c2patool')) {
    notes.push('c2patool not found — install from https://github.com/contentauth/c2pa-rs/tree/main/cli for C2PA manifest inspection.');
    return;
  }
  try {
    const { stdout } = await execFileP('c2patool', [filePath], { timeout: 10000 });
    if (stdout && !/no claim found|no jumbf data/i.test(stdout)) {
      findings.push({ type: 'C2PA manifest (c2patool confirmed)', confidence: 'confirmed' });
    }
  } catch {
    // c2patool exits non-zero when no manifest found — not an error.
  }
}

async function cleanWithExiftool(filePath, outputPath) {
  if (!await toolAvailable('exiftool')) {
    return { ok: false, error: 'exiftool not available. Install with `brew install exiftool` (macOS) or `apt install libimage-exiftool-perl` (Linux).' };
  }
  try {
    await execFileP('exiftool', ['-all=', '-overwrite_original', '-o', outputPath, filePath], { timeout: 30000 });
    return { ok: true, outputPath, stats: { metadataStripped: true } };
  } catch (e) {
    return { ok: false, error: `exiftool failed: ${e.message}` };
  }
}

// ── DOCX / ODT metadata strip (zip-based) ────────────────────────────────
// Requires the 'adm-zip' or 'jszip' package. Falls back gracefully if absent.

async function cleanDocxOdt(filePath, outputPath) {
  let AdmZip;
  try {
    const m = await import('adm-zip');
    AdmZip = m.default || m;
  } catch {
    return { ok: false, error: 'adm-zip not installed — run `npm i adm-zip` to enable DOCX/ODT metadata strip.' };
  }
  const zip = new AdmZip(filePath);
  const ext = path.extname(filePath).toLowerCase();
  let stripped = 0;

  if (ext === '.docx') {
    // Remove docProps/custom.xml (custom document properties — common AI mark vector).
    for (const entry of zip.getEntries()) {
      if (/^docProps\/custom\.xml$/i.test(entry.entryName)) {
        zip.deleteFile(entry.entryName);
        stripped++;
      }
    }
    // Scrub generator/AI keys from docProps/app.xml and docProps/core.xml.
    for (const name of ['docProps/app.xml', 'docProps/core.xml']) {
      const entry = zip.getEntry(name);
      if (entry) {
        let xml = zip.readAsText(entry);
        xml = xml.replace(/<(?:Application|AppVersion|Generator|dc:description)[^>]*>[^<]*(?:Claude|OpenAI|Gemini|GPT|Copilot|SynthID)[^<]*<\/[^>]+>/gi, '');
        zip.updateFile(name, Buffer.from(xml, 'utf8'));
      }
    }
  } else if (ext === '.odt') {
    const entry = zip.getEntry('meta.xml');
    if (entry) {
      let xml = zip.readAsText(entry);
      xml = xml.replace(/<(?:meta:generator|dc:description)[^>]*>[^<]*(?:Claude|OpenAI|Gemini|GPT|Copilot|SynthID)[^<]*<\/[^>]+>/gi, '');
      zip.updateFile('meta.xml', Buffer.from(xml, 'utf8'));
      stripped++;
    }
  }

  zip.writeZip(outputPath);
  return { ok: true, outputPath, stats: { strippedEntries: stripped } };
}

// ── Internal helpers ──────────────────────────────────────────────────────

async function readTextFile(filePath) {
  const stat = await import('node:fs/promises').then(m => m.stat(filePath));
  if (stat.size > MAX_FILE_BYTES) throw new Error(`File too large (${stat.size} bytes); max ${MAX_FILE_BYTES} bytes.`);
  return readFile(filePath, 'utf8');
}
