'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { applyFixes, applyMetaFix, applyCanonicalFix, addToSitemap, escapeAttr } = require('../src/fix');
const { auditSite } = require('../src/audit');
const { meta, linkHref, metaTags } = require('../src/parse');

const BASE = 'https://up2cloud.tech';

const PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Kubernetes Security Checklist for Platform Teams</title>
  <meta name="description" content="A production Kubernetes security checklist covering RBAC, admission control, network policy and supply-chain verification for platform teams.">
  <link rel="canonical" href="${BASE}/blog/k8s/" />
</head>
<body>
  <h1>Kubernetes Security</h1>
</body>
</html>`;

// ── Splicing ──────────────────────────────────────────────────────────────

test('a new meta tag lands inside <head>', () => {
  const out = applyMetaFix(PAGE, { attr: 'name', name: 'twitter:card', value: 'summary_large_image' });
  assert.equal(meta(out, 'twitter:card'), 'summary_large_image');
  const headEnd = out.search(/<\/head>/i);
  assert.ok(out.indexOf('twitter:card') < headEnd, 'inserted before </head>');
});

test('an existing meta tag is updated in place, not duplicated', () => {
  const once = applyMetaFix(PAGE, { attr: 'name', name: 'description', value: 'New description text.' });
  assert.equal(meta(once, 'description'), 'New description text.');
  const count = metaTags(once).filter((a) => (a.name || '').toLowerCase() === 'description').length;
  assert.equal(count, 1, 'exactly one description tag');
});

test('canonical is replaced rather than appended', () => {
  const out = applyCanonicalFix(PAGE, { value: `${BASE}/blog/k8s-security/` });
  assert.equal(linkHref(out, 'canonical'), `${BASE}/blog/k8s-security/`);
  assert.equal((out.match(/rel="canonical"/g) || []).length, 1);
});

test('applying the same fix twice changes nothing the second time', () => {
  // The weekly run re-reads its own output; a non-idempotent fixer would grow
  // the <head> without bound.
  const fix = { kind: 'meta', attr: 'name', name: 'twitter:card', value: 'summary_large_image' };
  const first = applyFixes(PAGE, [fix]);
  const second = applyFixes(first.html, [fix]);
  assert.equal(second.html, first.html);
  assert.equal(second.applied.length, 0);
  assert.equal(second.skipped.length, 1);
});

test('untouched markup is preserved byte-for-byte', () => {
  // A fixer that reformats produces a 500-line diff for a one-tag change, and
  // nobody reviews that properly.
  const out = applyFixes(PAGE, [
    { kind: 'meta', attr: 'name', name: 'twitter:card', value: 'summary_large_image' },
  ]).html;
  for (const line of PAGE.split('\n')) {
    if (line.includes('twitter:card')) continue;
    assert.ok(out.includes(line), `original line lost: ${line}`);
  }
});

test('values are escaped so content cannot break out of the attribute', () => {
  const out = applyMetaFix(PAGE, {
    attr: 'name',
    name: 'twitter:title',
    value: 'He said "stop" & <script>alert(1)</script>',
  });
  assert.equal(out.includes('<script>alert(1)</script>'), false, 'no live script injected');
  assert.equal(meta(out, 'twitter:title'), 'He said "stop" & <script>alert(1)</script>');
});

test('escapeAttr handles the characters that matter', () => {
  assert.equal(escapeAttr('a"b'), 'a&quot;b');
  assert.equal(escapeAttr('a&b'), 'a&amp;b');
  assert.equal(escapeAttr('<x>'), '&lt;x&gt;');
});

test('a tag is never spliced inside <noscript>', () => {
  // The real privacy page ends its head with a no-JS font fallback:
  //   <noscript><link href="…fonts…" rel="stylesheet" /></noscript>
  // Anchoring to "the last <link> in head" put the new meta INSIDE the
  // noscript — invisible to crawlers that run JS, and it broke the markup.
  const page = `<!doctype html><html lang="en"><head>
  <meta charset="utf-8">
  <title>Privacy Policy — UP2CLOUD Consulting</title>
  <link rel="canonical" href="${BASE}/privacy/" />
  <noscript><link href="https://fonts.example/css" rel="stylesheet" /></noscript>
  <style>body{color:red}</style>
