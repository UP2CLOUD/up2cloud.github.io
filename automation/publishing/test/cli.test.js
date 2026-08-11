'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { requiredCapabilitiesForMode, MODES } = require('../src/config');

const CLI = path.resolve(__dirname, '..', 'src', 'cli.js');

/**
 * Run the CLI as a real subprocess. Exit codes are a contract CI branches on,
 * so they are worth asserting through the actual process boundary rather than
 * by calling main() in-process.
 */
function runCli(argv, env = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopub-cli-'));
  const githubOutput = path.join(stateDir, 'github-output');
  const options = {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      STATE_FILE_PATH: path.join(stateDir, 'ledger.json'),
      GITHUB_OUTPUT: githubOutput,
      ...env,
    },
  };
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...argv], options);
    return {
      code: 0,
      stdout,
      githubOutput: fs.existsSync(githubOutput) ? fs.readFileSync(githubOutput, 'utf8') : '',
    };
  } catch (err) {
    return {
      code: err.status,
      stdout: err.stdout || '',
      stderr: err.stderr || '',
      githubOutput: fs.existsSync(githubOutput) ? fs.readFileSync(githubOutput, 'utf8') : '',
    };
  }
}

// ── Capability preflight ──────────────────────────────────────────────────

test('each mode declares exactly the credentials it can actually need', () => {
  assert.deepEqual(requiredCapabilitiesForMode(MODES.DRY_RUN), ['model']);
  assert.deepEqual(requiredCapabilitiesForMode(MODES.DRAFT), ['model', 'git']);
  assert.deepEqual(requiredCapabilitiesForMode(MODES.REVIEW), ['model', 'git']);
  assert.deepEqual(requiredCapabilitiesForMode(MODES.AUTO), ['model', 'git', 'linkedin']);
});

test('a KV state backend adds its own credential requirement', () => {
  assert.ok(requiredCapabilitiesForMode(MODES.DRY_RUN, 'kv').includes('kvState'));
  assert.equal(requiredCapabilitiesForMode(MODES.DRY_RUN, 'file').includes('kvState'), false);
});

test('a dry run does not require LinkedIn or git credentials', () => {
  // Otherwise the cheapest, safest way to exercise the pipeline would be the
  // one demanding the most privileged secrets.
  const caps = requiredCapabilitiesForMode(MODES.DRY_RUN);
  assert.equal(caps.includes('linkedin'), false);
  assert.equal(caps.includes('git'), false);
});

// ── Workflow configuration check ─────────────────────────────────────────

test('a scheduled auto run skips cleanly when LinkedIn is not configured', () => {
  const r = runCli(['check-config', '--mode', 'auto', '--trigger', 'schedule'], {
    GEMINI_API_KEY: 'test-key',
    GITHUB_TOKEN: 'ghp_test',
  });
  assert.equal(r.code, 0, `stderr: ${r.stderr}`);
  assert.match(r.githubOutput, /^skip=true$/m);
  assert.match(`${r.stdout}${r.stderr}`, /LINKEDIN_ACCESS_TOKEN/);
});

test('a manual auto run fails loudly when LinkedIn is not configured', () => {
  const r = runCli(['check-config', '--mode', 'auto', '--trigger', 'workflow_dispatch'], {
    GEMINI_API_KEY: 'test-key',
    GITHUB_TOKEN: 'ghp_test',
  });
  assert.equal(r.code, 2);
  assert.doesNotMatch(r.githubOutput, /^skip=true$/m);
  assert.match(`${r.stdout}${r.stderr}`, /LINKEDIN_ACCESS_TOKEN/);
});

test('a fully configured scheduled auto run continues to publishing', () => {
  const r = runCli(['check-config', '--mode', 'auto', '--trigger', 'schedule'], {
    GEMINI_API_KEY: 'test-key',
    GITHUB_TOKEN: 'ghp_test',
    LINKEDIN_ACCESS_TOKEN: 'linkedin-test-token',
    LINKEDIN_ORGANIZATION_URN: 'urn:li:organization:12345678',
  });
  assert.equal(r.code, 0, `stderr: ${r.stderr}`);
  assert.match(r.githubOutput, /^skip=false$/m);
});

test('Groq alone satisfies the model credential preflight', () => {
  const r = runCli(['check-config', '--mode', 'dry-run', '--trigger', 'workflow_dispatch'], {
    GROQ_API_KEY: 'gsk_test-key',
  });
  assert.equal(r.code, 0, `stderr: ${r.stderr}`);
  assert.match(r.githubOutput, /^skip=false$/m);
});

test('model preflight fails when neither Gemini nor Groq is configured', () => {
  const r = runCli(['check-config', '--mode', 'dry-run', '--trigger', 'workflow_dispatch'], {});
  assert.equal(r.code, 2);
  assert.match(`${r.stdout}${r.stderr}`, /GEMINI_API_KEY or GROQ_API_KEY/);
});

// ── Exit codes ────────────────────────────────────────────────────────────

test('missing credentials exit 2 (misconfiguration), not 1 (retryable failure)', () => {
  const r = runCli(['publish', '--mode', 'auto'], {});
  assert.equal(r.code, 2, `stderr: ${r.stderr}`);
});

