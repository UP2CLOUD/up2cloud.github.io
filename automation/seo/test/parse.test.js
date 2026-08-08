'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parsePage,
  parseAttributes,
  decodeEntities,
  meta,
  linkHref,
  headings,
  jsonLd,
  internalLinks,
  images,
} = require('../src/parse');

// ── The bug this parser exists to avoid ───────────────────────────────────

test('an apostrophe inside a double-quoted value does not truncate it', () => {
  // The naive `content="([^"']*)"` pattern stops at the apostrophe and reports
  // a 12-character description. That produced a confident, totally wrong
  // "description too short" finding against this very repo.
  const html = `<meta name="description" content="How UP2CLOUD's FinOps audit — tagging, rightsizing — cut spend." />`;
  const value = meta(html, 'description');
  assert.ok(value.includes("UP2CLOUD's"), 'apostrophe survived');
  assert.ok(value.length > 50, `expected full value, got ${value.length} chars`);
});

test('a double quote inside a single-quoted value does not truncate it', () => {
  const html = `<meta name='description' content='He said "hello" to the cluster operator, at length, repeatedly.' />`;
  assert.ok(meta(html, 'description').includes('"hello"'));
});

test('attribute order does not matter', () => {
  assert.equal(meta('<meta content="X" name="description">', 'description'), 'X');
  assert.equal(meta('<meta name="description" content="X">', 'description'), 'X');
});

test('og tags are found whether declared via property or name', () => {
  assert.equal(meta('<meta property="og:title" content="A">', 'og:title'), 'A');
  assert.equal(meta('<meta name="og:title" content="B">', 'og:title'), 'B');
});

test('commented-out tags are not treated as present', () => {
  const html = '<!-- <meta name="description" content="ghost"> -->';
  assert.equal(meta(html, 'description'), null);
});

test('entities are decoded so lengths reflect what users see', () => {
  assert.equal(decodeEntities('A &amp; B &mdash; C'), 'A & B — C');
  assert.equal(decodeEntities('&#8212;'), '—');
  assert.equal(decodeEntities('&#x2014;'), '—');
  // An unknown entity is left alone rather than mangled.
  assert.equal(decodeEntities('&zzz;'), '&zzz;');
});

test('bare (unquoted) attribute values parse', () => {
  assert.equal(parseAttributes('<meta name=robots content=noindex>').content, 'noindex');
});

// ── Script/style must not be mistaken for content ──────────────────────────

test('links inside a <script> template are not treated as real links', () => {
  // `/blog/${post.slug}/` in the homepage's JS was reported as a broken
  // internal link until content scanning learned to skip script bodies.
  const html = `
    <a href="/blog/real-post/">Real</a>
    <script>const t = \`<a href="/blog/\${post.slug}/">x</a>\`;</script>`;
  const links = internalLinks(html, 'https://example.com');
  assert.deepEqual(links, ['/blog/real-post/']);
});

test('headings and images inside scripts are ignored', () => {
  const html = '<h1>Real</h1><script><h1>Fake</h1><img src=x></script>';
  assert.deepEqual(headings(html, 1), ['Real']);
  assert.equal(images(html).length, 0);
});

// ── Structured data ───────────────────────────────────────────────────────

test('valid JSON-LD parses and invalid blocks are counted, not thrown', () => {
  const good = '<script type="application/ld+json">{"@type":"BlogPosting"}</script>';
  const bad = '<script type="application/ld+json">{ nope</script>';
  assert.equal(jsonLd(good).invalid, 0);
  assert.equal(jsonLd(good).blocks[0]['@type'], 'BlogPosting');
  assert.equal(jsonLd(good + bad).invalid, 1);
  assert.equal(jsonLd(good + bad).count, 2);
});

// ── Whole-page parse ──────────────────────────────────────────────────────

test('parsePage reports noindex from a robots meta', () => {
  assert.equal(parsePage('<meta name="robots" content="noindex, follow">').noindex, true);
  assert.equal(parsePage('<meta name="robots" content="index, follow">').noindex, false);
  assert.equal(parsePage('<html></html>').noindex, false);
});

test('canonical is read from rel lists containing more than one value', () => {
  assert.equal(
    linkHref('<link rel="canonical alternate" href="https://x.test/a">', 'canonical'),
    'https://x.test/a',
  );
});

test('title whitespace is collapsed', () => {
  assert.equal(parsePage('<title>\n  A   B \n</title>').title, 'A B');
});
