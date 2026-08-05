'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);

/**
 * Git + GitHub operations for the content flow:
 *   generate → branch → validate → PR → CI → merge → deploy → verify
 *
 * Every git invocation goes through `execFile` with an argument array — never a
 * shell string — so a model-derived branch name or commit message cannot be
 * interpreted as shell syntax. The token is passed via the `http.extraheader`
 * config on a per-command basis rather than being embedded in the remote URL,
 * which keeps it out of `git remote -v`, out of `.git/config`, and out of any
 * error message that echoes the remote.
 */

class GitError extends Error {
  constructor(message, { stdout, stderr, code } = {}) {
    super(message);
    this.name = 'GitError';
    this.stdout = stdout;
    this.stderr = stderr;
    this.code = code;
  }
}

async function git(args, { cwd, token, env = process.env } = {}) {
  const authArgs = token
    ? ['-c', `http.https://github.com/.extraheader=Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`]
    : [];
  try {
    const { stdout, stderr } = await execFileAsync('git', [...authArgs, ...args], {
      cwd,
      env,
      maxBuffer: 20 * 1024 * 1024,
    });
    return { stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (err) {
    throw new GitError(`git ${args[0]} failed: ${err.message.split('\n')[0]}`, {
      stdout: err.stdout,
      stderr: err.stderr,
      code: err.code,
    });
  }
}

/** Branch names are derived from a validated slug plus a date; assert anyway. */
function assertSafeBranchName(name) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,100}$/.test(name) || name.includes('..')) {
    throw new GitError(`Unsafe branch name: "${name}"`);
  }
  return name;
}

async function configureIdentity(cwd, { name, email, token }) {
  await git(['config', 'user.name', name], { cwd, token });
  await git(['config', 'user.email', email], { cwd, token });
}

async function createBranch(cwd, branch, { baseBranch = 'main', token } = {}) {
  assertSafeBranchName(branch);
  await git(['fetch', 'origin', baseBranch], { cwd, token });
  await git(['checkout', '-B', branch, `origin/${baseBranch}`], { cwd, token });
  return branch;
}

async function commitPaths(cwd, paths, message, { token } = {}) {
  if (!paths.length) throw new GitError('commitPaths called with no paths');
  await git(['add', '--', ...paths], { cwd, token });
  const status = await git(['status', '--porcelain'], { cwd, token });
  if (!status.stdout) return { committed: false, sha: null };
  // `-m` via argv: a model-authored message can contain quotes/newlines safely.
  await git(['commit', '-m', message], { cwd, token });
  const sha = await git(['rev-parse', 'HEAD'], { cwd, token });
  return { committed: true, sha: sha.stdout };
}

async function pushBranch(cwd, branch, { token, retries = 4 } = {}) {
  assertSafeBranchName(branch);
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      await git(['push', '-u', 'origin', branch], { cwd, token });
      return { pushed: true, attempts: attempt + 1 };
    } catch (err) {
      lastErr = err;
      // Exponential backoff per the repo's documented push convention.
      if (attempt < retries) await new Promise((r) => setTimeout(r, 2 ** (attempt + 1) * 1000));
    }
  }
  throw lastErr;
}

/** Minimal GitHub REST helper — avoids adding an SDK dependency. */
async function github(pathname, { token, method = 'GET', body, fetchImpl = globalThis.fetch } = {}) {
  const res = await fetchImpl(`https://api.github.com${pathname}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'content-type': 'application/json',
      'user-agent': 'up2cloud-autopublish',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  if (text.trim()) {
    try {
      json = JSON.parse(text);
    } catch {
      /* non-JSON error body */
    }
  }
  if (!res.ok) {
    throw new GitError(`GitHub API ${method} ${pathname} → ${res.status}: ${text.slice(0, 300)}`, {
      code: res.status,
    });
  }
  return json;
}

async function openPullRequest({ repository, branch, baseBranch, title, body, token, fetchImpl }) {
  const [owner, repo] = repository.split('/');
  const existing = await github(
    `/repos/${owner}/${repo}/pulls?head=${owner}:${encodeURIComponent(branch)}&state=open`,
    { token, fetchImpl },
  );
  if (Array.isArray(existing) && existing.length) {
    return { number: existing[0].number, url: existing[0].html_url, created: false };
  }
  const pr = await github(`/repos/${owner}/${repo}/pulls`, {
    token,
    method: 'POST',
    fetchImpl,
    body: { title, body, head: branch, base: baseBranch, draft: false },
  });
  return { number: pr.number, url: pr.html_url, created: true };
}

/**
 * Poll PR checks until they settle. Returns the aggregate conclusion rather
 * than throwing, so the caller decides whether a red build is fatal (auto mode)
 * or merely reported (draft mode).
 */
async function waitForChecks({
  repository,
  sha,
  token,
  fetchImpl,
  timeoutMs = 25 * 60 * 1000,
  pollMs = 20_000,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  const [owner, repo] = repository.split('/');
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const runs = await github(`/repos/${owner}/${repo}/commits/${sha}/check-runs?per_page=100`, {
      token,
      fetchImpl,
    });
    const checks = runs?.check_runs || [];
    // "Awaiting approval" style gates sit in `queued` forever by design, so a
    // caller running in auto mode must treat a timeout as "not green" and skip
    // the merge rather than blocking a runner indefinitely.
    const pending = checks.filter((c) => c.status !== 'completed');
    if (checks.length && !pending.length) {
      const failed = checks.filter(
        (c) => !['success', 'skipped', 'neutral'].includes(c.conclusion),
      );
      return {
        settled: true,
        green: failed.length === 0,
        checks: checks.map((c) => ({ name: c.name, conclusion: c.conclusion })),
        failed: failed.map((c) => ({ name: c.name, conclusion: c.conclusion, url: c.html_url })),
      };
    }
    await sleep(pollMs);
  }
  return { settled: false, green: false, checks: [], failed: [], timedOut: true };
}

async function mergePullRequest({ repository, number, token, fetchImpl, method = 'squash' }) {
  const [owner, repo] = repository.split('/');
  const result = await github(`/repos/${owner}/${repo}/pulls/${number}/merge`, {
    token,
    method: 'PUT',
    fetchImpl,
    body: { merge_method: method },
  });
  if (!result?.merged) {
    throw new GitError(`Pull request #${number} did not merge: ${result?.message || 'unknown reason'}`);
  }
  return { merged: true, sha: result.sha };
}

module.exports = {
  git,
  GitError,
  configureIdentity,
  createBranch,
  commitPaths,
  pushBranch,
  openPullRequest,
  waitForChecks,
  mergePullRequest,
  github,
  assertSafeBranchName,
};
