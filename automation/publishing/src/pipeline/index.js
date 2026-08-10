'use strict';

const path = require('node:path');
const fs = require('node:fs');

const { MODES } = require('../config');
const { STAGE_STATUS, RUN_STATUS, LINKEDIN_STATUS, isStageComplete, contentHash } = require('../state/ledger');
const { loadTopics, selectTopic, loadLegacyPosts } = require('../topics');
const { ModelClient } = require('../model-client');
const { runResearch } = require('./research');
const author = require('./author');
const { localizeMetadata, verifyPreservation, SUPPORTED_LOCALES } = require('./localize');
const { runAllGates } = require('../quality/gates');
const { renderArticle } = require('../publish/render');
const { upsertPostEntry, upsertSitemapEntry, upsertBlogIndexCard } = require('../publish/site-index');
const { safeWriteFile, assertSafeSlug } = require('../security/paths');
const gitOps = require('../publish/git');
const { verifyDeployment } = require('../verify/deployment');
const { LinkedInClient } = require('../linkedin/client');
const { composeLinkedInPost, validateComposedPost } = require('../linkedin/compose');
const { checkTokenExpiry, verifyOrganizationRole } = require('../linkedin/oauth');

/**
 * Pipeline orchestrator.
 *
 * Each stage records its output in the ledger before the next begins, and a
 * resumed run skips any stage already marked succeeded. That is what makes a
 * retry cheap and safe: re-entering after a LinkedIn 500 must not regenerate
 * (and re-publish) the article, and re-entering after a failed deploy check
 * must not spend another Opus draft.
 */

class Pipeline {
  constructor({ config, ledger, logger, deps = {} }) {
    this.config = config;
    this.ledger = ledger;
    this.logger = logger;
    this.deps = deps;
    this.artifactDir = path.join(
      config.repoRoot,
      'automation',
      'publishing',
      'artifacts',
    );
  }

  client() {
    if (!this._client) {
      this.config.requireFor('model');
      this._client = new ModelClient(this.config, {
        fetchImpl: this.deps.fetchImpl,
        logger: this.logger,
        sleepImpl: this.deps.sleep,
      });
    }
    return this._client;
  }

  /** Stage outputs are persisted to disk so a resumed run can reload them. */
  artifactPath(runId, name) {
    return path.join(this.artifactDir, runId, `${name}.json`);
  }

  saveArtifact(runId, name, data) {
    const rel = path.relative(
      this.config.repoRoot,
      this.artifactPath(runId, name),
    );
    safeWriteFile(this.config.repoRoot, rel, `${JSON.stringify(data, null, 2)}\n`);
    return rel;
  }

  loadArtifact(runId, name) {
    const file = this.artifactPath(runId, name);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }

  /** Wrap a stage with ledger bookkeeping, resume and attempt limits. */
  async stage(run, name, fn) {
    if (isStageComplete(run, name)) {
      const cached = this.loadArtifact(run.runId, name);
      this.logger.info('Stage already complete, resuming past it', { stage: name });
      return cached;
    }

    const attempts = run.stages[name]?.attempts ?? 0;
    if (attempts >= this.config.maxAttemptsPerStage) {
      throw new Error(
        `Stage "${name}" already failed ${attempts} times (limit ${this.config.maxAttemptsPerStage})`,
      );
    }

    await this.ledger.updateStage(run.runId, name, { status: STAGE_STATUS.RUNNING });
    this.logger.info('Stage started', { stage: name });
    try {
      const output = await fn();
      const artifact = output === undefined ? null : output;
      if (artifact !== null) this.saveArtifact(run.runId, name, artifact);
      await this.ledger.updateStage(run.runId, name, {
        status: STAGE_STATUS.SUCCEEDED,
        error: null,
        output: summarise(artifact),
      });
      this.logger.info('Stage succeeded', { stage: name });
      // Refresh our local copy so subsequent isStageComplete() checks are accurate.
      run.stages[name].status = STAGE_STATUS.SUCCEEDED;
      return artifact;
    } catch (err) {
      await this.ledger.updateStage(run.runId, name, {
        status: STAGE_STATUS.FAILED,
        error: String(err.message || err).slice(0, 800),
      });
      this.logger.error('Stage failed', { stage: name, error: err });
      throw err;
    }
  }

