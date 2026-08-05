'use strict';

const crypto = require('node:crypto');
const { detectFabrication } = require('./fabrication');
const { assertUrlShape } = require('../security/url-guard');

/**
 * Publish gates.
 *
 * Every gate returns findings rather than throwing, so a run reports *all*
 * problems in one pass instead of surfacing them one failed run at a time.
 * `runAllGates()` aggregates and makes the single go/no-go decision.
 *
 * Severity contract:
 *   blocking → never publishes, no override
 *   warning  → published, recorded in the ledger, surfaced in the PR body
 */

const SEVERITY = Object.freeze({ BLOCKING: 'blocking', WARNING: 'warning' });

function finding(gate, severity, message, extra = {}) {
  return { gate, severity, message, ...extra };
}

/** Word count within the configured band. */
function checkWordCount(body, { minWords, maxWords }) {
  const words = String(body || '')
    // Don't count fenced code toward prose length.
    .replace(/```[\s\S]*?```/g, ' ')
    .split(/\s+/)
    .filter(Boolean).length;

  const findings = [];
  if (words < minWords) {
    findings.push(
      finding('word_count', SEVERITY.BLOCKING, `Article is ${words} words, below minimum ${minWords}`, { words }),
    );
  } else if (words > maxWords) {
    // Over-length is a quality smell, not a correctness failure.
    findings.push(
      finding('word_count', SEVERITY.WARNING, `Article is ${words} words, above target ${maxWords}`, { words }),
    );
  }
  return { findings, words };
}

/** Required metadata for SEO + structured data. */
function checkMetadata(metadata = {}) {
  const findings = [];
  const required = ['title', 'slug', 'excerpt', 'category', 'date'];
  for (const key of required) {
    if (!String(metadata[key] || '').trim()) {
      findings.push(finding('metadata', SEVERITY.BLOCKING, `Missing required metadata field "${key}"`));
    }
  }

  const title = String(metadata.title || '');
  if (title && (title.length < 20 || title.length > 65)) {
    findings.push(
      finding('metadata', SEVERITY.WARNING, `Title is ${title.length} chars (target 20–65 for SERP)`, {
        length: title.length,
      }),
    );
  }

  const excerpt = String(metadata.excerpt || '');
  if (excerpt && (excerpt.length < 110 || excerpt.length > 158)) {
    findings.push(
      finding('metadata', SEVERITY.WARNING, `Excerpt is ${excerpt.length} chars (target 110–158)`, {
        length: excerpt.length,
      }),
    );
  }

  if (metadata.date && !/^\d{4}-\d{2}-\d{2}$/.test(metadata.date)) {
    findings.push(finding('metadata', SEVERITY.BLOCKING, `Date must be YYYY-MM-DD, got "${metadata.date}"`));
  }

  return { findings };
}

/**
 * Citations must exist, be well-formed public URLs, and — for at least some of
 * them — come from the authoritative domains the brief was told to prefer.
 */
const AUTHORITATIVE_HOSTS = [
  'kubernetes.io', 'cncf.io', 'opentelemetry.io', 'prometheus.io', 'argo-cd.readthedocs.io',
  'fluxcd.io', 'opengitops.dev', 'slsa.dev', 'owasp.org', 'nist.gov', 'csrc.nist.gov',
  'cisa.gov', 'finops.org', 'focus.finops.org', 'hashicorp.com', 'opentofu.org',
  'openpolicyagent.org', 'backstage.io', 'platformengineering.org', 'dora.dev',
  'sre.google', 'docs.aws.amazon.com', 'aws.amazon.com', 'cloud.google.com',
  'learn.microsoft.com', 'docs.github.com', 'github.blog', 'ietf.org', 'w3.org',
  'linuxfoundation.org', 'apache.org', 'postgresql.org', 'redhat.com',
];

function isAuthoritative(host) {
  const h = host.toLowerCase().replace(/^www\./, '');
  return AUTHORITATIVE_HOSTS.some((a) => h === a || h.endsWith(`.${a}`));
}

function checkCitations(citations = [], { minCitations = 3, minAuthoritative = 2 } = {}) {
  const findings = [];
  const list = Array.isArray(citations) ? citations : [];

  if (list.length < minCitations) {
    findings.push(
      finding('citations', SEVERITY.BLOCKING, `Only ${list.length} citations, need at least ${minCitations}`),
    );
  }

  let authoritative = 0;
  const seen = new Set();
  for (const c of list) {
    const url = typeof c === 'string' ? c : c?.url;
    if (!url) {
      findings.push(finding('citations', SEVERITY.BLOCKING, 'Citation entry has no URL'));
      continue;
    }
    try {
      const parsed = assertUrlShape(url);
      if (seen.has(parsed.toString())) {
        findings.push(finding('citations', SEVERITY.WARNING, `Duplicate citation: ${url}`));
      }
      seen.add(parsed.toString());
      if (isAuthoritative(parsed.hostname)) authoritative += 1;
      // A source the fetcher could not verify must not be cited as fact.
      if (typeof c === 'object' && c.verified === false) {
        findings.push(
          finding('citations', SEVERITY.BLOCKING, `Citation could not be fetched/verified: ${url}`, {
            url,
            status: c.status,
          }),
        );
      }
    } catch (err) {
      findings.push(finding('citations', SEVERITY.BLOCKING, `Invalid citation URL "${url}": ${err.message}`));
    }
  }

  if (list.length && authoritative < minAuthoritative) {
    findings.push(
      finding(
        'citations',
        SEVERITY.BLOCKING,
        `Only ${authoritative} authoritative sources (need ${minAuthoritative}: official docs, CNCF, FinOps Foundation, NIST, original research)`,
      ),
    );
  }

  return { findings, authoritativeCount: authoritative };
}

