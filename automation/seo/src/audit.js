'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { auditPage, urlForFile, isSitemapExcluded, SEVERITY } = require('./rules');
const { applyFixes, addToSitemap, touchSitemapLastmod } = require('./fix');

/** Directories that never contain published pages. */
const SKIP_DIRS = new Set(['.git', 'node_modules', 'public', '_includes', 'automation', 'terraform', 'scripts']);

function findHtmlFiles(repoRoot) {
  const out = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') && entry.name !== '.') continue;
      if (SKIP_DIRS.has(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.name.endsWith('.html')) out.push(path.relative(repoRoot, abs));
    }
  })(repoRoot);
  return out.sort();
}

function readSitemapUrls(repoRoot) {
  const file = path.join(repoRoot, 'sitemap.xml');
  if (!fs.existsSync(file)) return { urls: new Set(), xml: null };
  const xml = fs.readFileSync(file, 'utf8');
  const urls = new Set([...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim()));
  return { urls, xml };
}

/**
 * Cross-page checks — the ones no single page can see on its own.
 * Duplicate titles and descriptions are the classic example: each page looks
 * fine in isolation, and Google reports them as a site-level problem.
 */
function siteFindings(pages, { sitemapUrls, repoRoot, baseUrl }) {
  const findings = [];

  const byTitle = new Map();
  const byDescription = new Map();
  for (const p of pages) {
    if (p.parsed.noindex) continue;
    if (p.parsed.title) {
      if (!byTitle.has(p.parsed.title)) byTitle.set(p.parsed.title, []);
      byTitle.get(p.parsed.title).push(p.url);
    }
    if (p.parsed.description) {
      if (!byDescription.has(p.parsed.description)) byDescription.set(p.parsed.description, []);
      byDescription.get(p.parsed.description).push(p.url);
    }
  }
  for (const [value, urls] of byTitle) {
    if (urls.length > 1) {
      findings.push({
        rule: 'duplicate-title',
        severity: SEVERITY.WARN,
        message: `${urls.length} pages share the title "${value}": ${urls.join(', ')}`,
        file: null,
        url: null,
        fixable: false,
      });
    }
  }
  for (const [, urls] of byDescription) {
    if (urls.length > 1) {
      findings.push({
        rule: 'duplicate-description',
        severity: SEVERITY.WARN,
        message: `${urls.length} pages share one meta description: ${urls.join(', ')}`,
        file: null,
        url: null,
        fixable: false,
      });
    }
  }

  // Sitemap entries with no corresponding page — a 404 in the sitemap is a
  // crawl-budget leak and a Search Console error.
  const known = new Set(pages.map((p) => p.url));
  for (const url of sitemapUrls) {
    if (!known.has(url)) {
      findings.push({
        rule: 'sitemap-orphan',
        severity: SEVERITY.ERROR,
        message: `sitemap.xml lists ${url} but no page in the repo maps to it`,
        file: 'sitemap.xml',
        url,
        fixable: false,
      });
    }
  }

  // Internal links pointing at paths that do not exist.
  for (const p of pages) {
    for (const href of new Set(p.parsed.internalLinks)) {
      const clean = href.replace(baseUrl, '').split(/[?#]/)[0];
      if (!clean || !clean.startsWith('/')) continue;
      const candidates = clean.endsWith('/')
        ? [path.join(repoRoot, clean, 'index.html')]
        : [path.join(repoRoot, clean), path.join(repoRoot, `${clean}.html`), path.join(repoRoot, clean, 'index.html')];
      if (!candidates.some((c) => fs.existsSync(c))) {
        findings.push({
          rule: 'broken-internal-link',
          severity: SEVERITY.WARN,
          message: `${p.url} links to ${href}, which does not resolve to a file in the repo`,
          file: p.file,
          url: p.url,
          fixable: false,
        });
      }
    }
  }

  const robotsPath = path.join(repoRoot, 'robots.txt');
  if (!fs.existsSync(robotsPath)) {
    findings.push({
      rule: 'robots-missing',
      severity: SEVERITY.ERROR,
      message: 'robots.txt is missing',
      file: 'robots.txt',
      url: null,
      fixable: false,
    });
  } else {
    const robots = fs.readFileSync(robotsPath, 'utf8');
    if (!/^\s*Sitemap:/im.test(robots)) {
      findings.push({
        rule: 'robots-sitemap-ref',
        severity: SEVERITY.WARN,
        message: 'robots.txt does not reference the sitemap',
        file: 'robots.txt',
        url: null,
        fixable: false,
      });
    }
  }

  return findings;
}

/**
 * Audit the whole site.
 * `apply: true` writes fixes to disk; otherwise it is a pure report.
 */
function auditSite({
  repoRoot,
  baseUrl = 'https://up2cloud.tech',
  defaultOgImage = null,
  apply = false,
  today = new Date().toISOString().slice(0, 10),
} = {}) {
  const { urls: sitemapUrls, xml: sitemapXml } = readSitemapUrls(repoRoot);
  const files = findHtmlFiles(repoRoot);

  const pages = files.map((file) =>
    auditPage({
      file,
      html: fs.readFileSync(path.join(repoRoot, file), 'utf8'),
      baseUrl,
      sitemapUrls,
      defaultOgImage,
    }),
  );

  const findings = [
    ...pages.flatMap((p) => p.findings),
    ...siteFindings(pages, { sitemapUrls, repoRoot, baseUrl }),
  ];

  const changed = [];
  const skipped = [];

  if (apply) {
    for (const page of pages) {
      const pageFixes = page.fixes.filter((f) => f.kind !== 'sitemap');
      if (!pageFixes.length) continue;
      const abs = path.join(repoRoot, page.file);
      const original = fs.readFileSync(abs, 'utf8');
      const { html, applied, skipped: sk } = applyFixes(original, pageFixes);
      skipped.push(...sk);
      if (html !== original) {
        fs.writeFileSync(abs, html, 'utf8');
        changed.push({ file: page.file, fixes: applied.map((f) => f.rule) });
      }
    }

    // Sitemap additions, applied once against the real file.
    const sitemapAdds = pages.flatMap((p) => p.fixes.filter((f) => f.kind === 'sitemap'));
    if (sitemapAdds.length && sitemapXml !== null) {
      let xml = sitemapXml;
      const added = [];
      for (const add of sitemapAdds) {
        const next = addToSitemap(xml, add.url, today);
        if (next) {
          xml = next;
          added.push(add.url);
        }
      }
      if (added.length) {
        fs.writeFileSync(path.join(repoRoot, 'sitemap.xml'), xml, 'utf8');
        changed.push({ file: 'sitemap.xml', fixes: added.map((u) => `added ${u}`) });
      }
    }
  }

  const counts = {
    error: findings.filter((f) => f.severity === SEVERITY.ERROR).length,
    warn: findings.filter((f) => f.severity === SEVERITY.WARN).length,
    info: findings.filter((f) => f.severity === SEVERITY.INFO).length,
  };

  return {
    baseUrl,
    pagesScanned: pages.length,
    findings,
    counts,
    fixable: findings.filter((f) => f.fixable).length,
    changed,
    skipped,
    pages,
  };
}

module.exports = {
  auditSite,
  findHtmlFiles,
  readSitemapUrls,
  siteFindings,
  urlForFile,
  isSitemapExcluded,
  SKIP_DIRS,
};