  async run({ run, forcedTopic }) {
    const cfg = this.config;
    const dryRun = cfg.dryRun;

    // ── 1. Topic ───────────────────────────────────────────────────────────
    const topic = await this.stage(run, 'select_topic', async () => {
      const domains = loadTopics();
      const publications = await this.ledger.listPublications();
      const legacyPosts = loadLegacyPosts(cfg.repoRoot);
      const selection = selectTopic({
        domains,
        publications,
        legacyPosts,
        cooldownDays: cfg.topicCooldownDays,
        forcedTopicId: forcedTopic,
        now: Date.now(),
      });
      return {
        domainId: selection.domain.id,
        domain: selection.domain,
        angle: selection.angle,
        selectionReason: selection.selectionReason,
      };
    });
    await this.ledger.updateRun(run.runId, { topic: topic.domainId });

    // ── 2. Research ────────────────────────────────────────────────────────
    const research = await this.stage(run, 'research', () =>
      runResearch({
        client: this.client(),
        domain: topic.domain,
        angle: topic.angle,
        fetchImpl: this.deps.fetchImpl,
        resolver: this.deps.resolver,
        logger: this.logger,
      }),
    );

    // ── 3. Brief ───────────────────────────────────────────────────────────
    const brief = await this.stage(run, 'brief', () =>
      author.createBrief({ client: this.client(), domain: topic.domain, angle: topic.angle, research }),
    );

    // ── 4. Outline, metadata, draft ────────────────────────────────────────
    const drafted = await this.stage(run, 'draft', async () => {
      const legacyPosts = loadLegacyPosts(cfg.repoRoot);
      const publications = await this.ledger.listPublications();
      const outline = await author.createOutlineAndMetadata({
        client: this.client(),
        domain: topic.domain,
        angle: topic.angle,
        brief,
        minWords: cfg.minWords,
        maxWords: cfg.maxWords,
        existingTitles: [...legacyPosts, ...publications].map((p) => p.title).filter(Boolean),
      });
      assertSafeSlug(outline.slug);
      const body = await author.createDraft({
        client: this.client(),
        domain: topic.domain,
        brief,
        outline,
        research,
        minWords: cfg.minWords,
        maxWords: cfg.maxWords,
      });
      return { outline, body };
    });

    // ── 5. Review + revise ─────────────────────────────────────────────────
    const reviewed = await this.stage(run, 'review', async () => {
      const technical = await author.reviewDraft({
        client: this.client(),
        draft: drafted.body,
        brief,
        research,
        kind: 'technical',
      });
      const editorial = await author.reviewDraft({
        client: this.client(),
        draft: drafted.body,
        brief,
        research,
        kind: 'editorial',
      });
      const findings = [
        ...(technical.findings || []).map((f) => ({ ...f, source: 'technical' })),
        ...(editorial.findings || []).map((f) => ({ ...f, source: 'editorial' })),
      ];
      const { revised, applied } = await author.reviseDraft({
        client: this.client(),
        draft: drafted.body,
        findings,
        research,
      });
      return { findings, applied, body: revised };
    });

    const finalBody = reviewed.body || drafted.body;
    const metadata = {
      ...drafted.outline,
      category: topic.domain.category,
      badgeClass: topic.domain.badgeClass,
      date: new Date().toISOString().slice(0, 10),
    };

    // ── 6. Validate (quality gates) ────────────────────────────────────────
    const validation = await this.stage(run, 'validate', async () => {
      const publications = await this.ledger.listPublications();
      const legacyPosts = loadLegacyPosts(cfg.repoRoot);

      // Re-review the *revised* body: revision can introduce new problems, and
      // gating on findings from the pre-revision draft would check the wrong text.
      const recheck = await author.reviewDraft({
        client: this.client(),
        draft: finalBody,
        brief,
        research,
        kind: 'technical',
      });

      const result = runAllGates({
        body: finalBody,
        metadata,
        citations: research.sources,
        existingPublications: publications,
        existingPosts: legacyPosts,
        minWords: cfg.minWords,
        maxWords: cfg.maxWords,
        reviewFindings: recheck.findings || [],
      });

      if (!result.passed) {
        const summary = result.blocking.map((b) => `[${b.gate}] ${b.message}`).join('\n  ');
        throw new Error(`Quality gates blocked publication:\n  ${summary}`);
      }
      return { ...result, recheckFindings: recheck.findings || [] };
    });

    // ── 7. Localize ────────────────────────────────────────────────────────
    const localized = await this.stage(run, 'localize', async () => {
      const bundle = await localizeMetadata({ client: this.client(), metadata, locales: SUPPORTED_LOCALES });
      const problems = verifyPreservation(bundle, extractPreservedTerms(metadata));
      if (problems.length) {
        this.logger.warn('Localization preservation warnings', { problems });
      }
      return { bundle, problems };
    });

    if (dryRun) {
      this.logger.info('Dry run — stopping before any write', {
        slug: metadata.slug,
        words: validation.words,
      });
      await this.ledger.updateRun(run.runId, {
        status: RUN_STATUS.SUCCEEDED,
        completedAt: new Date().toISOString(),
      });
      return { dryRun: true, metadata, validation, body: finalBody };
    }

    // ── 8. Publish blog (branch → PR → CI → merge) ─────────────────────────
    const published = await this.stage(run, 'publish_blog', () =>
      this.publishBlog({ run, metadata, body: finalBody, validation, localized, research, topic }),
    );

    if (cfg.mode === MODES.DRAFT) {
      this.logger.info('Draft mode — PR opened, stopping before merge/verify', { pr: published.prUrl });
      await this.ledger.updateRun(run.runId, {
        status: RUN_STATUS.SUCCEEDED,
        completedAt: new Date().toISOString(),
      });
      return { mode: cfg.mode, ...published, metadata };
    }

    // ── 9. Verify deployment ───────────────────────────────────────────────
    const verification = await this.stage(run, 'verify_deployment', async () => {
      const result = await verifyDeployment(
        { slug: metadata.slug, title: metadata.title, canonicalUrl: published.blogUrl },
        {
          siteBaseUrl: cfg.siteBaseUrl,
          fetchImpl: this.deps.fetchImpl,
          resolver: this.deps.resolver,
          sleep: this.deps.sleep,
        },
      );
      if (!result.ok) {
        const failed = result.failures.map((f) => `${f.name}: ${f.detail}`).join('\n  ');
        throw new Error(`Deployment verification failed:\n  ${failed}`);
      }
      return { ok: true, url: result.url, checks: result.checks };
    });

    await this.ledger.recordPublication({
      runId: run.runId,
      title: metadata.title,
      slug: metadata.slug,
      topicId: topic.domainId,
      contentHash: contentHash(finalBody),
      status: 'published',
      blogUrl: published.blogUrl,
      deploymentVerified: true,
      deploymentVerifiedAt: new Date().toISOString(),
      linkedinStatus: LINKEDIN_STATUS.NOT_ATTEMPTED,
      locales: Object.keys(localized.bundle),
      prNumber: published.prNumber,
      prUrl: published.prUrl,
      mergedSha: published.mergedSha,
      publishedAt: new Date().toISOString(),
    });

    if (cfg.mode === MODES.REVIEW) {
      this.logger.info('Review mode — article live, stopping before LinkedIn', { url: published.blogUrl });
      await this.ledger.updateRun(run.runId, {
        status: RUN_STATUS.SUCCEEDED,
        completedAt: new Date().toISOString(),
      });
      return { mode: cfg.mode, ...published, verification, metadata };
    }

    // ── 10. LinkedIn ───────────────────────────────────────────────────────
    const linkedin = await this.stage(run, 'publish_linkedin', () =>
      this.publishLinkedIn({ run, metadata, body: finalBody, topic, blogUrl: published.blogUrl }),
    );

    await this.ledger.updatePublication(metadata.slug, {
      linkedinStatus: LINKEDIN_STATUS.SUCCEEDED,
      linkedinPostUrn: linkedin.urn,
      linkedinAttempts: linkedin.attempts,
    });
    await this.ledger.updateRun(run.runId, {
      status: RUN_STATUS.SUCCEEDED,
      completedAt: new Date().toISOString(),
    });

    return { mode: cfg.mode, ...published, verification, linkedin, metadata };
  }

