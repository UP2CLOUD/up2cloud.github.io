'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadConfig } = require('../src/config');
const { createLogger } = require('../src/logger');
const { FileBackend } = require('../src/state/backends/file-backend');
const { Ledger, STAGE_STATUS } = require('../src/state/ledger');
const { Pipeline } = require('../src/pipeline');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

/**
 * End-to-end exercise of the pipeline with the model and network stubbed.
 *
 * This is the test that proves the ten stages actually compose: that research
 * output feeds the brief, that the brief feeds the draft, that gate results
 * gate, and that a dry run touches nothing. Unit tests cover each piece; this
 * covers the wiring between them, which is where orchestration bugs live.
 */

const BODY = [
  '## Why reconciliation loops drift',
  '',
  'Controllers reconcile desired state against observed state. When the observed',
  'state is expensive to read, teams cache it, and the cache is where drift is born.',
  'The [Kubernetes controller docs](https://kubernetes.io/docs/concepts/architecture/controller/)',
  'describe the loop precisely.',
  '',
  '```yaml',
  'apiVersion: argoproj.io/v1alpha1',
  'kind: Application',
  'spec:',
  '  syncPolicy:',
  '    automated:',
  '      selfHeal: true',
  '```',
  '',
  '## Detecting drift before it compounds',
  '',
  'Argo CD exposes a sync status per application. Alerting on `OutOfSync` for',
  'longer than one reconciliation interval catches most real drift, per the',
  '[Argo CD documentation](https://argo-cd.readthedocs.io/en/stable/).',
  '',
  '- Alert on sustained OutOfSync, not instantaneous',
  '- Treat manual cluster edits as incidents',
  '',
  '## What to do next',
  '',
  'Start by turning on selfHeal in a non-production environment and measuring how',
  'often it fires. That number is your drift budget.',
  '',
  `${'filler word '.repeat(600)}`,
].join('\n');

/** A model stub that answers each stage by shape of the prompt. */
function stubClient() {
  return {
    async json({ prompt, validate }) {
      let out;
      if (prompt.includes('Propose authoritative')) {
        out = {
          sources: [
            { url: 'https://kubernetes.io/docs/concepts/architecture/controller/', why: 'loop' },
            { url: 'https://argo-cd.readthedocs.io/en/stable/', why: 'sync status' },
            { url: 'https://opengitops.dev/', why: 'principles' },
          ],
        };
      } else if (prompt.includes('factual brief')) {
        out = {
          workingTitle: 'Detecting GitOps Drift Before It Compounds',
          thesis: 'Drift is a caching problem, not a discipline problem.',
          readerProblem: 'Clusters silently diverge from git.',
          keyFacts: [
            { fact: 'Controllers reconcile continuously', sourceUrl: 'https://kubernetes.io/docs/concepts/architecture/controller/' },
            { fact: 'Argo CD reports sync status', sourceUrl: 'https://argo-cd.readthedocs.io/en/stable/' },
            { fact: 'GitOps principles define desired state', sourceUrl: 'https://opengitops.dev/' },
          ],
          outOfScope: ['multi-tenancy'],
        };
      } else if (prompt.includes('outline and SEO metadata')) {
        out = {
          title: 'Detecting GitOps Drift Before It Compounds',
          metaTitle: 'Detecting GitOps Drift Before It Compounds — UP2CLOUD',
          excerpt:
            'Cluster state diverges from git quietly. How to detect GitOps drift with Argo CD sync status, self-healing policies, and alerting that reflects reality.',
          slug: 'detecting-gitops-drift',
          keywords: ['GitOps', 'Argo CD', 'drift'],
          sections: [
            { heading: 'Why reconciliation loops drift', points: ['caching'] },
            { heading: 'Detecting drift', points: ['sync status'] },
            { heading: 'What to do next', points: ['selfHeal'] },
          ],
        };
      } else if (prompt.includes('Review this draft')) {
        out = { findings: [{ severity: 'low', message: 'could add a diagram' }], verdict: 'publishable' };
      } else if (prompt.includes('Translate the following')) {
        out = {
          pt: { title: 'Detectando Drift em GitOps', excerpt: 'Como detectar drift com Argo CD e políticas de auto-recuperação em clusters Kubernetes gerenciados por git.', category: 'Cloud' },
          es: { title: 'Detectando Drift en GitOps', excerpt: 'Cómo detectar drift con Argo CD y políticas de auto-reparación en clústeres Kubernetes gestionados por git.', category: 'Cloud' },
          fr: { title: 'Détecter la Dérive GitOps', excerpt: 'Comment détecter la dérive avec Argo CD et les politiques d auto-réparation sur des clusters Kubernetes gérés par git.', category: 'Cloud' },
        };
      } else if (prompt.includes('LinkedIn post')) {
        out = {
          opening: 'A cluster that silently diverges from git is not running your config.',
          problem: 'Most teams alert on pod health but never on sync status.',
          takeaways: ['Alert on sustained OutOfSync', 'Treat manual edits as incidents', 'Measure how often selfHeal fires'],
          hashtags: ['GitOps', 'Kubernetes'],
        };
      } else {
        out = {};
      }
      if (validate) {
        const problems = validate(out);
        if (problems?.length) throw new Error(`stub failed validation: ${problems.join('; ')}`);
      }
      return out;
    },
    async messages() {
      return { text: BODY, raw: {}, stopReason: 'end_turn' };
    },
  };
}

