// Fauna offscreen document — system clipboard access without requiring a
// focused tab. The background service worker (which has no DOM) delegates
// clipboard read/write here via runtime messages. Uses a hidden textarea +
// execCommand, the supported MV3 pattern for clipboard from an offscreen doc.

const ta = document.getElementById('clip');

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen-clipboard') return; // not for us
  try {
    if (msg.op === 'write') {
      ta.value = msg.text != null ? String(msg.text) : '';
      ta.focus();
      ta.select();
      const ok = document.execCommand('copy');
      sendResponse({ ok });
    } else if (msg.op === 'read') {
      ta.value = '';
      ta.focus();
      ta.select();
      const ok = document.execCommand('paste');
      sendResponse({ ok, text: ta.value });
    } else {
      sendResponse({ ok: false, error: 'unknown op' });
    }
  } catch (e) {
    sendResponse({ ok: false, error: (e && e.message) || String(e) });
  }
  return true; // keep the message channel open for the response
});
