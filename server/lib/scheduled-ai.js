// server/lib/scheduled-ai.js
// Shared wrapper for background AI calls made by the scheduler-style modules
// (heartbeat.js, workflow-manager.js). Centralises:
//   • withTimeout + withRetry from async-utils.js (PR2.1 / PR2.3)
//   • power-save acquire/release around the call (PR4.4)
// Returns whatever the underlying aiCaller returns (string or chat-completion
// object) — parsing/transformation is left to the caller.

import { withTimeout, withRetry } from './async-utils.js';

/**
 * @typedef {object} RunScheduledAIOptions
 * @property {(prompt: string, model?: string) => Promise<any>} aiCaller
 * @property {string} prompt
 * @property {string} [model]
 * @property {string} [label]        Used in withTimeout error messages.
 * @property {number} [timeoutMs]    Per-attempt timeout. Default 30000.
 * @property {number} [attempts]     Retry count. Default 3.
 * @property {number} [baseMs]       Retry base delay. Default 1000.
 * @property {number} [maxMs]        Retry max delay. Default 15000.
 * @property {{ acquire: () => void, release: () => void } | null} [powerSave]
 *   Optional ref-counted guard from server/lib/power-save.js. acquire() is
 *   called before the first attempt and release() in finally.
 */

/**
 * @param {RunScheduledAIOptions} opts
 * @returns {Promise<any>}
 */
export async function runScheduledAI(opts) {
  const {
    aiCaller,
    prompt,
    model,
    label = 'scheduled AI call',
    timeoutMs = 30000,
    attempts = 3,
    baseMs = 1000,
    maxMs = 15000,
    powerSave = null,
  } = opts;

  if (typeof aiCaller !== 'function') {
    throw new Error('runScheduledAI: aiCaller is required');
  }

  let held = false;
  try {
    if (powerSave && typeof powerSave.acquire === 'function') {
      try { powerSave.acquire(); held = true; } catch (_) { /* non-fatal */ }
    }
    return await withRetry(
      () => withTimeout(aiCaller(prompt, model), timeoutMs, label),
      { attempts, baseMs, maxMs }
    );
  } finally {
    if (held) {
      try { powerSave.release(); } catch (_) { /* non-fatal */ }
    }
  }
}
