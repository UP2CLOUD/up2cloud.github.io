'use strict';

const crypto = require('node:crypto');
const { STAGES } = require('../config');

/**
 * Run + publication ledger.
 *
 * Two record types with different lifetimes:
 *  - a **run** is one pipeline invocation, carrying per-stage status so a retry
 *    resumes at the first incomplete stage rather than regenerating an article
 *    that was already written and reviewed;
 *  - a **publication** is the durable record of an article that reached the
 *    site, and it is what the weekly scheduler and the 45-day topic cooldown
 *    read from.
 *
 * A run is only ever promoted to a publication once its blog stage succeeded,
 * so a failed LinkedIn post never blocks the next cycle's schedule but also
 * never silently re-publishes the article.
 */

const RUN_STATUS = Object.freeze({
  PENDING: 'pending',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  SKIPPED: 'skipped',
  BLOCKED: 'blocked',
});

const STAGE_STATUS = Object.freeze({
  PENDING: 'pending',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  SKIPPED: 'skipped',
});

const LINKEDIN_STATUS = Object.freeze({
  NOT_ATTEMPTED: 'not_attempted',
  PENDING: 'pending',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  SKIPPED: 'skipped',
});

/** Keep the ledger from growing without bound in a git-committed file. */
const MAX_RUNS_RETAINED = 60;
const MAX_PUBLICATIONS_RETAINED = 500;

function newRunId(clock = Date.now) {
  const ts = new Date(clock()).toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `run_${ts}_${crypto.randomBytes(3).toString('hex')}`;
}

function contentHash(content) {
  return crypto.createHash('sha256').update(String(content ?? ''), 'utf8').digest('hex');
}

function createRunRecord({ runId, mode, trigger, topic = null, clock = Date.now }) {
  const ts = new Date(clock()).toISOString();
  return {
    runId: runId || newRunId(clock),
    mode,
    trigger,
    status: RUN_STATUS.RUNNING,
    topic,
    createdAt: ts,
    updatedAt: ts,
    completedAt: null,
    error: null,
    stages: Object.fromEntries(
      STAGES.map((name) => [
        name,
        { status: STAGE_STATUS.PENDING, attempts: 0, startedAt: null, completedAt: null, error: null, output: null },
      ]),
    ),
  };
}

/** The first stage that has not succeeded — where a retry should resume. */
function firstIncompleteStage(run) {
  if (!run || !run.stages) return STAGES[0];
  for (const name of STAGES) {
    const stage = run.stages[name];
    if (!stage || (stage.status !== STAGE_STATUS.SUCCEEDED && stage.status !== STAGE_STATUS.SKIPPED)) {
      return name;
    }
  }
  return null;
}

function isStageComplete(run, name) {
  const stage = run?.stages?.[name];
  return stage?.status === STAGE_STATUS.SUCCEEDED || stage?.status === STAGE_STATUS.SKIPPED;
}

class Ledger {
  constructor(backend, { clock = Date.now } = {}) {
    this.backend = backend;
    this.clock = clock;
  }

  read() {
    return this.backend.read();
  }

