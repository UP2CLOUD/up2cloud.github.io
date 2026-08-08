'use strict';

const path = require('node:path');
const { parsePage } = require('./parse');

/**
 * The SEO rule catalogue.
 *
 * Every rule declares whether it is *mechanically* fixable. That split is the
 * whole design: a missing `og:url` has exactly one correct value derivable from
 * the page's own canonical, so a machine can write it unattended. A 25-character
 * title needs someone to decide what the page is *about* — a machine rewriting
 * it weekly would churn the SERP snippet and quietly drift the site's voice.
 *
 * Fixable rules get applied and committed. Judgement rules get reported in the
 * PR body for a human, and never touched.
 */

const SEVERITY = Object.freeze({ ERROR: 'error', WARN: 'warn', INFO: 'info' });

// Google truncates around these; they are guidance, not hard limits, which is
// why every length rule is a WARN and none of them auto-fix.
const TITLE_MIN = 30;
const TITLE_MAX = 60;
const DESC_MIN = 70;
const DESC_MAX = 160;

/** Map a repo-relative HTML path to its canonical site URL. */
function urlForFile(file, baseUrl) {
  const rel = file.split(path.sep).join('/').replace(/^\.\//, '');
  if (rel === 'index.html') return `${baseUrl}/`;
  if (rel.endsWith('/index.html')) return `${baseUrl}/${rel.slice(0, -'index.html'.length)}`;
  return `${baseUrl}/${rel}`;
}

function isBlogPost(file) {
  const rel = file.split(path.sep).join('/');
  return /(^|\/)blog\/[^/]+\/index\.html$/.test(rel) && !/\/blog\/index\.html$/.test(rel);
}

/**
 * Rules. Each returns a finding object or null.
 *
 * `fix` — when present, the rule is auto-fixable; the function returns the
 * value that should be written. Absent `fix` means human judgement required.
 */
const RULES = [
  {
    id: 'title-present',
    severity: SEVERITY.ERROR,
    check: (p) => (!p.title ? 'Page has no <title>' : null),
  },
  {
    id: 'title-length',
    severity: SEVERITY.WARN,
    check: (p) => {
      if (!p.title) return null;
      const n = p.title.length;
      if (n < TITLE_MIN) return `Title is ${n} chars (under ${TITLE_MIN}) — thin for a SERP snippet`;
      if (n > TITLE_MAX) return `Title is ${n} chars (over ${TITLE_MAX}) — Google will truncate it`;
      return null;
    },
  },
  {
    id: 'description-present',
    severity: SEVERITY.ERROR,
    check: (p) => (!p.description ? 'Page has no meta description' : null),
  },
  {
    id: 'description-length',
    severity: SEVERITY.WARN,
    check: (p) => {
      if (!p.description) return null;
      const n = p.description.length;
      if (n < DESC_MIN) return `Meta description is ${n} chars (under ${DESC_MIN})`;
      if (n > DESC_MAX) return `Meta description is ${n} chars (over ${DESC_MAX}) — will be truncated`;
      return null;
    },
  },
  {
    id: 'canonical-present',
    severity: SEVERITY.ERROR,
    check: (p) => (!p.canonical ? 'Page has no rel=canonical' : null),
    fix: (p, ctx) => ({ kind: 'canonical', value: ctx.expectedUrl }),
  },
  {
    id: 'canonical-points-elsewhere',
    severity: SEVERITY.INFO,
    /**
     * A canonical pointing at a *different* URL is almost always deliberate:
     * it consolidates a duplicate into the page that should rank. This repo
     * has a live example — `privacy/index_old.html` canonicalises to
     * `/privacy/`, which is exactly right.
     *
     * So this is reported, never fixed. An earlier draft of this rule "fixed"
     * that page by pointing its canonical at itself, which would have promoted
     * a suppressed duplicate into a competitor of the real page. Rewriting a
     * canonical can de-index or mis-index a URL, and no weekly bot should do
     * that unattended.
     */
    check: (p, ctx) => {
      if (!p.canonical || p.canonical === ctx.expectedUrl) return null;
      return `Canonical points to "${p.canonical}" rather than this page's own URL "${ctx.expectedUrl}". This is usually intentional duplicate-consolidation — verify before changing, and never change it automatically.`;
    },
  },
  {
    id: 'og-title',
    severity: SEVERITY.WARN,
    check: (p) => (!p.og.title ? 'Missing og:title' : null),
    fix: (p) => (p.title ? { kind: 'meta', attr: 'property', name: 'og:title', value: p.title } : null),
  },
  {
    id: 'og-description',
    severity: SEVERITY.WARN,
    check: (p) => (!p.og.description ? 'Missing og:description' : null),
    fix: (p) =>
      p.description
        ? { kind: 'meta', attr: 'property', name: 'og:description', value: p.description }
        : null,
  },
  {
    id: 'og-url',
    severity: SEVERITY.WARN,
    check: (p) => (!p.og.url ? 'Missing og:url' : null),
    fix: (p, ctx) => ({
      kind: 'meta',
      attr: 'property',
      name: 'og:url',
      value: p.canonical || ctx.expectedUrl,
    }),
  },
  {
    id: 'og-url-correct',
    severity: SEVERITY.WARN,
    // og:url should agree with the canonical, not with the file's own path —
    // on a consolidated duplicate those differ, and the canonical wins.
    check: (p, ctx) => {
      const want = p.canonical || ctx.expectedUrl;
      return p.og.url && p.og.url !== want ? `og:url is "${p.og.url}" but canonical is "${want}"` : null;
    },
    fix: (p, ctx) =>
      p.og.url && p.og.url.startsWith(ctx.baseUrl)
        ? { kind: 'meta', attr: 'property', name: 'og:url', value: p.canonical || ctx.expectedUrl }
        : null,
  },
  {
    id: 'og-type',
    severity: SEVERITY.INFO,
    check: (p) => (!p.og.type ? 'Missing og:type' : null),
    fix: (p, ctx) => ({
      kind: 'meta',
      attr: 'property',
      name: 'og:type',
      value: ctx.isBlogPost ? 'article' : 'website',
    }),
  },
  {
    id: 'og-image',
    severity: SEVERITY.WARN,
    check: (p) => (!p.og.image ? 'Missing og:image — social shares will render bare' : null),
    fix: (p, ctx) =>
      ctx.defaultOgImage
        ? { kind: 'meta', attr: 'property', name: 'og:image', value: ctx.defaultOgImage }
        : null,
  },
  {
    id: 'twitter-card',
    severity: SEVERITY.WARN,
    check: (p) => (!p.twitter.card ? 'Missing twitter:card' : null),
    fix: () => ({ kind: 'meta', attr: 'name', name: 'twitter:card', value: 'summary_large_image' }),
  },
  {
    id: 'twitter-title',
    severity: SEVERITY.INFO,
    check: (p) => (!p.twitter.title ? 'Missing twitter:title' : null),
    fix: (p) =>
      p.og.title || p.title
        ? { kind: 'meta', attr: 'name', name: 'twitter:title', value: p.og.title || p.title }
        : null,
  },
  {
    id: 'twitter-description',
    severity: SEVERITY.INFO,
    check: (p) => (!p.twitter.description ? 'Missing twitter:description' : null),
    fix: (p) =>
      p.og.description || p.description
        ? {
            kind: 'meta',
            attr: 'name',
            name: 'twitter:description',
            value: p.og.description || p.description,
          }
        : null,
  },
  {
    id: 'viewport',
    severity: SEVERITY.ERROR,
    check: (p) => (!p.viewport ? 'Missing viewport meta — mobile usability signal' : null),
    fix: () => ({
      kind: 'meta',
      attr: 'name',
      name: 'viewport',
      value: 'width=device-width, initial-scale=1.0',
    }),
  },
  {
    id: 'charset',
    severity: SEVERITY.ERROR,
    check: (p) => (!p.charset ? 'Missing <meta charset>' : null),
  },
  {
    id: 'html-lang',
    severity: SEVERITY.WARN,
    check: (p) => (!p.lang ? 'Missing lang attribute on <html>' : null),
  },
  {
    id: 'h1-exactly-one',
    severity: SEVERITY.WARN,
    check: (p) => {
      if (p.h1.length === 0) return 'Page has no <h1>';
      if (p.h1.length > 1) return `Page has ${p.h1.length} <h1> elements — should have exactly one`;
      return null;
    },
  },
  {
    id: 'jsonld-valid',
    severity: SEVERITY.ERROR,
    check: (p) =>
      p.jsonLd.invalid > 0
        ? `${p.jsonLd.invalid} JSON-LD block(s) failed to parse — Google will ignore them`
        : null,
  },
  {
    id: 'jsonld-present',
    severity: SEVERITY.INFO,
    check: (p, ctx) =>
      ctx.isBlogPost && p.jsonLd.count === 0 ? 'Blog post has no structured data' : null,
  },
  {
    id: 'image-alt',
    severity: SEVERITY.WARN,
    check: (p) => {
      const missing = p.images.filter((img) => img.alt === undefined).length;
      return missing > 0 ? `${missing} <img> without an alt attribute` : null;
    },
  },
  {
    id: 'robots-indexable',
    severity: SEVERITY.ERROR,
    // A noindex on a page that is in the sitemap is a contradiction Google
    // reports as an error — one of the few checks that needs cross-file state.
    check: (p, ctx) =>
      p.noindex && ctx.inSitemap
        ? 'Page is noindex but is listed in sitemap.xml — contradictory signals'
        : null,
  },
  {
    id: 'sitemap-listed',
    severity: SEVERITY.WARN,
    check: (p, ctx) => {
      if (p.noindex || ctx.excludeFromSitemap) return null;
      return ctx.inSitemap ? null : 'Indexable page is missing from sitemap.xml';
    },
    fix: (p, ctx) =>
      p.noindex || ctx.excludeFromSitemap ? null : { kind: 'sitemap', url: ctx.expectedUrl },
  },
];

/**
 * Rules that still apply to a `noindex` page.
 *
 * Most SEO rules are about how a page presents itself *in search results*, so
 * they are meaningless for a page deliberately kept out of the index. A 404
 * page does not need a canonical, a meta description, an `<h1>`, or a sitemap
 * entry — demanding them produces findings that can never legitimately be
 * cleared, and a permanently-nonzero report is one nobody reads.
 *
 * What still matters is anything that is simply *broken*: malformed structured
 * data, a missing charset, or a busted viewport hurt users regardless of
 * indexing.
 */
const NOINDEX_APPLICABLE = new Set([
  'title-present',
  'charset',
  'viewport',
  'html-lang',
  'jsonld-valid',
  'image-alt',
  'robots-indexable',
]);

/** Pages that should never appear in the sitemap. */
const SITEMAP_EXCLUDE = [/^404\.html$/, /_old\.html$/, /^_includes\//];

function isSitemapExcluded(file) {
  const rel = file.split(path.sep).join('/').replace(/^\.\//, '');
  return SITEMAP_EXCLUDE.some((re) => re.test(rel));
}

/**
 * Run every rule against one page.
 * Returns `{ file, url, findings[], fixes[] }`.
 */
function auditPage({ file, html, baseUrl, sitemapUrls = new Set(), defaultOgImage = null }) {
  const parsed = parsePage(html, { origin: baseUrl });
  const expectedUrl = urlForFile(file, baseUrl);
  const ctx = {
    file,
    baseUrl,
    expectedUrl,
    isBlogPost: isBlogPost(file),
    inSitemap: sitemapUrls.has(expectedUrl),
    excludeFromSitemap: isSitemapExcluded(file),
    defaultOgImage,
  };

  // A page that canonicalises to a different URL is a consolidated duplicate:
  // it will not rank and will not be shared, so "fixing" its social tags is
  // churn in the diff for no search benefit. Report on it, edit nothing.
  const consolidated = Boolean(parsed.canonical && parsed.canonical !== expectedUrl);

  const findings = [];
  const fixes = [];
  for (const rule of RULES) {
    if (parsed.noindex && !NOINDEX_APPLICABLE.has(rule.id)) continue;
    const message = rule.check(parsed, ctx);
    if (!message) continue;
    const fix = consolidated ? null : typeof rule.fix === 'function' ? rule.fix(parsed, ctx) : null;
    findings.push({
      rule: rule.id,
      severity: rule.severity,
      message,
      file,
      url: expectedUrl,
      fixable: Boolean(fix),
    });
    if (fix) fixes.push({ rule: rule.id, file, ...fix });
  }
  return { file, url: expectedUrl, parsed, findings, fixes };
}

module.exports = {
  NOINDEX_APPLICABLE,
  RULES,
  SEVERITY,
  auditPage,
  urlForFile,
  isBlogPost,
  isSitemapExcluded,
  TITLE_MIN,
  TITLE_MAX,
  DESC_MIN,
  DESC_MAX,
};
