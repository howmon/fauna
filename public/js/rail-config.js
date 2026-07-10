// ── App-rail feature configuration ────────────────────────────────────────
// Lets the user choose which primary-navigation (rail) items are visible and
// in what order. Home is pinned to the top and can never be hidden or moved.
//
// Persisted to localStorage under `fauna-rail-config`:
//   { order: [pageId, …], hidden: [pageId, …] }
// Both lists reference rail items by their `data-rail-page` id (excluding
// "home"). Any rail item not present in a saved config is treated as a new
// item and appended (visible) so future features surface by default.
//
// The Settings ▸ Features page and an in-rail long-press drag interaction both
// read/write this same config through applyRailConfig().

(function () {
  'use strict';

  var STORAGE_KEY = 'fauna-rail-config';

  // Rail item ids that are ALWAYS visible / fixed and never user-managed.
  // "home" is pinned to the very top of the rail.
  var PINNED_TOP = 'home';

  // By default every managed feature is visible. Users can hide/reorder them
  // from Settings ▸ Features or from the rail context menu.
  var DEFAULT_VISIBLE = null;
  var OLD_DEFAULT_VISIBLE = ['conversations', 'board'];

  // Ordered list of manageable rail item ids as they appear in the markup.
  // Derived from the DOM so it stays in sync with index.html.
  function railItemIds() {
    var top = document.querySelector('.app-rail-top');
    if (!top) return [];
    return Array.prototype.slice
      .call(top.querySelectorAll('.app-rail-btn[data-rail-page]:not(.app-rail-overflow-btn)'))
      .map(function (b) { return b.dataset.railPage; })
      .filter(function (id) { return id && id !== PINNED_TOP; });
  }

  function railButton(id) {
    return document.querySelector('.app-rail-top .app-rail-btn[data-rail-page="' + id + '"]');
  }

  function labelFor(id) {
    var b = railButton(id);
    return (b && (b.getAttribute('title') || b.getAttribute('aria-label'))) || id;
  }

  function iconClassFor(id) {
    var b = railButton(id);
    var i = b && b.querySelector('.ti');
    return i ? i.className : 'ti ti-square';
  }

  // ── Config load / save ───────────────────────────────────────────────────
  function loadRaw() {
    try {
      var raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (raw && Array.isArray(raw.order) && Array.isArray(raw.hidden)) return raw;
    } catch (_) {}
    return null;
  }

  function sameItems(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every(function (id) { return b.indexOf(id) !== -1; });
  }

  // Returns a normalized config: { order, hidden } covering exactly the rail
  // items currently present in the DOM. New items are appended; the default
  // (no saved config) keeps every managed feature visible.
  function getRailConfig() {
    var ids = railItemIds();
    var raw = loadRaw();

    if (!raw) {
      var hiddenDefault = DEFAULT_VISIBLE
        ? ids.filter(function (id) { return DEFAULT_VISIBLE.indexOf(id) === -1; })
        : [];
      return { order: ids.slice(), hidden: hiddenDefault };
    }

    var oldHiddenDefault = ids.filter(function (id) { return OLD_DEFAULT_VISIBLE.indexOf(id) === -1; });
    if (DEFAULT_VISIBLE === null && sameItems(raw.hidden, oldHiddenDefault)) {
      raw.hidden = [];
    }

    // Keep saved order for known ids, then append any brand-new items (visible).
    var order = raw.order.filter(function (id) { return ids.indexOf(id) !== -1; });
    ids.forEach(function (id) { if (order.indexOf(id) === -1) order.push(id); });

    var hidden = raw.hidden.filter(function (id) { return ids.indexOf(id) !== -1; });
    return { order: order, hidden: hidden };
  }

  function saveRailConfig(cfg) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ order: cfg.order, hidden: cfg.hidden })); } catch (_) {}
  }

  function isHidden(id, cfg) {
    cfg = cfg || getRailConfig();
    return cfg.hidden.indexOf(id) !== -1;
  }

  function featureListOrder(cfg) {
    cfg = cfg || getRailConfig();
    var hidden = cfg.hidden || [];
    return cfg.order.filter(function (id) { return hidden.indexOf(id) === -1; })
      .concat(cfg.order.filter(function (id) { return hidden.indexOf(id) !== -1; }));
  }

  // ── Apply config to the live rail ────────────────────────────────────────
  // Reorders the button elements (Home stays pinned at the top, the overflow
  // ellipsis stays last) and toggles the `rail-user-hidden` class.
  function applyRailConfig(cfg) {
    cfg = cfg || getRailConfig();
    var top = document.querySelector('.app-rail-top');
    if (!top) return;
    var overflow = document.getElementById('app-rail-overflow-btn');
    var homeBtn = railButton(PINNED_TOP);

    // Reorder: place each configured item in order, after Home, before overflow.
    var anchor = homeBtn || top.querySelector('.app-rail-brand');
    var prev = anchor;
    cfg.order.forEach(function (id) {
      var b = railButton(id);
      if (!b) return;
      // insert b right after prev
      if (prev && prev.nextSibling !== b) top.insertBefore(b, prev.nextSibling);
      prev = b;
    });
    // Ensure overflow button remains the final child.
    if (overflow) top.appendChild(overflow);

    // Visibility
    cfg.order.forEach(function (id) {
      var b = railButton(id);
      if (!b) return;
      b.classList.toggle('rail-user-hidden', cfg.hidden.indexOf(id) !== -1);
    });

    if (typeof window.layoutAppRail === 'function') window.layoutAppRail();
  }

  function setItemHidden(id, hidden) {
    if (id === PINNED_TOP) return;
    var cfg = getRailConfig();
    var i = cfg.hidden.indexOf(id);
    if (hidden && i === -1) cfg.hidden.push(id);
    else if (!hidden && i !== -1) cfg.hidden.splice(i, 1);
    cfg.order = featureListOrder(cfg);
    saveRailConfig(cfg);
    applyRailConfig(cfg);
    renderRailFeaturesPage();
  }

  // Move item id to a new index within the order (0-based, among manageable
  // items). Home is never part of this list.
  function moveItem(id, toIndex) {
    var cfg = getRailConfig();
    var order = featureListOrder(cfg);
    var from = order.indexOf(id);
    if (from === -1) return;
    order.splice(from, 1);
    toIndex = Math.max(0, Math.min(order.length, toIndex));
    order.splice(toIndex, 0, id);
    cfg.order = order;
    saveRailConfig(cfg);
    applyRailConfig(cfg);
    renderRailFeaturesPage();
  }

  function moveVisibleItem(id, delta) {
    var cfg = getRailConfig();
    if (cfg.hidden.indexOf(id) !== -1) return;
    var visible = cfg.order.filter(function (item) { return cfg.hidden.indexOf(item) === -1; });
    var hidden = cfg.order.filter(function (item) { return cfg.hidden.indexOf(item) !== -1; });
    var from = visible.indexOf(id);
    if (from === -1) return;
    var to = Math.max(0, Math.min(visible.length - 1, from + delta));
    if (to === from) return;
    visible.splice(from, 1);
    visible.splice(to, 0, id);
    cfg.order = visible.concat(hidden);
    saveRailConfig(cfg);
    applyRailConfig(cfg);
    renderRailFeaturesPage();
  }

  function resetRailConfig() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
    applyRailConfig();
    renderRailFeaturesPage();
  }

  // ── Settings ▸ Features page ─────────────────────────────────────────────
  function renderRailFeaturesPage() {
    var mount = document.getElementById('rail-features-list');
    if (!mount) return;
    var cfg = getRailConfig();
    mount.innerHTML = '';

    // Pinned Home row (informational — not draggable / not toggleable).
    var homeRow = document.createElement('div');
    homeRow.className = 'rail-feat-row rail-feat-pinned';
    homeRow.innerHTML =
      '<span class="rail-feat-grip" aria-hidden="true"><i class="ti ti-lock"></i></span>' +
      '<i class="' + iconClassFor(PINNED_TOP) + ' rail-feat-icon"></i>' +
      '<span class="rail-feat-name">' + labelFor(PINNED_TOP) + '</span>' +
      '<span class="rail-feat-pinned-tag">Pinned</span>';
    mount.appendChild(homeRow);

    featureListOrder(cfg).forEach(function (id) {
      var hidden = cfg.hidden.indexOf(id) !== -1;
      var row = document.createElement('div');
      row.className = 'rail-feat-row';
      row.draggable = true;
      row.dataset.railItem = id;
      row.innerHTML =
        '<span class="rail-feat-grip" aria-hidden="true"><i class="ti ti-grip-vertical"></i></span>' +
        '<i class="' + iconClassFor(id) + ' rail-feat-icon"></i>' +
        '<span class="rail-feat-name">' + labelFor(id) + '</span>' +
        '<label class="rail-feat-switch"><input type="checkbox"' + (hidden ? '' : ' checked') + '>' +
        '<span class="rail-feat-slider"></span></label>';
      var chk = row.querySelector('input');
      chk.addEventListener('change', function () { setItemHidden(id, !chk.checked); });
      _wireRowDrag(row, mount);
      mount.appendChild(row);
    });
  }

  // HTML5 drag-and-drop reordering for the settings list rows.
  var _dragRow = null;
  function _wireRowDrag(row, mount) {
    row.addEventListener('dragstart', function (e) {
      _dragRow = row;
      row.classList.add('rail-feat-dragging');
      try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', row.dataset.railItem); } catch (_) {}
    });
    row.addEventListener('dragend', function () {
      row.classList.remove('rail-feat-dragging');
      mount.querySelectorAll('.rail-feat-row.rail-feat-drop-before, .rail-feat-row.rail-feat-drop-after')
        .forEach(function (r) { r.classList.remove('rail-feat-drop-before', 'rail-feat-drop-after'); });
      _dragRow = null;
    });
    row.addEventListener('dragover', function (e) {
      if (!_dragRow || _dragRow === row) return;
      e.preventDefault();
      var r = row.getBoundingClientRect();
      var after = (e.clientY - r.top) > r.height / 2;
      row.classList.toggle('rail-feat-drop-after', after);
      row.classList.toggle('rail-feat-drop-before', !after);
    });
    row.addEventListener('dragleave', function () {
      row.classList.remove('rail-feat-drop-before', 'rail-feat-drop-after');
    });
    row.addEventListener('drop', function (e) {
      e.preventDefault();
      if (!_dragRow || _dragRow === row) return;
      var r = row.getBoundingClientRect();
      var after = (e.clientY - r.top) > r.height / 2;
      var cfg = getRailConfig();
      var dragHidden = cfg.hidden.indexOf(_dragRow.dataset.railItem) !== -1;
      var targetHidden = cfg.hidden.indexOf(row.dataset.railItem) !== -1;
      if (dragHidden !== targetHidden) return;
      var order = featureListOrder(cfg);
      var targetIdx = order.indexOf(row.dataset.railItem);
      if (after) targetIdx += 1;
      // Account for removal of the dragged item shifting indices.
      var fromIdx = order.indexOf(_dragRow.dataset.railItem);
      if (fromIdx < targetIdx) targetIdx -= 1;
      order.splice(fromIdx, 1);
      order.splice(targetIdx, 0, _dragRow.dataset.railItem);
      cfg.order = order;
      saveRailConfig(cfg);
      applyRailConfig(cfg);
      renderRailFeaturesPage();
    });
  }

  // ── In-rail long-press drag reordering ───────────────────────────────────
  // Long-press (>350ms) on a rail button enters reorder mode; dragging shows a
  // drop indicator between buttons and reorders on release. Home is excluded.
  var LONG_PRESS_MS = 350;
  var _lp = null; // { id, timer, active, ghost, indicator }

  function _clearLongPress() {
    if (!_lp) return;
    if (_lp.timer) clearTimeout(_lp.timer);
    if (_lp.ghost && _lp.ghost.parentNode) _lp.ghost.parentNode.removeChild(_lp.ghost);
    if (_lp.indicator && _lp.indicator.parentNode) _lp.indicator.parentNode.removeChild(_lp.indicator);
    document.body.classList.remove('rail-reordering');
    if (_lp && _lp.moveGuard) document.removeEventListener('pointermove', _lp.moveGuard);
    document.removeEventListener('pointermove', _onLpMove);
    document.removeEventListener('pointerup', _onLpUp);
    document.removeEventListener('pointercancel', _clearLongPress);
    _lp = null;
  }

  function _draggableButtons() {
    var cfg = getRailConfig();
    return cfg.order
      .filter(function (id) { return cfg.hidden.indexOf(id) === -1; })
      .map(function (id) { return railButton(id); })
      .filter(function (b) { return b && !b.classList.contains('rail-hidden'); });
  }

  function _onRailPointerDown(e) {
    if (e.button != null && e.button !== 0) return;
    var btn = e.target.closest('.app-rail-btn[data-rail-page]');
    if (!btn) return;
    var id = btn.dataset.railPage;
    if (!id || id === PINNED_TOP || btn.classList.contains('app-rail-overflow-btn')) return;
    if (isHidden(id)) return;

    var startX = e.clientX, startY = e.clientY;
    _lp = { id: id, btn: btn, active: false, timer: null };
    _lp.timer = setTimeout(function () {
      if (!_lp) return;
      _lp.active = true;
      document.body.classList.add('rail-reordering');
      btn.classList.add('rail-drag-source');
      // Drop indicator line
      var ind = document.createElement('div');
      ind.className = 'rail-drop-indicator';
      document.body.appendChild(ind);
      _lp.indicator = ind;
      _positionIndicator(e.clientY);
      if (navigator.vibrate) { try { navigator.vibrate(8); } catch (_) {} }
    }, LONG_PRESS_MS);

    var moveGuard = function (ev) {
      // If the pointer moves too far before long-press fires, cancel (treat as click/scroll).
      if (_lp && !_lp.active) {
        var dx = Math.abs(ev.clientX - startX), dy = Math.abs(ev.clientY - startY);
        if (dx > 6 || dy > 6) _clearLongPress();
      }
    };
    _lp.moveGuard = moveGuard;
    document.addEventListener('pointermove', moveGuard);
    document.addEventListener('pointermove', _onLpMove);
    document.addEventListener('pointerup', _onLpUp);
    document.addEventListener('pointercancel', _clearLongPress);
  }

  function _positionIndicator(clientY) {
    if (!_lp || !_lp.indicator) return;
    var btns = _draggableButtons();
    var target = null, before = true;
    for (var i = 0; i < btns.length; i++) {
      var r = btns[i].getBoundingClientRect();
      if (clientY < r.top + r.height / 2) { target = btns[i]; before = true; break; }
      target = btns[i]; before = false;
    }
    if (!target) return;
    var tr = target.getBoundingClientRect();
    var y = before ? tr.top - 3 : tr.bottom + 1;
    _lp.indicator.style.left = (tr.left - 3) + 'px';
    _lp.indicator.style.top = y + 'px';
    _lp.indicator.style.width = (tr.width + 6) + 'px';
    _lp._dropTarget = target;
    _lp._dropBefore = before;
  }

  function _onLpMove(e) {
    if (!_lp || !_lp.active) return;
    e.preventDefault();
    _positionIndicator(e.clientY);
  }

  function _onLpUp() {
    if (_lp && _lp.active && _lp._dropTarget) {
      var cfg = getRailConfig();
      var targetId = _lp._dropTarget.dataset.railPage;
      var targetIdx = cfg.order.indexOf(targetId);
      if (!_lp._dropBefore) targetIdx += 1;
      var fromIdx = cfg.order.indexOf(_lp.id);
      if (fromIdx < targetIdx) targetIdx -= 1;
      if (_lp.btn) _lp.btn.classList.remove('rail-drag-source');
      moveItem(_lp.id, targetIdx);
    }
    _clearLongPress();
  }

  function _initRailDrag() {
    var rail = document.querySelector('.app-rail-top');
    if (!rail) return;
    rail.addEventListener('pointerdown', _onRailPointerDown);
  }

  // ── Rail right-click menu ────────────────────────────────────────────────
  var _ctxMenu = null;

  function _visibleIds(cfg) {
    cfg = cfg || getRailConfig();
    return cfg.order.filter(function (id) { return cfg.hidden.indexOf(id) === -1; });
  }

  function _closeRailContextMenu() {
    if (_ctxMenu && _ctxMenu.parentNode) _ctxMenu.parentNode.removeChild(_ctxMenu);
    _ctxMenu = null;
    document.removeEventListener('mousedown', _onRailContextOutside);
    document.removeEventListener('contextmenu', _onRailContextOutside);
    document.removeEventListener('keydown', _onRailContextKeydown);
  }

  function _onRailContextOutside(e) {
    if (_ctxMenu && _ctxMenu.contains(e.target)) return;
    _closeRailContextMenu();
  }

  function _onRailContextKeydown(e) {
    if (e.key === 'Escape') _closeRailContextMenu();
  }

  function _railContextItem(icon, label, disabled, action) {
    var item = document.createElement('button');
    item.type = 'button';
    item.className = 'app-rail-context-item' + (disabled ? ' disabled' : '');
    item.disabled = !!disabled;
    item.innerHTML = '<i class="ti ' + icon + '"></i><span>' + label + '</span>';
    if (!disabled) {
      item.addEventListener('click', function (e) {
        e.stopPropagation();
        _closeRailContextMenu();
        action();
      });
    }
    return item;
  }

  function _showRailContextMenu(id, x, y) {
    var cfg = getRailConfig();
    var visible = _visibleIds(cfg);
    var idx = visible.indexOf(id);
    if (idx === -1) return;
    _closeRailContextMenu();
    var menu = document.createElement('div');
    menu.className = 'app-rail-context-menu';
    menu.setAttribute('role', 'menu');
    menu.appendChild(_railContextItem('ti-eye-off', 'Hide from rail', false, function () { setItemHidden(id, true); }));
    menu.appendChild(_railContextItem('ti-arrow-up', 'Move up', idx <= 0, function () { moveVisibleItem(id, -1); }));
    menu.appendChild(_railContextItem('ti-arrow-down', 'Move down', idx >= visible.length - 1, function () { moveVisibleItem(id, 1); }));
    document.body.appendChild(menu);
    _ctxMenu = menu;
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
    var r = menu.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(x, window.innerWidth - r.width - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) + 'px';
    setTimeout(function () {
      document.addEventListener('mousedown', _onRailContextOutside);
      document.addEventListener('contextmenu', _onRailContextOutside);
      document.addEventListener('keydown', _onRailContextKeydown);
    }, 0);
  }

  function _initRailContextMenu() {
    var rail = document.querySelector('.app-rail-top');
    if (!rail) return;
    rail.addEventListener('contextmenu', function (e) {
      var btn = e.target.closest('.app-rail-btn[data-rail-page]');
      if (!btn) return;
      var id = btn.dataset.railPage;
      if (!id || id === PINNED_TOP || btn.classList.contains('app-rail-overflow-btn')) return;
      if (isHidden(id)) return;
      e.preventDefault();
      e.stopPropagation();
      _showRailContextMenu(id, e.clientX, e.clientY);
    });
  }

  // ── Boot ─────────────────────────────────────────────────────────────────
  function boot() {
    applyRailConfig();
    _initRailDrag();
    _initRailContextMenu();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  // Public API
  window.getRailConfig = getRailConfig;
  window.applyRailConfig = applyRailConfig;
  window.renderRailFeaturesPage = renderRailFeaturesPage;
  window.resetRailConfig = resetRailConfig;
  window.railItemHidden = isHidden;
})();