  async publishBlog({ run, metadata, body, validation, localized, research, topic }) {
    const cfg = this.config;
    cfg.requireFor('git');

    const { html, url } = renderArticle(
      {
        slug: metadata.slug,
        title: metadata.title,
        metaTitle: metadata.metaTitle,
        excerpt: metadata.excerpt,
        category: metadata.category,
        badgeClass: metadata.badgeClass,
        date: metadata.date,
        keywords: metadata.keywords,
        bodyMarkdown: body,
      },
      { repoRoot: cfg.repoRoot, siteBaseUrl: cfg.siteBaseUrl },
    );

    safeWriteFile(cfg.repoRoot, `blog/${metadata.slug}/index.html`, html);
    upsertPostEntry(cfg.repoRoot, metadata, { featured: true });
    upsertBlogIndexCard(cfg.repoRoot, metadata);
    upsertSitemapEntry(cfg.repoRoot, {
      url,
      lastmod: metadata.date,
      blogIndexUrl: `${cfg.siteBaseUrl}/blog/`,
    });
    this.saveArtifact(run.runId, 'localized_metadata', localized.bundle);

    const branch = `automation/blog-${metadata.date}-${metadata.slug}`.slice(0, 100);
    const cwd = cfg.repoRoot;
    await gitOps.configureIdentity(cwd, {
      name: cfg.git.authorName,
      email: cfg.git.authorEmail,
      token: cfg.git.token,
    });
    await gitOps.createBranch(cwd, branch, { baseBranch: cfg.git.baseBranch, token: cfg.git.token });

    // Re-write after checkout: `createBranch` resets the tree to origin/base.
    safeWriteFile(cfg.repoRoot, `blog/${metadata.slug}/index.html`, html);
    upsertPostEntry(cfg.repoRoot, metadata, { featured: true });
    upsertBlogIndexCard(cfg.repoRoot, metadata);
    upsertSitemapEntry(cfg.repoRoot, {
      url,
      lastmod: metadata.date,
      blogIndexUrl: `${cfg.siteBaseUrl}/blog/`,
    });

    const paths = [
      `blog/${metadata.slug}/index.html`,
      'blog/posts.json',
      'blog/index.html',
      'sitemap.xml',
    ];
    const commitMessage = [
      `content: ${metadata.title}`,
      '',
      `Automated publication for the ${topic.domain.label} rotation slot.`,
      `Sources: ${research.sources.length} verified (${validation.authoritativeCitations} authoritative).`,
      `Words: ${validation.words}. Run: ${run.runId}.`,
    ].join('\n');

    const { sha } = await gitOps.commitPaths(cwd, paths, commitMessage, { token: cfg.git.token });
    await gitOps.pushBranch(cwd, branch, { token: cfg.git.token });

    const pr = await gitOps.openPullRequest({
      repository: cfg.git.repository,
      branch,
      baseBranch: cfg.git.baseBranch,
      title: `content: ${metadata.title}`,
      body: buildPrBody({ metadata, validation, research, topic, run }),
      token: cfg.git.token,
      fetchImpl: this.deps.fetchImpl,
    });

    if (this.config.mode === MODES.DRAFT) {
      return { branch, sha, prNumber: pr.number, prUrl: pr.url, blogUrl: url, merged: false };
    }

    const checks = await gitOps.waitForChecks({
      repository: cfg.git.repository,
      sha,
      token: cfg.git.token,
      fetchImpl: this.deps.fetchImpl,
      sleep: this.deps.sleep,
    });
    if (!checks.green) {
      const detail = checks.timedOut
        ? 'checks did not settle within the timeout'
        : `failing checks: ${checks.failed.map((c) => `${c.name}=${c.conclusion}`).join(', ')}`;
      throw new Error(`Refusing to merge PR #${pr.number} — ${detail}`);
    }

    const merged = await gitOps.mergePullRequest({
      repository: cfg.git.repository,
      number: pr.number,
      token: cfg.git.token,
      fetchImpl: this.deps.fetchImpl,
    });

    return {
      branch,
      sha,
      prNumber: pr.number,
      prUrl: pr.url,
      blogUrl: url,
      merged: true,
      mergedSha: merged.sha,
    };
  }

