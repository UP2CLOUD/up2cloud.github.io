'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { verifyDeployment } = require('../src/verify/deployment');

const SLUG = 'my-article';
const URL = `https://up2cloud.tech/blog/${SLUG}/`;
const TITLE = 'Progressive Delivery with Argo Rollouts';

function pageHtml(overrides = {}) {
  const {
    title = `${TITLE} — UP2CLOUD`,
    canonical = URL,
    ogImage = 'https://up2cloud.tech/assets/img/og-image.png',
    robots = null,
    jsonLd = '{"@context":"https://schema.org","@type":"BlogPosting","headline":"x"}',
    includeOg = true,
  } = overrides;

  return [
    '<!DOCTYPE html><html><head>',
    `<title>${title}</title>`,
    `<link rel="canonical" href="${canonical}" />`,
    robots ? `<meta name="robots" content="${robots}" />` : '',
    includeOg
      ? [
          `<meta property="og:title" content="${title}" />`,
          `<meta property="og:url" content="${URL}" />`,
          '<meta property="og:description" content="A description of the article." />',
          `<meta property="og:image" content="${ogImage}" />`,
        ].join('\n')
      : '',
    jsonLd ? `<script type="application/ld+json">${jsonLd}</script>` : '',
    '</head><body><h1>Article</h1></body></html>',
  ].join('\n');
}

/** Build a fetch stub keyed by URL substring. */
function stubFetch(routes) {
  return async (url) => {
    for (const [needle, response] of routes) {
      if (url.includes(needle)) {
        return {
          status: response.status ?? 200,
          ok: (response.status ?? 200) < 400,
          headers: {
            get: (k) => {
              const h = { 'content-type': response.contentType ?? 'text/html', ...(response.headers || {}) };
              return h[k.toLowerCase()] ?? null;
            },
          },
          arrayBuffer: async () => Buffer.from(response.body ?? '', 'utf8'),
          text: async () => response.body ?? '',
        };
      }
    }
    return {
      status: 404,
      ok: false,
      headers: { get: () => null },
      arrayBuffer: async () => Buffer.from('', 'utf8'),
      text: async () => '',
    };
  };
}

const resolver = { lookup: async () => [{ address: '93.184.216.34', family: 4 }] };
const noSleep = async () => {};

function happyRoutes(pageOverrides = {}) {
  return [
    ['/assets/img/og-image.png', { contentType: 'image/png', body: 'PNG' }],
    ['/sitemap.xml', { contentType: 'application/xml', body: `<urlset><loc>${URL}</loc></urlset>` }],
    ['/blog/', { body: `<a href="/blog/${SLUG}/">post</a>` }],
    [`/blog/${SLUG}/`, { body: pageHtml(pageOverrides) }],
  ];
}

/** Route order matters: the article URL must match before the generic /blog/. */
function routesFor(pageOverrides = {}, extra = []) {
  return [
    [`/blog/${SLUG}/`, { body: pageHtml(pageOverrides) }],
    ...extra,
    ['/assets/img/og-image.png', { contentType: 'image/png', body: 'PNG' }],
    ['/sitemap.xml', { contentType: 'application/xml', body: `<urlset><loc>${URL}</loc></urlset>` }],
    ['/blog/', { body: `<a href="/blog/${SLUG}/">post</a>` }],
  ];
}

test('a fully correct deployment passes every check', async () => {
  const r = await verifyDeployment(
    { slug: SLUG, title: TITLE, canonicalUrl: URL },
    { fetchImpl: stubFetch(routesFor()), resolver, sleep: noSleep },
  );
  assert.equal(r.ok, true, JSON.stringify(r.failures, null, 2));
  const names = r.checks.map((c) => c.name);
  for (const expected of [
    'http_200',
    'title',
    'canonical',
    'open_graph',
    'og_image_reachable',
    'indexable',
    'structured_data',
    'sitemap',
    'internal_links',
  ]) {
    assert.ok(names.includes(expected), `missing check "${expected}"`);
  }
});

test('a 404 article fails fast and blocks LinkedIn', async () => {
  const r = await verifyDeployment(
    { slug: SLUG, title: TITLE, canonicalUrl: URL },
    { fetchImpl: stubFetch([]), resolver, sleep: noSleep, retries: 2 },
  );
  assert.equal(r.ok, false);
  assert.equal(r.checks[0].name, 'http_200');
  assert.equal(r.checks[0].ok, false);
});