/** Network stub: sources resolve 200 with enough text to pass extraction. */
function stubFetch() {
  return async (url) => {
    const body = `<html><head><title>Doc</title></head><body><p>${'Real documentation content. '.repeat(40)}</p></body></html>`;
    return {
      status: 200,
      ok: true,
      headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'text/html' : null) },
      arrayBuffer: async () => Buffer.from(body, 'utf8'),
      text: async () => body,
    };
  };
}

const resolver = { lookup: async () => [{ address: '93.184.216.34', family: 4 }] };

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopub-e2e-'));
  fs.mkdirSync(path.join(dir, 'blog'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'automation', 'publishing', 'state'), { recursive: true });
  for (const f of ['blog/posts.json', 'blog/index.html', 'sitemap.xml']) {
    fs.copyFileSync(path.join(REPO_ROOT, f), path.join(dir, f));
  }
  // The renderer clones a real published post as its chrome template.
  fs.mkdirSync(path.join(dir, 'blog', 'terraform-iac-best-practices'), { recursive: true });
  fs.copyFileSync(
    path.join(REPO_ROOT, 'blog', 'terraform-iac-best-practices', 'index.html'),
    path.join(dir, 'blog', 'terraform-iac-best-practices', 'index.html'),
  );
  return dir;
}

function makePipeline(repoRoot, mode) {
  const config = loadConfig(
    {
      REPO_ROOT: repoRoot,
      PUBLISH_MODE: mode,
      GEMINI_API_KEY: 'test-key',
      GEMINI_MODEL: 'gemini-2.5-pro',
      STATE_FILE_PATH: path.join(repoRoot, 'automation', 'publishing', 'state', 'ledger.json'),
    },
    {},
  );
  const backend = new FileBackend({ filePath: config.state.filePath });
  const ledger = new Ledger(backend);
  const logger = createLogger({ level: 'error' });
  const pipeline = new Pipeline({
    config,
    ledger,
    logger,
    deps: { fetchImpl: stubFetch(), resolver, sleep: async () => {} },
  });
  pipeline._client = stubClient();
  return { config, ledger, pipeline, backend };
}

test('dry run completes all generation stages and writes nothing', async () => {
  const repo = sandbox();
  const { ledger, pipeline, backend } = makePipeline(repo, 'dry-run');

  const before = fs.readFileSync(path.join(repo, 'blog', 'posts.json'), 'utf8');
  const run = await ledger.startRun({ mode: 'dry-run', trigger: 'test' });
  const result = await pipeline.run({ run, forcedTopic: null });

  assert.equal(result.dryRun, true);
  assert.equal(result.metadata.slug, 'detecting-gitops-drift');
  assert.ok(result.validation.passed, JSON.stringify(result.validation.blocking));
  assert.ok(result.validation.words >= 1200, `words=${result.validation.words}`);

  // Nothing on disk changed, and the schedule clock did not move.
  assert.equal(fs.readFileSync(path.join(repo, 'blog', 'posts.json'), 'utf8'), before);
  assert.equal(fs.existsSync(path.join(repo, 'blog', 'detecting-gitops-drift')), false);
  assert.equal((await backend.read()).lastSuccessfulPublicationAt, null);

  // Every generation stage really ran.
  const reloaded = await ledger.getRun(run.runId);
  for (const stage of ['select_topic', 'research', 'brief', 'draft', 'review', 'validate', 'localize']) {
    assert.equal(reloaded.stages[stage].status, STAGE_STATUS.SUCCEEDED, `stage ${stage}`);
  }
});

test('research rejects sources that do not resolve, and fails when too few verify', async () => {
  const repo = sandbox();
  const { ledger, pipeline } = makePipeline(repo, 'dry-run');
  // Every source 404s → cannot reach the 3-source floor.
  pipeline.deps.fetchImpl = async () => ({
    status: 404,
    ok: false,
    headers: { get: () => null },
    arrayBuffer: async () => Buffer.from('', 'utf8'),
    text: async () => '',
  });

  const run = await ledger.startRun({ mode: 'dry-run', trigger: 'test' });
  await assert.rejects(
    () => pipeline.run({ run, forcedTopic: null }),
    /could be verified/,
    'a hallucinated source set must stop the run',
  );
});

test('quality gates block a fabricated claim before anything is written', async () => {
  const repo = sandbox();
  const { ledger, pipeline } = makePipeline(repo, 'dry-run');

  const original = pipeline._client.messages;
  pipeline._client.messages = async () => ({
    text: `${BODY}\n\nWe saved our client 42% on their AWS bill last quarter.`,
    raw: {},
    stopReason: 'end_turn',
  });

  const run = await ledger.startRun({ mode: 'dry-run', trigger: 'test' });
  await assert.rejects(() => pipeline.run({ run, forcedTopic: null }), /Quality gates blocked/);

  const reloaded = await ledger.getRun(run.runId);
  assert.equal(reloaded.stages.validate.status, STAGE_STATUS.FAILED);
  assert.equal(fs.existsSync(path.join(repo, 'blog', 'detecting-gitops-drift')), false);
  pipeline._client.messages = original;
});