  async publishLinkedIn({ run, metadata, body, topic, blogUrl }) {
    const cfg = this.config;
    cfg.requireFor('linkedin');

    const expiry = checkTokenExpiry(cfg.linkedin.tokenExpiresAt);
    if (expiry.status === 'expired') throw new Error(expiry.message);
    if (expiry.status !== 'valid') this.logger.warn(expiry.message);

    const role = await verifyOrganizationRole({
      accessToken: cfg.linkedin.accessToken,
      organizationUrn: cfg.linkedin.organizationUrn,
      apiVersion: cfg.linkedin.apiVersion,
      fetchImpl: this.deps.fetchImpl,
    }).catch((err) => ({ verified: false, indeterminate: true, message: err.message }));
    if (!role.verified && !role.indeterminate) throw new Error(role.message);
    this.logger.info('LinkedIn organization role check', { message: role.message });

    const promo = await author.composePromoCopy({
      client: this.client(),
      title: metadata.title,
      excerpt: metadata.excerpt,
      draft: body,
      domainLabel: topic.domain.label,
    });

    const composed = composeLinkedInPost(
      {
        slug: metadata.slug,
        title: metadata.title,
        opening: promo.opening,
        problem: promo.problem,
        takeaways: promo.takeaways,
        hashtags: promo.hashtags,
        topicLabel: topic.domain.label,
      },
      { siteBaseUrl: cfg.siteBaseUrl, utm: cfg.utm },
    );

    const problems = validateComposedPost(composed);
    if (problems.length) throw new Error(`LinkedIn post failed validation: ${problems.join('; ')}`);

    const client = new LinkedInClient(cfg.linkedin, {
      fetchImpl: this.deps.fetchImpl,
      logger: this.logger,
      sleepImpl: this.deps.sleep,
    });

    // Idempotency key derived from the slug: a retried run reuses it, so
    // LinkedIn returns the original post instead of creating a second one.
    const result = await client.createPost({
      commentary: composed.commentary,
      articleUrl: composed.url,
      idempotencyKey: `up2cloud-${metadata.slug}`,
    });

    this.logger.info('LinkedIn post published', { urn: result.urn, attempts: result.attempts });
    return { ...result, commentary: composed.commentary, trackedUrl: composed.url };
  }
}

