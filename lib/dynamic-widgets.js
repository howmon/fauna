// ── Dynamic Widgets — server-side helpers for ephemeral, per-conversation tools ──
// When `enableDynamicWidgets` is on, the model can call `fauna_emit_widget` to
// render a sandboxed HTML/JS widget in the chat, with its own ephemeral tool
// manifest. Those tools are scoped to the conversation (extracted from message
// history) and routed back to the live widget via SSE → frontend postMessage.
//
// This module is pure / IO-free — chat.js wires the SSE bridge + pending map.

const MARKER = '\u0000FAUNA_WIDGET\u0000'; // unique sentinel inside tool_result content
const NAME_RE = /^[a-z][a-z0-9_]{0,40}$/i;
const MAX_TOOLS_PER_WIDGET = 12;
const MAX_TOTAL_WIDGET_TOOLS = 24; // per-turn cap across all live widgets

/**
 * @typedef {{ name: string, description?: string, parameters?: object }} WidgetTool
 * @typedef {{ widgetId: string, tools: WidgetTool[] }} WidgetRegistration
 */

/**
 * Pack a widget registration into a tool_result content string.
 * The string is JSON with a private marker the model never needs to see.
 */
export function packWidgetResult(payload, registration) {
  return JSON.stringify({
    ...payload,
    __fauna_widget: MARKER,
    __fauna_registration: registration,
  });
}

/** Try to extract a WidgetRegistration from a tool_result content string. */
export function unpackWidgetResult(content) {
  if (typeof content !== 'string' || !content.includes('__fauna_widget')) return null;
  try {
    const parsed = JSON.parse(content);
    if (parsed?.__fauna_widget !== MARKER) return null;
    const reg = parsed.__fauna_registration;
    if (!reg?.widgetId || !Array.isArray(reg.tools)) return null;
    return reg;
  } catch (_) {
    return null;
  }
}

/**
 * Walk a message history and return all widget registrations that the model
 * should currently have access to. Later registrations override earlier ones
 * sharing the same widgetId.
 *
 * @param {Array<{role:string,content?:any,tool_call_id?:string}>} messages
 * @returns {WidgetRegistration[]}
 */
export function extractWidgetRegistrations(messages) {
  if (!Array.isArray(messages)) return [];
  const byId = new Map();
  for (const msg of messages) {
    if (msg?.role !== 'tool') continue;
    const content = typeof msg.content === 'string' ? msg.content : null;
    if (!content) continue;
    const reg = unpackWidgetResult(content);
    if (!reg) continue;
    byId.set(reg.widgetId, reg);
  }
  return Array.from(byId.values());
}

/**
 * Convert widget registrations into OpenAI-shaped tool definitions, namespaced
 * so they cannot collide with builtin tools.
 *
 * Tool name format: `w_<widgetIdSlug>__<toolName>` — chat.js parses this prefix
 * to route the call to the widget RPC bridge.
 */
export function buildEphemeralToolDefs(registrations) {
  const defs = [];
  let count = 0;
  for (const reg of registrations) {
    const slug = String(reg.widgetId).replace(/[^a-z0-9]/gi, '').slice(0, 24);
    if (!slug) continue;
    const seen = new Set();
    for (const t of reg.tools) {
      if (count >= MAX_TOTAL_WIDGET_TOOLS) return defs;
      if (!t || !NAME_RE.test(t.name) || seen.has(t.name)) continue;
      seen.add(t.name);
      if (seen.size > MAX_TOOLS_PER_WIDGET) break;
      defs.push({
        type: 'function',
        function: {
          name: `w_${slug}__${t.name}`,
          description: (t.description || '').slice(0, 400) ||
            `Widget action "${t.name}" from widget ${reg.widgetId}`,
          parameters: t.parameters && typeof t.parameters === 'object'
            ? t.parameters
            : { type: 'object', properties: {} },
        },
      });
      count++;
    }
  }
  return defs;
}

/** True if a tool name targets a dynamic widget. */
export function isWidgetTool(name) {
  return typeof name === 'string' && name.startsWith('w_') && name.includes('__');
}

/** Parse a widget tool name → { widgetIdSlug, toolName } or null. */
export function parseWidgetToolName(name) {
  if (!isWidgetTool(name)) return null;
  const idx = name.indexOf('__');
  return {
    widgetIdSlug: name.slice(2, idx),
    toolName: name.slice(idx + 2),
  };
}

/**
 * Build a runnable iframe srcdoc for a widget bundle. The host (parent window)
 * exchanges `tool_call` / `tool_result` messages with this iframe. The widget
 * registers handlers via the injected `widget.on(name, fn)` API.
 *
 * NOTE: This is server-side only as a convenience for tests + the SSE payload
 * preview. The actual mounting happens in the frontend (`dynamic-widgets.js`).
 */
