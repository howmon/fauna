// ── Item Model — n8n-style item arrays for pipeline data flow ─────────────
//
// Phase: n8n-parity #4. n8n passes data between nodes as an ARRAY OF ITEMS,
// each shaped { json: <any>, binary?: { <key>: { data, mimeType, fileName } } }.
// Nodes run once per item (fan-out) and a Merge node recombines branches.
//
// Fauna's legacy model stored a single scalar (usually a string) per node.
// This module is the bridge: it normalises any node output into an item array
// on read, and collapses item arrays back to a legacy-friendly display value
// where single-value consumers (summaries, legacy {{nodeId}}) still expect one.
//
// Storage convention: item-aware nodes (split, merge, per-item action runs)
// store a TAGGED item array; every other (legacy) node keeps storing a scalar.
// `toItems()` accepts either and always yields a proper item array.

// Brand used to distinguish a deliberate item array from a plain JS array that
// merely happens to hold objects. Non-enumerable so it never leaks into JSON.
const ITEM_BRAND = '__faunaItems';

/** Is `value` a branded item array produced by this module? */
function isItemArray(value) {
  return Array.isArray(value) && value[ITEM_BRAND] === true;
}

/** Brand an array in place as an item array and return it. */
function brandItems(arr) {
  if (Array.isArray(arr) && !arr[ITEM_BRAND]) {
    Object.defineProperty(arr, ITEM_BRAND, { value: true, enumerable: false, configurable: true });
  }
  return arr;
}

/** Is `v` already a single item ({ json } / { json, binary } shape)? */
function isItem(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v) &&
    Object.prototype.hasOwnProperty.call(v, 'json');
}

// Best-effort JSON parse for scalar strings that hold JSON.
function _maybeJson(val) {
  if (typeof val !== 'string') return val;
  const t = val.trim();
  if (!t || (t[0] !== '{' && t[0] !== '[')) return val;
  try { return JSON.parse(t); } catch (_) { return val; }
}

/**
 * Normalise ANY node output into a branded item array.
 * - branded item array            → returned as-is
 * - single item ({json,...})       → [item]
 * - plain array                    → one item per element
 * - JSON-array string              → one item per parsed element
 * - everything else (scalar/obj)   → [{ json: value }]
 */
function toItems(value) {
  if (isItemArray(value)) return value;
  if (isItem(value)) return brandItems([value]);
  if (Array.isArray(value)) {
    return brandItems(value.map((v) => (isItem(v) ? v : { json: v })));
  }
  const parsed = _maybeJson(value);
  if (Array.isArray(parsed)) {
    return brandItems(parsed.map((v) => ({ json: v })));
  }
  return brandItems([{ json: value }]);
}

/** Wrap an arbitrary executor return value into a single item. */
function toItem(value) {
  return isItem(value) ? value : { json: value };
}

/**
 * Collapse an item array (or scalar) into a legacy display value:
 *   0 items   → null
 *   1 item    → that item's json
 *   N items   → array of the items' json
 * Non-item values pass through untouched.
 */
function fromItems(value) {
  if (!isItemArray(value)) return value;
  if (value.length === 0) return null;
  if (value.length === 1) return value[0].json;
  return value.map((it) => it.json);
}

/**
 * Produce a human/string-friendly representation of any node output for
 * summaries and per-node result previews. Item arrays render as their json.
 */
function displayOutput(value) {
  if (isItemArray(value)) {
    const collapsed = fromItems(value);
    if (collapsed == null) return '';
    return typeof collapsed === 'object' ? JSON.stringify(collapsed) : String(collapsed);
  }
  if (value != null && typeof value === 'object') return JSON.stringify(value);
  return String(value == null ? '' : value);
}

/**
 * Build a binary attachment descriptor for an item.
 * @param {Buffer|Uint8Array|string} data  raw bytes (Buffer) or base64 string
 * @param {object} [meta] { mimeType, fileName }
 */
function makeBinary(data, meta = {}) {
  let base64;
  if (Buffer.isBuffer(data)) base64 = data.toString('base64');
  else if (data instanceof Uint8Array) base64 = Buffer.from(data).toString('base64');
  else base64 = String(data || '');
  return {
    data: base64,
    mimeType: meta.mimeType || 'application/octet-stream',
    fileName: meta.fileName || 'data',
    size: meta.size != null ? meta.size : Math.floor((base64.length * 3) / 4),
  };
}

export {
  ITEM_BRAND,
  isItemArray,
  isItem,
  brandItems,
  toItems,
  toItem,
  fromItems,
  displayOutput,
  makeBinary,
};
