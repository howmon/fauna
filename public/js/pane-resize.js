// ── Shared pane-resize helper ─────────────────────────────────────────────
// Centralizes the drag-to-resize behavior used by sidebar, artifact pane,
// browser pane, tasks/auto nav column, project hub and project-run split.
//
// Why this exists: the original implementations attached mousemove/mouseup
// to `document`, which fails the moment the cursor passes over an <iframe>
// or <webview> (artifact HTML previews, design frames, browser-pane webview).
// Those elements swallow the events, so the handle stays "stuck" until you
// click again. This helper switches to Pointer Events with
// `setPointerCapture`, which guarantees every pointermove/pointerup is
// delivered to the handle regardless of what's underneath. It also toggles a
// `body.is-resizing` class that disables pointer-events on iframes/webviews
// as a belt-and-suspenders backup.
//
// API:
//   installPaneResize({
//     handle,                  // HTMLElement — the drag grip
//     getStartWidth(),         // () => number — pane width at drag start
//     onMove(dx, startW, e),   // (dx, startW, ev) => void — apply new width
//     onEnd(e),                // (ev) => void — persist + cleanup
//     classTarget,             // HTMLElement to toggle '.resizing' on
//     onDoubleClick,           // optional — () => void
//   });

(function () {
  function installPaneResize(opts) {
    var handle = opts.handle;
    if (!handle) return;

    handle.addEventListener('pointerdown', function (e) {
      // Left button only; ignore touch-tap context, etc.
      if (e.button !== undefined && e.button !== 0) return;
      e.preventDefault();
      var startX = e.clientX;
      var startW = opts.getStartWidth();
      try { handle.setPointerCapture(e.pointerId); } catch (_) {}
      if (opts.classTarget) opts.classTarget.classList.add('resizing');
      document.body.classList.add('is-resizing');

      function onMove(ev) {
        opts.onMove(ev.clientX - startX, startW, ev);
      }
      function cleanup(ev) {
        try { handle.releasePointerCapture(e.pointerId); } catch (_) {}
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', cleanup);
        handle.removeEventListener('pointercancel', cleanup);
        handle.removeEventListener('lostpointercapture', cleanup);
        if (opts.classTarget) opts.classTarget.classList.remove('resizing');
        document.body.classList.remove('is-resizing');
        if (opts.onEnd) opts.onEnd(ev);
      }
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', cleanup);
      handle.addEventListener('pointercancel', cleanup);
      handle.addEventListener('lostpointercapture', cleanup);
    });

    if (opts.onDoubleClick) {
      handle.addEventListener('dblclick', opts.onDoubleClick);
    }
  }

  window.installPaneResize = installPaneResize;
}());
