'use strict';

const { GeminiClient, GeminiError } = require('./gemini');
const { GroqClient } = require('./groq');

/**
 * Prefer Gemini, but switch to Groq when Gemini is unavailable or out of
 * quota. The switch is sticky for the process so later stages do not repeat a
 * known-failing Gemini call. Content, safety and schema failures never trigger
 * a provider switch.
 */
class ModelClient {
  constructor(config, { fetchImpl, logger, sleepImpl, clients = {} } = {}) {
    this.logger = logger;
    this.primary = clients.gemini || (
      config.gemini.apiKey
        ? new GeminiClient(config.gemini, { fetchImpl, logger })
        : null
    );
    this.fallback = clients.groq || (
      config.groq.apiKey
        ? new GroqClient(config.groq, { fetchImpl, logger, sleepImpl })
        : null
    );
    this.active = this.primary || this.fallback;
    this.activeProvider = this.primary ? 'gemini' : 'groq';
    if (!this.active) {
      throw new Error('GEMINI_API_KEY or GROQ_API_KEY is required');
    }
  }

  async invoke(method, args) {
    try {
      return await this.active[method](args);
    } catch (err) {
      if (
        this.active === this.primary &&
        this.fallback &&
        err instanceof GeminiError &&
        err.fallbackEligible
      ) {
        this.logger?.warn('Gemini unavailable; switching to Groq for the rest of the run', {
          status: err.status,
        });
        this.active = this.fallback;
        this.activeProvider = 'groq';
        return this.active[method](args);
      }
      throw err;
    }
  }

  messages(args) {
    return this.invoke('messages', args);
  }

  json(args) {
    return this.invoke('json', args);
  }
}

module.exports = { ModelClient };
