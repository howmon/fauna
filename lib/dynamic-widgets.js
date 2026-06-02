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
  // Auto-inject common libs when the widget references their globals but
  // the html/js doesn't already load them (THREE, Chart.js, d3).
  const _combined = html + '\n' + js;
  const _autoLibs = [];
  // Pin THREE to 0.149.x — the last release that still ships classic globals
  // (THREE.OrbitControls etc) via examples/js. Newer releases moved those to
  // ESM-only addons which `new THREE.OrbitControls(...)` cannot reach.
  if (/\bTHREE\b/.test(js) && !/three(\.min)?\.js|three@|unpkg\.com\/three|cdn\.jsdelivr\.net\/npm\/three|esm\.sh\/three/i.test(_combined)) {
    _autoLibs.push('https://cdn.jsdelivr.net/npm/three@0.149.0/build/three.min.js');
    if (/THREE\.OrbitControls\b/.test(_combined)) {
      _autoLibs.push('https://cdn.jsdelivr.net/npm/three@0.149.0/examples/js/controls/OrbitControls.js');
    }
  }
  if (/\bChart\b/.test(js) && !/chart(\.min)?\.js|chart\.js@|unpkg\.com\/chart\.js|cdn\.jsdelivr\.net\/npm\/chart\.js/i.test(_combined)) {
    _autoLibs.push('https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.0/chart.umd.min.js');
  }
  if (/\bd3\b/.test(js) && !/d3(\.min)?\.js|d3@|unpkg\.com\/d3|cdn\.jsdelivr\.net\/npm\/d3/i.test(_combined)) {
    _autoLibs.push('https://cdnjs.cloudflare.com/ajax/libs/d3/7.8.5/d3.min.js');
  }
  const _autoLibTags = _autoLibs.map(u => `<script src="${u}"><\/script>`).join('');
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
<div id="root">${html}</div>
<script>
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
  try {
${js}
  } catch (err) {
    document.getElementById('root').innerHTML +=
      '<pre style="color:#f85149;white-space:pre-wrap">Widget script error: ' + (err && err.message || err) + '</pre>';
  }
  parent.postMessage({source:'fauna-widget', widgetId: widget.id, type:'ready'}, '*');
})();
</script>
</body></html>`;
}
