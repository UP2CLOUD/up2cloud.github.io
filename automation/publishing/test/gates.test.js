'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  runAllGates,
  checkWordCount,
  checkMetadata,
  checkCitations,
  checkCodeBlocks,
  checkDuplication,
  isAuthoritative,
  SEVERITY,
} = require('../src/quality/gates');
const { detectFabrication } = require('../src/quality/fabrication');

const goodCitations = [
  { url: 'https://kubernetes.io/docs/concepts/', verified: true },
  { url: 'https://www.finops.org/framework/', verified: true },
  { url: 'https://slsa.dev/spec/v1.0/levels', verified: true },
];

function bodyOf(words, extra = '') {
  return `${'word '.repeat(words).trim()}\n\n${extra}`;
}

const validMetadata = {
  title: 'Progressive Delivery with Argo Rollouts in Production',
  slug: 'progressive-delivery-argo-rollouts',
  excerpt:
    'How to run canary and blue/green releases on Kubernetes with Argo Rollouts, including analysis templates, metric gates and safe rollback behaviour.',
  category: 'Cloud',
  date: '2026-08-10',
};

test('word count blocks below the minimum and warns above the maximum', () => {
  assert.equal(
    checkWordCount(bodyOf(500), { minWords: 1200, maxWords: 2200 }).findings[0].severity,
    SEVERITY.BLOCKING,
  );
  assert.equal(
    checkWordCount(bodyOf(2500), { minWords: 1200, maxWords: 2200 }).findings[0].severity,
    SEVERITY.WARNING,
  );
  assert.equal(checkWordCount(bodyOf(1500), { minWords: 1200, maxWords: 2200 }).findings.length, 0);
});

test('fenced code does not count toward prose word count', () => {
  const withCode = `${bodyOf(1250)}\n\n\`\`\`yaml\n${'key: value\n'.repeat(400)}\`\`\``;
  const r = checkWordCount(withCode, { minWords: 1200, maxWords: 2200 });
  assert.ok(r.words < 1400, `code leaked into the count: ${r.words}`);
});

test('metadata gate requires the fields the template needs', () => {
  const findings = checkMetadata({ title: 'x' }).findings;
  const blocking = findings.filter((f) => f.severity === SEVERITY.BLOCKING).map((f) => f.message);
  assert.ok(blocking.some((m) => m.includes('slug')));
  assert.ok(blocking.some((m) => m.includes('excerpt')));
  assert.ok(blocking.some((m) => m.includes('date')));
});

test('metadata gate rejects a malformed date', () => {
  const findings = checkMetadata({ ...validMetadata, date: '10/08/2026' }).findings;
  assert.ok(findings.some((f) => f.severity === SEVERITY.BLOCKING && /YYYY-MM-DD/.test(f.message)));
});

test('citation gate blocks too few sources', () => {
  const findings = checkCitations([{ url: 'https://kubernetes.io/docs/' }]).findings;
  assert.ok(findings.some((f) => /at least 3/.test(f.message)));
});

test('citation gate blocks an unverified (hallucinated) source', () => {
  const findings = checkCitations([
    ...goodCitations,
    { url: 'https://kubernetes.io/docs/does-not-exist', verified: false, status: 404 },
  ]).findings;
  assert.ok(
    findings.some((f) => f.severity === SEVERITY.BLOCKING && /could not be fetched/.test(f.message)),
    'a source that failed verification must block publication',
  );
});

test('citation gate requires authoritative sources', () => {
  const findings = checkCitations([
    { url: 'https://example.com/a', verified: true },
    { url: 'https://example.com/b', verified: true },
    { url: 'https://example.com/c', verified: true },
  ]).findings;
  assert.ok(findings.some((f) => /authoritative/.test(f.message)));
});

test('authoritative host detection covers subdomains but not lookalikes', () => {
  assert.equal(isAuthoritative('kubernetes.io'), true);
  assert.equal(isAuthoritative('docs.kubernetes.io'), true);
  assert.equal(isAuthoritative('www.finops.org'), true);
  assert.equal(isAuthoritative('kubernetes.io.evil.com'), false);
  assert.equal(isAuthoritative('notkubernetes.io'), false);
});

test('code gate blocks invalid JSON and tab-indented YAML', () => {
  const badJson = checkCodeBlocks('```json\n{ "a": }\n```').findings;
  assert.ok(badJson.some((f) => f.severity === SEVERITY.BLOCKING));

  const tabYaml = checkCodeBlocks('```yaml\nspec:\n\treplicas: 2\n```').findings;
  assert.ok(tabYaml.some((f) => f.severity === SEVERITY.BLOCKING && /tab/.test(f.message)));

  const good = checkCodeBlocks('```json\n{"a":1}\n```\n```yaml\nspec:\n  replicas: 2\n```').findings;
  assert.equal(good.filter((f) => f.severity === SEVERITY.BLOCKING).length, 0);
});

