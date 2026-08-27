'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { linkResolves } = require('../src/audit');

/**
 * Build a throwaway repo containing exactly the given files, so link
 * resolution is exercised against a real filesystem rather than a stub.
 */
function sandbox(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seo-audit-'));
  for (const rel of files) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, '');
  }
  return root;
}

// ── Static pages ──────────────────────────────────────────────────────────

test('a directory index resolves with or without a trailing slash', () => {
  const root = sandbox(['about/index.html']);
  assert.equal(linkResolves('/about/', root), true);
  assert.equal(linkResolves('/about', root), true);
});

test('a bare .html file resolves', () => {
  const root = sandbox(['404.html']);
  assert.equal(linkResolves('/404.html', root), true);
});

test('a path with no backing file does not resolve', () => {
  const root = sandbox(['about/index.html']);
  assert.equal(linkResolves('/nope', root), false);
  assert.equal(linkResolves('/nope/', root), false);
});

// ── Cloudflare Pages Functions ────────────────────────────────────────────

test('a Pages Function resolves the route it serves', () => {
  // functions/connect.js answers GET/POST /connect. Before this was taught to
  // the auditor, the navbar's "MCP Connector" link was reported as broken on
  // every run even though the URL returns 200 — an un-actionable warning that
  // reappears weekly is how a report stops being read.
  const root = sandbox(['functions/connect.js']);
  assert.equal(linkResolves('/connect', root), true);
  assert.equal(linkResolves('/connect/', root), true);
});

test('a nested Pages Function resolves', () => {
  const root = sandbox(['functions/api/chat.js']);
  assert.equal(linkResolves('/api/chat', root), true);
});

test('a Pages Function directory index resolves', () => {
  const root = sandbox(['functions/widget/index.js']);
  assert.equal(linkResolves('/widget', root), true);
});

test('an unrelated function does not make every route resolve', () => {
  const root = sandbox(['functions/connect.js']);
  assert.equal(linkResolves('/not-a-function', root), false);
});

test('the root is never resolved by the functions fallback', () => {
  // "/" must be answered by index.html; letting functions/ satisfy it would
  // mask a genuinely missing homepage.
  const root = sandbox(['functions/connect.js']);
  assert.equal(linkResolves('/', root), false);
});

test('a static page still wins when both exist', () => {
  const root = sandbox(['connect/index.html', 'functions/connect.js']);
  assert.equal(linkResolves('/connect', root), true);
});
