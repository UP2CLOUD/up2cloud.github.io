'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { GeminiClient, GeminiError } = require('../src/gemini');
const { GroqClient } = require('../src/groq');
const { ModelClient } = require('../src/model-client');

function response({ status = 200, body = {}, headers = {} } = {}) {
  const lower = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (key) => lower[key.toLowerCase()] || null },
    json: async () => body,
    text: async () => typeof body === 'string' ? body : JSON.stringify(body),
  };
}

function config() {
  return {
    gemini: { apiKey: 'gemini-key', model: 'gemini-model' },
    groq: {
      apiKey: 'groq-key',
      model: 'llama-3.3-70b-versatile',
      baseUrl: 'https://api.groq.com/openai/v1',
      maxRetries: 0,
      maxOutputTokens: 8192,
      envPrefix: 'GROQ',
    },
    cerebras: {
      apiKey: 'cerebras-key',
      model: 'llama-3.3-70b',
      baseUrl: 'https://api.cerebras.ai/v1',
      maxRetries: 0,
      maxOutputTokens: 8192,
      envPrefix: 'CEREBRAS',
    },
  };
}

test('Gemini quota exhaustion switches to Groq and the switch is sticky', async () => {
  let geminiCalls = 0;
  let groqCalls = 0;
  const gemini = {
    messages: async () => {
      geminiCalls += 1;
      throw new GeminiError('monthly spending cap exceeded', {
        status: 429,
        fallbackEligible: true,
      });
    },
  };
  const groq = {
    messages: async () => {
      groqCalls += 1;
      return { text: 'fallback result' };
    },
  };
  const client = new ModelClient(config(), { clients: { gemini, groq } });

  assert.equal((await client.messages({})).text, 'fallback result');
  assert.equal((await client.messages({})).text, 'fallback result');
  assert.equal(client.activeProvider, 'groq');
  assert.equal(geminiCalls, 1);
  assert.equal(groqCalls, 2);
});

test('Gemini monthly spending-cap errors skip retries so fallback is immediate', async () => {
  let calls = 0;
  const client = new GeminiClient({
    apiKey: 'gemini-key',
    model: 'gemini-model',
    baseUrl: 'https://generativelanguage.googleapis.com',
    maxRetries: 4,
  }, {
    fetchImpl: async () => {
      calls += 1;
      return response({
        status: 429,
        body: {
          error: {
            status: 'RESOURCE_EXHAUSTED',
            message: 'Your project has exceeded its monthly spending cap.',
          },
        },
      });
    },
  });

  await assert.rejects(
    () => client.messages({ messages: [{ role: 'user', content: 'test' }] }),
    (err) => err instanceof GeminiError && err.fallbackEligible && !err.retryable,
  );
  assert.equal(calls, 1);
});

test('model/schema errors do not silently switch providers', async () => {
  let groqCalls = 0;
  const gemini = {
    json: async () => {
      throw new GeminiError('Model JSON failed schema validation');
    },
  };
  const groq = {
    json: async () => {
      groqCalls += 1;
      return {};
    },
  };
  const client = new ModelClient(config(), { clients: { gemini, groq } });

  await assert.rejects(() => client.json({}), /schema validation/);
  assert.equal(client.activeProvider, 'gemini');
  assert.equal(groqCalls, 0);
});

test('cascades through all three providers when Gemini and Groq are both exhausted', async () => {
  let geminiCalls = 0;
  let groqCalls = 0;
  let cerebrasCalls = 0;
  const gemini = {
    messages: async () => {
      geminiCalls += 1;
      throw new GeminiError('quota exceeded', { status: 429, fallbackEligible: true });
    },
  };
  const groq = {
    messages: async () => {
      groqCalls += 1;
      const err = new Error('Groq API 429: rate_limit_exceeded');
      err.status = 429;
      err.fallbackEligible = true;
      throw err;
    },
  };
  const cerebras = {
    messages: async () => {
      cerebrasCalls += 1;
      return { text: 'cerebras result' };
    },
  };
  const client = new ModelClient(config(), { clients: { gemini, groq, cerebras } });

  assert.equal((await client.messages({})).text, 'cerebras result');
  assert.equal(client.activeProvider, 'cerebras');
  // Sticky: the next call skips straight past the two known-failing providers.
  assert.equal((await client.messages({})).text, 'cerebras result');
  assert.equal(geminiCalls, 1);
  assert.equal(groqCalls, 1);
  assert.equal(cerebrasCalls, 2);
});

test('a non-fallback-eligible error on the last provider is not swallowed', async () => {
  const gemini = {
    messages: async () => {
      throw new GeminiError('quota exceeded', { status: 429, fallbackEligible: true });
    },
  };
  const groq = {
    messages: async () => {
      const err = new Error('Groq API 429');
      err.fallbackEligible = true;
      throw err;
    },
  };
  const cerebras = {
    messages: async () => {
      throw new Error('Cerebras API 500: internal error');
    },
  };
  const client = new ModelClient(config(), { clients: { gemini, groq, cerebras } });

  await assert.rejects(() => client.messages({}), /Cerebras API 500/);
});

test('Cerebras-only configuration starts directly on Cerebras', async () => {
  const cerebras = { messages: async () => ({ text: 'cerebras only' }) };
  const cfg = config();
  cfg.gemini.apiKey = '';
  cfg.groq.apiKey = '';
  const client = new ModelClient(cfg, { clients: { cerebras } });

  assert.equal((await client.messages({})).text, 'cerebras only');
  assert.equal(client.activeProvider, 'cerebras');
});

test('Groq-only configuration starts directly on Groq', async () => {
  const groq = { messages: async () => ({ text: 'groq only' }) };
  const cfg = config();
  cfg.gemini.apiKey = '';
  const client = new ModelClient(cfg, { clients: { groq } });

  assert.equal((await client.messages({})).text, 'groq only');
  assert.equal(client.activeProvider, 'groq');
});

test('Groq client uses OpenAI chat format and JSON Object Mode', async () => {
  let request;
  const client = new GroqClient(config().groq, {
    fetchImpl: async (url, init) => {
      request = { url, init, body: JSON.parse(init.body) };
      return response({
        body: {
          choices: [{
            message: { content: '{"ok":true}' },
            finish_reason: 'stop',
          }],
        },
        headers: { 'x-request-id': 'req-1' },
      });
    },
  });

  const result = await client.json({
    system: 'system rules',
    prompt: 'Return JSON',
    validate: (value) => value.ok ? [] : ['not ok'],
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(request.url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(request.init.headers.authorization, 'Bearer groq-key');
  assert.deepEqual(request.body.response_format, { type: 'json_object' });
  assert.deepEqual(request.body.messages, [
    { role: 'system', content: 'system rules' },
    { role: 'user', content: 'Return JSON' },
  ]);
});

test('Groq client caps requested output at the configured model maximum', async () => {
  let body;
  const client = new GroqClient(config().groq, {
    fetchImpl: async (_url, init) => {
      body = JSON.parse(init.body);
      return response({
        body: {
          choices: [{ message: { content: 'article' }, finish_reason: 'stop' }],
        },
      });
    },
  });

  await client.messages({
    messages: [{ role: 'user', content: 'write' }],
    maxTokens: 16_000,
  });
  assert.equal(body.max_completion_tokens, 8192);
});
