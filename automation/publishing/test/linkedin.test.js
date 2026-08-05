'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { LinkedInClient, normaliseUrn, isValidPostUrn } = require('../src/linkedin/client');
const { checkTokenExpiry, hasRequiredScopes, buildAuthorizationUrl } = require('../src/linkedin/oauth');
const { composeLinkedInPost, validateComposedPost, buildTrackedUrl, toHashtag } = require('../src/linkedin/compose');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-08-10T09:00:00Z');

function mockResponse({ status = 200, headers = {}, body = '' } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    text: async () => body,
    json: async () => JSON.parse(body || '{}'),
  };
}

const baseConfig = {
  accessToken: 'test-token',
  organizationUrn: 'urn:li:organization:12345678',
  apiVersion: '202508',
  maxRetries: 3,
  tokenExpiresAt: new Date(NOW + 30 * DAY).toISOString(),
};

const noSleep = async () => {};

test('returns the post URN from the x-restli-id header', async () => {
  const client = new LinkedInClient(baseConfig, {
    fetchImpl: async () => mockResponse({ status: 201, headers: { 'x-restli-id': 'urn:li:share:7123' } }),
    sleepImpl: noSleep,
  });
  const r = await client.createPost({ commentary: 'hello', articleUrl: 'https://up2cloud.tech/blog/x/' });
  assert.equal(r.urn, 'urn:li:share:7123');
  assert.equal(r.attempts, 1);
});

test('a 2xx WITHOUT a URN is treated as failure, not success', async () => {
  // This is the "never report success unless LinkedIn returns a valid URN" rule.
  const client = new LinkedInClient(baseConfig, {
    fetchImpl: async () => mockResponse({ status: 201, body: '' }),
    sleepImpl: noSleep,
  });
  await assert.rejects(
    () => client.createPost({ commentary: 'hello' }),
    /no post URN/,
  );
});

test('retries on 429 then succeeds', async () => {
  let calls = 0;
  const client = new LinkedInClient(baseConfig, {
    fetchImpl: async () => {
      calls += 1;
      if (calls < 3) return mockResponse({ status: 429, headers: { 'retry-after': '0' }, body: 'rate limited' });
      return mockResponse({ status: 201, headers: { 'x-restli-id': 'urn:li:share:999' } });
    },
    sleepImpl: noSleep,
  });
  const r = await client.createPost({ commentary: 'hi' });
  assert.equal(r.urn, 'urn:li:share:999');
  assert.equal(calls, 3);
  assert.equal(r.attempts, 3);
});

test('retries on 5xx and gives up after maxRetries', async () => {
  let calls = 0;
  const client = new LinkedInClient({ ...baseConfig, maxRetries: 2 }, {
    fetchImpl: async () => {
      calls += 1;
      return mockResponse({ status: 503, body: 'unavailable' });
    },
    sleepImpl: noSleep,
  });
  await assert.rejects(() => client.createPost({ commentary: 'hi' }), /503/);
  assert.equal(calls, 3, 'initial attempt + 2 retries');
});

test('401 is not retried and reports reauthorization', async () => {
  let calls = 0;
  const client = new LinkedInClient(baseConfig, {
    fetchImpl: async () => {
      calls += 1;
      return mockResponse({ status: 401, body: 'invalid token' });
    },
    sleepImpl: noSleep,
  });
  await assert.rejects(() => client.createPost({ commentary: 'hi' }), /Reauthorization required/);
  assert.equal(calls, 1, '401 must not be retried');
});

test('403 is not retried and names the likely scope problem', async () => {
  const client = new LinkedInClient(baseConfig, {
    fetchImpl: async () => mockResponse({ status: 403, body: 'forbidden' }),
    sleepImpl: noSleep,
  });
  await assert.rejects(() => client.createPost({ commentary: 'hi' }), /w_organization_social/);
});

test('an expired token fails before any HTTP call is made', async () => {
  let called = false;
  const client = new LinkedInClient(
    { ...baseConfig, tokenExpiresAt: new Date(NOW - DAY).toISOString() },
    {
      fetchImpl: async () => {
        called = true;
        return mockResponse({ status: 201 });
      },
      sleepImpl: noSleep,
      clock: () => NOW,
    },
  );
  await assert.rejects(() => client.createPost({ commentary: 'hi' }), /expired/);
  assert.equal(called, false, 'must not call the API with a known-expired token');
});

test('the idempotency key is sent so a retry cannot double-post', async () => {
  let seenHeader = null;
  const client = new LinkedInClient(baseConfig, {
    fetchImpl: async (_url, init) => {
      seenHeader = init.headers['x-restli-request-id'];
      return mockResponse({ status: 201, headers: { 'x-restli-id': 'urn:li:share:1' } });
    },
    sleepImpl: noSleep,
  });
  await client.createPost({ commentary: 'hi', idempotencyKey: 'up2cloud-my-slug' });
  assert.equal(seenHeader, 'up2cloud-my-slug');
});

test('posts with the configured organization URN as author', async () => {
  let payload = null;
  const client = new LinkedInClient(baseConfig, {
    fetchImpl: async (_url, init) => {
      payload = JSON.parse(init.body);
      return mockResponse({ status: 201, headers: { 'x-restli-id': 'urn:li:share:1' } });
    },
    sleepImpl: noSleep,
  });
  await client.createPost({ commentary: 'hi', articleUrl: 'https://up2cloud.tech/blog/x/' });
  assert.equal(payload.author, 'urn:li:organization:12345678');
  assert.equal(payload.lifecycleState, 'PUBLISHED');
  assert.equal(payload.content.article.source, 'https://up2cloud.tech/blog/x/');
});