</head><body><h1>Privacy</h1></body></html>`;

  const out = applyMetaFix(page, { attr: 'name', name: 'twitter:card', value: 'summary_large_image' });

  const noscript = out.match(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/i)[0];
  assert.equal(noscript.includes('twitter:card'), false, 'must not land inside <noscript>');
  assert.ok(out.indexOf('twitter:card') < out.search(/<\/head>/i), 'still inside head');
  // The noscript block itself must survive untouched.
  assert.ok(out.includes('<noscript><link href="https://fonts.example/css" rel="stylesheet" /></noscript>'));
});

test('a tag is never spliced inside a <script> or comment in head', () => {
  const page = `<html><head>
  <title>A perfectly reasonable page title here</title>
  <script>var x = "<link rel=stylesheet>";</script>
  <!-- <meta name="ghost" content="x"> -->
</head><body></body></html>`;
  const out = applyMetaFix(page, { attr: 'name', name: 'twitter:card', value: 'summary_large_image' });
  const script = out.match(/<script\b[^>]*>[\s\S]*?<\/script>/i)[0];
  assert.equal(script.includes('twitter:card'), false);
  assert.ok(out.includes('<!-- <meta name="ghost" content="x"> -->'), 'comment untouched');
});

test('a page with no <head> is skipped, not corrupted', () => {
  const r = applyFixes('<html><body>hi</body></html>', [
    { kind: 'meta', attr: 'name', name: 'twitter:card', value: 'x' },
  ]);
  assert.equal(r.html, '<html><body>hi</body></html>');
  assert.equal(r.skipped.length, 1);
});

// ── Sitemap ───────────────────────────────────────────────────────────────

const SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${BASE}/</loc>
    <lastmod>2026-08-01</lastmod>
  </url>
</urlset>`;

test('a new URL is appended before </urlset>', () => {
  const out = addToSitemap(SITEMAP, `${BASE}/about/`, '2026-08-10');
  assert.ok(out.includes(`<loc>${BASE}/about/</loc>`));
  assert.ok(out.trimEnd().endsWith('</urlset>'));
  assert.equal((out.match(/<urlset/g) || []).length, 1);
});

test('an already-listed URL is not added again', () => {
  assert.equal(addToSitemap(SITEMAP, `${BASE}/`, '2026-08-10'), null);
});

// ── End to end against a real repo layout ─────────────────────────────────

/** A complete, correct page — used so the fixture itself adds no findings. */
const HOME = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>UP2CLOUD — Cloud, DevOps and FinOps Consulting</title>
  <meta name="description" content="UP2CLOUD helps engineering teams cut cloud spend and ship faster, with FinOps, DevOps and platform engineering that survives production.">
  <link rel="canonical" href="${BASE}/" />
  <meta property="og:title" content="UP2CLOUD — Cloud, DevOps and FinOps Consulting">
  <meta property="og:description" content="Cut cloud spend and ship faster.">
  <meta property="og:url" content="${BASE}/">
  <meta property="og:type" content="website">
  <meta property="og:image" content="${BASE}/assets/img/og-image.png">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="UP2CLOUD">
  <meta name="twitter:description" content="Cut cloud spend and ship faster.">
</head>
<body><h1>UP2CLOUD</h1></body>
</html>`;

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seo-fix-'));
  fs.mkdirSync(path.join(dir, 'blog', 'k8s'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'blog', 'k8s', 'index.html'), PAGE);
  // The sitemap lists the site root, so the fixture must actually contain it —
  // otherwise the (correct) sitemap-orphan rule fires and the fixture, not the
  // code under test, is what fails.
  fs.writeFileSync(path.join(dir, 'index.html'), HOME);
  fs.writeFileSync(path.join(dir, 'sitemap.xml'), SITEMAP);
  fs.writeFileSync(path.join(dir, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${BASE}/sitemap.xml\n`);
  return dir;
}

