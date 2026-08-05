'use strict';

const { safeFetch, UrlSecurityError } = require('../security/url-guard');
const { htmlToText, wrapUntrusted } = require('../security/sanitize');
const { isAuthoritative } = require('../quality/gates');

/**
 * Research stage: gather and *verify* authoritative sources.
 *
 * The critical property here is that a citation is only usable if we actually
 * fetched it and got a 200. The model proposes URLs; this stage proves they
 * exist. Anything that 404s, times out, or fails the SSRF guard is marked
 * `verified: false`, and the citation gate later blocks publishing on it — so a
 * hallucinated URL can never end up as a footnote on a live article.
 */

const CANDIDATE_SCHEMA_HINT = `{
  "queries": ["search-style phrases a practitioner would use"],
  "sources": [
    { "url": "https://…", "why": "what this source establishes", "authoritative": true }
  ]
}`;

async function proposeSources({ client, domain, angle, count = 8 }) {
  const preferred = (domain.preferredSources || []).join('\n- ');
  const prompt = [
    `Propose authoritative, currently-existing sources for a technical article.`,
    ``,
    `Primary domain: ${domain.label}`,
    `Specific angle: ${angle}`,
    ``,
    `Strongly prefer these already-known-good roots:`,
    `- ${preferred}`,
    ``,
    `Rules:`,
    `- Only URLs you are confident exist right now. Prefer stable documentation`,
    `  roots and specification pages over blog posts and news articles.`,
    `- Prefer official project documentation, CNCF, FinOps Foundation, NIST,`,
    `  IETF, and original vendor documentation or original research.`,
    `- Never invent a URL to make a point. Fewer, real sources beat more, guessed ones.`,
    `- Do not include marketing pages, listicles, or content farms.`,
    ``,
    `Return up to ${count} sources as JSON matching:`,
    CANDIDATE_SCHEMA_HINT,
  ].join('\n');

  const result = await client.json({
    system:
      'You are a meticulous technical researcher. You only cite sources you are confident exist. ' +
      'You never fabricate URLs, statistics, or attributions.',
    prompt,
    temperature: 0.2,
    validate: (obj) => {
      const problems = [];
      if (!Array.isArray(obj.sources)) problems.push('sources must be an array');
      return problems;
    },
  });

  return (result.sources || [])
    .map((s) => (typeof s === 'string' ? { url: s } : s))
    .filter((s) => s && typeof s.url === 'string');
}

/**
 * Fetch each candidate. Returns verified sources with extracted, sanitised text
 * plus the rejects (kept for the run record so a reviewer can see what was
 * discarded and why).
 */
async function verifySources(candidates, { fetchImpl, resolver, maxSources = 6, logger } = {}) {
  const verified = [];
  const rejected = [];

  for (const candidate of candidates) {
    if (verified.length >= maxSources) break;
    try {
      const res = await safeFetch(candidate.url, { fetchImpl, resolver, timeoutMs: 20_000 });
      if (res.status !== 200) {
        rejected.push({ ...candidate, verified: false, status: res.status, reason: `HTTP ${res.status}` });
        continue;
      }
      if (!/text\/html|text\/plain|application\/xhtml/i.test(res.contentType)) {
        rejected.push({ ...candidate, verified: false, reason: `Unsupported content-type ${res.contentType}` });
        continue;
      }

      const text = htmlToText(res.body, { maxLength: 10_000 });
      if (text.length < 200) {
        rejected.push({ ...candidate, verified: false, reason: 'Too little extractable text' });
        continue;
      }

      const host = new URL(res.url).hostname;
      verified.push({
        url: res.url,
        title: extractTitle(res.body) || candidate.url,
        why: candidate.why || '',
        authoritative: isAuthoritative(host),
        verified: true,
        status: 200,
        fetchedAt: new Date().toISOString(),
        text,
      });
    } catch (err) {
      const reason = err instanceof UrlSecurityError ? `blocked: ${err.message}` : err.message;
      rejected.push({ ...candidate, verified: false, reason });
      logger?.warn('Source rejected', { url: candidate.url, reason });
    }
  }

  return { verified, rejected };
}

function extractTitle(html) {
  const m = String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? m[1].replace(/\s+/g, ' ').trim().slice(0, 200) : null;
}

/**
 * Build the untrusted-source block handed to later stages. Each source is
 * individually fenced so the model sees clear per-document boundaries.
 */
function buildResearchContext(verified) {
  return verified
    .map((s, i) => wrapUntrusted(`source ${i + 1}: ${s.url}`, `${s.title}\n\n${s.text}`))
    .join('\n\n');
}

async function runResearch({ client, domain, angle, fetchImpl, resolver, logger, maxSources = 6 }) {
  const candidates = await proposeSources({ client, domain, angle });
  logger?.info('Proposed research sources', { count: candidates.length });

  const { verified, rejected } = await verifySources(candidates, {
    fetchImpl,
    resolver,
    maxSources,
    logger,
  });
  logger?.info('Verified research sources', { verified: verified.length, rejected: rejected.length });

  if (verified.length < 3) {
    throw new Error(
      `Only ${verified.length} of ${candidates.length} proposed sources could be verified ` +
        `(need at least 3). Rejected: ${rejected.map((r) => `${r.url} (${r.reason})`).join('; ')}`,
    );
  }

  return {
    sources: verified,
    rejected,
    context: buildResearchContext(verified),
    authoritativeCount: verified.filter((s) => s.authoritative).length,
  };
}

module.exports = { runResearch, proposeSources, verifySources, buildResearchContext, extractTitle };
