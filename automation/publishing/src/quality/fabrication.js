'use strict';

/**
 * Fabrication guard.
 *
 * The single most damaging failure mode for an autonomous publisher on a
 * consultancy's own domain is inventing business facts: a customer that does
 * not exist, a "we saved client X 40%" statistic, a partnership, a
 * certification. Those are reputational and potentially legal problems, not
 * style problems — so they are a hard publish blocker, never a warning.
 *
 * Two categories, treated differently:
 *
 *  - **First-person business claims** (`BLOCKING`): any assertion that UP2CLOUD
 *    has a client, saved a specific amount, holds a credential, or partners
 *    with a vendor. These are blocked outright, because the pipeline has no
 *    ground truth to verify them against and no legitimate reason to emit them.
 *  - **Unsourced quantitative claims** (`REQUIRES_CITATION`): statistics and
 *    benchmarks are legitimate *if* attributed to a cited source, so these are
 *    blocked only when no citation supports them.
 */

/** Claims about UP2CLOUD itself that the pipeline can never substantiate. */
const BLOCKING_PATTERNS = [
  {
    id: 'invented_client',
    // "our client", "a client of ours", "we worked with <Proper Noun>"
    pattern:
      /\b(?:our|my)\s+(?:client|customer)s?\b|\ba\s+client\s+of\s+(?:ours|mine)\b|\bwe\s+(?:worked|partnered)\s+with\s+[A-Z][A-Za-z0-9&.-]+/g,
    message: 'Names or implies a specific UP2CLOUD client or engagement',
  },
  {
    id: 'invented_savings',
    // "we saved ... 30%", "we cut their bill by $4,200"
    pattern:
      /\bwe\s+(?:saved|cut|reduced|slashed|shaved)\b[^.!?]{0,80}?(?:\d+\s*%|[$€£]\s?[\d,]+)/gi,
    message: 'Claims a specific saving UP2CLOUD delivered',
  },
  {
    id: 'invented_testimonial',
    // A quoted sentence attributed to a named person/role.
    pattern: /"[^"]{25,}"\s*[—–-]\s*[A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+)*\s*,\s*[A-Z]/g,
    message: 'Contains an attributed quote or testimonial',
  },
  {
    id: 'invented_partnership',
    pattern:
      /\b(?:we|up2cloud)\s+(?:are|is|'re)\s+(?:an?\s+)?(?:official|certified|premier|gold|silver|advanced)\s+(?:\w+\s+){0,3}partner\b/gi,
    message: 'Claims a vendor partnership tier',
  },
  {
    id: 'invented_certification',
    pattern:
      /\b(?:we|up2cloud)\s+(?:are|is|'re|hold|holds|have|has)\s+(?:\w+\s+){0,4}(?:ISO\s?\d{4,5}|SOC\s?2|PCI[\s-]?DSS|HIPAA|FedRAMP)\s*(?:certified|compliant|certification)/gi,
    message: 'Claims a compliance certification',
  },
  {
    id: 'invented_scale',
    pattern:
      /\b(?:we|up2cloud)\s+(?:manage|manages|operate|operates|run|runs|serve|serves)\s+(?:over\s+|more\s+than\s+)?[\d,]+\+?\s+(?:clients|customers|clusters|accounts|workloads|engineers)/gi,
    message: 'Claims a specific operational scale',
  },
];

/** Quantitative language that is fine *with* a citation and not without one. */
const CITATION_REQUIRED_PATTERNS = [
  {
    id: 'bare_statistic',
    pattern: /\b\d{1,3}(?:\.\d+)?\s?%\s+(?:of|faster|slower|cheaper|more|less|reduction|increase|improvement)/gi,
    message: 'Percentage claim',
  },
  {
    id: 'bare_benchmark',
    pattern: /\b(?:benchmark|benchmarks|measured|latency of|throughput of)\b[^.!?]{0,60}?\b\d+(?:\.\d+)?\s?(?:ms|s|rps|qps|GB|TB|x)\b/gi,
    message: 'Benchmark figure',
  },
  {
    id: 'bare_survey',
    pattern: /\b(?:survey|study|report|research)\s+(?:found|shows|showed|says|indicates|reveals)\b/gi,
    message: 'Reference to a study or survey',
  },
];

const SEVERITY = Object.freeze({ BLOCKING: 'blocking', WARNING: 'warning' });

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

function snippet(text, index, length) {
  const start = Math.max(0, index - 40);
  const end = Math.min(text.length, index + length + 40);
  return `…${text.slice(start, end).replace(/\s+/g, ' ').trim()}…`;
}

/**
 * Scan prose for fabricated claims.
 *
 * @param {string} text     article body (markdown or plain text)
 * @param {object} options
 * @param {Array}  options.citations  sources available to support claims
 * @returns {{findings: Array, blocking: Array, passed: boolean}}
 */
function detectFabrication(text, { citations = [] } = {}) {
  const body = String(text ?? '');
  const findings = [];

  for (const rule of BLOCKING_PATTERNS) {
    rule.pattern.lastIndex = 0;
    let match;
    while ((match = rule.pattern.exec(body)) !== null) {
      findings.push({
        ruleId: rule.id,
        severity: SEVERITY.BLOCKING,
        message: rule.message,
        line: lineOf(body, match.index),
        excerpt: snippet(body, match.index, match[0].length),
      });
      if (match[0].length === 0) rule.pattern.lastIndex += 1;
    }
  }

  // A quantitative claim needs *some* citation present. We do not attempt to
  // prove the specific number appears in the specific source — that is what the
  // technical review stage is for — but an article with zero sources may not
  // make numeric claims at all.
  const hasCitations = Array.isArray(citations) && citations.length > 0;
  for (const rule of CITATION_REQUIRED_PATTERNS) {
    rule.pattern.lastIndex = 0;
    let match;
    while ((match = rule.pattern.exec(body)) !== null) {
      const line = lineOf(body, match.index);
      const nearbyCitation = hasCitations && hasCitationNear(body, match.index);
      findings.push({
        ruleId: rule.id,
        severity: nearbyCitation ? SEVERITY.WARNING : SEVERITY.BLOCKING,
        message: nearbyCitation
          ? `${rule.message} (citation found nearby)`
          : `${rule.message} without a supporting citation`,
        line,
        excerpt: snippet(body, match.index, match[0].length),
      });
      if (match[0].length === 0) rule.pattern.lastIndex += 1;
    }
  }

  const blocking = findings.filter((f) => f.severity === SEVERITY.BLOCKING);
  return { findings, blocking, passed: blocking.length === 0 };
}

/**
 * Is there a link or footnote marker within a couple of sentences of `index`?
 * Cheap proximity heuristic — deliberately generous, since the blocking
 * decision it feeds is already conservative.
 */
function hasCitationNear(text, index, window = 400) {
  const start = Math.max(0, index - window);
  const end = Math.min(text.length, index + window);
  const region = text.slice(start, end);
  return /\[[^\]]+\]\((https?:\/\/[^)]+)\)|https?:\/\/\S+|\[\^?\d+\]/.test(region);
}

module.exports = {
  detectFabrication,
  hasCitationNear,
  BLOCKING_PATTERNS,
  CITATION_REQUIRED_PATTERNS,
  SEVERITY,
};
