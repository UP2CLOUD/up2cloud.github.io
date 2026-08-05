'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { FileBackend } = require('../src/state/backends/file-backend');
const {
  Ledger,
  STAGE_STATUS,
  RUN_STATUS,
  LINKEDIN_STATUS,
  firstIncompleteStage,
  isStageComplete,
  contentHash,
} = require('../src/state/ledger');
const { STAGES } = require('../src/config');

function tmpLedger() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopub-ledger-'));
  const backend = new FileBackend({ filePath: path.join(dir, 'ledger.json') });
  return { backend, ledger: new Ledger(backend) };
}

test('a new run starts with every stage pending', async () => {
  const { ledger } = tmpLedger();
  const run = await ledger.startRun({ mode: 'auto', trigger: 'schedule' });
  assert.equal(run.status, RUN_STATUS.RUNNING);
  for (const stage of STAGES) {
    assert.equal(run.stages[stage].status, STAGE_STATUS.PENDING);
  }
  assert.equal(firstIncompleteStage(run), 'select_topic');
});

test('resume points at the first incomplete stage', async () => {
  const { ledger } = tmpLedger();
  const run = await ledger.startRun({ mode: 'auto', trigger: 'schedule' });

  for (const stage of ['select_topic', 'research', 'brief']) {
    await ledger.updateStage(run.runId, stage, { status: STAGE_STATUS.SUCCEEDED });
  }
  const reloaded = await ledger.getRun(run.runId);
  assert.equal(firstIncompleteStage(reloaded), 'draft');
  assert.equal(isStageComplete(reloaded, 'brief'), true);
  assert.equal(isStageComplete(reloaded, 'draft'), false);
});

test('a failed stage is where a retry resumes — completed work is not repeated', async () => {
  const { ledger } = tmpLedger();
  const run = await ledger.startRun({ mode: 'auto', trigger: 'schedule' });

  for (const stage of STAGES.slice(0, STAGES.indexOf('publish_linkedin'))) {
    await ledger.updateStage(run.runId, stage, { status: STAGE_STATUS.SUCCEEDED });
  }
  await ledger.updateStage(run.runId, 'publish_linkedin', {
    status: STAGE_STATUS.FAILED,
    error: 'LinkedIn 503',
  });

  const reloaded = await ledger.getRun(run.runId);
  // The expensive stages (draft, review) must be considered done.
  assert.equal(isStageComplete(reloaded, 'draft'), true);
  assert.equal(isStageComplete(reloaded, 'publish_blog'), true);
  assert.equal(firstIncompleteStage(reloaded), 'publish_linkedin');
});

test('attempts increment so a stage cannot retry forever', async () => {
  const { ledger } = tmpLedger();
  const run = await ledger.startRun({ mode: 'auto', trigger: 'schedule' });

  for (let i = 0; i < 3; i += 1) {
    await ledger.updateStage(run.runId, 'research', { status: STAGE_STATUS.RUNNING });
    await ledger.updateStage(run.runId, 'research', { status: STAGE_STATUS.FAILED, error: 'boom' });
  }
  const reloaded = await ledger.getRun(run.runId);
  assert.equal(reloaded.stages.research.attempts, 3);
});

test('a verified publication advances lastSuccessfulPublicationAt', async () => {
  const { backend, ledger } = tmpLedger();
  await ledger.recordPublication({
    runId: 'r1',
    title: 'A',
    slug: 'a',
    topicId: 'finops',
    contentHash: contentHash('body'),
    blogUrl: 'https://up2cloud.tech/blog/a/',
    deploymentVerified: true,
    publishedAt: '2026-08-10T09:00:00.000Z',
  });
  const state = await backend.read();
  assert.equal(state.lastSuccessfulPublicationAt, '2026-08-10T09:00:00.000Z');
});

test('an UNVERIFIED publication does NOT advance the schedule clock', async () => {
  // Otherwise a failed deploy would silently consume the 48h slot.
  const { backend, ledger } = tmpLedger();
  await ledger.recordPublication({
    runId: 'r1',
    title: 'A',
    slug: 'a',
    topicId: 'finops',
    blogUrl: 'https://up2cloud.tech/blog/a/',
    deploymentVerified: false,
    publishedAt: '2026-08-10T09:00:00.000Z',
  });
  const state = await backend.read();
  assert.equal(state.lastSuccessfulPublicationAt, null);
});