test('retries a transient 404 then succeeds once the CDN catches up', async () => {
  let calls = 0;
  const fetchImpl = async (url) => {
    if (url.includes(`/blog/${SLUG}/`) && !url.includes('sitemap')) {
      calls += 1;
      if (calls < 3) {
        return { status: 404, ok: false, headers: { get: () => null }, arrayBuffer: async () => Buffer.from(''), text: async () => '' };
      }
    }
    return stubFetch(routesFor())(url);
  };
  const r = await verifyDeployment(
    { slug: SLUG, title: TITLE, canonicalUrl: URL },
    { fetchImpl, resolver, sleep: noSleep, retries: 5 },
  );
  assert.equal(r.ok, true, JSON.stringify(r.failures));
});

test('a noindex page fails the indexable check', async () => {
  const r = await verifyDeployment(
    { slug: SLUG, title: TITLE, canonicalUrl: URL },
    { fetchImpl: stubFetch(routesFor({ robots: 'noindex, nofollow' })), resolver, sleep: noSleep },
  );
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((f) => f.name === 'indexable'));
});

test('a wrong canonical fails', async () => {
  const r = await verifyDeployment(
    { slug: SLUG, title: TITLE, canonicalUrl: URL },
    {
      fetchImpl: stubFetch(routesFor({ canonical: 'https://up2cloud.tech/blog/other/' })),
      resolver,
      sleep: noSleep,
    },
  );
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((f) => f.name === 'canonical'));
});

test('missing Open Graph tags fail', async () => {
  const r = await verifyDeployment(
    { slug: SLUG, title: TITLE, canonicalUrl: URL },
    { fetchImpl: stubFetch(routesFor({ includeOg: false })), resolver, sleep: noSleep },
  );
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((f) => f.name === 'open_graph'));
});

test('an unreachable og:image fails — LinkedIn would scrape a broken card', async () => {
  const routes = [
    [`/blog/${SLUG}/`, { body: pageHtml() }],
    ['/sitemap.xml', { contentType: 'application/xml', body: `<urlset><loc>${URL}</loc></urlset>` }],
    ['/blog/', { body: `<a href="/blog/${SLUG}/">post</a>` }],
    // og-image.png intentionally absent → 404 fallback
  ];
  const r = await verifyDeployment(
    { slug: SLUG, title: TITLE, canonicalUrl: URL },
    { fetchImpl: stubFetch(routes), resolver, sleep: noSleep },
  );
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((f) => f.name === 'og_image_reachable'));
});

test('invalid JSON-LD fails structured data', async () => {
  const r = await verifyDeployment(
    { slug: SLUG, title: TITLE, canonicalUrl: URL },
    { fetchImpl: stubFetch(routesFor({ jsonLd: '{ broken json' })), resolver, sleep: noSleep },
  );
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((f) => f.name === 'structured_data'));
});

test('absence from the sitemap fails', async () => {
  const routes = [
    [`/blog/${SLUG}/`, { body: pageHtml() }],
    ['/assets/img/og-image.png', { contentType: 'image/png', body: 'PNG' }],
    ['/sitemap.xml', { contentType: 'application/xml', body: '<urlset></urlset>' }],
    ['/blog/', { body: `<a href="/blog/${SLUG}/">post</a>` }],
  ];
  const r = await verifyDeployment(
    { slug: SLUG, title: TITLE, canonicalUrl: URL },
    { fetchImpl: stubFetch(routes), resolver, sleep: noSleep },
  );
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((f) => f.name === 'sitemap'));
});

test('an orphan page not linked from the blog index fails', async () => {
  const routes = [
    [`/blog/${SLUG}/`, { body: pageHtml() }],
    ['/assets/img/og-image.png', { contentType: 'image/png', body: 'PNG' }],
    ['/sitemap.xml', { contentType: 'application/xml', body: `<urlset><loc>${URL}</loc></urlset>` }],
    ['/blog/', { body: '<p>no links here</p>' }],
  ];
  const r = await verifyDeployment(
    { slug: SLUG, title: TITLE, canonicalUrl: URL },
    { fetchImpl: stubFetch(routes), resolver, sleep: noSleep },
  );
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((f) => f.name === 'internal_links'));
});
