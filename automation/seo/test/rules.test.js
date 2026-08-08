'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { auditPage, urlForFile, isBlogPost, SEVERITY } = require('../src/rules');

const BASE = 'https://up2cloud.tech';

/** A page with complete, correct metadata. */
function goodPage({ url = `${BASE}/about/`, title = 'About UP2CLOUD — Cloud & FinOps Consulting' } = {}) {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<meta name="description" content="UP2CLOUD helps engineering teams cut cloud spend and ship faster with FinOps, DevOps and platform engineering practices that hold up.">
<link rel="canonical" href="${url}" />
<meta property="og:title" content="${title}">
<meta property="og:description" content="UP2CLOUD helps engineering teams cut cloud spend and ship faster.">
<meta property="og:url" content="${url}">
<meta property="og:type" content="website">
<meta property="og:image" content="${BASE}/assets/img/og-image.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="UP2CLOUD helps engineering teams cut cloud spend.">
</head><body><h1>About</h1></body></html>`;
}

const run = (file, html, opts = {}) =>
  auditPage({ file, html, baseUrl: BASE, sitemapUrls: new Set([urlForFile(file, BASE)]), ...opts });

// ── URL mapping ───────────────────────────────────────────────────────────

test('file paths map to the URLs the site actually serves', () => {
  assert.equal(urlForFile('index.html', BASE), `${BASE}/`);
  assert.equal(urlForFile('about/index.html', BASE), `${BASE}/about/`);
  assert.equal(urlForFile('blog/a-post/index.html', BASE), `${BASE}/blog/a-post/`);
  assert.equal(urlForFile('404.html', BASE), `${BASE}/404.html`);
});

test('blog posts are distinguished from the blog index', () => {
  assert.equal(isBlogPost('blog/a-post/index.html'), true);
  assert.equal(isBlogPost('blog/index.html'), false);
  assert.equal(isBlogPost('about/index.html'), false);
});

// ── A clean page produces no noise ────────────────────────────────────────

test('a fully correct page yields no findings', () => {
  const r = run('about/index.html', goodPage());
  assert.deepEqual(r.findings, [], JSON.stringify(r.findings, null, 2));
});

// ── The dangerous case: consolidated duplicates ───────────────────────────

test('a canonical pointing elsewhere is reported but NEVER auto-fixed', () => {
  // privacy/index_old.html canonicalises to /privacy/. That is correct: it
  // suppresses a stale duplicate. An earlier version of this rule "fixed" it by
  // pointing the canonical at itself, which would have promoted the duplicate
  // into a competitor of the real page.
  const html = goodPage({ url: `${BASE}/privacy/` });
  const r = run('privacy/index_old.html', html);

  const finding = r.findings.find((f) => f.rule === 'canonical-points-elsewhere');
  assert.ok(finding, 'the mismatch is reported');
  assert.equal(finding.severity, SEVERITY.INFO);
  assert.equal(finding.fixable, false);

  assert.equal(
    r.fixes.some((f) => f.kind === 'canonical'),
    false,
    'no canonical rewrite may ever be proposed',
  );
});

test('a consolidated duplicate gets no cosmetic fixes either', () => {
  // It will never rank or be shared, so editing its social tags is pure diff
  // churn on a file heading for deletion.
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Privacy Policy — UP2CLOUD Consulting Services</title>
<meta name="description" content="How UP2CLOUD collects, uses and protects personal data across our consulting engagements and this website.">
<link rel="canonical" href="${BASE}/privacy/" /></head><body><h1>Privacy</h1></body></html>`;
  const r = run('privacy/index_old.html', html);
  assert.equal(r.fixes.length, 0, `expected no fixes, got ${JSON.stringify(r.fixes)}`);
  assert.ok(r.findings.length > 0, 'but it is still reported');
});

// ── noindex pages ─────────────────────────────────────────────────────────