/**
 * Fenced code must declare a language and parse for the languages we can check
 * cheaply and reliably (JSON/YAML-ish structure). We deliberately do not try to
 * "validate" bash or HCL by regex — a false failure that blocks publishing is
 * worse than an unchecked snippet the technical review already read.
 */
function checkCodeBlocks(body) {
  const findings = [];
  const blocks = [];
  const fence = /```([A-Za-z0-9_+-]*)\n([\s\S]*?)```/g;
  let match;
  while ((match = fence.exec(String(body || ''))) !== null) {
    const [, lang, code] = match;
    blocks.push({ lang, code });

    if (!lang) {
      findings.push(
        finding('code', SEVERITY.WARNING, 'Fenced code block has no language annotation'),
      );
      continue;
    }
    const l = lang.toLowerCase();
    if (l === 'json') {
      try {
        JSON.parse(code);
      } catch (err) {
        findings.push(finding('code', SEVERITY.BLOCKING, `Invalid JSON code block: ${err.message}`));
      }
    }
    if ((l === 'yaml' || l === 'yml') && /\t/.test(code)) {
      // Tabs are illegal for YAML indentation — a cheap, certain check.
      findings.push(
        finding('code', SEVERITY.BLOCKING, 'YAML code block uses tab indentation, which is invalid YAML'),
      );
    }
  }
  return { findings, blockCount: blocks.length };
}

/**
 * Duplicate-content gate. Exact hash catches a re-run emitting identical bytes;
 * slug and normalised-title comparison catch near-duplicates that would compete
 * with an existing post in search.
 */
function checkDuplication({ body, slug, title, existingPublications = [], existingPosts = [] }) {
  const findings = [];
  const hash = crypto.createHash('sha256').update(String(body ?? ''), 'utf8').digest('hex');

  if (existingPublications.some((p) => p.contentHash === hash)) {
    findings.push(finding('duplication', SEVERITY.BLOCKING, 'Identical content hash already published', { hash }));
  }

  const allSlugs = new Set([
    ...existingPublications.map((p) => p.slug),
    ...existingPosts.map((p) => p.slug),
  ]);
  if (allSlugs.has(slug)) {
    findings.push(finding('duplication', SEVERITY.BLOCKING, `Slug "${slug}" already exists`, { slug }));
  }

  const normalise = (t) =>
    String(t || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .filter((w) => w.length > 3)
      .sort()
      .join(' ');

  const target = normalise(title);
  const targetWords = new Set(target.split(' ').filter(Boolean));
  for (const existing of [...existingPublications, ...existingPosts]) {
    const other = new Set(normalise(existing.title).split(' ').filter(Boolean));
    if (!targetWords.size || !other.size) continue;
    const overlap = [...targetWords].filter((w) => other.has(w)).length;
    const similarity = overlap / Math.max(targetWords.size, other.size);
    if (similarity >= 0.7) {
      findings.push(
        finding('duplication', SEVERITY.BLOCKING, `Title is ${(similarity * 100).toFixed(0)}% similar to existing post "${existing.title}"`, {
          existingSlug: existing.slug,
          similarity,
        }),
      );
    }
  }

  return { findings, contentHash: hash };
}

/** Aggregate every gate into one decision. */
function runAllGates({
  body,
  metadata = {},
  citations = [],
  existingPublications = [],
  existingPosts = [],
  minWords = 1200,
  maxWords = 2200,
  reviewFindings = [],
}) {
  const results = [];
  const wordCount = checkWordCount(body, { minWords, maxWords });
  results.push(...wordCount.findings);
  results.push(...checkMetadata(metadata).findings);

  const citationResult = checkCitations(citations);
  results.push(...citationResult.findings);
  results.push(...checkCodeBlocks(body).findings);

  const dup = checkDuplication({
    body,
    slug: metadata.slug,
    title: metadata.title,
    existingPublications,
    existingPosts,
  });
  results.push(...dup.findings);

  const fabrication = detectFabrication(body, { citations });
  for (const f of fabrication.findings) {
    results.push(
      finding('fabrication', f.severity, f.message, { line: f.line, excerpt: f.excerpt, ruleId: f.ruleId }),
    );
  }

  // High-severity findings raised by the model-driven technical/editorial
  // review are treated as blocking, same as a static gate.
  for (const rf of reviewFindings) {
    const severity = ['high', 'critical', 'blocking'].includes(String(rf.severity).toLowerCase())
      ? SEVERITY.BLOCKING
      : SEVERITY.WARNING;
    results.push(finding('review', severity, rf.message || String(rf), { source: rf.source || 'review' }));
  }

  const blocking = results.filter((f) => f.severity === SEVERITY.BLOCKING);
  const warnings = results.filter((f) => f.severity === SEVERITY.WARNING);

  return {
    passed: blocking.length === 0,
    blocking,
    warnings,
    findings: results,
    contentHash: dup.contentHash,
    words: wordCount.words,
    authoritativeCitations: citationResult.authoritativeCount,
  };
}

module.exports = {
  runAllGates,
  checkWordCount,
  checkMetadata,
  checkCitations,
  checkCodeBlocks,
  checkDuplication,
  isAuthoritative,
  AUTHORITATIVE_HOSTS,
  SEVERITY,
};