test('duplicate detection blocks an identical content hash, slug, or near-identical title', () => {
  const existing = [
    {
      slug: 'progressive-delivery-argo-rollouts',
      title: 'Progressive Delivery with Argo Rollouts in Production',
      contentHash: require('node:crypto').createHash('sha256').update('same body', 'utf8').digest('hex'),
    },
  ];

  const sameHash = checkDuplication({
    body: 'same body',
    slug: 'different-slug',
    title: 'Totally Unrelated Article About Networking Meshes',
    existingPublications: existing,
  }).findings;
  assert.ok(sameHash.some((f) => /content hash/.test(f.message)));

  const sameSlug = checkDuplication({
    body: 'unique',
    slug: 'progressive-delivery-argo-rollouts',
    title: 'Something Else Entirely Here',
    existingPublications: existing,
  }).findings;
  assert.ok(sameSlug.some((f) => /already exists/.test(f.message)));

  const sameTitle = checkDuplication({
    body: 'unique',
    slug: 'new-slug',
    title: 'Progressive Delivery with Argo Rollouts in Production',
    existingPublications: existing,
  }).findings;
  assert.ok(sameTitle.some((f) => /similar to existing post/.test(f.message)));
});

// ── Fabrication ───────────────────────────────────────────────────────────

test('blocks an invented client reference', () => {
  const r = detectFabrication('We migrated our client, a large retailer, to GKE.', { citations: goodCitations });
  assert.equal(r.passed, false);
  assert.ok(r.blocking.some((f) => f.ruleId === 'invented_client'));
});

test('blocks an invented savings claim', () => {
  const r = detectFabrication('In one engagement we reduced spend by 42% within a quarter.', {
    citations: goodCitations,
  });
  assert.equal(r.passed, false);
  assert.ok(r.blocking.some((f) => f.ruleId === 'invented_savings'));
});

test('blocks an invented partnership and certification', () => {
  assert.equal(detectFabrication('UP2CLOUD is an official Google Cloud partner.').passed, false);
  assert.equal(detectFabrication('We are ISO 27001 certified.').passed, false);
});

test('blocks a fabricated testimonial', () => {
  const r = detectFabrication('"This transformed how our team ships software" — Jane Doe, CTO');
  assert.equal(r.passed, false);
  assert.ok(r.blocking.some((f) => f.ruleId === 'invented_testimonial'));
});

test('blocks a bare statistic with no citation anywhere', () => {
  const r = detectFabrication('Teams see 60% faster deployments after adopting GitOps.', { citations: [] });
  assert.equal(r.passed, false);
});

test('allows a statistic that sits next to a citation', () => {
  const text =
    'According to the DORA research programme, elite performers deploy far more often; ' +
    'one measure showed 30% faster recovery ([DORA](https://dora.dev/research/)).';
  const r = detectFabrication(text, { citations: goodCitations });
  assert.equal(r.passed, true, JSON.stringify(r.blocking));
});

test('clean technical prose passes', () => {
  const text =
    'Argo Rollouts implements canary releases using a Rollout resource. ' +
    'The analysis template queries Prometheus and aborts on a failed metric gate. ' +
    'See the [Argo Rollouts docs](https://argo-cd.readthedocs.io/) for the full specification.';
  assert.equal(detectFabrication(text, { citations: goodCitations }).passed, true);
});

// ── Aggregate ─────────────────────────────────────────────────────────────

test('runAllGates passes a clean article', () => {
  const body = `${bodyOf(1400)}\n\nSee [the docs](https://kubernetes.io/docs/).\n\n\`\`\`yaml\nspec:\n  replicas: 2\n\`\`\``;
  const r = runAllGates({
    body,
    metadata: validMetadata,
    citations: goodCitations,
    existingPublications: [],
    existingPosts: [],
  });
  assert.equal(r.passed, true, JSON.stringify(r.blocking, null, 2));
  assert.ok(r.contentHash);
});

test('runAllGates treats a high-severity review finding as blocking', () => {
  const body = `${bodyOf(1400)}\n\n[docs](https://kubernetes.io/docs/)`;
  const r = runAllGates({
    body,
    metadata: validMetadata,
    citations: goodCitations,
    reviewFindings: [{ severity: 'high', message: 'kubectl flag does not exist' }],
  });
  assert.equal(r.passed, false);
  assert.ok(r.blocking.some((f) => f.gate === 'review'));
});

test('runAllGates ignores a low-severity review finding', () => {
  const body = `${bodyOf(1400)}\n\n[docs](https://kubernetes.io/docs/)`;
  const r = runAllGates({
    body,
    metadata: validMetadata,
    citations: goodCitations,
    reviewFindings: [{ severity: 'low', message: 'could use another example' }],
  });
  assert.equal(r.passed, true, JSON.stringify(r.blocking));
  assert.ok(r.warnings.some((f) => f.gate === 'review'));
});