test('the schedule clock never moves backwards', async () => {
  const { backend, ledger } = tmpLedger();
  const base = {
    runId: 'r',
    topicId: 'finops',
    blogUrl: 'https://up2cloud.tech/blog/x/',
    deploymentVerified: true,
  };
  await ledger.recordPublication({ ...base, slug: 'newer', title: 'N', publishedAt: '2026-08-10T09:00:00.000Z' });
  await ledger.recordPublication({ ...base, slug: 'older', title: 'O', publishedAt: '2026-08-01T09:00:00.000Z' });
  const state = await backend.read();
  assert.equal(state.lastSuccessfulPublicationAt, '2026-08-10T09:00:00.000Z');
});

test('re-recording the same slug updates rather than duplicates', async () => {
  const { ledger } = tmpLedger();
  const base = {
    runId: 'r',
    slug: 'a',
    title: 'A',
    topicId: 'finops',
    blogUrl: 'https://up2cloud.tech/blog/a/',
    deploymentVerified: true,
  };
  await ledger.recordPublication(base);
  await ledger.recordPublication({ ...base, title: 'A (updated)' });

  const pubs = await ledger.listPublications();
  assert.equal(pubs.filter((p) => p.slug === 'a').length, 1);
  assert.equal(pubs[0].title, 'A (updated)');
});

test('LinkedIn status is tracked separately from blog publication', async () => {
  const { ledger } = tmpLedger();
  await ledger.recordPublication({
    runId: 'r',
    slug: 'a',
    title: 'A',
    topicId: 'finops',
    blogUrl: 'https://up2cloud.tech/blog/a/',
    deploymentVerified: true,
  });
  let pubs = await ledger.listPublications();
  assert.equal(pubs[0].linkedinStatus, LINKEDIN_STATUS.NOT_ATTEMPTED);
  assert.equal(pubs[0].linkedinPostUrn, null);

  await ledger.updatePublication('a', {
    linkedinStatus: LINKEDIN_STATUS.SUCCEEDED,
    linkedinPostUrn: 'urn:li:share:123',
    linkedinAttempts: 2,
  });
  pubs = await ledger.listPublications();
  assert.equal(pubs[0].linkedinPostUrn, 'urn:li:share:123');
  assert.equal(pubs[0].linkedinAttempts, 2);
});

test('the ledger persists across backend instances', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopub-persist-'));
  const file = path.join(dir, 'ledger.json');

  const first = new Ledger(new FileBackend({ filePath: file }));
  await first.recordPublication({
    runId: 'r',
    slug: 'a',
    title: 'A',
    topicId: 'finops',
    blogUrl: 'u',
    deploymentVerified: true,
    publishedAt: '2026-08-10T09:00:00.000Z',
  });

  const second = new FileBackend({ filePath: file });
  const state = await second.read();
  assert.equal(state.publications.length, 1);
  assert.equal(state.lastSuccessfulPublicationAt, '2026-08-10T09:00:00.000Z');
});

test('the very first write creates the state directory', async () => {
  // A fresh checkout has no automation/publishing/state directory at all. The
  // lockfile lives beside the ledger, so if the write path assumed the dir
  // existed the first CI run would crash before publishing anything.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopub-fresh-'));
  const file = path.join(dir, 'does', 'not', 'exist', 'ledger.json');
  const ledger = new Ledger(new FileBackend({ filePath: file }));

  const run = await ledger.startRun({ mode: 'auto', trigger: 'schedule' });
  assert.equal(run.status, RUN_STATUS.RUNNING);
  assert.ok(fs.existsSync(file), 'ledger written into a directory that did not exist');
});

test('a corrupt ledger is reported, not silently reset', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopub-corrupt-'));
  const file = path.join(dir, 'ledger.json');
  fs.writeFileSync(file, '{ not json');
  const backend = new FileBackend({ filePath: file });
  await assert.rejects(() => backend.read(), /Corrupt state ledger/);
});

test('run records are capped so the committed ledger cannot grow forever', async () => {
  const { ledger, backend } = tmpLedger();
  for (let i = 0; i < 70; i += 1) {
    await ledger.startRun({ runId: `run_${i}`, mode: 'auto', trigger: 'schedule' });
  }
  const state = await backend.read();
  assert.ok(state.runs.length <= 60, `runs=${state.runs.length}`);
});

test('contentHash is stable and differentiates content', () => {
  assert.equal(contentHash('abc'), contentHash('abc'));
  assert.notEqual(contentHash('abc'), contentHash('abd'));
});
