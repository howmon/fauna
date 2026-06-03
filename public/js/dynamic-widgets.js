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
    // Three.js loading strategy: use an importmap pointing at the latest
    // stable release (r180). This lets the bundle use either modern ESM
    // (`import * as THREE from 'three'`, `import { OrbitControls } from
    // 'three/addons/controls/OrbitControls.js'`) OR the classic-global style
    // (`new THREE.OrbitControls(...)`). For the classic style we inject a
    // back-compat preamble that imports the same modules and re-attaches
    // them on the global `THREE`.
    var THREE_VERSION = '0.180.0';
    var combined = html + '\n' + js;
    function _refs(re){ return re.test(js) || re.test(html); }
    function _has(re){ return re.test(combined); }
    var refsThree = _refs(/\bTHREE\b/) || _has(/\bfrom\s+['"]three(\/|['"])/);
    var hasHandLoadedThree = _has(/three(\.min|\.module(\.min)?)?\.js\b|three@|three\/addons/i);
    var useImportmap = refsThree && !hasHandLoadedThree;

    var importMapTag = '';
    var backCompatPreamble = '';
    if (useImportmap) {
      importMapTag = '<script type="importmap">' +
        '{"imports":{' +
          '"three":"https://cdn.jsdelivr.net/npm/three@' + THREE_VERSION + '/build/three.module.min.js",' +
          '"three/addons/":"https://cdn.jsdelivr.net/npm/three@' + THREE_VERSION + '/examples/jsm/"' +
        '}}<\/script>';
      var imps = ["import * as THREE from 'three';"];
      var atts = ['window.THREE = THREE;'];
      function _addon(name, path){
        if (new RegExp('THREE\\.' + name + '\\b').test(combined)) {
          imps.push("import { " + name + " } from 'three/addons/" + path + "';");
          atts.push('THREE.' + name + ' = ' + name + ';');
        }
      }
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
      backCompatPreamble = '<script type="module">' + imps.join('') + atts.join('') + '<\/script>';
    }

    // Chart.js + d3 still ship UMD bundles — load as classic globals.
    var autoLibs = [];
    if (_refs(/\bChart\b/) && !_has(/chart(\.min)?\.js|chart\.js@|unpkg\.com\/chart\.js|cdn\.jsdelivr\.net\/npm\/chart\.js/i)) {
      autoLibs.push('https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.0/chart.umd.min.js');
    }
    if (_refs(/\bd3\b/) && !_has(/d3(\.min)?\.js|d3@|unpkg\.com\/d3|cdn\.jsdelivr\.net\/npm\/d3/i)) {
      autoLibs.push('https://cdnjs.cloudflare.com/ajax/libs/d3/7.8.5/d3.min.js');
    }
    var autoLibTags = importMapTag + autoLibs.map(function(u){ return '<script src="' + u + '"><\/script>'; }).join('');
    // If html is empty but js needs a canvas (common 3D widget pattern),
    // inject a default <canvas> filling the iframe so getElementById doesn't
    // return null and the WebGLRenderer can mount.
    var bodyHtml = html;
    if (!String(html || '').trim()) {
      var m = /getElementById\(['"]([\w-]+)['"]\)/.exec(js);
      var id = m ? m[1] : 'c';
      bodyHtml = '<canvas id="' + id + '" style="display:block;width:100%;height:100%"></canvas>';
    }

    // Snapshot + resize glue — appended to whichever bundle script we emit.
    var glueJs =
      'function _reportH(){var h=Math.max(document.documentElement.scrollHeight,document.body?document.body.scrollHeight:0);parent.postMessage({source:"fauna-widget",widgetId:' + JSON.stringify(widgetId) + ',type:"event",event:"resize",data:{height:h}},"*");}' +
      'setTimeout(_reportH,50);setTimeout(_reportH,300);setTimeout(_reportH,1000);' +
      'try{if(window.ResizeObserver){var _ro=new ResizeObserver(_reportH);_ro.observe(document.documentElement);if(document.body)_ro.observe(document.body);}}catch(_){}' +
      'window.addEventListener("message",function(ev){' +
        'var d=ev.data||{};if(d.source!=="fauna-host"||d.widgetId!==' + JSON.stringify(widgetId) + '||d.type!=="snapshot")return;' +
        'var reqId=d.reqId;var reply={source:"fauna-widget",widgetId:' + JSON.stringify(widgetId) + ',type:"snapshot_result",reqId:reqId};' +
        'try{' +
          'var cv=document.querySelector("canvas");' +
          'if(cv&&cv.toDataURL){reply.dataUrl=cv.toDataURL("image/png");parent.postMessage(reply,"*");return;}' +
          'var w=document.documentElement.scrollWidth||640;var h=document.documentElement.scrollHeight||480;' +
          'var svg=\'<svg xmlns="http://www.w3.org/2000/svg" width="\'+w+\'" height="\'+h+\'"><foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml">\'+document.documentElement.outerHTML.replace(/<script[\\s\\S]*?<\\/script>/g,"")+\'</div></foreignObject></svg>\';' +
          'reply.svg=svg;parent.postMessage(reply,"*");' +
        '}catch(err){reply.error=String(err&&err.message||err);parent.postMessage(reply,"*");}' +
      '});' +
      'parent.postMessage({source:"fauna-widget",widgetId:' + JSON.stringify(widgetId) + ',type:"ready"},"*");';

    var bundleScript;
    if (useImportmap) {
      // ES module bundle — top-level `import` works; isolation is automatic.
      // Errors surface via the global error/unhandledrejection handlers.
      bundleScript =
        '<script type="module">\n' + js + '\n<\/script>' +
        '<script type="module">' + glueJs + '<\/script>';
    } else {
      // Classic bundle — wrap in IIFE + try/catch for back-compat with bundles
      // that rely on implicit globals.
      bundleScript =
        '<script>(function(){try{' + js + '}catch(err){' +
          'document.getElementById("root").innerHTML+="<pre style=\\"color:#f85149;white-space:pre-wrap\\">Widget script error: "+(err&&err.message||err)+"</pre>";' +
        '}' + glueJs + '})();<\/script>';
    }

    // Mirror lib/dynamic-widgets.js buildWidgetSrcdoc — kept inline so the
    // frontend doesn't need to round-trip the assembled HTML over the wire.
    return '<!doctype html><html><head>' +
      '<meta charset="utf-8">' +
      '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\' https://cdnjs.cloudflare.com https://unpkg.com https://cdn.jsdelivr.net https://esm.sh; script-src-elem \'unsafe-inline\' https://cdnjs.cloudflare.com https://unpkg.com https://cdn.jsdelivr.net https://esm.sh; style-src \'unsafe-inline\' https://cdnjs.cloudflare.com https://unpkg.com https://cdn.jsdelivr.net; img-src data: blob: https: http://localhost:3737; media-src blob: data: https: http://localhost:3737; font-src data: https://cdnjs.cloudflare.com https://unpkg.com https://cdn.jsdelivr.net; connect-src http://localhost:3737 ws://localhost:3737; frame-src \'none\'">' +
      autoLibTags +
      '<style>html,body{margin:0;padding:0;font-family:system-ui,-apple-system,sans-serif;color:#e6e6e6;background:transparent}' +
      css + '</style></head><body>' +
      '<div id="root" style="width:100vw;height:100vh">' + bodyHtml + '</div>' +
      // Global error handlers — catch SyntaxError + import-loader 404s + uncaught
      // runtime errors + unhandled promise rejections from module bundles.
      '<script>(function(){function show(msg){try{var r=document.getElementById("root");if(!r)return;r.innerHTML+=\'<pre style="color:#f85149;white-space:pre-wrap;font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;padding:8px;margin:8px;border:1px solid rgba(248,81,73,.4);border-radius:6px;background:rgba(248,81,73,.08)">Widget script error: \'+msg+\'</pre>\';}catch(_){}}window.addEventListener("error",function(ev){show((ev&&(ev.message||(ev.error&&ev.error.message)))||"unknown error");});window.addEventListener("unhandledrejection",function(ev){var r=ev&&ev.reason;show((r&&(r.message||String(r)))||"unhandled promise rejection");});})();<\/script>' +
      // Widget API setup — synchronous classic <script> so window.widget is
      // ready before any deferred <script type="module"> bundle runs.
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
      '})();<\/script>' +
      backCompatPreamble +
      bundleScript +
      '</body></html>';
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
    header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 12px;font-size:12px;color:var(--fau-text-dim,#888);background:var(--fau-surface2,#1c1c1c);border-bottom:1px solid var(--fau-border,#2a2a2a)';
    var titleText = evt.title || 'Dynamic Widget';
    var toolsCount = (evt.tools || []).length;
    var btnStyle = 'background:transparent;border:1px solid var(--fau-border,#2a2a2a);color:var(--fau-text-dim,#888);border-radius:6px;padding:3px 7px;font-size:11px;cursor:pointer;display:inline-flex;align-items:center;gap:4px;line-height:1';
    function _esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c];});}
    header.innerHTML =
      '<span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1"><i class="ti ti-bolt" style="margin-right:6px"></i>' +
        _esc(titleText) +
        ' <span style="opacity:0.6">· ' + toolsCount + ' action' + (toolsCount === 1 ? '' : 's') + '</span>' +
      '</span>' +
      '<span style="display:flex;gap:4px;flex-shrink:0">' +
        '<button class="fauna-widget-zoom-out" title="Shrink"        style="' + btnStyle + '"><i class="ti ti-minus"></i></button>' +
        '<button class="fauna-widget-zoom-in"  title="Enlarge"       style="' + btnStyle + '"><i class="ti ti-plus"></i></button>' +
        '<button class="fauna-widget-fs"       title="Fullscreen"    style="' + btnStyle + '"><i class="ti ti-maximize"></i></button>' +
        '<button class="fauna-widget-dl-img"   title="Download image"        style="' + btnStyle + '"><i class="ti ti-photo-down"></i></button>' +
        '<button class="fauna-widget-dl-html"  title="Download HTML"  style="' + btnStyle + '"><i class="ti ti-file-code"></i></button>' +
        '<button class="fauna-widget-save"     title="Save to playbook"      style="' + btnStyle + '"><i class="ti ti-bookmark"></i></button>' +
      '</span>';

    var iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.setAttribute('referrerpolicy', 'no-referrer');
    iframe.setAttribute('loading', 'lazy');
    iframe.style.cssText = 'width:100%;border:0;display:block;height:520px;min-height:420px;background:transparent';
    iframe.srcdoc = _buildSrcdoc(widgetId, evt.bundle);

    // Auto-resize: widgets that emit { source:'fauna-widget', type:'event', event:'resize', data:{height} }
    // will get their iframe height updated.

    wrap.appendChild(header);
    wrap.appendChild(iframe);

    var mount = targetEl || document.body;
    mount.appendChild(wrap);

    window._faunaDynamicWidgets.mounted.set(widgetId, { iframe, wrap, tools: evt.tools || [], bundle: evt.bundle, title: titleText });

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

    // ── Zoom (resize iframe height) ────────────────────────────────────
    var ZOOM_STEP = 120;
    var MIN_H = 240, MAX_H = 2000;
    function _curH() { return parseInt(iframe.style.height, 10) || iframe.offsetHeight || 520; }
    function _setH(h) {
      h = Math.max(MIN_H, Math.min(MAX_H, Math.round(h)));
      iframe.style.height = h + 'px';
    }
    var zoomIn  = header.querySelector('.fauna-widget-zoom-in');
    var zoomOut = header.querySelector('.fauna-widget-zoom-out');
    if (zoomIn)  zoomIn.onclick  = function () { _setH(_curH() + ZOOM_STEP); };
    if (zoomOut) zoomOut.onclick = function () { _setH(_curH() - ZOOM_STEP); };

    // ── Fullscreen ─────────────────────────────────────────────────────
    var fsBtn = header.querySelector('.fauna-widget-fs');
    if (fsBtn) {
      fsBtn.onclick = function () {
        var el = wrap;
        var inFs = document.fullscreenElement === el;
        if (inFs) {
          if (document.exitFullscreen) document.exitFullscreen();
        } else if (el.requestFullscreen) {
          el.requestFullscreen().catch(function () {});
        }
      };
      document.addEventListener('fullscreenchange', function () {
        var inFs = document.fullscreenElement === wrap;
        fsBtn.innerHTML = '<i class="ti ' + (inFs ? 'ti-minimize' : 'ti-maximize') + '"></i>';
        if (inFs) {
          wrap.dataset._prevH = iframe.style.height || '';
          iframe.style.height = '100vh';
        } else if (wrap.dataset._prevH !== undefined) {
          iframe.style.height = wrap.dataset._prevH;
          delete wrap.dataset._prevH;
        }
      });
    }

    // ── Download bundle as standalone .html ───────────────────────────
    var dlHtmlBtn = header.querySelector('.fauna-widget-dl-html');
    if (dlHtmlBtn) {
      dlHtmlBtn.onclick = function () {
        try {
          var html = _buildSrcdoc(widgetId, evt.bundle);
          var blob = new Blob([html], { type: 'text/html' });
          var url = URL.createObjectURL(blob);
          var a = document.createElement('a');
          a.href = url;
          a.download = (titleText || 'widget').replace(/[^a-z0-9-_]+/gi, '_').toLowerCase() + '.html';
          document.body.appendChild(a); a.click(); a.remove();
          setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
        } catch (e) { try { dbg('widget html download failed: ' + (e && e.message), 'err'); } catch (_) {} }
      };
    }

    // ── Download snapshot image (asks widget for canvas/SVG) ──────────
    var dlImgBtn = header.querySelector('.fauna-widget-dl-img');
    if (dlImgBtn) {
      dlImgBtn.onclick = function () {
        var reqId = 'snap_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        var done = false;
        function _onSnap(e) {
          var m = e.data || {};
          if (m.source !== 'fauna-widget' || m.widgetId !== widgetId || m.type !== 'snapshot_result' || m.reqId !== reqId) return;
          if (done) return;
          done = true;
          window.removeEventListener('message', _onSnap);
          var fileBase = (titleText || 'widget').replace(/[^a-z0-9-_]+/gi, '_').toLowerCase();
          if (m.dataUrl) {
            var a = document.createElement('a');
            a.href = m.dataUrl; a.download = fileBase + '.png';
            document.body.appendChild(a); a.click(); a.remove();
          } else if (m.svg) {
            var blob = new Blob([m.svg], { type: 'image/svg+xml' });
            var url = URL.createObjectURL(blob);
            var a2 = document.createElement('a');
            a2.href = url; a2.download = fileBase + '.svg';
            document.body.appendChild(a2); a2.click(); a2.remove();
            setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
          } else {
            try { dbg('widget snapshot empty: ' + (m.error || 'no canvas'), 'warn'); } catch (_) {}
          }
        }
        window.addEventListener('message', _onSnap);
        setTimeout(function () {
          if (done) return;
          done = true;
          window.removeEventListener('message', _onSnap);
          try { dbg('widget snapshot timed out', 'warn'); } catch (_) {}
        }, 4000);
        try {
          iframe.contentWindow.postMessage({ source: 'fauna-host', widgetId: widgetId, type: 'snapshot', reqId: reqId }, '*');
        } catch (e) { done = true; window.removeEventListener('message', _onSnap); }
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
      var h = Math.max(240, Math.min(1600, m.data.height));
      mounted.iframe.style.height = h + 'px';
    }
    if (m.type === 'event' && m.event === 'download' && m.data && m.data.url) {
      // Widgets inside an allow-scripts sandbox cannot trigger downloads
      // themselves. Relay the request through the parent document, which is
      // same-origin with the server and can use the <a download> mechanism.
      try {
        var url = String(m.data.url);
        if (/^\/(?!\/)/.test(url)) url = window.location.origin + url;
        var a = document.createElement('a');
        a.href = url;
        if (m.data.filename) a.download = String(m.data.filename);
        a.rel = 'noopener';
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        setTimeout(function () { try { a.remove(); } catch (_) {} }, 1000);
      } catch (err) {
        console.error('[dynamic-widgets] download relay failed', err);
      }
    }
  });

  // Public API used by public/js/chat.js when it sees the SSE events.
  window.faunaDynamicWidgets = {
    mountWidget: mountWidget,
    handleToolPending: handleToolPending,
    isMounted: function (id) { return window._faunaDynamicWidgets.mounted.has(id); },
  };
})();
