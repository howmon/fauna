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
          case 'extract':       result = await doExtract(msg); break;
          case 'extract-forms': result = await doExtractForms(); break;
          case 'fill':          result = await doFill(msg); break;
          case 'click':         result = await doClick(msg); break;
          case 'scroll':        result = await doScroll(msg); break;
          case 'scroll-to':     result = await doScrollTo(msg); break;
          case 'hover':         result = await doHover(msg); break;
          case 'select':        result = await doSelect(msg); break;
          case 'keyboard':      result = await doKeyboard(msg); break;
          case 'eval':          result = await doEval(msg); break;
          case 'get-dims':      result = getDims(); break;
          case 'stitch-strips': result = await doStitchStrips(msg); break;
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

    return {
      title, url,
      text: text.slice(0, maxChars),
      textLength: text.length,
      truncated: text.length > maxChars,
      links,
      headings,
      images
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
      if (el) { el.click(); return { ok: true, method: 'coordinates' }; }
      return { ok: false, error: 'No element at (' + x + ',' + y + ')' };
    }

    const el = resolveElement(selector, text);
    if (!el) {
      // Provide helpful context
      const cands = Array.from(document.querySelectorAll('a,button,[role=button],[role=tab],[role=menuitem]'))
        .slice(0, 40).map(e => ({ tag: e.tagName.toLowerCase(), text: (e.innerText || '').trim().slice(0, 60), sel: uniqueSelector(e) }));
      return { ok: false, error: 'Element not found: ' + (selector || text), candidates: cands };
    }

    el.scrollIntoView({ block: 'center' });
    el.focus();

    // If it's an anchor with a real href, navigate properly
    if (el.tagName === 'A' && el.href && !el.href.startsWith('javascript')) {
      location.href = el.href;
      return { ok: true, navigated: el.href };
    }

    el.click();
    return { ok: true };
  }

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

  // ── Select (dropdown) ───────────────────────────────────────────────────

  async function doSelect({ selector, value, label } = {}) {
    const el = resolveElement(selector);
    if (!el) return { ok: false, error: 'Element not found: ' + selector };
    if (el.tagName !== 'SELECT') return { ok: false, error: 'Element is not a <select>' };
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
      // Text content match across common interactive elements
      const needle = (text || selector || '').toLowerCase();
      const cands  = document.querySelectorAll('a,button,[role=button],[role=tab],[role=menuitem],[role=option],input[type=submit],label');
      for (const el of cands) {
        const t = (el.innerText || el.textContent || el.value || el.placeholder || '').toLowerCase();
        if (t.includes(needle)) return el;
      }
    }
    return null;
  }

})();