export function buildWidgetSrcdoc({ widgetId, html = '', css = '', js = '' }) {
  // Three.js loading strategy: use an importmap pointing at the latest stable
  // release. This lets the bundle either:
  //   (a) write modern ESM: `import * as THREE from 'three'` /
  //       `import { OrbitControls } from 'three/addons/controls/OrbitControls.js'`
  //   (b) write classic-style: `new THREE.OrbitControls(camera, renderer.domElement)`
  // For (b) we inject a tiny back-compat preamble that imports the same modules
  // and re-attaches them as `window.THREE` + `THREE.OrbitControls`/`GLTFLoader`/
  // etc. So both styles work against the same current three.js build.
  const THREE_VERSION = '0.180.0';
  const _combined = String(html || '') + '\n' + String(js || '');
  const _refsTHREE = /\bTHREE\b/.test(_combined) || /\bfrom\s+['"]three(\/|['"])/.test(_combined);
  const _hasHandLoadedThree = /three(\.min|\.module(\.min)?)?\.js\b|three@|three\/addons/i.test(_combined);
  const _useThreeImportmap = _refsTHREE && !_hasHandLoadedThree;
  // Detect top-level ES module syntax independently. If the bundle uses static
  // `import ... from ...` / `export ...` / side-effect `import '...';`, it MUST
  // be emitted as <script type="module"> or the browser throws "Cannot use
  // import statement outside a module" at parse time. This is separate from
  // the importmap decision — a bundle that imports directly from an esm.sh URL
  // is hand-loading three but still needs module wrapping.
  const _usesEsmSyntax = /^[ \t]*(import|export)\s+(?!\()/m.test(String(js || ''));
  const _useModuleBundle = _useThreeImportmap || _usesEsmSyntax;

  // Inline importmap so bare `import 'three'` and `import 'three/addons/...'`
  // resolve to the jsdelivr-hosted r180 ESM build.
  const _importMapTag = _useThreeImportmap
    ? `<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@${THREE_VERSION}/build/three.module.min.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@${THREE_VERSION}/examples/jsm/"}}\u003c/script>`
    : '';

  // Back-compat preamble: expose `THREE` globally and re-attach commonly used
  // addons that the model often writes as `THREE.OrbitControls` / `THREE.GLTFLoader`
  // (the classic r147-and-earlier global style). Only injected when the bundle
  // actually references those globals.
  let _backCompatPreamble = '';
  if (_useThreeImportmap) {
    const _imports = ["import * as THREE from 'three';"];
    const _attach  = ['window.THREE = THREE;'];
    const _addon = (name, path) => {
      if (new RegExp('THREE\\.' + name + '\\b').test(_combined)) {
        _imports.push(`import { ${name} } from 'three/addons/${path}';`);
        _attach.push(`THREE.${name} = ${name};`);
      }
    };
    _addon('OrbitControls', 'controls/OrbitControls.js');
    _addon('MapControls', 'controls/MapControls.js');
    _addon('TrackballControls', 'controls/TrackballControls.js');
    _addon('TransformControls', 'controls/TransformControls.js');
    _addon('DragControls', 'controls/DragControls.js');
    _addon('PointerLockControls', 'controls/PointerLockControls.js');
    _addon('GLTFLoader', 'loaders/GLTFLoader.js');
    _addon('DRACOLoader', 'loaders/DRACOLoader.js');
    _addon('OBJLoader', 'loaders/OBJLoader.js');
    _addon('FBXLoader', 'loaders/FBXLoader.js');
    _addon('RGBELoader', 'loaders/RGBELoader.js');
    _addon('EXRLoader', 'loaders/EXRLoader.js');
    _addon('SVGLoader', 'loaders/SVGLoader.js');
    _addon('FontLoader', 'loaders/FontLoader.js');
    _addon('TextGeometry', 'geometries/TextGeometry.js');
    _addon('RoomEnvironment', 'environments/RoomEnvironment.js');
    _addon('EffectComposer', 'postprocessing/EffectComposer.js');
    _addon('RenderPass', 'postprocessing/RenderPass.js');
    _addon('UnrealBloomPass', 'postprocessing/UnrealBloomPass.js');
    _backCompatPreamble = `<script type="module">${_imports.join('')}${_attach.join('')}\u003c/script>`;
  }

  // Chart.js + d3 still ship UMD bundles — load as classic globals when the
  // bundle references them but didn't load them itself.
  const _autoLibs = [];
  if (/\bChart\b/.test(js) && !/chart(\.min)?\.js|chart\.js@|unpkg\.com\/chart\.js|cdn\.jsdelivr\.net\/npm\/chart\.js/i.test(_combined)) {
    _autoLibs.push('https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.0/chart.umd.min.js');
  }
  if (/\bd3\b/.test(js) && !/d3(\.min)?\.js|d3@|unpkg\.com\/d3|cdn\.jsdelivr\.net\/npm\/d3/i.test(_combined)) {
    _autoLibs.push('https://cdnjs.cloudflare.com/ajax/libs/d3/7.8.5/d3.min.js');
  }
  const _autoLibTags = _importMapTag + _autoLibs.map(u => `<script src="${u}"><\/script>`).join('');
  // If the model emitted an empty bundle.html but the JS expects a canvas
  // (common 3D/Chart pattern: `document.getElementById('c')`), inject a
  // sensible default so `new THREE.WebGLRenderer({canvas})` doesn't get null.
  let _bodyHtml = html;
  if (!String(html || '').trim()) {
    const m = /getElementById\(['"]([\w-]+)['"]\)/.exec(js);
    const id = m ? m[1] : 'c';
    _bodyHtml = `<canvas id="${id}" style="display:block;width:100%;height:100%"></canvas>`;
  }
  // CSP: no network, no parent same-origin (handled by iframe `sandbox` attr).
  return `<!doctype html><html><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' https://cdnjs.cloudflare.com https://unpkg.com https://cdn.jsdelivr.net https://esm.sh; script-src-elem 'unsafe-inline' https://cdnjs.cloudflare.com https://unpkg.com https://cdn.jsdelivr.net https://esm.sh; style-src 'unsafe-inline' https://cdnjs.cloudflare.com https://unpkg.com https://cdn.jsdelivr.net; img-src data: blob: https: http://localhost:3737; media-src blob: data: https: http://localhost:3737; font-src data: https://cdnjs.cloudflare.com https://unpkg.com https://cdn.jsdelivr.net; connect-src http://localhost:3737 ws://localhost:3737; frame-src 'none'">
${_autoLibTags}
<style>
html,body{margin:0;padding:0;font-family:system-ui,-apple-system,sans-serif;color:#e6e6e6;background:transparent}
${css}
</style>
</head><body>
<div id="root" style="width:100vw;height:100vh">${_bodyHtml}</div>
<script>
// Surface uncaught errors (including SyntaxError from the bundle module,
// which an in-bundle try/catch cannot reach because syntax errors happen at
// parse time, before any code in that block runs). Module scripts also throw
// loader errors here when an import URL 404s.
(function(){
  function show(msg){
    try {
      var root = document.getElementById('root');
      if (!root) return;
      root.innerHTML += '<pre style="color:#f85149;white-space:pre-wrap;font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;padding:8px;margin:8px;border:1px solid rgba(248,81,73,.4);border-radius:6px;background:rgba(248,81,73,.08)">Widget script error: ' + msg + '</pre>';
    } catch(_) {}
  }
  window.addEventListener('error', function(ev){
    show((ev && (ev.message || (ev.error && ev.error.message))) || 'unknown error');
  });
  window.addEventListener('unhandledrejection', function(ev){
    var r = ev && ev.reason;
    show((r && (r.message || String(r))) || 'unhandled promise rejection');
  });
})();
</script>
<script>
// Widget API setup — synchronous + classic so it's available before any
// downstream <script type="module"> runs (modules are deferred).
(function(){
  var handlers = {};
  var widget = {
    id: ${JSON.stringify(widgetId)},
    on: function(name, fn){ handlers[name] = fn; },
    emit: function(ev, data){ parent.postMessage({source:'fauna-widget', widgetId: widget.id, type:'event', event: ev, data: data}, '*'); }
  };
  window.widget = widget;
  window.addEventListener('message', async function(e){
    var msg = e.data || {};
    if (msg.source !== 'fauna-host' || msg.widgetId !== widget.id) return;
    if (msg.type === 'tool_call') {
      var fn = handlers[msg.name];
      var reply = { source:'fauna-widget', widgetId: widget.id, type:'tool_result', callId: msg.callId };
      if (!fn) { reply.error = 'No handler registered for "' + msg.name + '"'; }
      else {
        try { reply.result = await fn(msg.args || {}); }
        catch (err) { reply.error = String(err && err.message || err); }
      }
      parent.postMessage(reply, '*');
    }
  });
})();
</script>
${_backCompatPreamble}
${_useModuleBundle
  // ES module bundle — top-level `import` works; isolation is automatic.
  // Errors surface via the global error/unhandledrejection handlers above.
  ? `<script type="module">\n${js}\n\u003c/script>\n<script type="module">parent.postMessage({source:'fauna-widget', widgetId: ${JSON.stringify(widgetId)}, type:'ready'}, '*');\u003c/script>`
  // Classic bundle — wrap in IIFE + try/catch for back-compat with bundles
  // that rely on implicit globals or that we don't need to load three.js for.
  : `<script>
(function(){
  try {
${js}
  } catch (err) {
    document.getElementById('root').innerHTML +=
      '<pre style="color:#f85149;white-space:pre-wrap">Widget script error: ' + (err && err.message || err) + '</pre>';
  }
  parent.postMessage({source:'fauna-widget', widgetId: ${JSON.stringify(widgetId)}, type:'ready'}, '*');
})();
\u003c/script>`}
</body></html>`;
}
