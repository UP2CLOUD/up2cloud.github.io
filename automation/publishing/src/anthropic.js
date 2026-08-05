'use strict';

/**
 * Anthropic Messages API client.
 *
 * Deliberately dependency-free (the repo ships zero runtime deps) and narrow:
 * one `messages()` call plus a `json()` helper that enforces a schema-shaped
 * response. Retries cover 429 and 5xx with exponential backoff + jitter and
 * honour `retry-after` when the API supplies it.
 */

const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

class AnthropicError extends Error {
  constructor(message, { status, requestId, retryable } = {}) {
    super(message);
    this.name = 'AnthropicError';
    this.status = status;
    this.requestId = requestId;
    this.retryable = Boolean(retryable);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

class AnthropicClient {
  constructor(config, { fetchImpl, logger } = {}) {
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.version = config.version;
    this.baseUrl = config.baseUrl;
    this.maxRetries = config.maxRetries ?? 4;
    this.fetchImpl = fetchImpl || globalThis.fetch;
    this.logger = logger;
    if (!this.apiKey) throw new AnthropicError('ANTHROPIC_API_KEY is required');
    if (!this.model) throw new AnthropicError('ANTHROPIC_MODEL is required');
  }

  async messages({
    system,
    messages,
    maxTokens = 8192,
    temperature = 0.4,
    stopSequences,
    timeoutMs = 180_000,
  }) {
    const body = {
      model: this.model,
      max_tokens: maxTokens,
      temperature,
      messages,
      ...(system ? { system } : {}),
      ...(stopSequences ? { stop_sequences: stopSequences } : {}),
    };

    let lastError;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'content-type': 'application/json',
            'x-api-key': this.apiKey,
            'anthropic-version': this.version,
          },
          body: JSON.stringify(body),
        });

        const requestId = res.headers.get('request-id') || undefined;

        if (res.ok) {
          const json = await res.json();
          const text = (json.content || [])
            .filter((block) => block.type === 'text')
            .map((block) => block.text)
            .join('');
          return { text, raw: json, requestId, stopReason: json.stop_reason };
        }

        const errText = await res.text().catch(() => '');
        const retryable = RETRYABLE_STATUS.has(res.status);
        lastError = new AnthropicError(
          `Anthropic API ${res.status}: ${errText.slice(0, 400)}`,
          { status: res.status, requestId, retryable },
        );
        if (!retryable || attempt === this.maxRetries) throw lastError;

        const retryAfter = Number(res.headers.get('retry-after'));
        const backoff = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : Math.min(2 ** attempt * 1000, 30_000) + Math.floor(Math.random() * 500);
        this.logger?.warn('Anthropic call failed, retrying', {
          status: res.status,
          attempt: attempt + 1,
          backoffMs: backoff,
        });
        await sleep(backoff);
      } catch (err) {
        clearTimeout(timer);
        if (err instanceof AnthropicError) {
          if (!err.retryable || attempt === this.maxRetries) throw err;
          lastError = err;
          continue;
        }
        // Network error / abort — retryable.
        lastError = new AnthropicError(`Anthropic request failed: ${err.message}`, {
          retryable: true,
        });
        if (attempt === this.maxRetries) throw lastError;
        await sleep(Math.min(2 ** attempt * 1000, 30_000));
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError || new AnthropicError('Anthropic request failed with no error recorded');
  }

  /**
   * Request JSON. We prefill the assistant turn with `{` so the model cannot
   * open with prose, then re-attach it — far more reliable than asking politely
   * for "JSON only" and parsing whatever comes back.
   */
  async json({ system, prompt, maxTokens = 8192, temperature = 0.3, validate }) {
    const messages = [
      { role: 'user', content: prompt },
      { role: 'assistant', content: '{' },
    ];
    const { text, requestId, stopReason } = await this.messages({
      system,
      messages,
      maxTokens,
      temperature,
    });

    const candidate = `{${text}`.trim();
    let parsed;
    try {
      parsed = JSON.parse(extractJsonObject(candidate));
    } catch (err) {
      throw new AnthropicError(
        `Model did not return valid JSON (stop_reason=${stopReason}, request-id=${requestId}): ${err.message}`,
        { requestId },
      );
    }

    if (typeof validate === 'function') {
      const problems = validate(parsed);
      if (Array.isArray(problems) && problems.length) {
        throw new AnthropicError(
          `Model JSON failed schema validation: ${problems.join('; ')}`,
          { requestId },
        );
      }
    }
    return parsed;
  }
}

/** Trim anything after the outermost balanced object (models sometimes trail). */
function extractJsonObject(text) {
  const start = text.indexOf('{');
  if (start === -1) throw new Error('no JSON object found');
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced JSON object');
}

module.exports = { AnthropicClient, AnthropicError, extractJsonObject, RETRYABLE_STATUS };
