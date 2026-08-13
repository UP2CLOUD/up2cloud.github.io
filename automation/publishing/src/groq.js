'use strict';

/**
 * Groq OpenAI-compatible chat client.
 *
 * It mirrors GeminiClient's narrow `messages()` / `json()` interface so the
 * pipeline can switch providers without changing any generation stage.
 */

const { extractJsonObject, RETRYABLE_STATUS } = require('./gemini');

class GroqError extends Error {
  constructor(message, { status, requestId, retryable } = {}) {
    super(message);
    this.name = 'GroqError';
    this.status = status;
    this.requestId = requestId;
    this.retryable = Boolean(retryable);
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
    if (!this.apiKey) throw new GroqError('GROQ_API_KEY is required');
    if (!this.model) throw new GroqError('GROQ_MODEL is required');
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
        const retryable = RETRYABLE_STATUS.has(res.status) || transientJsonFailure;
        lastError = new GroqError(
          `Groq API ${res.status}: ${errText.slice(0, 400)}`,
          { status: res.status, requestId, retryable },
        );
        if (!retryable || attempt === this.maxRetries) throw lastError;

        const retryAfter = Number(res.headers.get('retry-after'));
        const backoff = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : Math.min(2 ** attempt * 1000, 30_000) + Math.floor(Math.random() * 500);
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
        });
        if (attempt === this.maxRetries) throw lastError;
        await this.sleep(Math.min(2 ** attempt * 1000, 30_000));
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
