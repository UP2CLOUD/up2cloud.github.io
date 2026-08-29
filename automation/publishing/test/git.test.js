'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { git, GitError } = require('../src/publish/git');

test('a failed git command surfaces the actual stderr reason, not just "Command failed"', async () => {
  const execImpl = async () => {
    const err = new Error('Command failed: git fetch origin main\nfatal: unable to access \'https://github.com/foo/bar\': Could not resolve host: github.com');
    err.stdout = '';
    err.stderr = "fatal: unable to access 'https://github.com/foo/bar': Could not resolve host: github.com";
    err.code = 128;
    throw err;
  };

  await assert.rejects(
    () => git(['fetch', 'origin', 'main'], { cwd: '/tmp', execImpl }),
    (err) => {
      assert.ok(err instanceof GitError);
      assert.match(err.message, /Could not resolve host/);
      assert.doesNotMatch(err.message, /^git fetch failed: Command failed/);
      assert.equal(err.code, 128);
      return true;
    },
  );
});

test('a failed git command with no stderr falls back to the exec error message', async () => {
  const execImpl = async () => {
    const err = new Error('spawn git ENOENT');
    throw err;
  };

  await assert.rejects(
    () => git(['status'], { cwd: '/tmp', execImpl }),
    (err) => {
      assert.ok(err instanceof GitError);
      assert.match(err.message, /ENOENT/);
      return true;
    },
  );
});

test('a successful git command trims stdout/stderr and returns them', async () => {
  const execImpl = async () => ({ stdout: '  abc123\n', stderr: '  \n' });

  const result = await git(['rev-parse', 'HEAD'], { cwd: '/tmp', execImpl });

  assert.deepEqual(result, { stdout: 'abc123', stderr: '' });
});

test('a token clears actions/checkout\'s persisted extraheader before adding its own', async () => {
  // actions/checkout (persist-credentials: true) already writes an
  // http.extraheader into .git/config for its own GITHUB_TOKEN. Since that's
  // a multi-valued git config key, adding ours without first clearing it
  // makes git send both Authorization headers — GitHub's API then rejects
  // the request with 400 "Duplicate header: Authorization" (seen in
  // production on the first run that ever reached publishBlog).
  let seenArgs;
  const execImpl = async (cmd, args) => {
    seenArgs = args;
    return { stdout: '', stderr: '' };
  };

  await git(['fetch', 'origin', 'main'], { cwd: '/tmp', token: 'my-token', execImpl });

  const clearIdx = seenArgs.indexOf('http.https://github.com/.extraheader=');
  const setIdx = seenArgs.findIndex((a) => a.startsWith('http.https://github.com/.extraheader=Authorization'));
  assert.notEqual(clearIdx, -1, 'expected an empty-value extraheader clearing the persisted one');
  assert.notEqual(setIdx, -1, 'expected the real Authorization extraheader');
  assert.ok(clearIdx < setIdx, 'the clearing entry must come before the real header');
});