test('audit alone never writes to disk', () => {
  const dir = sandbox();
  const file = path.join(dir, 'blog', 'k8s', 'index.html');
  const before = fs.readFileSync(file, 'utf8');
  const beforeSitemap = fs.readFileSync(path.join(dir, 'sitemap.xml'), 'utf8');

  const r = auditSite({ repoRoot: dir, baseUrl: BASE, apply: false });

  assert.ok(r.findings.length > 0, 'it found something');
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'page untouched');
  assert.equal(fs.readFileSync(path.join(dir, 'sitemap.xml'), 'utf8'), beforeSitemap);
  assert.deepEqual(r.changed, []);
});

test('fix writes the page and adds it to the sitemap', () => {
  const dir = sandbox();
  const r = auditSite({
    repoRoot: dir,
    baseUrl: BASE,
    apply: true,
    defaultOgImage: `${BASE}/assets/img/og-image.png`,
    today: '2026-08-10',
  });

  assert.ok(r.changed.length >= 1);
  const html = fs.readFileSync(path.join(dir, 'blog', 'k8s', 'index.html'), 'utf8');
  assert.equal(meta(html, 'og:title'), 'Kubernetes Security Checklist for Platform Teams');
  assert.equal(meta(html, 'og:url'), `${BASE}/blog/k8s/`);
  assert.equal(meta(html, 'og:type'), 'article');
  assert.equal(meta(html, 'twitter:card'), 'summary_large_image');

  const xml = fs.readFileSync(path.join(dir, 'sitemap.xml'), 'utf8');
  assert.ok(xml.includes(`<loc>${BASE}/blog/k8s/</loc>`));
});

test('running fix twice produces no second diff', () => {
  const dir = sandbox();
  const opts = { repoRoot: dir, baseUrl: BASE, apply: true, defaultOgImage: `${BASE}/x.png`, today: '2026-08-10' };
  auditSite(opts);
  const afterFirst = fs.readFileSync(path.join(dir, 'blog', 'k8s', 'index.html'), 'utf8');
  const xmlFirst = fs.readFileSync(path.join(dir, 'sitemap.xml'), 'utf8');

  const second = auditSite(opts);
  assert.equal(fs.readFileSync(path.join(dir, 'blog', 'k8s', 'index.html'), 'utf8'), afterFirst);
  assert.equal(fs.readFileSync(path.join(dir, 'sitemap.xml'), 'utf8'), xmlFirst);
  assert.deepEqual(second.changed, [], 'a settled site produces an empty PR, not a churn PR');
});

test('the fixed page then audits clean', () => {
  const dir = sandbox();
  auditSite({ repoRoot: dir, baseUrl: BASE, apply: true, defaultOgImage: `${BASE}/x.png` });
  const after = auditSite({ repoRoot: dir, baseUrl: BASE, apply: false });
  assert.equal(after.counts.error, 0, JSON.stringify(after.findings, null, 2));
  assert.equal(after.fixable, 0, 'nothing fixable remains');
});

test('a sitemap URL with no page behind it is reported as an error', () => {
  const dir = sandbox();
  fs.writeFileSync(
    path.join(dir, 'sitemap.xml'),
    SITEMAP.replace('</urlset>', `  <url><loc>${BASE}/deleted/</loc></url>\n</urlset>`),
  );
  const r = auditSite({ repoRoot: dir, baseUrl: BASE });
  const f = r.findings.find((x) => x.rule === 'sitemap-orphan');
  assert.ok(f, 'orphan detected');
  assert.equal(f.severity, 'error');
});

test('duplicate titles across pages are detected', () => {
  const dir = sandbox();
  fs.mkdirSync(path.join(dir, 'blog', 'copy'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'blog', 'copy', 'index.html'), PAGE.replace('/blog/k8s/', '/blog/copy/'));
  const r = auditSite({ repoRoot: dir, baseUrl: BASE });
  assert.ok(r.findings.some((f) => f.rule === 'duplicate-title'));
});

test('the automation directory is never scanned as site content', () => {
  const dir = sandbox();
  fs.mkdirSync(path.join(dir, 'automation', 'seo'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'automation', 'seo', 'fixture.html'), '<html><body>x</body></html>');
  const r = auditSite({ repoRoot: dir, baseUrl: BASE });
  assert.equal(
    r.pages.some((p) => p.file.includes('automation')),
    false,
  );
});
