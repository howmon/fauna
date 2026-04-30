/**
 * Fauna Browser Bridge — content script
 *
 * Injected into every page. Handles DOM extraction, form mapping,
 * interaction (fill / click / scroll / hover / select / keyboard),
 * screenshot stitching, and arbitrary JS evaluation.
 *
 * All communication goes through chrome.runtime.onMessage.
 */

(function () {
  'use strict';

  // Guard: don't double-inject
  if (window.__faunaContentInjected) return;
  window.__faunaContentInjected = true;

  // ── Message dispatcher ──────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    (async () => {
      try {
        let result;
        switch (msg.action) {
          case 'extract':        result = await doExtract(msg); break;
          case 'extract-forms':  result = await doExtractForms(); break;
          case 'extract-assets': result = doExtractAssets(); break;
          case 'fill':          result = await doFill(msg); break;
          case 'click':         result = await doClick(msg); break;
          case 'type':          result = await doType(msg); break;
          case 'scroll':        result = await doScroll(msg); break;
          case 'scroll-to':     result = await doScrollTo(msg); break;
          case 'hover':         result = await doHover(msg); break;
          case 'drag':          result = await doDrag(msg); break;
          case 'select':        result = await doSelect(msg); break;
          case 'keyboard':      result = await doKeyboard(msg); break;
          case 'eval':          result = await doEval(msg); break;
          case 'get-dims':      result = getDims(); break;
          case 'stitch-strips': result = await doStitchStrips(msg); break;
          case 'picker:start':  result = startPicker(); break;
          case 'picker:stop':   result = stopPicker();  break;
          default:              result = { error: 'Unknown action: ' + msg.action };
        }
        reply(result);
      } catch (err) {
        reply({ error: err.message || String(err) });
      }
    })();
    return true; // keep channel open for async
  });

  // ── Extract ─────────────────────────────────────────────────────────────

  function doExtract({ maxChars = 12000 } = {}) {
    const title = document.title || '';
    const url   = location.href;
    const text  = (document.body?.innerText || document.body?.textContent || '').trim();

    const links = Array.from(document.querySelectorAll('a[href]'))
      .slice(0, 200)
      .map(a => ({
        text: (a.innerText || a.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80),
        href: a.href
      }))
      .filter(l => l.href && !l.href.startsWith('javascript') && !l.href.startsWith('data:'));

    const headings = Array.from(document.querySelectorAll('h1,h2,h3'))
      .slice(0, 50)
      .map(h => ({ level: h.tagName.toLowerCase(), text: h.innerText.trim().slice(0, 120) }));

    const images = Array.from(document.querySelectorAll('img[src]'))
      .slice(0, 30)
      .map(i => ({ src: i.src, alt: i.alt || '' }))
      .filter(i => i.src && !i.src.startsWith('data:'));

    // Clickable cards/items — for SPAs that use <button> or role="group" instead of <a href>.
    // Captures Figma folder cards, Notion pages, Google Drive tiles, etc.
    const cards = [];
    // Pattern 1: role="group" containers with aria-label (Figma folder cards)
    document.querySelectorAll('[role="group"][aria-label]').forEach(el => {
      const label = el.getAttribute('aria-label').trim();
      if (!label) return;
      const btn = el.querySelector('[data-card-main-action], button[tabindex="0"]');
      const selector = btn
        ? '[role="group"][aria-label="' + label.replace(/"/g, '\\"') + '"] button[data-card-main-action="true"]'
        : '[role="group"][aria-label="' + label.replace(/"/g, '\\"') + '"]';
      cards.push({ label, selector });
    });
    // Pattern 2: role="listitem" or role="option" with visible text
    if (!cards.length) {
      document.querySelectorAll('[role="listitem"], [role="option"], [role="row"]').forEach(el => {
        const t = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80);
        if (t) cards.push({ label: t, selector: null });
      });
    }

    return {
      title, url,
      text: text.slice(0, maxChars),
      textLength: text.length,
      truncated: text.length > maxChars,
      links,
      headings,
      images,
      cards: cards.slice(0, 100)
    };
  }

  // ── Asset extraction ────────────────────────────────────────────────────

  function doExtractAssets() {
    // Images: <img>, <picture source>, srcset, CSS background-image
    const images = [];
    document.querySelectorAll('img[src]').forEach(el => {
      images.push({ type: 'img', src: el.src, alt: el.alt || '', width: el.naturalWidth, height: el.naturalHeight });
    });
    document.querySelectorAll('picture source[srcset], img[srcset]').forEach(el => {
      el.srcset.split(',').forEach(s => {
        const u = s.trim().split(/\s+/)[0];
        if (u) images.push({ type: 'srcset', src: u });
      });
    });
    // CSS background images from computed styles (sample first 200 elements)
    Array.from(document.querySelectorAll('*')).slice(0, 200).forEach(el => {
      const bg = getComputedStyle(el).backgroundImage;
      if (bg && bg !== 'none') {
        const m = bg.match(/url\(["']?([^"')]+)["']?\)/g);
        if (m) m.forEach(u => {
          const url = u.replace(/url\(["']?|["']?\)/g, '');
          if (url && !url.startsWith('data:')) images.push({ type: 'css-bg', src: url });
        });
      }
    });

    // SVGs: inline elements + external <img src="*.svg">
    const svgs = [];
    document.querySelectorAll('svg').forEach((el, i) => {
      svgs.push({ type: 'inline', index: i, outerHTML: el.outerHTML.slice(0, 8000), id: el.id || null, width: el.getAttribute('width'), height: el.getAttribute('height') });
    });
    document.querySelectorAll('img[src$=".svg"], img[src*=".svg?"]').forEach(el => {
      svgs.push({ type: 'external', src: el.src, alt: el.alt || '' });
    });
    document.querySelectorAll('use[href], use[xlink\\:href]').forEach(el => {
      svgs.push({ type: 'sprite-ref', href: el.getAttribute('href') || el.getAttribute('xlink:href') });
    });

    // Stylesheets: external hrefs + inline <style> content
    const stylesheets = [];
    document.querySelectorAll('link[rel~="stylesheet"][href]').forEach(el => {
      stylesheets.push({ type: 'external', href: el.href, media: el.media || 'all' });
    });
    document.querySelectorAll('style').forEach((el, i) => {
      stylesheets.push({ type: 'inline', index: i, content: el.textContent.slice(0, 20000) });
    });
    // Live CSS rules from document.styleSheets (only same-origin sheets)
    const cssRules = [];
    Array.from(document.styleSheets).forEach(sheet => {
      try {
        if (!sheet.cssRules) return;
        Array.from(sheet.cssRules).slice(0, 200).forEach(rule => {
          cssRules.push(rule.cssText.slice(0, 400));
        });
      } catch (_) {} // cross-origin sheets throw SecurityError
    });

    // CSS custom properties on :root
    const cssVars = {};
    try {
      const style = getComputedStyle(document.documentElement);
      Array.from(document.styleSheets).forEach(sheet => {
        try {
          Array.from(sheet.cssRules || []).forEach(rule => {
            if (rule.style) {
              Array.from(rule.style).filter(p => p.startsWith('--')).forEach(p => {
                cssVars[p] = style.getPropertyValue(p).trim();
              });
            }
          });
        } catch (_) {}
      });
    } catch (_) {}

    // Scripts: external src + inline content
    const scripts = [];
    document.querySelectorAll('script[src]').forEach(el => {
      scripts.push({ type: 'external', src: el.src, async: el.async, defer: el.defer, type: el.type || 'text/javascript' });
    });
    document.querySelectorAll('script:not([src])').forEach((el, i) => {
      const content = el.textContent.trim();
      if (!content) return;
      scripts.push({ type: 'inline', index: i, content });
    });

    return {
      url: location.href,
      title: document.title,
      images:       [...new Map(images.map(x => [x.src, x])).values()].slice(0, 200),
      svgs:         svgs.slice(0, 50),
      stylesheets,
      cssRules:     cssRules.slice(0, 500),
      cssVars,
      scripts,
    };
  }

  // ── Form extraction ─────────────────────────────────────────────────────

  function doExtractForms() {
    const forms = Array.from(document.querySelectorAll('form'));
    const result = forms.length ? forms.map(mapForm) : [mapForm(document.body)];
    return { fields: result.flatMap(f => f.fields), forms: result };
  }

  function mapForm(container) {
    const fields = [];
    const selector = 'input:not([type=hidden]),textarea,select,[contenteditable=true],[contenteditable=""]';
    Array.from(container.querySelectorAll(selector)).forEach(el => {
      const label = resolveLabel(el);
      const type  = el.type || el.tagName.toLowerCase();
      const entry = {
        selector:     uniqueSelector(el),
        type,
        label:        label || '',
        name:         el.name || el.id || '',
        value:        el.value ?? el.textContent?.trim() ?? '',
        placeholder:  el.placeholder || '',
        required:     el.required || false,
        disabled:     el.disabled || false
      };
      if (type === 'select' || el.tagName === 'SELECT') {
        entry.options = Array.from(el.options || []).map(o => ({ value: o.value, text: o.text, selected: o.selected }));
      }
      if (type === 'radio' || type === 'checkbox') {
        entry.checked = el.checked;
      }
      fields.push(entry);
    });
    return { name: container.tagName?.toLowerCase() === 'form' ? (container.id || container.name || 'form') : 'page', fields };
  }

  function resolveLabel(el) {
    // 1. aria-label
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
    // 2. aria-labelledby
    const lbId = el.getAttribute('aria-labelledby');
    if (lbId) {
      const lbEl = document.getElementById(lbId);
      if (lbEl) return lbEl.innerText?.trim() || '';
    }
    // 3. <label for=id>
    if (el.id) {
      const lbl = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (lbl) return lbl.innerText?.trim() || '';
    }
    // 4. Wrapping <label>
    const parent = el.closest('label');
    if (parent) return parent.innerText?.replace(el.value, '').trim() || '';
    // 5. Placeholder
    return el.placeholder || '';
  }

  function uniqueSelector(el) {
    if (el.id) return '#' + CSS.escape(el.id);
    if (el.name) return el.tagName.toLowerCase() + '[name="' + el.name + '"]';
    // Build a path up the DOM
    const parts = [];
    let node = el;
    while (node && node !== document.body) {
      let part = node.tagName.toLowerCase();
      if (node.className) {
        const cls = Array.from(node.classList).slice(0, 2).map(c => '.' + CSS.escape(c)).join('');
        if (cls) part += cls;
      }
      const siblings = node.parentNode ? Array.from(node.parentNode.children).filter(c => c.tagName === node.tagName) : [];
      if (siblings.length > 1) {
        const idx = siblings.indexOf(node) + 1;
        part += ':nth-of-type(' + idx + ')';
      }
      parts.unshift(part);
      node = node.parentNode;
    }
    return parts.join(' > ').slice(-200); // keep selector reasonably short
  }

  // ── Fill ────────────────────────────────────────────────────────────────

  async function doFill({ fields = [] } = {}) {
    const results = [];
    for (const { selector, value } of fields) {
      try {
        const el = resolveElement(selector);
        if (!el) { results.push({ selector, ok: false, error: 'Element not found' }); continue; }

        el.scrollIntoView({ block: 'center' });
        el.focus();

        if (el.tagName === 'SELECT') {
          setSelectValue(el, value);
        } else if (el.type === 'checkbox' || el.type === 'radio') {
          const shouldCheck = value === true || value === 'true' || value === '1' || value === el.value;
          el.checked = shouldCheck;
          el.dispatchEvent(new Event('change', { bubbles: true }));
        } else if (el.contentEditable === 'true' || el.contentEditable === '') {
          el.textContent = value;
          el.dispatchEvent(new InputEvent('input', { bubbles: true, data: value }));
        } else {
          // Handles React/Vue controlled inputs via native value setter
          const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const desc  = Object.getOwnPropertyDescriptor(proto, 'value');
          if (desc && desc.set) {
            desc.set.call(el, value);
          } else {
            el.value = value;
          }
          el.dispatchEvent(new InputEvent('input', { bubbles: true, data: String(value) }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
        results.push({ selector, ok: true });
      } catch (e) {
        results.push({ selector, ok: false, error: e.message });
      }
    }
    return { filled: results };
  }

  function setSelectValue(el, value) {
    // Try by option value first, then by label text
    let found = Array.from(el.options).find(o => o.value === value);
    if (!found) found = Array.from(el.options).find(o => o.text.toLowerCase().includes(String(value).toLowerCase()));
    if (found) {
      el.value = found.value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  // ── Click ───────────────────────────────────────────────────────────────

  async function doClick({ selector, text, x, y } = {}) {
    if (typeof x === 'number' && typeof y === 'number') {
      // Coordinate click
      const el = document.elementFromPoint(x, y);
      if (el) { _simulateClick(el); return { ok: true, method: 'coordinates' }; }
      return { ok: false, error: 'No element at (' + x + ',' + y + ')' };
    }

    const el = resolveElement(selector, text);
    if (!el) {
      // Provide helpful context
      const cands = Array.from(document.querySelectorAll('a,button,[role=button],[role=tab],[role=menuitem],[role=option],[role=listbox] li,ul[role=listbox] > *,.autocomplete-item,.suggestion-item,.dropdown-item,[data-option],[data-value]'))
        .slice(0, 60).map(e => ({ tag: e.tagName.toLowerCase(), text: (e.innerText || '').trim().slice(0, 60), sel: uniqueSelector(e) }));
      return { ok: false, error: 'Element not found: ' + (selector || text), candidates: cands };
    }

    el.scrollIntoView({ block: 'center' });
    el.focus();

    // If it's an anchor with a real href, navigate properly
    if (el.tagName === 'A' && el.href && !el.href.startsWith('javascript')) {
      location.href = el.href;
      return { ok: true, navigated: el.href };
    }

    _simulateClick(el);
    return { ok: true };
  }

  /**
   * Type into a field character-by-character, triggering autocomplete/suggestions.
   * Use after click to focus the field. Optionally pick from the resulting dropdown.
   */
  async function doType({ selector, text, delay = 40, clear = true, pressEnter = false } = {}) {
    const el = selector ? resolveElement(selector) : document.activeElement;
    if (!el) return { ok: false, error: 'Element not found: ' + (selector || 'activeElement') };

    el.scrollIntoView({ block: 'center' });
    _simulateClick(el);
    await _sleep(60);

    // Clear existing value
    if (clear) {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) desc.set.call(el, ''); else el.value = '';
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: '' }));
    }

    // Type character by character
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      el.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));

      // Use native setter to update value (works with React/Vue)
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      const newVal = (el.value || '') + ch;
      if (desc && desc.set) desc.set.call(el, newVal); else el.value = newVal;

      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ch }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true }));
      if (delay > 0) await _sleep(delay);
    }

    // Fire change
    el.dispatchEvent(new Event('change', { bubbles: true }));

    if (pressEnter) {
      await _sleep(100);
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    }

    return { ok: true, typed: text };
  }

  /** Dispatch the full mouse event sequence that frameworks expect. */
  function _simulateClick(el) {
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const shared = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy };
    el.dispatchEvent(new PointerEvent('pointerdown', { ...shared, pointerId: 1 }));
    el.dispatchEvent(new MouseEvent('mousedown', shared));
    el.dispatchEvent(new PointerEvent('pointerup', { ...shared, pointerId: 1 }));
    el.dispatchEvent(new MouseEvent('mouseup', shared));
    el.dispatchEvent(new MouseEvent('click', shared));
  }

  function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ── Scroll ──────────────────────────────────────────────────────────────

  async function doScroll({ direction = 'down', px, selector, behavior = 'smooth' } = {}) {
    const target = selector ? document.querySelector(selector) : window;
    const amount = px || window.innerHeight * 0.8;

    if (selector && !target) return { ok: false, error: 'Scroll target not found: ' + selector };

    const scrollOpts = { behavior };
    if (direction === 'down')  scrollOpts.top =  amount;
    if (direction === 'up')    scrollOpts.top = -amount;
    if (direction === 'right') scrollOpts.left =  amount;
    if (direction === 'left')  scrollOpts.left = -amount;
    if (direction === 'top')   { scrollOpts.top = -999999; scrollOpts.behavior = 'instant'; }
    if (direction === 'bottom'){ scrollOpts.top =  999999; scrollOpts.behavior = 'instant'; }

    if (target === window) {
      window.scrollBy(scrollOpts);
    } else {
      target.scrollBy(scrollOpts);
    }

    return { ok: true, direction, px: amount };
  }

  async function doScrollTo({ y = 0 } = {}) {
    window.scrollTo({ top: y, behavior: 'instant' });
    return { ok: true };
  }

  // ── Hover ───────────────────────────────────────────────────────────────

  async function doHover({ selector } = {}) {
    const el = resolveElement(selector);
    if (!el) return { ok: false, error: 'Element not found: ' + selector };
    el.scrollIntoView({ block: 'center' });
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    return { ok: true };
  }

  // ── Drag and Drop ─────────────────────────────────────────────────────

  async function doDrag({ source, target, sourceX, sourceY, targetX, targetY, steps = 10, delay = 15 } = {}) {
    let srcEl, tgtEl, sx, sy, tx, ty;

    // Resolve source
    if (typeof sourceX === 'number' && typeof sourceY === 'number') {
      srcEl = document.elementFromPoint(sourceX, sourceY);
      sx = sourceX; sy = sourceY;
    } else if (source) {
      srcEl = resolveElement(source);
      if (srcEl) {
        const r = srcEl.getBoundingClientRect();
        sx = r.left + r.width / 2; sy = r.top + r.height / 2;
      }
    }
    if (!srcEl) return { ok: false, error: 'Source element not found: ' + (source || sourceX + ',' + sourceY) };

    // Resolve target
    if (typeof targetX === 'number' && typeof targetY === 'number') {
      tgtEl = document.elementFromPoint(targetX, targetY);
      tx = targetX; ty = targetY;
    } else if (target) {
      tgtEl = resolveElement(target);
      if (tgtEl) {
        const r = tgtEl.getBoundingClientRect();
        tx = r.left + r.width / 2; ty = r.top + r.height / 2;
      }
    }
    if (!tgtEl) return { ok: false, error: 'Target element not found: ' + (target || targetX + ',' + targetY) };

    srcEl.scrollIntoView({ block: 'center' });
    await _sleep(50);

    const shared = { bubbles: true, cancelable: true, view: window };

    // Pointer/mouse down on source
    srcEl.dispatchEvent(new PointerEvent('pointerdown', { ...shared, clientX: sx, clientY: sy, pointerId: 1 }));
    srcEl.dispatchEvent(new MouseEvent('mousedown', { ...shared, clientX: sx, clientY: sy }));

    // HTML5 drag events on source
    const dt = new DataTransfer();
    srcEl.dispatchEvent(new DragEvent('dragstart', { ...shared, clientX: sx, clientY: sy, dataTransfer: dt }));

    // Intermediate move steps
    for (let i = 1; i <= steps; i++) {
      const cx = sx + (tx - sx) * (i / steps);
      const cy = sy + (ty - sy) * (i / steps);
      const moveTarget = document.elementFromPoint(cx, cy) || tgtEl;
      moveTarget.dispatchEvent(new DragEvent('dragover', { ...shared, clientX: cx, clientY: cy, dataTransfer: dt }));
      srcEl.dispatchEvent(new PointerEvent('pointermove', { ...shared, clientX: cx, clientY: cy, pointerId: 1 }));
      srcEl.dispatchEvent(new MouseEvent('mousemove', { ...shared, clientX: cx, clientY: cy }));
      if (delay > 0) await _sleep(delay);
    }

    // Drop on target
    tgtEl.dispatchEvent(new DragEvent('dragover', { ...shared, clientX: tx, clientY: ty, dataTransfer: dt }));
    tgtEl.dispatchEvent(new DragEvent('drop', { ...shared, clientX: tx, clientY: ty, dataTransfer: dt }));
    srcEl.dispatchEvent(new DragEvent('dragend', { ...shared, clientX: tx, clientY: ty, dataTransfer: dt }));

    // Pointer/mouse up on target
    tgtEl.dispatchEvent(new PointerEvent('pointerup', { ...shared, clientX: tx, clientY: ty, pointerId: 1 }));
    tgtEl.dispatchEvent(new MouseEvent('mouseup', { ...shared, clientX: tx, clientY: ty }));

    return { ok: true };
  }

  // ── Select (dropdown) ───────────────────────────────────────────────────

  async function doSelect({ selector, value, values, label } = {}) {
    const el = resolveElement(selector);
    if (!el) return { ok: false, error: 'Element not found: ' + selector };
    if (el.tagName !== 'SELECT') return { ok: false, error: 'Element is not a <select>' };

    // Multi-select: values array
    if (values && Array.isArray(values) && el.multiple) {
      const selected = [];
      Array.from(el.options).forEach(o => { o.selected = false; });
      for (const v of values) {
        let opt = Array.from(el.options).find(o => o.value === v);
        if (!opt) opt = Array.from(el.options).find(o => o.text.toLowerCase().includes(String(v).toLowerCase()));
        if (opt) { opt.selected = true; selected.push(opt.value); }
      }
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, selected };
    }

    setSelectValue(el, value || label || '');
    return { ok: true };
  }

  // ── Keyboard ────────────────────────────────────────────────────────────

  async function doKeyboard({ key, selector } = {}) {
    const target = selector ? resolveElement(selector) : document.activeElement || document.body;
    if (!target) return { ok: false, error: 'No target for keyboard event' };

    const opts = { key, bubbles: true, cancelable: true };
    target.dispatchEvent(new KeyboardEvent('keydown', opts));
    target.dispatchEvent(new KeyboardEvent('keypress', opts));
    target.dispatchEvent(new KeyboardEvent('keyup', opts));

    // Handle Enter on forms
    if (key === 'Enter' && target.tagName === 'INPUT') {
      const form = target.closest('form');
      if (form) {
        const submitBtn = form.querySelector('[type=submit]');
        if (submitBtn) submitBtn.click();
        else form.submit();
      }
    }
    return { ok: true };
  }

  // ── Eval ────────────────────────────────────────────────────────────────

  async function doEval({ js } = {}) {
    if (!js) return { result: '' };
    try {
      // eslint-disable-next-line no-new-func
      const fn  = new Function('return (async function(){\n' + js + '\n})()');
      const res = await fn();
      return { result: res === undefined ? '(undefined)' : String(res) };
    } catch (e) {
      return { result: 'ERROR: ' + e.message };
    }
  }

  // ── Dimensions ─────────────────────────────────────────────────────────

  function getDims() {
    return {
      scrollHeight:   document.documentElement.scrollHeight,
      scrollWidth:    document.documentElement.scrollWidth,
      viewportHeight: window.innerHeight,
      viewportWidth:  window.innerWidth,
      scrollY:        window.scrollY,
      scrollX:        window.scrollX
    };
  }

  // ── Full-page stitch ────────────────────────────────────────────────────

  async function doStitchStrips({ strips = [], totalHeight, viewportHeight } = {}) {
    return new Promise((resolve) => {
      const canvas = document.createElement('canvas');
      const width  = window.innerWidth;
      canvas.width  = width;
      canvas.height = totalHeight;
      const ctx = canvas.getContext('2d');
      let loaded = 0;

      if (!strips.length) { resolve({ base64: '' }); return; }

      strips.forEach(({ dataUrl, scrollY, height }) => {
        const img = new Image();
        img.onload = () => {
          // Crop region: the visible viewport strip at this scroll offset
          // Source y offset within captured image = 0 (we always capture from top of viewport)
          // But we need to account for overlap when scrollHeight isn't a multiple of viewportHeight
          const srcY = (scrollY + viewportHeight > totalHeight)
            ? (viewportHeight - (totalHeight - scrollY))  // partial strip
            : 0;
          ctx.drawImage(img, 0, srcY, width, height, 0, scrollY, width, height);
          loaded++;
          if (loaded === strips.length) {
            try {
              const base64 = canvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, '');
              resolve({ base64 });
            } catch (_) {
              resolve({ base64: '' });
            }
          }
        };
        img.onerror = () => {
          loaded++;
          if (loaded === strips.length) resolve({ base64: '' });
        };
        img.src = dataUrl;
      });
    });
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  function resolveElement(selector, text) {
    if (selector) {
      // Try CSS selector (handles comma-separated)
      try {
        const el = document.querySelector(selector);
        if (el) return el;
      } catch (_) {}
    }
    if (text || selector) {
      // Text content match across interactive elements + dropdown/autocomplete items
      const needle = (text || selector || '').toLowerCase();
      const cands  = document.querySelectorAll(
        'a,button,[role=button],[role=tab],[role=menuitem],[role=option],input[type=submit],label,' +
        '[role=listbox] > *,[role=listbox] li,.autocomplete-item,.suggestion-item,.dropdown-item,' +
        '[data-option],[data-value],li[id*=option],li[id*=result],ul.dropdown li,div.dropdown li,' +
        'div[class*=option],div[class*=suggestion],div[class*=autocomplete] li'
      );
      for (const el of cands) {
        const t = (el.innerText || el.textContent || el.value || el.placeholder || el.getAttribute('data-value') || '').toLowerCase();
        if (t.includes(needle)) return el;
      }
    }
    return null;
  }

  // ── Element Picker ──────────────────────────────────────────────────────
  // Visual crosshair picker: hover highlights elements, click captures them.

  let _pickerActive = false;
  let _pickerOverlay = null;
  let _pickerLabel   = null;
  let _pickerMoveFn  = null;
  let _pickerClickFn = null;
  let _pickerKeyFn   = null;

  function startPicker() {
    if (_pickerActive) return { ok: true };
    _pickerActive = true;

    // Highlight box
    _pickerOverlay = document.createElement('div');
    _pickerOverlay.setAttribute('id', '__fauna_picker_hl__');
    Object.assign(_pickerOverlay.style, {
      position: 'fixed', pointerEvents: 'none', zIndex: '2147483646',
      border: '2px solid #6366f1', background: 'rgba(99,102,241,0.10)',
      borderRadius: '3px', boxSizing: 'border-box', display: 'none',
      transition: 'top 0.04s,left 0.04s,width 0.04s,height 0.04s',
    });
    document.documentElement.appendChild(_pickerOverlay);

    // Tag label
    _pickerLabel = document.createElement('div');
    _pickerLabel.setAttribute('id', '__fauna_picker_lbl__');
    Object.assign(_pickerLabel.style, {
      position: 'fixed', pointerEvents: 'none', zIndex: '2147483647',
      background: '#6366f1', color: '#fff', fontSize: '11px',
      fontFamily: 'ui-monospace,monospace', padding: '2px 7px',
      borderRadius: '3px', display: 'none',
      maxWidth: '320px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    });
    document.documentElement.appendChild(_pickerLabel);

    _pickerMoveFn = (e) => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el || el === _pickerOverlay || el === _pickerLabel) return;
      const r = el.getBoundingClientRect();
      Object.assign(_pickerOverlay.style, {
        display: 'block', left: r.left + 'px', top: r.top + 'px',
        width: r.width + 'px', height: r.height + 'px',
      });
      const sel = uniqueSelector(el);
      _pickerLabel.textContent = el.tagName.toLowerCase() + (sel.length < 50 ? '  ' + sel : '');
      const lx = Math.min(e.clientX, window.innerWidth - 330);
      const ly = r.top > 24 ? r.top - 22 : r.bottom + 4;
      Object.assign(_pickerLabel.style, { display: 'block', left: lx + 'px', top: ly + 'px' });
    };

    _pickerClickFn = (e) => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el || el === _pickerOverlay || el === _pickerLabel) return;
      e.preventDefault(); e.stopPropagation();
      stopPicker();
      const r = el.getBoundingClientRect();
      const attrs = {};
      for (const a of el.attributes) attrs[a.name] = a.value;
      const data = {
        selector:   uniqueSelector(el),
        tag:        el.tagName.toLowerCase(),
        id:         el.id || null,
        classes:    Array.from(el.classList).join(' '),
        text:       (el.innerText || el.textContent || '').trim().slice(0, 800),
        html:       el.outerHTML.slice(0, 6000),
        rect:       { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) },
        attributes: attrs,
        url:        location.href,
        pageTitle:  document.title,
      };
      chrome.runtime.sendMessage({ type: 'picker:selected', data });
    };

    _pickerKeyFn = (e) => {
      if (e.key === 'Escape') { stopPicker(); chrome.runtime.sendMessage({ type: 'picker:cancelled' }); }
    };

    document.addEventListener('mousemove', _pickerMoveFn,  true);
    document.addEventListener('click',     _pickerClickFn, true);
    document.addEventListener('keydown',   _pickerKeyFn,   true);
    document.documentElement.style.cursor = 'crosshair';
    return { ok: true };
  }

  function stopPicker() {
    if (!_pickerActive) return { ok: true };
    _pickerActive = false;
    _pickerOverlay?.remove(); _pickerOverlay = null;
    _pickerLabel?.remove();   _pickerLabel   = null;
    if (_pickerMoveFn)  document.removeEventListener('mousemove', _pickerMoveFn,  true);
    if (_pickerClickFn) document.removeEventListener('click',     _pickerClickFn, true);
    if (_pickerKeyFn)   document.removeEventListener('keydown',   _pickerKeyFn,   true);
    _pickerMoveFn = _pickerClickFn = _pickerKeyFn = null;
    document.documentElement.style.cursor = '';
    return { ok: true };
  }

})();