test('validate retries the revise-and-recheck cycle when only a review finding blocks, and recovers', async () => {
  const repo = sandbox();
  const { ledger, pipeline } = makePipeline(repo, 'dry-run');

  const baseJson = pipeline._client.json.bind(pipeline._client);
  let reviewCalls = 0;
  pipeline._client.json = async (args) => {
    if (args.prompt.includes('Review this draft')) {
      reviewCalls += 1;
      // Stage 5's technical + editorial reviews (calls 1-2) and validate's
      // first recheck (call 3) all report a blocking finding; only the
      // recheck after one revise-retry (call 4) comes back clean.
      if (reviewCalls <= 3) {
        return {
          findings: [{ severity: 'high', message: 'unclear connection between the cited foundations and the thesis' }],
          verdict: 'needs_revision',
        };
      }
      return { findings: [{ severity: 'low', message: 'reads fine now' }], verdict: 'publishable' };
    }
    return baseJson(args);
  };

  const run = await ledger.startRun({ mode: 'dry-run', trigger: 'test' });
  const result = await pipeline.run({ run, forcedTopic: null });

  assert.ok(result.validation.passed, JSON.stringify(result.validation.blocking));
  assert.equal(reviewCalls, 4, 'expected exactly one revise-and-recheck retry');
});

test('a resumed run does not repeat completed stages', async () => {
  const repo = sandbox();
  const { ledger, pipeline } = makePipeline(repo, 'dry-run');
  const run = await ledger.startRun({ mode: 'dry-run', trigger: 'test' });
  await pipeline.run({ run, forcedTopic: null });

  // Count model calls on a second pass over the same run.
  let calls = 0;
  const counting = stubClient();
  const origJson = counting.json.bind(counting);
  const origMessages = counting.messages.bind(counting);
  counting.json = async (...a) => {
    calls += 1;
    return origJson(...a);
  };
  counting.messages = async (...a) => {
    calls += 1;
    return origMessages(...a);
  };

  const { pipeline: resumed, ledger: ledger2 } = makePipeline(repo, 'dry-run');
  resumed._client = counting;
  const reloaded = await ledger2.getRun(run.runId);
  await resumed.run({ run: reloaded, forcedTopic: null });

  assert.equal(calls, 0, 'a fully-completed run must make no further model calls on resume');
});

test('the generated page is a valid article with correct SEO metadata', async () => {
  const repo = sandbox();
  const { pipeline, ledger } = makePipeline(repo, 'dry-run');
  const run = await ledger.startRun({ mode: 'dry-run', trigger: 'test' });
  const result = await pipeline.run({ run, forcedTopic: null });

  // Render the very article the dry run produced, to assert on real output.
  const { renderArticle } = require('../src/publish/render');
  const { html } = renderArticle(
    {
      slug: result.metadata.slug,
      title: result.metadata.title,
      metaTitle: result.metadata.metaTitle,
      excerpt: result.metadata.excerpt,
      category: result.metadata.category,
      badgeClass: result.metadata.badgeClass,
      date: result.metadata.date,
      keywords: result.metadata.keywords,
      bodyMarkdown: result.body,
    },
    { repoRoot: repo, siteBaseUrl: 'https://up2cloud.tech' },
  );

  assert.match(html, /<title>Detecting GitOps Drift Before It Compounds — UP2CLOUD<\/title>/);
  assert.match(html, /rel="canonical" href="https:\/\/up2cloud\.tech\/blog\/detecting-gitops-drift\/"/);
  assert.match(html, /<h2>Why reconciliation loops drift<\/h2>/);
  assert.match(html, /<pre><code class="language-yaml">/);

  // JSON-LD must still parse after substitution.
  for (const block of html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    const inner = block.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '');
    assert.doesNotThrow(() => JSON.parse(inner), 'JSON-LD must remain valid');
  }

  // Meta description length stays in the SERP-safe band the site now enforces.
  const desc = html.match(/<meta name="description" content="([^"]*)"/)[1];
  assert.ok(desc.length >= 110 && desc.length <= 165, `description length ${desc.length}`);
});

test('localization preserves technical identifiers across locales', async () => {
  const repo = sandbox();
  const { pipeline, ledger } = makePipeline(repo, 'dry-run');
  const run = await ledger.startRun({ mode: 'dry-run', trigger: 'test' });
  await pipeline.run({ run, forcedTopic: null });

  const bundle = pipeline.loadArtifact(run.runId, 'localize').bundle;
  assert.deepEqual(Object.keys(bundle).sort(), ['en', 'es', 'fr', 'pt']);
  for (const locale of ['pt', 'es', 'fr']) {
    assert.ok(bundle[locale].title, `locale ${locale} has a title`);
    // "GitOps" / "Argo CD" are product names and must survive translation.
    assert.match(bundle[locale].excerpt, /Argo CD/);
  }
});