  /**
   * Read-modify-write with bounded optimistic retry. Every mutation funnels
   * through here so version conflicts are handled in exactly one place.
   */
  async mutate(mutator, { maxRetries = 5 } = {}) {
    let lastErr;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const state = await this.backend.read();
      const next = await mutator(structuredClone(state));
      try {
        return await this.backend.write(next, { expectedVersion: state.version });
      } catch (err) {
        lastErr = err;
        if (err.code !== 'VERSION_CONFLICT') throw err;
        await new Promise((r) => setTimeout(r, 40 + Math.floor(Math.random() * 120)));
      }
    }
    throw lastErr;
  }

  async getRun(runId) {
    const state = await this.backend.read();
    return state.runs.find((r) => r.runId === runId) || null;
  }

  async startRun({ runId, mode, trigger, topic }) {
    const record = createRunRecord({ runId, mode, trigger, topic, clock: this.clock });
    await this.mutate((state) => {
      const existing = state.runs.findIndex((r) => r.runId === record.runId);
      if (existing >= 0) state.runs[existing] = record;
      else state.runs.unshift(record);
      state.runs = state.runs.slice(0, MAX_RUNS_RETAINED);
      return state;
    });
    return record;
  }

  async updateRun(runId, patch) {
    let updated = null;
    await this.mutate((state) => {
      const run = state.runs.find((r) => r.runId === runId);
      if (!run) throw new Error(`Unknown runId "${runId}"`);
      Object.assign(run, patch, { updatedAt: new Date(this.clock()).toISOString() });
      updated = run;
      return state;
    });
    return updated;
  }

  async updateStage(runId, stageName, patch) {
    if (!STAGES.includes(stageName)) throw new Error(`Unknown stage "${stageName}"`);
    let updated = null;
    await this.mutate((state) => {
      const run = state.runs.find((r) => r.runId === runId);
      if (!run) throw new Error(`Unknown runId "${runId}"`);
      const stage = run.stages[stageName];
      Object.assign(stage, patch);
      if (patch.status === STAGE_STATUS.RUNNING) {
        stage.attempts += 1;
        stage.startedAt = new Date(this.clock()).toISOString();
      }
      if (patch.status === STAGE_STATUS.SUCCEEDED || patch.status === STAGE_STATUS.FAILED) {
        stage.completedAt = new Date(this.clock()).toISOString();
      }
      run.updatedAt = new Date(this.clock()).toISOString();
      updated = stage;
      return state;
    });
    return updated;
  }

  /**
   * Record a published article. `lastSuccessfulPublicationAt` only advances for
   * a genuinely live article, because that timestamp gates the next weekly cycle.
   */
  async recordPublication(publication) {
    const ts = new Date(this.clock()).toISOString();
    const record = {
      publicationId: publication.publicationId || `pub_${crypto.randomBytes(6).toString('hex')}`,
      runId: publication.runId,
      title: publication.title,
      slug: publication.slug,
      topicId: publication.topicId,
      contentHash: publication.contentHash,
      status: publication.status || 'published',
      blogUrl: publication.blogUrl,
      deploymentVerified: publication.deploymentVerified === true,
      deploymentVerifiedAt: publication.deploymentVerifiedAt || null,
      linkedinStatus: publication.linkedinStatus || LINKEDIN_STATUS.NOT_ATTEMPTED,
      linkedinPostUrn: publication.linkedinPostUrn || null,
      linkedinAttempts: publication.linkedinAttempts || 0,
      locales: publication.locales || [],
      prNumber: publication.prNumber || null,
      prUrl: publication.prUrl || null,
      mergedSha: publication.mergedSha || null,
      errors: publication.errors || [],
      publishedAt: publication.publishedAt || ts,
      createdAt: ts,
      updatedAt: ts,
    };

    await this.mutate((state) => {
      const idx = state.publications.findIndex((p) => p.slug === record.slug);
      if (idx >= 0) state.publications[idx] = { ...state.publications[idx], ...record };
      else state.publications.unshift(record);
      state.publications = state.publications.slice(0, MAX_PUBLICATIONS_RETAINED);

      if (record.deploymentVerified && record.status === 'published') {
        const prev = state.lastSuccessfulPublicationAt;
        if (!prev || new Date(record.publishedAt) > new Date(prev)) {
          state.lastSuccessfulPublicationAt = record.publishedAt;
        }
      }
      return state;
    });
    return record;
  }

  async updatePublication(slug, patch) {
    let updated = null;
    await this.mutate((state) => {
      const pub = state.publications.find((p) => p.slug === slug);
      if (!pub) throw new Error(`Unknown publication slug "${slug}"`);
      Object.assign(pub, patch, { updatedAt: new Date(this.clock()).toISOString() });
      updated = pub;
      return state;
    });
    return updated;
  }

  async listPublications() {
    const state = await this.backend.read();
    return state.publications || [];
  }
}

module.exports = {
  Ledger,
  RUN_STATUS,
  STAGE_STATUS,
  LINKEDIN_STATUS,
  createRunRecord,
  firstIncompleteStage,
  isStageComplete,
  newRunId,
  contentHash,
  MAX_RUNS_RETAINED,
};
