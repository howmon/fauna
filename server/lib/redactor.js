// ── Secret/PII redactor (Phase 6) ────────────────────────────────────────
//
// Pure, dependency-free, deterministic scrubber. Designed to run on
// anything we're about to persist to disk (memory facts, playbook bundles)
// or send across a trust boundary. Recognises high-confidence token
// patterns (cloud keys, JWTs, PEM private keys, OAuth client secrets,
// bearer headers, key=value secrets) and rewrites each match to
// `[REDACTED:<TYPE>]`.
//
// Conservative by design: only patterns where false-positive rate is
// near-zero are on by default. Email + phone scrubbing is opt-in
// because users routinely want the assistant to remember contacts.
//
// Returns `{ text, redactions, count, mutated }` so callers can decide
// whether to drop the input entirely, surface a warning, or annotate
// the stored record.

const PATTERNS = [
  // ── Asymmetric keys / certs ─────────────────────────────────────
  // Whole PEM-encoded private key blocks (RSA, EC, DSA, OPENSSH, generic).
  { type: 'PEM_PRIVATE_KEY',
    re:   /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP |)PRIVATE KEY(?: BLOCK)?-----[\s\S]+?-----END [^-]*PRIVATE KEY(?: BLOCK)?-----/g },
  // Inline SSH authorized_keys-style private blob is rare; covered above.

  // ── Cloud provider keys ─────────────────────────────────────────
  { type: 'AWS_ACCESS_KEY_ID',  re: /\bAKIA[0-9A-Z]{16}\b/g },
  { type: 'AWS_ACCESS_KEY_ID',  re: /\bASIA[0-9A-Z]{16}\b/g },  // temp/session IDs
  { type: 'GOOGLE_API_KEY',     re: /\bAIza[0-9A-Za-z_\-]{35}\b/g },
  { type: 'AZURE_CLIENT_SECRET',re: /\b[A-Za-z0-9~_\-.]{34,40}\.[A-Za-z0-9~_\-.]{0,2}\b(?=\s*(?:["';,}\]]|$))/g, // weak, see note
    enabled: false }, // disabled — too noisy without ctx

  // ── SaaS tokens with hard prefixes ──────────────────────────────
  { type: 'GITHUB_PAT_CLASSIC', re: /\bgh[pousr]_[A-Za-z0-9]{36,251}\b/g },
  { type: 'GITHUB_PAT_FINE',    re: /\bgithub_pat_[A-Za-z0-9_]{82}\b/g },
  { type: 'SLACK_TOKEN',        re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { type: 'STRIPE_LIVE_SECRET', re: /\bsk_live_[A-Za-z0-9]{20,}\b/g },
  { type: 'STRIPE_TEST_SECRET', re: /\bsk_test_[A-Za-z0-9]{20,}\b/g },
  { type: 'STRIPE_WEBHOOK',     re: /\bwhsec_[A-Za-z0-9]{20,}\b/g },
  { type: 'ANTHROPIC_API_KEY',  re: /\bsk-ant-[A-Za-z0-9_\-]{20,}\b/g },
  // OpenAI-style: sk- followed by ≥20 chars but NOT sk_test/sk_live (those caught above).
  // Match `sk-` then either `proj-…` or raw token; require letters AND digits to reduce
  // false positives on things like "sk-something-friendly".
  { type: 'OPENAI_API_KEY',     re: /\bsk-(?:proj-)?(?=[A-Za-z0-9_\-]*[A-Za-z])(?=[A-Za-z0-9_\-]*[0-9])[A-Za-z0-9_\-]{20,}\b/g },

  // ── JWT (three base64url segments) ──────────────────────────────
  { type: 'JWT',                re: /\beyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\b/g },

  // ── Authorization headers ───────────────────────────────────────
  // Match `Bearer <token>` keeping the literal "Bearer " prefix so the
  // surrounding text still scans. Token must be ≥20 chars to avoid
  // catching legit short examples like `Bearer demo`.
  { type: 'BEARER_TOKEN',
    re:      /\b(Bearer)\s+([A-Za-z0-9._\-]{20,})/g,
    replace: (_m, p) => `${p} [REDACTED:BEARER_TOKEN]` },

  // ── Generic key=value secrets (catch-all, lowest priority) ──────
  // Replaces ONLY the value (capture group), keeping the key visible.
  // Triggers on key names that strongly imply secret material; value
  // must be ≥12 chars and contain at least one digit + one letter to
  // skip placeholder strings like "your-token-here".
  { type: 'GENERIC_SECRET_KV',
    re:      /\b(api[_\-]?key|api[_\-]?secret|client[_\-]?secret|access[_\-]?key|private[_\-]?key|secret(?:_key)?|token|password|passwd|pwd)\s*[:=]\s*["']?((?=[^\s"']*[A-Za-z])(?=[^\s"']*[0-9])[A-Za-z0-9_\-./+=]{12,})["']?/gi,
    replace: (_m, key) => `${key}=[REDACTED:GENERIC_SECRET]` },
];

// Opt-in patterns: PII that users frequently want preserved.
const PII_PATTERNS = {
  email: { type: 'EMAIL', re: /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g },
  phone: { type: 'PHONE', re: /\b(?:\+?\d{1,3}[\s.\-]?)?\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}\b/g },
  // 13-19 digit numbers with separators; Luhn-checked in matcher below.
  creditCard: { type: 'CREDIT_CARD', re: /\b(?:\d[ \-]?){13,19}\b/g, luhn: true },
};

/**
 * Scrub secrets/PII from a text blob.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {boolean} [opts.email=false]       — redact email addresses
 * @param {boolean} [opts.phone=false]       — redact phone numbers
 * @param {boolean} [opts.creditCard=true]   — redact Luhn-valid card numbers
 * @returns {{ text: string, redactions: Array<{type:string,count:number}>, count: number, mutated: boolean }}
 */
export function scrubSecrets(text, opts = {}) {
  if (typeof text !== 'string' || !text) {
    return { text: text || '', redactions: [], count: 0, mutated: false };
  }
  const enable = {
    email:      !!opts.email,
    phone:      !!opts.phone,
    creditCard: opts.creditCard !== false,
  };
  const counts = new Map();
  let out = text;

  // Pass 1: high-confidence patterns
  for (const p of PATTERNS) {
    if (p.enabled === false) continue;
    let local = 0;
    out = out.replace(p.re, (...args) => {
      local++;
      if (typeof p.replace === 'function') return p.replace(...args);
      return `[REDACTED:${p.type}]`;
    });
    if (local) counts.set(p.type, (counts.get(p.type) || 0) + local);
  }

  // Pass 2: opt-in PII
  for (const [name, conf] of Object.entries(PII_PATTERNS)) {
    if (!enable[name]) continue;
    let local = 0;
    out = out.replace(conf.re, (m) => {
      if (conf.luhn && !_luhnValid(m)) return m;
      local++;
      return `[REDACTED:${conf.type}]`;
    });
    if (local) counts.set(conf.type, (counts.get(conf.type) || 0) + local);
  }

  const redactions = [...counts.entries()].map(([type, count]) => ({ type, count }));
  const total = redactions.reduce((s, r) => s + r.count, 0);
  return { text: out, redactions, count: total, mutated: total > 0 };
}

/** Quick boolean: does this text contain anything we'd redact? */
export function containsSecret(text, opts = {}) {
  return scrubSecrets(text, opts).count > 0;
}

// Luhn checksum for credit-card validation.
function _luhnValid(raw) {
  const digits = String(raw).replace(/[^\d]/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0, alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}
