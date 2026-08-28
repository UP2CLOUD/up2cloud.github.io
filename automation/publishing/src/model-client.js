'use strict';

const { GeminiClient } = require('./gemini');
const { GroqClient } = require('./groq');
const { ClaudeCliClient } = require('./claude-cli');

/**
 * Prefer Claude first when a subscription token is configured — quality is
 * meaningfully better than the free open-weight models below, and its
 * quota (a Claude Pro/Max/Team subscription) is entirely separate from all
 * of them. Otherwise prefer OpenRouter — its `:free` models run on their
 * own account/quota, so they're untouched by whatever exhausted the other
 * four (Cloudflare AI's 10,000 Neurons/day, Gemini's quota, Groq's
 * per-minute cap, and Cerebras' now card-gated free tier), which have all
 * been observed exhausted simultaneously in production. Fall through an
 * ordered chain (Cloudflare AI, then Gemini, then Groq, then Cerebras) when
 * the active one is unavailable or out of quota. Once a provider succeeds,
 * the switch is sticky for the rest of the process so later stages do not
 * repeat a known-failing call. Content, safety and schema failures never
 * trigger a provider switch — only rate limits, outages, and quota
 * exhaustion do (`err.fallbackEligible`), because a different provider
 * would likely produce the same bad answer.
 */
class ModelClient {
  constructor(config, { fetchImpl, logger, sleepImpl, spawnImpl, clients = {} } = {}) {
    this.logger = logger;

    const build = (name, cfg, ClientClass, extraOpts) =>
      cfg?.apiKey || cfg?.oauthToken
        ? (clients[name] || new ClientClass(cfg, { fetchImpl, logger, sleepImpl, ...extraOpts }))
        : null;

    this.providers = [
      { name: 'claude', client: build('claude', config.claude, ClaudeCliClient, { spawnImpl }) },
      { name: 'openrouter', client: build('openrouter', config.openrouter, GroqClient) },
      { name: 'cloudflare-ai', client: build('cloudflare-ai', config.cloudflareAi, GroqClient) },
      { name: 'gemini', client: build('gemini', config.gemini, GeminiClient) },
      { name: 'groq', client: build('groq', config.groq, GroqClient) },
      { name: 'cerebras', client: build('cerebras', config.cerebras, GroqClient) },
    ].filter((p) => p.client);

    if (!this.providers.length) {
      throw new Error(
        'CLAUDE_CODE_OAUTH_TOKEN, OPENROUTER_API_KEY, GEMINI_API_KEY, GROQ_API_KEY, ' +
          'CEREBRAS_API_KEY, or CLOUDFLARE_AI_API_TOKEN (+ CLOUDFLARE_ACCOUNT_ID) is required',
      );
    }
    this.activeIndex = 0;
  }

  get activeProvider() {
    return this.providers[this.activeIndex].name;
  }

  async invoke(method, args) {
    let lastErr;
    for (let i = this.activeIndex; i < this.providers.length; i += 1) {
      const { name, client } = this.providers[i];
      try {
        const result = await client[method](args);
        if (i !== this.activeIndex) {
          this.logger?.warn('Switched model provider for the rest of the run', {
            from: this.providers[this.activeIndex].name,
            to: name,
          });
          this.activeIndex = i;
        }
        return result;
      } catch (err) {
        lastErr = err;
        const hasNext = i + 1 < this.providers.length;
        if (!err?.fallbackEligible || !hasNext) throw err;
        this.logger?.warn(`${name} unavailable; trying next provider`, {
          status: err.status,
          next: this.providers[i + 1].name,
        });
      }
    }
    // Unreachable while providers.length >= 1, but keeps the function total.
    throw lastErr;
  }

  messages(args) {
    return this.invoke('messages', args);
  }

  json(args) {
    return this.invoke('json', args);
  }
}

module.exports = { ModelClient };