// ── URN validation ────────────────────────────────────────────────────────

test('URN normalisation and validation', () => {
  assert.equal(normaliseUrn('urn:li:share:7123'), 'urn:li:share:7123');
  assert.equal(normaliseUrn('urn:li:ugcPost:7123'), 'urn:li:ugcPost:7123');
  assert.equal(normaliseUrn('7123'), 'urn:li:share:7123');
  assert.equal(normaliseUrn(''), null);
  assert.equal(normaliseUrn(null), null);
  assert.equal(normaliseUrn('garbage'), null);

  assert.equal(isValidPostUrn('urn:li:share:7123'), true);
  assert.equal(isValidPostUrn('urn:li:organization:1'), false);
  assert.equal(isValidPostUrn(''), false);
});

// ── Token lifecycle ───────────────────────────────────────────────────────

test('token expiry classification', () => {
  assert.equal(checkTokenExpiry(new Date(NOW + 40 * DAY).toISOString(), { now: NOW }).status, 'valid');
  assert.equal(checkTokenExpiry(new Date(NOW + 5 * DAY).toISOString(), { now: NOW }).status, 'expiring_soon');
  assert.equal(checkTokenExpiry(new Date(NOW - DAY).toISOString(), { now: NOW }).status, 'expired');
  assert.equal(checkTokenExpiry(null, { now: NOW }).status, 'unknown');
  assert.equal(checkTokenExpiry('nonsense', { now: NOW }).status, 'unknown');
});

test('scope checking reports exactly what is missing', () => {
  const ok = hasRequiredScopes('w_organization_social r_organization_social');
  assert.equal(ok.ok, true);

  const missing = hasRequiredScopes('r_organization_social');
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.missing, ['w_organization_social']);
});

test('authorization URL requests the write scope and carries CSRF state', () => {
  const { url, state } = buildAuthorizationUrl({
    clientId: 'abc',
    redirectUri: 'https://up2cloud.tech/callback',
  });
  assert.ok(url.startsWith('https://www.linkedin.com/oauth/v2/authorization'));
  assert.ok(decodeURIComponent(url).includes('w_organization_social'));
  assert.ok(url.includes(`state=${state}`));
  assert.ok(state.length >= 16);
});

// ── Composition ───────────────────────────────────────────────────────────

const utm = { source: 'linkedin', medium: 'organic_social', campaign: 'up2cloud_blog' };

test('tracked URL carries all four UTM parameters', () => {
  const url = buildTrackedUrl({ siteBaseUrl: 'https://up2cloud.tech', slug: 'my-post', utm });
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get('utm_source'), 'linkedin');
  assert.equal(parsed.searchParams.get('utm_medium'), 'organic_social');
  assert.equal(parsed.searchParams.get('utm_campaign'), 'up2cloud_blog');
  assert.equal(parsed.searchParams.get('utm_content'), 'my-post');
  assert.equal(parsed.pathname, '/blog/my-post/');
});

test('a traversal slug is rejected before it reaches a public URL', () => {
  assert.throws(() => buildTrackedUrl({ siteBaseUrl: 'https://up2cloud.tech', slug: '../../etc', utm }), /Slug/);
});

test('composed post has the required structure', () => {
  const composed = composeLinkedInPost(
    {
      slug: 'argo-rollouts',
      title: 'Progressive Delivery',
      opening: 'A canary that cannot roll itself back is just a slower outage.',
      problem: 'Most teams wire up canary weights but never wire up the abort condition.',
      takeaways: ['Define the metric gate first', 'Fail closed on missing metrics', 'Keep rollback under one minute'],
      hashtags: ['Kubernetes', 'GitOps'],
      topicLabel: 'Kubernetes & GitOps',
    },
    { siteBaseUrl: 'https://up2cloud.tech', utm },
  );

  assert.equal(validateComposedPost(composed).length, 0, JSON.stringify(validateComposedPost(composed)));
  assert.ok(composed.commentary.includes(composed.url));
  assert.ok(composed.hashtags.length <= 3);
  assert.equal((composed.commentary.match(/^→ /gm) || []).length, 3);
});

test('hashtags are capped at three', () => {
  const composed = composeLinkedInPost(
    {
      slug: 'x',
      opening: 'Opening line about a real engineering constraint here.',
      problem: 'The problem statement.',
      takeaways: ['One', 'Two'],
      hashtags: ['A', 'B', 'C', 'D', 'E'],
    },
    { siteBaseUrl: 'https://up2cloud.tech', utm },
  );
  assert.equal(composed.hashtags.length, 3);
});

test('too few takeaways is rejected', () => {
  assert.throws(
    () =>
      composeLinkedInPost(
        { slug: 'x', opening: 'o', problem: 'p', takeaways: ['only one'] },
        { siteBaseUrl: 'https://up2cloud.tech', utm },
      ),
    /at least 2 takeaways/,
  );
});

test('hashtag formatting', () => {
  assert.equal(toHashtag('Platform Engineering'), '#PlatformEngineering');
  assert.equal(toHashtag('Kubernetes & GitOps'), '#KubernetesGitOps');
  assert.equal(toHashtag(''), null);
});
