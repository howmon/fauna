// ── Dynamic Widgets (frontend) ────────────────────────────────────────────
// Mounts sandboxed widget iframes emitted by the backend and bridges RPC
// between the chat-route SSE stream and the iframe.
//
// SSE events handled (dispatched from public/js/chat.js):
//   widget_emitted        { widgetId, title, bundle, tools[], fromPlaybook }
//   widget_tool_pending   { callId, widgetId, name, args }
//
// Iframe message protocol:
//   parent → iframe   { source:'fauna-host',  widgetId, type:'tool_call',  callId, name, args }
//   iframe → parent   { source:'fauna-widget', widgetId, type:'tool_result', callId, result|error }
//   iframe → parent   { source:'fauna-widget', widgetId, type:'event', event, data }
//   iframe → parent   { source:'fauna-widget', widgetId, type:'ready' }

(function () {
  if (window._faunaDynamicWidgets) return;
  window._faunaDynamicWidgets = { mounted: new Map() };

  function _buildSrcdoc(widgetId, bundle) {
    var html = String(bundle.html || '');
    var css  = String(bundle.css  || '');
    var js   = String(bundle.js   || '');
    // Mirror lib/dynamic-widgets.js buildWidgetSrcdoc — kept inline so the
    // frontend doesn't need to round-trip the assembled HTML over the wire.
    return '<!doctype html><html><head>' +
      '<meta charset="utf-8">' +
      '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\' https://cdnjs.cloudflare.com https://unpkg.com https://cdn.jsdelivr.net https://esm.sh; script-src-elem \'unsafe-inline\' https://cdnjs.cloudflare.com https://unpkg.com https://cdn.jsdelivr.net https://esm.sh; style-src \'unsafe-inline\' https://cdnjs.cloudflare.com https://unpkg.com https://cdn.jsdelivr.net; img-src data: blob: https:; font-src data: https://cdnjs.cloudflare.com https://unpkg.com https://cdn.jsdelivr.net; connect-src \'none\'; frame-src \'none\'">' +
      '<style>html,body{margin:0;padding:0;font-family:system-ui,-apple-system,sans-serif;color:#e6e6e6;background:transparent}' +
      css + '</style></head><body>' +
      '<div id="root">' + html + '</div>' +
      '<script>(function(){' +
        'var handlers={};' +
        'var widget={id:' + JSON.stringify(widgetId) + ',' +
          'on:function(n,f){handlers[n]=f;},' +
          'emit:function(ev,data){parent.postMessage({source:"fauna-widget",widgetId:widget.id,type:"event",event:ev,data:data},"*");}};' +
        'window.widget=widget;' +
        'window.addEventListener("message",async function(e){' +
          'var m=e.data||{};' +
          'if(m.source!=="fauna-host"||m.widgetId!==widget.id)return;' +
          'if(m.type==="tool_call"){' +
            'var fn=handlers[m.name];' +
            'var reply={source:"fauna-widget",widgetId:widget.id,type:"tool_result",callId:m.callId};' +
            'if(!fn){reply.error="No handler registered for \\""+m.name+"\\"";}' +
            'else{try{reply.result=await fn(m.args||{});}catch(err){reply.error=String(err&&err.message||err);}}' +
            'parent.postMessage(reply,"*");' +
          '}' +
        '});' +
        'try{' + js + '}catch(err){' +
          'document.getElementById("root").innerHTML+="<pre style=\\"color:#f85149;white-space:pre-wrap\\">Widget script error: "+(err&&err.message||err)+"</pre>";' +
        '}' +
        'parent.postMessage({source:"fauna-widget",widgetId:widget.id,type:"ready"},"*");' +
      '})();</script></body></html>';
  }

  function mountWidget(evt, targetEl) {
    var widgetId = evt.widgetId;
    if (!widgetId || !evt.bundle) return;
    if (window._faunaDynamicWidgets.mounted.has(widgetId)) return; // dedup

    var wrap = document.createElement('div');
    wrap.className = 'fauna-dynamic-widget';
    wrap.dataset.widgetId = widgetId;
    wrap.style.cssText = 'margin:10px 0;border:1px solid var(--fau-border,#2a2a2a);border-radius:10px;overflow:hidden;background:var(--fau-surface,#161616)';

    var header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:8px 12px;font-size:12px;color:var(--fau-text-dim,#888);background:var(--fau-surface2,#1c1c1c);border-bottom:1px solid var(--fau-border,#2a2a2a)';
    var titleText = evt.title || 'Dynamic Widget';
    var toolsCount = (evt.tools || []).length;
    header.innerHTML =
      '<span><i class="ti ti-bolt" style="margin-right:6px"></i>' +
        (titleText.replace(/</g, '&lt;')) +
        ' <span style="opacity:0.6">· ' + toolsCount + ' action' + (toolsCount === 1 ? '' : 's') + '</span>' +
      '</span>' +
      '<span style="display:flex;gap:6px">' +
        '<button class="fauna-widget-save" title="Save to playbook" style="background:transparent;border:1px solid var(--fau-border,#2a2a2a);color:var(--fau-text-dim,#888);border-radius:6px;padding:3px 8px;font-size:11px;cursor:pointer"><i class="ti ti-bookmark"></i> Save</button>' +
      '</span>';

    var iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.setAttribute('referrerpolicy', 'no-referrer');
    iframe.setAttribute('loading', 'lazy');
    iframe.style.cssText = 'width:100%;border:0;display:block;min-height:240px;background:transparent';
    iframe.srcdoc = _buildSrcdoc(widgetId, evt.bundle);

    // Auto-resize: widgets that emit { source:'fauna-widget', type:'event', event:'resize', data:{height} }
    // will get their iframe height updated.

    wrap.appendChild(header);
    wrap.appendChild(iframe);

    var mount = targetEl || document.body;
    mount.appendChild(wrap);

    window._faunaDynamicWidgets.mounted.set(widgetId, { iframe, wrap, tools: evt.tools || [] });

    // Wire "Save to playbook" — sends a chat message asking the agent to save.
    var saveBtn = header.querySelector('.fauna-widget-save');
    if (saveBtn) {
      saveBtn.onclick = function () {
        var name = prompt('Save this widget to your playbook as:', titleText);
        if (!name) return;
        if (typeof window.sendChatMessage === 'function') {
          window.sendChatMessage('Save the current widget ' + widgetId + ' to my playbook with the name "' + name + '".');
        } else {
          saveBtn.textContent = 'Ask the agent: save widget ' + widgetId;
        }
      };
    }
  }

  // Resolve a widget tool call by forwarding to the iframe and posting the
  // result back to the server.
  function handleToolPending(evt) {
    var widgetId = evt.widgetId;
    var mounted = window._faunaDynamicWidgets.mounted.get(widgetId);
    if (!mounted) {
      // Widget not (yet) mounted on this client — report back so the model isn't stuck.
      fetch('/api/widget-tool-result', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callId: evt.callId, error: 'Widget ' + widgetId + ' is not mounted in this UI' }),
      }).catch(function () {});
      return;
    }
    var pending = { callId: evt.callId, widgetId: widgetId };
    var onMessage = function (e) {
      var m = e.data || {};
      if (m.source !== 'fauna-widget' || m.widgetId !== widgetId) return;
      if (m.type !== 'tool_result' || m.callId !== pending.callId) return;
      window.removeEventListener('message', onMessage);
      fetch('/api/widget-tool-result', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callId: pending.callId, result: m.result, error: m.error }),
      }).catch(function () {});
    };
    window.addEventListener('message', onMessage);
    // 20s safety unbind in case the widget never replies.
    setTimeout(function () { window.removeEventListener('message', onMessage); }, 20000);

    mounted.iframe.contentWindow.postMessage({
      source: 'fauna-host',
      widgetId: widgetId,
      type: 'tool_call',
      callId: evt.callId,
      name: evt.name,
      args: evt.args || {},
    }, '*');
  }

  // Listen for widget-driven resize / event broadcasts.
  window.addEventListener('message', function (e) {
    var m = e.data || {};
    if (m.source !== 'fauna-widget') return;
    var mounted = window._faunaDynamicWidgets.mounted.get(m.widgetId);
    if (!mounted) return;
    if (m.type === 'event' && m.event === 'resize' && m.data && typeof m.data.height === 'number') {
      var h = Math.max(120, Math.min(1200, m.data.height));
      mounted.iframe.style.height = h + 'px';
    }
  });

  // Public API used by public/js/chat.js when it sees the SSE events.
  window.faunaDynamicWidgets = {
    mountWidget: mountWidget,
    handleToolPending: handleToolPending,
    isMounted: function (id) { return window._faunaDynamicWidgets.mounted.has(id); },
  };
})();
