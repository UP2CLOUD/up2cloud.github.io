'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { ClaudeCliClient, ClaudeCliError } = require('../src/claude-cli');

/** A fake `child_process.spawn` that never touches a real process. */
function fakeSpawn({ code = 0, stdout = '', stderr = '', spawnError } = {}) {
  const calls = [];
  const impl = (cliPath, args) => {
    calls.push({ cliPath, args });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    let written = '';
    child.stdin = {
      write: (chunk) => {
        written += chunk;
      },
      end: () => {},
    };
    child.kill = () => {};
    setImmediate(() => {
      if (spawnError) {
        child.emit('error', spawnError);
        return;
      }
      if (stdout) child.stdout.emit('data', stdout);
      if (stderr) child.stderr.emit('data', stderr);
      child.emit('close', code);
      child._writtenStdin = written;
    });
    return child;
  };
  impl.calls = calls;
  return impl;
}

function config(overrides = {}) {
  return {
    oauthToken: 'test-oauth-token',
    model: 'claude-sonnet-5',
    cliPath: 'claude',
    maxRetries: 0,
    ...overrides,
  };
}

test('a successful CLI call returns the "result" field as text', async () => {
  const spawnImpl = fakeSpawn({
    code: 0,
    stdout: JSON.stringify({ result: 'generated text', session_id: 'sess-1' }),
  });
  const client = new ClaudeCliClient(config(), { spawnImpl });

  const { text, requestId } = await client.messages({
    system: 'be terse',
    messages: [{ role: 'user', content: 'hello' }],
  });

  assert.equal(text, 'generated text');
  assert.equal(requestId, 'sess-1');
});

test('every call disables all tools, so a generation call cannot touch the filesystem or shell', async () => {
  const spawnImpl = fakeSpawn({ code: 0, stdout: JSON.stringify({ result: 'ok' }) });
  const client = new ClaudeCliClient(config(), { spawnImpl });

  await client.messages({ messages: [{ role: 'user', content: 'hi' }] });

  const [{ args }] = spawnImpl.calls;
  const idx = args.indexOf('--allowedTools');
  assert.notEqual(idx, -1);
  assert.equal(args[idx + 1], '');
});

test('a subscription usage-limit error is fallback-eligible with no local retry', async () => {
  const spawnImpl = fakeSpawn({
    code: 1,
    stderr: 'Claude usage limit reached. Your limit will reset at 3pm.',
  });
  const client = new ClaudeCliClient(config({ maxRetries: 3 }), { spawnImpl });

  await assert.rejects(
    () => client.messages({ messages: [{ role: 'user', content: 'hi' }] }),
    (err) => err instanceof ClaudeCliError && err.fallbackEligible === true && !err.retryable,
  );
  assert.equal(spawnImpl.calls.length, 1);
});

test('a transient non-zero exit retries up to maxRetries then throws fallback-eligible', async () => {
  const spawnImpl = fakeSpawn({ code: 1, stderr: 'internal error' });
  const client = new ClaudeCliClient(config({ maxRetries: 2 }), {
    spawnImpl,
    sleepImpl: async () => {},
  });

  await assert.rejects(
    () => client.messages({ messages: [{ role: 'user', content: 'hi' }] }),
    (err) => err instanceof ClaudeCliError && err.fallbackEligible === true,
  );
  assert.equal(spawnImpl.calls.length, 3);
});

test('is_error in the JSON envelope throws even on exit code 0', async () => {
  const spawnImpl = fakeSpawn({
    code: 0,
    stdout: JSON.stringify({ is_error: true, result: 'something went wrong' }),
  });
  const client = new ClaudeCliClient(config(), { spawnImpl });

  await assert.rejects(
    () => client.messages({ messages: [{ role: 'user', content: 'hi' }] }),
    ClaudeCliError,
  );
});

test('json() retries a schema-invalid response and succeeds on the next attempt', async () => {
  let call = 0;
  const responses = [
    JSON.stringify({ result: 'not json at all' }),
    JSON.stringify({ result: JSON.stringify({ sources: [] }) }),
  ];
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { write: () => {}, end: () => {} };
    child.kill = () => {};
    const out = responses[call];
    call += 1;
    setImmediate(() => {
      child.stdout.emit('data', out);
      child.emit('close', 0);
    });
    return child;
  };
  const client = new ClaudeCliClient(config({ maxRetries: 1 }), { spawnImpl });

  const result = await client.json({
    prompt: 'find sources',
    maxJsonRetries: 1,
    validate: (obj) => (Array.isArray(obj.sources) ? [] : ['sources must be an array']),
  });

  assert.deepEqual(result, { sources: [] });
  assert.equal(call, 2);
});

test('constructing without an oauth token throws', () => {
  assert.throws(() => new ClaudeCliClient(config({ oauthToken: '' })), ClaudeCliError);
});
