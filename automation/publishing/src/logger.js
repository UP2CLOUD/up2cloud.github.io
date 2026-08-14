'use strict';

/**
 * Redacting logger.
 *
 * Every log line passes through `redact()` before it is emitted, so a secret
 * that accidentally ends up inside an error message, an API response body or a
 * stack trace never reaches CI logs. Redaction is value-based (we scrub the
 * actual secret strings we know about) rather than key-based, because the most
 * common leak path is an upstream API echoing a token back inside prose.
 */

const SECRET_ENV_KEYS = [
  'GEMINI_API_KEY',
  'LINKEDIN_CLIENT_ID',
  'LINKEDIN_CLIENT_SECRET',
  'LINKEDIN_ACCESS_TOKEN',
  'LINKEDIN_REFRESH_TOKEN',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_ACCOUNT_ID',
  'BREVO_API_KEY',
  'GROQ_API_KEY',
  'CEREBRAS_API_KEY',
];

/** Secrets shorter than this are too generic to scrub without mangling logs. */
const MIN_REDACTABLE_LENGTH = 8;

/** Token-shaped strings we scrub even if we never saw them in the environment. */
const TOKEN_PATTERNS = [
  /\bAIzaSy[A-Za-z0-9_-]{33}\b/g, // Google (Gemini) API key
  /\bAQ[A-Za-z0-9_-]{40,}/g, // LinkedIn access tokens
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub
  /\bxkeysib-[A-Za-z0-9]{16,}/g, // Brevo
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/gi,
];

function collectSecrets(env = process.env) {
  const out = [];
  for (const key of SECRET_ENV_KEYS) {
    const value = env[key];
    if (typeof value === 'string' && value.trim().length >= MIN_REDACTABLE_LENGTH) {
      out.push(value.trim());
    }
  }
  // Longest first so an overlapping prefix does not leave a tail behind.
  return out.sort((a, b) => b.length - a.length);
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replace every known secret value and token-shaped substring with `[REDACTED]`.
 * Accepts any value; objects are JSON-serialised first so nested secrets are
 * caught too.
 */
function redact(value, env = process.env) {
  let text;
  if (typeof value === 'string') {
    text = value;
  } else if (value instanceof Error) {
    text = value.stack || `${value.name}: ${value.message}`;
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  if (typeof text !== 'string') return text;

  for (const secret of collectSecrets(env)) {
    text = text.replace(new RegExp(escapeRegExp(secret), 'g'), '[REDACTED]');
  }
  for (const pattern of TOKEN_PATTERNS) {
    text = text.replace(pattern, '[REDACTED]');
  }
  return text;
}

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function createLogger(options = {}) {
  const minLevel = LEVELS[options.level || process.env.LOG_LEVEL || 'info'] ?? LEVELS.info;
  const stream = options.stream || process.stdout;
  const errStream = options.errStream || process.stderr;
  const env = options.env || process.env;
  const context = options.context || {};

  function emit(level, message, fields) {
    if (LEVELS[level] < minLevel) return;
    const line = {
      ts: new Date().toISOString(),
      level,
      msg: redact(message, env),
      ...context,
    };
    if (fields && typeof fields === 'object') {
      for (const [k, v] of Object.entries(fields)) {
        line[k] = typeof v === 'string' || v instanceof Error ? redact(v, env) : v;
      }
    }
    const target = level === 'error' ? errStream : stream;
    target.write(`${JSON.stringify(line)}\n`);
  }

  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    /** Derive a logger that stamps extra fields (e.g. runId) on every line. */
    child: (extra) => createLogger({ ...options, context: { ...context, ...extra } }),
  };
}

module.exports = { createLogger, redact, SECRET_ENV_KEYS };