test('a noindex page is not nagged about search-presentation tags', () => {
  // A 404 needs no canonical, description, sitemap entry or h1. Demanding them
  // creates findings that can never legitimately be cleared.
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex">
<title>Page not found — UP2CLOUD</title></head><body><p>Gone</p></body></html>`;
  const r = auditPage({ file: '404.html', html, baseUrl: BASE, sitemapUrls: new Set() });

  const ids = r.findings.map((f) => f.rule);
  for (const shouldNotFire of [
    'description-present',
    'canonical-present',
    'h1-exactly-one',
    'sitemap-listed',
    'og-title',
    'twitter-card',
  ]) {
    assert.equal(ids.includes(shouldNotFire), false, `${shouldNotFire} must not fire on noindex`);
  }
});

test('a noindex page IS still checked for things that are simply broken', () => {
  const html = '<html><head><meta name="robots" content="noindex"><title>X</title>' +
    '<script type="application/ld+json">{ broken</script></head><body></body></html>';
  const r = auditPage({ file: '404.html', html, baseUrl: BASE, sitemapUrls: new Set() });
  const ids = r.findings.map((f) => f.rule);
  assert.ok(ids.includes('jsonld-valid'), 'invalid structured data still reported');
  assert.ok(ids.includes('charset'), 'missing charset still reported');
});

test('noindex plus a sitemap entry is flagged as contradictory', () => {
  const html = '<html lang="en"><head><meta charset="utf-8"><title>Hidden page here</title>' +
    '<meta name="viewport" content="width=device-width"><meta name="robots" content="noindex"></head><body></body></html>';
  const r = auditPage({
    file: 'secret/index.html',
    html,
    baseUrl: BASE,
    sitemapUrls: new Set([`${BASE}/secret/`]),
  });
  assert.ok(r.findings.some((f) => f.rule === 'robots-indexable'));
});

// ── Fixable vs judgement ──────────────────────────────────────────────────

test('missing mechanical tags are fixable', () => {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Platform Engineering and FinOps in 2026 — UP2CLOUD</title>
<meta name="description" content="What platform teams actually changed in 2026, and the cost controls that survived contact with production workloads.">
<link rel="canonical" href="${BASE}/blog/p/" /></head><body><h1>P</h1></body></html>`;
  const r = run('blog/p/index.html', html);
  const fixed = r.fixes.map((f) => f.name || f.kind);

  assert.ok(fixed.includes('og:title'));
  assert.ok(fixed.includes('og:url'));
  assert.ok(fixed.includes('twitter:card'));
  // og:type on a blog post must be "article", not "website".
  assert.equal(r.fixes.find((f) => f.name === 'og:type').value, 'article');
});

test('title and description LENGTH are never auto-fixed', () => {
  // Rewriting these means deciding what a page is about. A bot doing that
  // weekly churns the SERP snippet and drifts the site's voice.
  const html = goodPage({ title: 'Privacy' });
  const r = run('privacy/index.html', html);
  const lengthFinding = r.findings.find((f) => f.rule === 'title-length');
  assert.ok(lengthFinding);
  assert.equal(lengthFinding.fixable, false);
  assert.equal(lengthFinding.severity, SEVERITY.WARN);
});

test('og:url is derived from the canonical, not the file path', () => {
  const html = goodPage({ url: `${BASE}/about/` }).replace(/<meta property="og:url"[^>]*>/, '');
  const r = run('about/index.html', html);
  assert.equal(r.fixes.find((f) => f.name === 'og:url').value, `${BASE}/about/`);
});

test('a page missing from the sitemap is reported and fixable', () => {
  const r = auditPage({
    file: 'about/index.html',
    html: goodPage(),
    baseUrl: BASE,
    sitemapUrls: new Set(),
  });
  const f = r.findings.find((x) => x.rule === 'sitemap-listed');
  assert.ok(f);
  assert.equal(f.fixable, true);
  assert.ok(r.fixes.some((x) => x.kind === 'sitemap'));
});

test('404 and _old pages are never proposed for the sitemap', () => {
  for (const file of ['404.html', 'privacy/index_old.html']) {
    const r = auditPage({ file, html: goodPage(), baseUrl: BASE, sitemapUrls: new Set() });
    assert.equal(
      r.fixes.some((x) => x.kind === 'sitemap'),
      false,
      `${file} must not be added to the sitemap`,
    );
  }
});

test('multiple h1 elements are flagged', () => {
  const html = goodPage().replace('<h1>About</h1>', '<h1>A</h1><h1>B</h1>');
  const r = run('about/index.html', html);
  assert.ok(r.findings.some((f) => f.rule === 'h1-exactly-one'));
});

test('images without alt are counted', () => {
  const html = goodPage().replace('<h1>About</h1>', '<h1>A</h1><img src="a.png"><img src="b.png" alt="">');
  const r = run('about/index.html', html);
  const f = r.findings.find((x) => x.rule === 'image-alt');
  assert.ok(f);
  assert.match(f.message, /^1 <img>/, 'alt="" is a valid decorative alt, not missing');
});
