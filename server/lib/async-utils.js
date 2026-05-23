// ── Small shared async helpers ────────────────────────────────────────────
// Used by automation pipelines (heartbeat, workflows, chat tool dispatch) to
// bound runtime and recover from transient failures without hanging the
// caller's event loop.

/**
 * Race a promise against a timeout. Resolves/rejects with whichever wins.
 * On timeout, rejects with an Error whose `code` is 'ETIMEDOUT'.
 *
 * @param {Promise<any>} promise
 * @param {number} ms                — hard cap in milliseconds
 * @param {string} [label='operation']  — used in the timeout message
 * @returns {Promise<any>}
 */
export function withTimeout(promise, ms, label = 'operation') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(label + ' timed out after ' + ms + 'ms');
      err.code = 'ETIMEDOUT';
      reject(err);
    }, ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Retry a thunk with exponential backoff. Stops on success or after
 * `attempts` total tries. Does NOT retry if the error's `code` is in
 * `nonRetryable` (e.g. ETIMEDOUT can be retried, but auth errors can't).
 *
 * @param {() => Promise<any>} fn
 * @param {object} [opts]
 * @param {number} [opts.attempts=3]
 * @param {number} [opts.baseMs=500]    — initial delay; doubles each retry
 * @param {number} [opts.maxMs=5000]    — cap on per-attempt backoff
 * @param {string[]} [opts.nonRetryable=[]]  — error codes that abort immediately
 * @returns {Promise<any>}
 */
export async function withRetry(fn, opts = {}) {
  const attempts     = Math.max(1, opts.attempts ?? 3);
  const baseMs       = opts.baseMs ?? 500;
  const maxMs        = opts.maxMs ?? 5000;
  const nonRetryable = new Set(opts.nonRetryable || []);
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (e && nonRetryable.has(e.code)) throw e;
      if (i === attempts - 1) break;
      const delay = Math.min(maxMs, baseMs * Math.pow(2, i));
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}
