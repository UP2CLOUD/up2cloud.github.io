'use strict';

const { GeminiClient } = require('./gemini');
const { GroqClient } = require('./groq');

/**
 * Prefer Cloudflare Workers AI first — its free tier is a 10,000
 * Neurons/day allowance that renews daily, unlike Gemini's quota, Groq's
 * per-minute cap, and Cerebras' free credits, which have all been observed
 * exhausted simultaneously in production. Fall through an ordered chain
 * (Gemini, then Groq, then Cerebras) when the active one is unavailable or
 * out of quota. Once a provider succeeds, the switch is sticky for the rest
 * of the process so later stages do not repeat a known-failing call.
 * Content, safety and schema failures never trigger a provider switch —
 * only rate limits, outages, and quota exhaustion do
 * (`err.fallbackEligible`), because a different provider would likely
 * produce the same bad answer.
 */
class ModelClient {
  constructor(config, { fetchImpl, logger, sleepImpl, clients = {} } = {}) {
    this.logger = logger;

    const build = (name, cfg, ClientClass) =>
      cfg?.apiKey ? (clients[name] || new ClientClass(cfg, { fetchImpl, logger, sleepImpl })) : null;

    this.providers = [
      { name: 'cloudflare-ai', client: build('cloudflare-ai', config.cloudflareAi, GroqClient) },
      { name: 'gemini', client: build('gemini', config.gemini, GeminiClient) },
      { name: 'groq', client: build('groq', config.groq, GroqClient) },
      { name: 'cerebras', client: build('cerebras', config.cerebras, GroqClient) },
    ].filter((p) => p.client);

    if (!this.providers.length) {
      throw new Error(
        'GEMINI_API_KEY, GROQ_API_KEY, CEREBRAS_API_KEY, or CLOUDFLARE_AI_API_TOKEN ' +
          '(+ CLOUDFLARE_ACCOUNT_ID) is required',
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
