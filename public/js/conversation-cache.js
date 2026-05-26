// ── Conversation cache ────────────────────────────────────────────────────
// Two backends behind a flag, chosen at boot:
//
//   localStorage['fauna-conv-client-storage'] = 'localstorage' (default)
//                                             | 'indexeddb'
//
// Default behavior is byte-for-byte identical to the old single-key
// `fauna-convs` localStorage layout so existing users see zero change.
//
// IndexedDB mode keeps a slim metadata index in localStorage
// (key: `fauna-convs-index`) so that `state.conversations` can still be
// populated synchronously at boot; message bodies, archived messages, and
// artifacts live in the IDB object store keyed by conversation id.
//
// All operations are best-effort: failures fall back to localStorage so a
// broken IndexedDB never bricks the app.

window.FaunaConvCache = (function () {
  var LEGACY_KEY = 'fauna-convs';
  var INDEX_KEY = 'fauna-convs-index';
  var DB_NAME = 'fauna-conversations';
  var STORE = 'bodies';
  var DB_VERSION = 1;

  function getMode() {
    try { return localStorage.getItem('fauna-conv-client-storage') || 'localstorage'; }
    catch (_) { return 'localstorage'; }
  }

  // ── Slim metadata projection ─────────────────────────────────────────────
  function slim(conv) {
    return {
      id: conv.id,
      title: conv.title,
      model: conv.model,
      projectId: conv.projectId || null,
      createdAt: conv.createdAt,
      updatedAt: conv.updatedAt,
      titleManual: conv.titleManual,
      titleSource: conv.titleSource,
      titleUpdatedAt: conv.titleUpdatedAt,
      messageCount: Array.isArray(conv.messages) ? conv.messages.length : 0,
    };
  }

  // ── IndexedDB helpers ────────────────────────────────────────────────────
  var _dbPromise = null;
  function openDB() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise(function (resolve, reject) {
      try {
        var req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = function () {
          var db = req.result;
          if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
        };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error || new Error('indexedDB open failed')); };
      } catch (e) { reject(e); }
    });
    _dbPromise.catch(function () { _dbPromise = null; });
    return _dbPromise;
  }

  function idbPut(conv) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(conv);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error); };
      });
    });
  }

  function idbDelete(id) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete(id);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  function idbGet(id) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, 'readonly');
        var req = tx.objectStore(STORE).get(id);
        req.onsuccess = function () { resolve(req.result || null); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  function idbGetAll() {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, 'readonly');
        var req = tx.objectStore(STORE).getAll();
        req.onsuccess = function () { resolve(req.result || []); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  // ── Sync boot read ──────────────────────────────────────────────────────
  // Returns the array of conversations to seed `state.conversations` with.
  // In legacy mode this is the full bodies. In IDB mode this is the slim
  // index — bodies are hydrated asynchronously via `hydrateBodies()`.
  function loadSync() {
    if (getMode() === 'indexeddb') {
      try {
        var idx = JSON.parse(localStorage.getItem(INDEX_KEY) || '[]');
        if (Array.isArray(idx)) return idx.map(function (r) {
          // Seed with empty messages so existing code that reads
          // conv.messages doesn't crash before hydration completes.
          return Object.assign({ messages: [] }, r);
        });
      } catch (_) { /* fall through */ }
    }
    try {
      var raw = localStorage.getItem(LEGACY_KEY) || '[]';
      var parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) { return []; }
  }

  // ── Async body hydration ────────────────────────────────────────────────
  // Fills in messages/archivedMessages/artifacts for each conv in the
  // provided array (mutating in place). No-op in legacy mode.
  function hydrateBodies(convs) {
    if (getMode() !== 'indexeddb') return Promise.resolve(false);
    return idbGetAll().then(function (bodies) {
      var byId = Object.create(null);
      bodies.forEach(function (b) { if (b && b.id) byId[b.id] = b; });
      var changed = false;
      convs.forEach(function (conv) {
        var body = byId[conv.id];
        if (body) {
          // Merge body fields into existing slim row.
          ['messages', 'archivedMessages', 'artifacts', 'systemPrompt', 'contextSummary']
            .forEach(function (k) { if (k in body) conv[k] = body[k]; });
          changed = true;
        }
      });
      return changed;
    }).catch(function () { return false; });
  }

  // ── Save ────────────────────────────────────────────────────────────────
  // Persists the full conversation array. In legacy mode this is the same
  // single-key write with shrinking-fallback. In IDB mode it writes the
  // slim index synchronously and the bodies async (fire-and-forget).
  function saveAll(convs, serializeForStorage) {
    if (getMode() === 'indexeddb') {
      // Slim index — always succeeds at any realistic size.
      try {
        localStorage.setItem(INDEX_KEY, JSON.stringify(convs.map(slim)));
      } catch (_) { /* swallow; bodies still go to IDB */ }
      // Bodies — best-effort.
      var serialized = convs.map(function (c) {
        return serializeForStorage(c, { recentLimit: 9999, archiveLimit: 9999, keepAttachments: true });
      });
      Promise.all(serialized.map(idbPut)).catch(function () {
        // If IDB is broken, fall back to legacy single-key write so data
        // isn't lost.
        try { localStorage.setItem(LEGACY_KEY, JSON.stringify(serialized)); } catch (_) {}
      });
      return;
    }
    // Legacy mode — caller already implements shrinking fallback; we just
    // expose the key it should write to.
  }

  function saveOne(conv, serializeForStorage) {
    if (getMode() !== 'indexeddb') return;
    var body = serializeForStorage(conv, { recentLimit: 9999, archiveLimit: 9999, keepAttachments: true });
    idbPut(body).catch(function () {});
  }

  function removeOne(id) {
    if (getMode() !== 'indexeddb') return;
    idbDelete(id).catch(function () {});
  }

  // ── Mode switching ──────────────────────────────────────────────────────
  // Opt-in migration: copies current localStorage convs into IDB and flips
  // the flag. Reversible: switching back to legacy doesn't touch IDB data.
  function enableIndexedDB(convs) {
    if (!window.indexedDB) return Promise.reject(new Error('indexedDB not available'));
    return openDB().then(function () {
      var bodies = convs.map(function (c) { return Object.assign({}, c); });
      return Promise.all(bodies.map(idbPut)).then(function () {
        localStorage.setItem(INDEX_KEY, JSON.stringify(convs.map(slim)));
        localStorage.setItem('fauna-conv-client-storage', 'indexeddb');
      });
    });
  }

  function disableIndexedDB() {
    localStorage.setItem('fauna-conv-client-storage', 'localstorage');
    // Leave IDB data alone for safety / rollback. Caller should call
    // saveConversations() afterward to refresh the legacy key.
  }

  return {
    getMode: getMode,
    loadSync: loadSync,
    hydrateBodies: hydrateBodies,
    saveAll: saveAll,
    saveOne: saveOne,
    removeOne: removeOne,
    enableIndexedDB: enableIndexedDB,
    disableIndexedDB: disableIndexedDB,
    INDEX_KEY: INDEX_KEY,
    LEGACY_KEY: LEGACY_KEY,
  };
})();
