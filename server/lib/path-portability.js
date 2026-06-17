// ── Path Portability — cross-OS path token rewriting for sync ──────────────
//
// Problem: project.rootPath is an absolute filesystem path. On macOS it's
// "/Users/alice/Documents/Fauna/MyProj"; on Windows it's
// "C:\\Users\\alice\\Documents\\Fauna\\MyProj". Syncing the raw absolute
// path corrupts the project record on the other machine.
//
// Solution: when serializing a sync payload we rewrite known-home-relative
// prefixes to symbolic tokens. When applying a sync payload we rewrite them
// back using the local machine's homedir. Local storage and the in-process
// code paths (path-traversal checks etc.) always see absolute paths — we
// only ever touch the value on the wire.
//
// Recognized tokens (most-specific first):
//   ${FAUNA_HOME}/<rest>    →  <home>/Documents/Fauna/<rest>   (where Fauna's
//                              auto-created project folders live)
//   ${USER_DOCS}/<rest>     →  <home>/Documents/<rest>
//   ${HOME}/<rest>          →  <home>/<rest>
//
// Anything that doesn't start with one of those prefixes is returned with
// `device_local: true` so the receiving machine knows to prompt the user
// to relocate it (e.g. a user-imported repo at /opt/work).

import os from 'os';
import path from 'path';

const POSIX_SEP = '/';

function _home() {
  // Allow override for tests.
  return process.env.FAUNA_TEST_HOME || os.homedir();
}

// Normalize to forward slashes for token matching. Tokens are stored with
// posix separators on the wire so a payload written on Windows applies
// cleanly on macOS and vice-versa.
function _toPosix(p) {
  if (!p || typeof p !== 'string') return '';
  return p.replace(/\\/g, '/');
}

// Resolve a posix-style relative tail against the local platform's path
// separator. Returns an absolute path using path.join (which inserts the
// correct separator per OS).
function _resolveLocal(rest) {
  const home = _home();
  const segments = rest.split(POSIX_SEP).filter(Boolean);
  return path.join(home, ...segments);
}

/**
 * Convert an absolute local path to a portable token form.
 *
 * @param {string} abs - absolute path on this machine
 * @returns {{ token: string, deviceLocal: boolean, original: string }}
 *   token: the wire form (either "${PREFIX}/rest..." or the original if not portable)
 *   deviceLocal: true when the path lives outside the recognized roots
 *   original: the input, for diagnostic round-trip checks
 */
export function toPortable(abs) {
  const original = abs;
  const posixAbs = _toPosix(abs || '');
  const home = _toPosix(_home());

  if (!posixAbs) return { token: '', deviceLocal: false, original };

  // Fauna's auto-folder. Most specific — check first.
  const faunaRoot = `${home}/Documents/Fauna/`;
  if (posixAbs === faunaRoot.replace(/\/$/, '') || posixAbs.startsWith(faunaRoot)) {
    const rest = posixAbs.slice(faunaRoot.length);
    return { token: `\${FAUNA_HOME}/${rest}`.replace(/\/$/, ''), deviceLocal: false, original };
  }

  const docs = `${home}/Documents/`;
  if (posixAbs === docs.replace(/\/$/, '') || posixAbs.startsWith(docs)) {
    const rest = posixAbs.slice(docs.length);
    return { token: `\${USER_DOCS}/${rest}`.replace(/\/$/, ''), deviceLocal: false, original };
  }

  if (posixAbs === home || posixAbs.startsWith(home + '/')) {
    const rest = posixAbs.slice(home.length + 1);
    return { token: `\${HOME}/${rest}`.replace(/\/$/, ''), deviceLocal: false, original };
  }

  // Outside any known root — keep the raw path but mark it as needing user
  // attention on the receiving side.
  return { token: posixAbs, deviceLocal: true, original };
}

/**
 * Resolve a portable token to an absolute path on the current machine.
 *
 * @param {string} token - the wire form from toPortable()
 * @returns {{ path: string, deviceLocal: boolean }}
 *   path: absolute, using the local platform's separators
 *   deviceLocal: true if the token wasn't a recognized prefix; the receiving
 *                client should treat the path as a hint and prompt the user.
 */
export function fromPortable(token) {
  if (!token || typeof token !== 'string') return { path: '', deviceLocal: false };

  if (token.startsWith('${FAUNA_HOME}/')) {
    return { path: _resolveLocal('Documents/Fauna/' + token.slice('${FAUNA_HOME}/'.length)), deviceLocal: false };
  }
  if (token === '${FAUNA_HOME}') {
    return { path: _resolveLocal('Documents/Fauna'), deviceLocal: false };
  }
  if (token.startsWith('${USER_DOCS}/')) {
    return { path: _resolveLocal('Documents/' + token.slice('${USER_DOCS}/'.length)), deviceLocal: false };
  }
  if (token === '${USER_DOCS}') {
    return { path: _resolveLocal('Documents'), deviceLocal: false };
  }
  if (token.startsWith('${HOME}/')) {
    return { path: _resolveLocal(token.slice('${HOME}/'.length)), deviceLocal: false };
  }
  if (token === '${HOME}') {
    return { path: _home(), deviceLocal: false };
  }

  // Raw absolute path from another machine. We don't trust it for traversal
  // — caller should treat as deviceLocal and ask the user to relocate.
  return { path: token, deviceLocal: true };
}

/**
 * Walk an object and rewrite the keys listed in `keys` from absolute paths
 * to portable tokens. Returns a deep copy; the input is not mutated.
 * Unknown / device-local paths are annotated with a sibling
 * `<key>_deviceLocal: true` flag so the receiver can prompt.
 */
export function serializeForWire(obj, keys = ['rootPath']) {
  if (obj == null || typeof obj !== 'object') return obj;
  const out = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj)) {
    if (keys.includes(k) && typeof v === 'string' && v) {
      const portable = toPortable(v);
      out[k] = portable.token;
      if (portable.deviceLocal) out[`${k}_deviceLocal`] = true;
    } else if (v && typeof v === 'object') {
      out[k] = serializeForWire(v, keys);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Inverse of serializeForWire — rewrites tokens back to absolute paths
 * for the current machine. Preserves the `_deviceLocal` flags so the
 * applying code can decide whether to surface a "relocate" prompt.
 */
export function deserializeFromWire(obj, keys = ['rootPath']) {
  if (obj == null || typeof obj !== 'object') return obj;
  const out = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj)) {
    if (keys.includes(k) && typeof v === 'string' && v) {
      const local = fromPortable(v);
      out[k] = local.path;
      // Preserve the explicit flag if it was already there; else infer.
      const flagKey = `${k}_deviceLocal`;
      if (obj[flagKey] !== undefined) {
        out[flagKey] = obj[flagKey];
      } else if (local.deviceLocal) {
        out[flagKey] = true;
      }
    } else if (v && typeof v === 'object') {
      out[k] = deserializeFromWire(v, keys);
    } else {
      out[k] = v;
    }
  }
  return out;
}
