'use strict';

const path = require('node:path');

/**
 * Environment + run-mode configuration.
 *
 * Validation is split by *capability* rather than validating everything up
 * front: a `--dry-run` that never calls LinkedIn should not demand LinkedIn
 * credentials, and `verify`-only invocations should not demand a model
 * provider key. `requireFor()` is therefore called lazily by each stage.
 */

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

/** Publish modes, ordered by how much autonomy they grant. */
const MODES = Object.freeze({
  /** Run the pipeline, write nothing, call no mutating API. */
  DRY_RUN: 'dry-run',
  /** Generate + commit to a branch, open a PR, stop there. Never merges. */
  DRAFT: 'draft',
  /** Draft + auto-merge once CI is green, but stop before LinkedIn. */
  REVIEW: 'review',
  /** Full pipeline through LinkedIn. */
  AUTO: 'auto',
});

const VALID_MODES = new Set(Object.values(MODES));

/** Stages, in execution order. Used for resume-from-last-incomplete. */
const STAGES = Object.freeze([
  'select_topic',
  'research',
  'brief',
  'draft',
  'review',
  'validate',
  'localize',
  'publish_blog',
  'verify_deployment',
  'publish_linkedin',
]);

const DEFAULTS = Object.freeze({
  publishIntervalHours: 48,
  topicCooldownDays: 45,
  minWords: 1200,
  maxWords: 2200,
  lockTtlSeconds: 45 * 60,
  maxAttemptsPerStage: 3,
  siteBaseUrl: 'https://up2cloud.tech',
  geminiModel: 'gemini-2.5-pro',
  geminiApiVersion: 'v1beta',
  groqModel: 'llama-3.3-70b-versatile',
  cerebrasModel: 'gpt-oss-120b',
  linkedinApiVersion: '202508',
  utmCampaign: 'up2cloud_blog',
});

function parseBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function parseIntOr(value, fallback) {
  const n = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Which env vars each capability needs. Checked lazily via `requireFor()` so a
 * dry run never fails on a LinkedIn credential it will never use.
 */
const CAPABILITY_REQUIREMENTS = Object.freeze({
  gemini: ['GEMINI_API_KEY'],
  groq: ['GROQ_API_KEY'],
  cerebras: ['CEREBRAS_API_KEY'],
  model: [],
  linkedin: ['LINKEDIN_ACCESS_TOKEN', 'LINKEDIN_ORGANIZATION_URN'],
  linkedinOAuth: ['LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET'],
  git: ['GITHUB_TOKEN'],
  kvState: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_KV_NAMESPACE_ID'],
});

/**
 * The capabilities a mode will certainly need. Lets the CLI check credentials
 * up front rather than discovering a missing LinkedIn token *after* the model
 * spend — with an article half-published and the schedule clock ambiguous.
 */
function requiredCapabilitiesForMode(mode, stateBackend = 'file') {
  const caps = ['model'];
  if (mode !== MODES.DRY_RUN) caps.push('git');
  if (mode === MODES.AUTO) caps.push('linkedin');
  if (stateBackend === 'kv') caps.push('kvState');
  return caps;
}

function loadConfig(env = process.env, argv = {}) {
  const mode = String(argv.mode || env.PUBLISH_MODE || MODES.DRAFT).trim().toLowerCase();
  if (!VALID_MODES.has(mode)) {
    throw new ConfigError(
      `Invalid mode "${mode}". Expected one of: ${[...VALID_MODES].join(', ')}`,
    );
  }

  // Kill switch is deliberately checked from two sources: an env var (fast,
  // settable as a repo variable without a commit) and a committed flag file
  // (auditable, works when the runner has no access to repo settings).
  const killSwitch =
    parseBool(env.AUTOPUBLISH_DISABLED, false) || parseBool(env.PUBLISH_KILL_SWITCH, false);

  const organizationUrn = (env.LINKEDIN_ORGANIZATION_URN || '').trim();
  if (organizationUrn && !/^urn:li:organization:\d+$/.test(organizationUrn)) {
    throw new ConfigError(
      'LINKEDIN_ORGANIZATION_URN must look like "urn:li:organization:12345678"',
    );
  }

  const siteBaseUrl = (env.SITE_BASE_URL || DEFAULTS.siteBaseUrl).replace(/\/+$/, '');
  if (!/^https:\/\//.test(siteBaseUrl)) {
    throw new ConfigError('SITE_BASE_URL must be an https:// URL');
  }

  const config = {
    mode,
    killSwitch,
    dryRun: mode === MODES.DRY_RUN || parseBool(argv.dryRun, false),
    repoRoot: env.REPO_ROOT ? path.resolve(env.REPO_ROOT) : REPO_ROOT,
    siteBaseUrl,

    publishIntervalHours: parseIntOr(env.PUBLISH_INTERVAL_HOURS, DEFAULTS.publishIntervalHours),
    topicCooldownDays: parseIntOr(env.TOPIC_COOLDOWN_DAYS, DEFAULTS.topicCooldownDays),
    minWords: parseIntOr(env.MIN_WORDS, DEFAULTS.minWords),
    maxWords: parseIntOr(env.MAX_WORDS, DEFAULTS.maxWords),
    lockTtlSeconds: parseIntOr(env.LOCK_TTL_SECONDS, DEFAULTS.lockTtlSeconds),
    maxAttemptsPerStage: parseIntOr(env.MAX_ATTEMPTS_PER_STAGE, DEFAULTS.maxAttemptsPerStage),

    gemini: {
      apiKey: env.GEMINI_API_KEY || '',
      // Model is configured through GEMINI_MODEL so the pinned version can be
      // rolled forward without a code change.
      model: (env.GEMINI_MODEL || DEFAULTS.geminiModel).trim(),
      apiVersion: env.GEMINI_API_VERSION || DEFAULTS.geminiApiVersion,
      baseUrl: (env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com').replace(/\/+$/, ''),
      maxRetries: parseIntOr(env.GEMINI_MAX_RETRIES, 4),
    },

    groq: {
      apiKey: env.GROQ_API_KEY || '',
      model: (env.GROQ_MODEL || DEFAULTS.groqModel).trim(),
      baseUrl: (env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/+$/, ''),
      maxRetries: parseIntOr(env.GROQ_MAX_RETRIES, 4),
      maxOutputTokens: parseIntOr(env.GROQ_MAX_OUTPUT_TOKENS, 8192),
      envPrefix: 'GROQ',
    },

    // Open-source-model fallback: Cerebras hosts open-weight models free of
    // charge, with its own quota separate from Gemini/Groq. Same
    // OpenAI-compatible client as Groq, just pointed at a different host.
    // The catalog is account-scoped — check GET /v1/models before changing
    // the default model.
    cerebras: {
      apiKey: env.CEREBRAS_API_KEY || '',
      model: (env.CEREBRAS_MODEL || DEFAULTS.cerebrasModel).trim(),
      baseUrl: (env.CEREBRAS_BASE_URL || 'https://api.cerebras.ai/v1').replace(/\/+$/, ''),
      maxRetries: parseIntOr(env.CEREBRAS_MAX_RETRIES, 4),
      maxOutputTokens: parseIntOr(env.CEREBRAS_MAX_OUTPUT_TOKENS, 8192),
      envPrefix: 'CEREBRAS',
    },

    linkedin: {
      accessToken: env.LINKEDIN_ACCESS_TOKEN || '',
      refreshToken: env.LINKEDIN_REFRESH_TOKEN || '',
      clientId: env.LINKEDIN_CLIENT_ID || '',
      clientSecret: env.LINKEDIN_CLIENT_SECRET || '',
      organizationUrn,
      apiVersion: (env.LINKEDIN_API_VERSION || DEFAULTS.linkedinApiVersion).trim(),
      redirectUri: env.LINKEDIN_REDIRECT_URI || '',
      tokenExpiresAt: env.LINKEDIN_TOKEN_EXPIRES_AT || '',
      maxRetries: parseIntOr(env.LINKEDIN_MAX_RETRIES, 5),
    },

    git: {
      token: env.GITHUB_TOKEN || env.GH_TOKEN || '',
      repository: env.GITHUB_REPOSITORY || 'UP2CLOUD/up2cloud.github.io',
      baseBranch: env.GIT_BASE_BRANCH || 'main',
      authorName: env.GIT_AUTHOR_NAME || 'up2cloud-autopublish[bot]',
      authorEmail: env.GIT_AUTHOR_EMAIL || 'automation@up2cloud.tech',
    },

    state: {
      // "file" keeps the ledger in-repo (git push is the CAS primitive).
      // "kv" uses Cloudflare KV, which the site already depends on.
      backend: (env.STATE_BACKEND || 'file').trim().toLowerCase(),
      filePath:
        env.STATE_FILE_PATH ||
        path.join(REPO_ROOT, 'automation', 'publishing', 'state', 'ledger.json'),
      cloudflare: {
        apiToken: env.CLOUDFLARE_API_TOKEN || '',
        accountId: env.CLOUDFLARE_ACCOUNT_ID || '',
        namespaceId: env.CLOUDFLARE_KV_NAMESPACE_ID || '',
      },
    },

    utm: {
      source: 'linkedin',
      medium: 'organic_social',
      campaign: (env.UTM_CAMPAIGN || DEFAULTS.utmCampaign).trim(),
    },

    forcedTopic: (argv.topic || env.FORCE_TOPIC || '').trim() || null,
    runId: argv.runId || env.RUN_ID || null,
    resumeRunId: (argv.resume || env.RESUME_RUN_ID || '').trim() || null,
  };

  if (config.minWords >= config.maxWords) {
    throw new ConfigError('MIN_WORDS must be less than MAX_WORDS');
  }

  /**
   * Assert the env vars for a capability are present. Called by the stage that
   * actually needs them, so unrelated missing credentials never block a run.
   */
  /**
   * Non-throwing counterpart to `requireFor`. Lets a caller ask "is this
   * wired up?" and choose to degrade, rather than having to catch an
   * exception to find out.
   */
  config.hasCapability = function hasCapability(capability) {
    const required = CAPABILITY_REQUIREMENTS[capability];
    if (!required) return false;
    return required.every((k) => String(env[k] || '').trim());
  };

  config.requireFor = function requireFor(capability) {
    const required = CAPABILITY_REQUIREMENTS[capability];
    if (!required) throw new ConfigError(`Unknown capability "${capability}"`);
    if (capability === 'model') {
      if (!config.gemini.apiKey && !config.groq.apiKey && !config.cerebras.apiKey) {
        throw new ConfigError(
          'Missing model credentials: set GEMINI_API_KEY, GROQ_API_KEY, or CEREBRAS_API_KEY',
        );
      }
      return true;
    }
    const missing = required.filter((k) => !String(env[k] || '').trim());
    if (missing.length) {
      throw new ConfigError(
        `Missing required environment variable(s) for "${capability}": ${missing.join(', ')}`,
      );
    }
    return true;
  };

  return config;
}

module.exports = {
  loadConfig,
  ConfigError,
  MODES,
  STAGES,
  DEFAULTS,
  REPO_ROOT,
  CAPABILITY_REQUIREMENTS,
  requiredCapabilitiesForMode,
  parseBool,
};