test('auto mode refuses to start without a LinkedIn token', () => {
  // Catching this up front is the difference between "no article" and "an
  // article published with no promotion and a burnt weekly slot".
  const r = runCli(['publish', '--mode', 'auto'], {
    GEMINI_API_KEY: 'test-key',
    GITHUB_TOKEN: 'ghp_test',
  });
  assert.equal(r.code, 2);
  assert.match(`${r.stdout}${r.stderr}`, /LINKEDIN_ACCESS_TOKEN/);
});

test('a SCHEDULED auto run degrades to draft when LinkedIn is unconfigured', () => {
  // While the Community Management API approval is pending, `auto` with no
  // token is the expected state. Failing the cron over it would keep this
  // workflow permanently red, which is how a real failure gets ignored.
  // The degrade decision happens before any model call, so point the client at
  // a dead port and cap retries: this asserts the branch, not the pipeline,
  // and keeps the suite fast and offline.
  const r = runCli(['publish', '--mode', 'auto', '--trigger', 'schedule'], {
    GEMINI_API_KEY: 'test-key',
    GITHUB_TOKEN: 'ghp_test',
    GEMINI_BASE_URL: 'http://127.0.0.1:1',
    GEMINI_MAX_RETRIES: '1',
  });
  const all = `${r.stdout}${r.stderr}`;
  assert.notEqual(r.code, 2, 'must not exit as misconfiguration');
  assert.match(all, /degrading this scheduled run to draft/);
});

test('a MANUAL auto run still fails hard when LinkedIn is unconfigured', () => {
  // Someone clicked "Run workflow" asking for a LinkedIn post; silently
  // downgrading would leave them wondering why nothing was posted.
  const r = runCli(['publish', '--mode', 'auto', '--trigger', 'workflow_dispatch'], {
    GEMINI_API_KEY: 'test-key',
    GITHUB_TOKEN: 'ghp_test',
  });
  assert.equal(r.code, 2);
  assert.match(`${r.stdout}${r.stderr}`, /LINKEDIN_ACCESS_TOKEN/);
});

test('a scheduled auto run with LinkedIn configured is NOT degraded', () => {
  const r = runCli(['publish', '--mode', 'auto', '--trigger', 'schedule'], {
    GEMINI_API_KEY: 'test-key',
    GITHUB_TOKEN: 'ghp_test',
    LINKEDIN_ACCESS_TOKEN: 'li-token',
    LINKEDIN_ORGANIZATION_URN: 'urn:li:organization:75008856',
    GEMINI_BASE_URL: 'http://127.0.0.1:1',
    GEMINI_MAX_RETRIES: '1',
  });
  assert.equal(/degrading this scheduled run to draft/.test(`${r.stdout}${r.stderr}`), false);
});

test('the default publish interval is the 48h cadence', () => {
  const { DEFAULTS } = require('../src/config');
  assert.equal(DEFAULTS.publishIntervalHours, 48);
});

test('an invalid mode exits 2 before touching any state', () => {
  const r = runCli(['publish', '--mode', 'yolo'], { GEMINI_API_KEY: 'test-key' });
  assert.equal(r.code, 2);
  assert.match(`${r.stdout}${r.stderr}`, /Invalid mode/);
});

test('the kill switch exits 0 and outranks --force', () => {
  const r = runCli(['publish', '--mode', 'auto', '--force'], { AUTOPUBLISH_DISABLED: 'true' });
  assert.equal(r.code, 0, `stderr: ${r.stderr}`);
});

test('the kill switch is checked before the credential preflight', () => {
  // A disabled pipeline must go quiet even on a half-configured runner —
  // a kill switch that only works when everything else is healthy is not one.
  const r = runCli(['publish', '--mode', 'auto'], { AUTOPUBLISH_DISABLED: '1' });
  assert.equal(r.code, 0);
});

test('status reports schedule and token health without any credentials', () => {
  const r = runCli(['status'], {});
  assert.equal(r.code, 0, `stderr: ${r.stderr}`);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.due, true);
  assert.equal(parsed.reason, 'no_previous_publication');
  assert.equal(parsed.linkedinToken.status, 'unknown');
});

test('--help exits 0', () => {
  assert.equal(runCli(['--help']).code, 0);
});

test('an unknown command exits 2', () => {
  assert.equal(runCli(['frobnicate']).code, 2);
});

// ── Secrets must never reach the logs ─────────────────────────────────────

test('a configured secret never appears in CLI output', () => {
  const secret = 'AIzaSySupersecrettokenvalue0123456789xyz';
  const r = runCli(['publish', '--mode', 'auto'], {
    GEMINI_API_KEY: secret,
    GITHUB_TOKEN: 'ghp_anothersecretvalue0123456789',
  });
  const all = `${r.stdout}${r.stderr}`;
  assert.equal(all.includes(secret), false, 'GEMINI_API_KEY leaked into output');
  assert.equal(all.includes('ghp_anothersecretvalue0123456789'), false, 'GITHUB_TOKEN leaked');
});
