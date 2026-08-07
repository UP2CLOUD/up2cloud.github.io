'use strict';

/**
 * Google Gemini (Generative Language API) client.
 *
 * Deliberately dependency-free (the repo ships zero runtime deps) and narrow:
 * one `messages()` call plus a `json()` helper that enforces a schema-shaped
 * response. Mirrors the interface the previous Anthropic client exposed —
 * `{system, messages, maxTokens, temperature, stopSequences, timeoutMs}` in,
 * `{text, raw, requestId, stopReason}` out — so every pipeline stage that
 * consumes it (research/author/localize) needed zero changes.
 *
 * Retries cover 429 and 5xx with exponential backoff + jitter and honour
 * `retry-after` when the API supplies it.
 */

const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);

class GeminiError extends Error {
  constructor(message, { status, requestId, retryable } = {}) {
    super(message);
    this.name = 'GeminiError';
    this.status = status;
    this.requestId = requestId;
    this.retryable = Boolean(retryable);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Anthropic-style {role:'user'|'assistant', content:string} -> Gemini {role:'user'|'model', parts:[{text}]}. */
function toGeminiContents(messages) {
  return messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));
}

class GeminiClient {
  constructor(config, { fetchImpl, logger } = {}) {
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.apiVersion = config.apiVersion || 'v1beta';
    this.baseUrl = config.baseUrl;
    this.maxRetries = config.maxRetries ?? 4;
    this.fetchImpl = fetchImpl || globalThis.fetch;
    this.logger = logger;
    if (!this.apiKey) throw new GeminiError('GEMINI_API_KEY is required');
    if (!this.model) throw new GeminiError('GEMINI_MODEL is required');
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
      contents: toGeminiContents(messages),
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      generationConfig: {
        maxOutputTokens: maxTokens,
        temperature,
        ...(stopSequences ? { stopSequences } : {}),
        ...(responseMimeType ? { responseMimeType } : {}),
      },
    };

    const url = `${this.baseUrl}/${this.apiVersion}/models/${this.model}:generateContent?key=${this.apiKey}`;

    let lastError;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await this.fetchImpl(url, {
          method: 'POST',
          signal: controller.signal,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });

        const requestId = res.headers.get('x-goog-request-id') || undefined;

        if (res.ok) {
          const json = await res.json();
          const candidate = (json.candidates || [])[0];
          if (!candidate) {
            throw new GeminiError('Gemini returned no candidates', { requestId });
          }
          if (candidate.finishReason === 'SAFETY' || candidate.finishReason === 'RECITATION') {
            throw new GeminiError(
              `Gemini blocked the response (finishReason=${candidate.finishReason})`,
              { requestId },
            );
          }
          const text = (candidate.content?.parts || [])
            .map((part) => part.text || '')
            .join('');
          return { text, raw: json, requestId, stopReason: candidate.finishReason };
        }

        const errText = await res.text().catch(() => '');
        const retryable = RETRYABLE_STATUS.has(res.status);
        lastError = new GeminiError(
          `Gemini API ${res.status}: ${errText.slice(0, 400)}`,
          { status: res.status, requestId, retryable },
        );
        if (!retryable || attempt === this.maxRetries) throw lastError;

        const retryAfter = Number(res.headers.get('retry-after'));
        const backoff = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : Math.min(2 ** attempt * 1000, 30_000) + Math.floor(Math.random() * 500);
        this.logger?.warn('Gemini call failed, retrying', {
          status: res.status,
          attempt: attempt + 1,
          backoffMs: backoff,
        });
        await sleep(backoff);
      } catch (err) {
        clearTimeout(timer);
        if (err instanceof GeminiError) {
          if (!err.retryable || attempt === this.maxRetries) throw err;
          lastError = err;
          continue;
        }
        // Network error / abort — retryable.
        lastError = new GeminiError(`Gemini request failed: ${err.message}`, {
          retryable: true,
        });
        if (attempt === this.maxRetries) throw lastError;
        await sleep(Math.min(2 ** attempt * 1000, 30_000));
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError || new GeminiError('Gemini request failed with no error recorded');
  }

  /**
   * Request JSON. Gemini 1.5+/2.x models support `responseMimeType:
   * "application/json"`, which is far more reliable than asking politely for
   * "JSON only" and hoping — the API itself constrains the output.
   */
  async json({ system, prompt, maxTokens = 8192, temperature = 0.3, validate }) {
    const messages = [{ role: 'user', content: prompt }];
    const { text, requestId, stopReason } = await this.messages({
      system,
      messages,
      maxTokens,
      temperature,
      responseMimeType: 'application/json',
    });

    let parsed;
    try {
      parsed = JSON.parse(extractJsonObject(text.trim()));
    } catch (err) {
      throw new GeminiError(
        `Model did not return valid JSON (stop_reason=${stopReason}, request-id=${requestId}): ${err.message}`,
        { requestId },
      );
    }

    if (typeof validate === 'function') {
      const problems = validate(parsed);
      if (Array.isArray(problems) && problems.length) {
        throw new GeminiError(
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

module.exports = { GeminiClient, GeminiError, extractJsonObject, RETRYABLE_STATUS };
