'use strict';

/**
 * Generic OpenAI-compatible chat client (Groq, Cerebras, and any other host
 * that speaks the `/chat/completions` dialect — only `baseUrl`/`model`/
 * `apiKey` differ between them). Named GroqClient because that's the first
 * provider it served; reused as-is for Cerebras via a different config block.
 *
 * It mirrors GeminiClient's narrow `messages()` / `json()` interface so the
 * pipeline can switch providers without changing any generation stage.
 */

const { extractJsonObject, RETRYABLE_STATUS, MAX_BACKOFF_MS } = require('./gemini');

class GroqError extends Error {
  constructor(message, { status, requestId, retryable, fallbackEligible } = {}) {
    super(message);
    this.name = 'GroqError';
    this.status = status;
    this.requestId = requestId;
    this.retryable = Boolean(retryable);
    // Whether ModelClient should try the next provider in the chain once
    // local retries are exhausted. Rate limits and outages are — the model
    // gave a bad/unsafe answer is not, because another provider would likely
    // do the same.
    this.fallbackEligible = Boolean(fallbackEligible);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toChatMessages(system, messages) {
  return [
    ...(system ? [{ role: 'system', content: system }] : []),
    ...messages
      .filter((message) => message.role !== 'system')
      .map((message) => ({
        role: message.role === 'assistant' ? 'assistant' : 'user',
        content: message.content,
      })),
  ];
}

class GroqClient {
  constructor(config, { fetchImpl, logger, sleepImpl } = {}) {
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.baseUrl = config.baseUrl;
    this.maxRetries = config.maxRetries ?? 4;
    this.maxOutputTokens = config.maxOutputTokens ?? 8192;
    this.fetchImpl = fetchImpl || globalThis.fetch;
    this.logger = logger;
    this.sleep = sleepImpl || sleep;
    // Reused for any OpenAI-compatible host (Groq, Cerebras, ...); the env
    // var prefix in error text follows the caller so a Cerebras misconfig
    // doesn't point someone at the wrong variable.
    const envPrefix = (config.envPrefix || 'GROQ').toUpperCase();
    if (!this.apiKey) throw new GroqError(`${envPrefix}_API_KEY is required`);
    if (!this.model) throw new GroqError(`${envPrefix}_MODEL is required`);
  }

  async messages({
    system,
    messages,
    maxTokens = 8192,
    temperature = 0.4,
    stopSequences,
    responseMimeType,
    timeoutMs = 180_000,
  }) {
    const body = {
      model: this.model,
      messages: toChatMessages(system, messages),
      max_completion_tokens: Math.min(maxTokens, this.maxOutputTokens),
      temperature,
      ...(stopSequences ? { stop: stopSequences } : {}),
      ...(responseMimeType === 'application/json'
        ? { response_format: { type: 'json_object' } }
        : {}),
    };

    const url = `${this.baseUrl}/chat/completions`;
    let lastError;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await this.fetchImpl(url, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
        });

        const requestId = res.headers.get('x-request-id') || undefined;
        if (res.ok) {
          const json = await res.json();
          const choice = (json.choices || [])[0];
          const text = choice?.message?.content;
          if (typeof text !== 'string') {
            throw new GroqError('Groq returned no message content', { requestId });
          }
          return {
            text,
            raw: json,
            requestId,
            stopReason: choice.finish_reason,
          };
        }

        const errText = await res.text().catch(() => '');
        // Groq's json_object mode occasionally emits output that fails its own
        // schema validation (400 `json_validate_failed`) — a transient
        // generation hiccup, not a malformed request, so it is worth one more
        // attempt exactly like a 429/5xx.
        let errCode;
        try {
          errCode = JSON.parse(errText)?.error?.code;
        } catch {
          // Non-JSON error body; fall through with errCode undefined.
        }
        const transientJsonFailure = res.status === 400 && errCode === 'json_validate_failed';
        // Groq reports a tokens-per-minute cap as 413 `rate_limit_exceeded`
        // instead of 429 — it's a rate limit, not a malformed request, but
        // retrying the same provider won't help since the request size is
        // fixed, so skip local retries and go straight to the next provider.
        const tpmCapped = res.status === 413 && errCode === 'rate_limit_exceeded';
        const retryable = RETRYABLE_STATUS.has(res.status) || transientJsonFailure;
        lastError = new GroqError(
          `Groq API ${res.status}: ${errText.slice(0, 400)}`,
          { status: res.status, requestId, retryable, fallbackEligible: retryable || tpmCapped },
        );
        if (!retryable || attempt === this.maxRetries) throw lastError;

        // Groq's Retry-After can reflect a long quota-reset window (observed:
        // 7686s ≈ 2.1h) rather than a short rate-limit cooldown. Honouring it
        // verbatim would sleep the job past its own CI timeout instead of
        // failing with a clear error, so cap it exactly like the exponential
        // fallback — a few short retries either clear a transient limit or
        // fail fast; nothing productive happens by sleeping for hours.
        const retryAfter = Number(res.headers.get('retry-after'));
        const backoff = Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, MAX_BACKOFF_MS)
          : Math.min(2 ** attempt * 1000, MAX_BACKOFF_MS) + Math.floor(Math.random() * 500);
        this.logger?.warn('Groq call failed, retrying', {
          status: res.status,
          attempt: attempt + 1,
          backoffMs: backoff,
        });
        await this.sleep(backoff);
      } catch (err) {
        if (err instanceof GroqError) {
          if (!err.retryable || attempt === this.maxRetries) throw err;
          lastError = err;
          continue;
        }
        lastError = new GroqError(`Groq request failed: ${err.message}`, {
          retryable: true,
          fallbackEligible: true,
        });
        if (attempt === this.maxRetries) throw lastError;
        await this.sleep(Math.min(2 ** attempt * 1000, MAX_BACKOFF_MS));
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError || new GroqError('Groq request failed with no error recorded');
  }

  async json({ system, prompt, maxTokens = 8192, temperature = 0.3, validate }) {
    const { text, requestId, stopReason } = await this.messages({
      system,
      messages: [{ role: 'user', content: prompt }],
      maxTokens,
      temperature,
      responseMimeType: 'application/json',
    });

    let parsed;
    try {
      parsed = JSON.parse(extractJsonObject(text.trim()));
    } catch (err) {
      throw new GroqError(
        `Model did not return valid JSON (stop_reason=${stopReason}, request-id=${requestId}): ${err.message}`,
        { requestId },
      );
    }

    if (typeof validate === 'function') {
      const problems = validate(parsed);
      if (Array.isArray(problems) && problems.length) {
        throw new GroqError(
          `Model JSON failed schema validation: ${problems.join('; ')}`,
          { requestId },
        );
      }
    }
    return parsed;
  }
}

module.exports = { GroqClient, GroqError, toChatMessages };