function extractPreservedTerms(metadata) {
  const source = `${metadata.title} ${metadata.excerpt}`;
  const terms = source.match(/\b(?:[A-Z][a-zA-Z]*(?:[A-Z][a-zA-Z]*)+|[A-Z]{2,}|\d+(?:\.\d+)?)\b/g) || [];
  return [...new Set(terms)];
}

function summarise(artifact) {
  if (!artifact || typeof artifact !== 'object') return artifact ?? null;
  const keys = Object.keys(artifact);
  return { keys, size: JSON.stringify(artifact).length };
}

function buildPrBody({ metadata, validation, research, topic, run }) {
  const warnings = validation.warnings?.length
    ? validation.warnings.map((w) => `- \`${w.gate}\` — ${w.message}`).join('\n')
    : '- None';

  return [
    '## Automated publication',
    '',
    `**Topic rotation slot:** ${topic.domain.label} (\`${topic.domainId}\`)`,
    `**Angle:** ${topic.angle}`,
    `**Run:** \`${run.runId}\``,
    '',
    '### Article',
    `- **Title:** ${metadata.title}`,
    `- **Slug:** \`${metadata.slug}\``,
    `- **Words:** ${validation.words} (target ${'1200–2200'})`,
    `- **Meta title:** ${metadata.metaTitle} (${metadata.metaTitle.length} chars)`,
    `- **Excerpt:** ${metadata.excerpt.length} chars`,
    '',
    '### Sources',
    research.sources.map((s) => `- ${s.authoritative ? '**[authoritative]** ' : ''}${s.url}`).join('\n'),
    '',
    `${validation.authoritativeCitations} of ${research.sources.length} sources are from the authoritative allow-list.`,
    'Every source above returned HTTP 200 at generation time.',
    '',
    '### Quality gates',
    'All blocking gates passed: word count, metadata, citations, code validity,',
    'duplicate detection, and fabrication screening.',
    '',
    '**Non-blocking warnings:**',
    warnings,
    '',
    '---',
    '_Generated by the UP2CLOUD autopublish pipeline. Review before merge if in draft mode._',
  ].join('\n');
}

module.exports = { Pipeline, buildPrBody, extractPreservedTerms };
