'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const CLI = path.resolve(__dirname, '..', 'src', 'cli.js');
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

function run(argv) {
  try {
    return { code: 0, stdout: execFileSync(process.execPath, [CLI, ...argv], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (err) {
    return { code: err.status, stdout: err.stdout || '', stderr: err.stderr || '' };
  }
}

test('--help exits 0', () => {
  assert.equal(run(['--help']).code, 0);
});

test('an unknown command exits 2', () => {
  assert.equal(run(['demolish']).code, 2);
});

test('audit emits valid JSON with --json', () => {
  const r = run(['audit', '--json']);
  const parsed = JSON.parse(r.stdout);
  assert.ok(parsed.pagesScanned > 0);
  assert.ok(Array.isArray(parsed.findings));
  assert.ok(parsed.counts);
});

test('audit against the real repo leaves the working tree untouched', () => {
  // The default command must be safe to run anywhere, including on a
  // developer's dirty checkout.
  const before = execFileSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' });
  run(['audit']);
  const after = execFileSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.equal(after, before, 'audit must never write');
});

test('the real site currently has zero SEO errors', () => {
  // A regression guard: if a future commit ships a page missing a canonical or
  // with broken JSON-LD, this fails in CI on that PR rather than a week later.
  const parsed = JSON.parse(run(['audit', '--json']).stdout);
  const errors = parsed.findings.filter((f) => f.severity === 'error');
  assert.deepEqual(errors, [], `SEO errors introduced:\n${JSON.stringify(errors, null, 2)}`);
});

test('--report writes the markdown to a file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seo-report-'));
  const out = path.join(dir, 'report.md');
  const r = run(['audit', '--report', out]);
  assert.equal(r.code, 0);
  const md = fs.readFileSync(out, 'utf8');
  assert.match(md, /## Weekly SEO audit/);
  assert.match(md, /Scanned \*\*\d+ pages\*\*/);
});
