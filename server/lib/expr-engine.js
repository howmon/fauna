// ── Expression Engine — n8n-style {{ ... }} expressions for pipelines ──────
//
// Phase: n8n-parity #2. Lets pipeline node configs reference upstream data
// field-by-field instead of flat string substitution. Syntax mirrors n8n:
//
//   {{ $json.field }}              current node's input, JSON-parsed
//   {{ $input }}                   current node's raw input value
//   {{ $node["Label"].output }}    a named upstream node's output
//   {{ $node.nodeId.json.x }}      upstream output parsed as JSON
//   {{ $env.NAME }}                allow-listed environment variables
//   {{ $now }} / {{ $today }}      Date.now() / ISO date
//   {{ $json.x.toUpperCase() }}    arbitrary safe JS expressions
//
// SECURITY: expressions are the user's OWN automation config (not untrusted
// input), but we still evaluate inside a Node `vm` context with NO access to
// require/process/global/module and a hard timeout. This is strictly safer
// than the legacy `new Function(...)` used by the code/condition nodes.

import vm from 'vm';

const EXPR_TIMEOUT_MS = 1000;

// Environment allow-list: only variables prefixed FAUNA_EXPR_ are exposed via
// $env, so expressions can never read arbitrary secrets from process.env.
function _buildEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env || {})) {
    if (k.startsWith('FAUNA_EXPR_')) env[k.slice('FAUNA_EXPR_'.length)] = v;
  }
  return env;
}

// Best-effort JSON parse: returns the parsed object for JSON strings, else the
// original value untouched.
function _maybeJson(val) {
  if (val == null) return val;
  if (typeof val !== 'string') return val;
  const t = val.trim();
  if (!t || (t[0] !== '{' && t[0] !== '[')) return val;
  try { return JSON.parse(t); } catch (_) { return val; }
}

/**
 * Build the sandbox object exposed to expressions.
 * @param {object} opts
 * @param {*} opts.input              current node's input value
 * @param {Record<string,*>} opts.nodeOutputs   nodeId -> output
 * @param {Record<string,string>} [opts.labels] nodeId -> label (for $node["Label"])
 * @param {Record<string,object>} [opts.creds]  credName -> resolved data map
 * @param {Array<{json:*,binary?:object}>} [opts.items]  current node's input items
 * @param {{json:*,binary?:object}} [opts.item]          the item being processed now
 */
function buildContext(opts = {}) {
  const { input, nodeOutputs = {}, labels = {}, creds = {}, items, item } = opts;

  // $node accessor: indexable by id OR label, each entry { output, json }.
  const node = {};
  for (const [id, out] of Object.entries(nodeOutputs)) {
    const entry = { output: out, json: _maybeJson(out) };
    node[id] = entry;
    const label = labels[id];
    if (label && !(label in node)) node[label] = entry;
  }

  // Item-aware accessors ($items / $item / $binary). When a specific item is
  // being processed (per-item fan-out), $json reflects THAT item's json.
  const curItem = item || (Array.isArray(items) && items.length ? items[0] : null);
  const itemArr = Array.isArray(items) ? items : (curItem ? [curItem] : []);
  const jsonVal = curItem ? curItem.json : _maybeJson(input);

  const now = new Date();
  return {
    $json:  jsonVal,
    $input: input,
    $items: itemArr,
    $item:  curItem,
    $binary: curItem ? (curItem.binary || {}) : {},
    $node:  node,
    $env:   _buildEnv(),
    $cred:  creds,
    $now:   now.getTime(),
    $today: now.toISOString().slice(0, 10),
    $isoNow: now.toISOString(),
  };
}

/**
 * Evaluate a single JS expression string against a context. Never throws —
 * returns undefined on error so interpolation degrades gracefully.
 */
function evaluateExpression(expr, context) {
  const sandbox = Object.create(null);
  Object.assign(sandbox, context);
  // Expose a tiny safe helper surface; explicitly shadow dangerous globals.
  sandbox.JSON = JSON;
  sandbox.Math = Math;
  sandbox.Date = Date;
  sandbox.Number = Number;
  sandbox.String = String;
  sandbox.Boolean = Boolean;
  sandbox.Array = Array;
  sandbox.Object = Object;
  sandbox.require = undefined;
  sandbox.process = undefined;
  sandbox.global = undefined;
  sandbox.globalThis = undefined;
  sandbox.module = undefined;
  try {
    const ctx = vm.createContext(sandbox);
    return vm.runInContext('(' + expr + ')', ctx, { timeout: EXPR_TIMEOUT_MS, displayErrors: false });
  } catch (_) {
    return undefined;
  }
}

// Does this string contain at least one {{ ... }} expression referencing the
// $-namespace? Used to gate the engine so legacy {{nodeId}} stays untouched.
function hasExpression(str) {
  return typeof str === 'string' && /\{\{[^}]*\$[^}]*\}\}/.test(str);
}

/**
 * Interpolate all {{ ... }} spans in a template against a context.
 * - If the ENTIRE template is a single {{ expr }}, the raw (typed) value is
 *   returned so objects/arrays pass through unstringified.
 * - Otherwise each span is stringified and concatenated.
 */
function interpolate(template, context) {
  if (typeof template !== 'string' || template.indexOf('{{') === -1) return template;

  const single = template.match(/^\s*\{\{([\s\S]+?)\}\}\s*$/);
  if (single) {
    const val = evaluateExpression(single[1].trim(), context);
    return val === undefined ? '' : val;
  }

  return template.replace(/\{\{([\s\S]+?)\}\}/g, (_m, expr) => {
    const val = evaluateExpression(expr.trim(), context);
    if (val === undefined || val === null) return '';
    return typeof val === 'object' ? JSON.stringify(val) : String(val);
  });
}

export { buildContext, evaluateExpression, interpolate, hasExpression };
