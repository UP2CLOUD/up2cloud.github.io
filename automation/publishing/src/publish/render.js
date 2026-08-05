'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { renderMarkdown } = require('./markdown');
const { escapeHtml, escapeAttr } = require('../security/sanitize');
const { assertSafeSlug } = require('../security/paths');

/**
 * Article renderer.
 *
 * Rather than carrying its own copy of the page chrome, the renderer clones an
 * existing published post and replaces three regions: the `<head>` metadata,
 * the article hero, and the body between `<!-- ARTICLE BODY -->` and
 * `</article>`.
 *
 * That choice is deliberate. The nav, language picker, engagement widgets,
 * footer, analytics snippet and i18n script are ~250 lines that evolve with the
 * site (the favicon include and the `data-i18n` hooks both changed recently).
 * A duplicated template would silently rot; cloning means generated posts
 * inherit every future chrome change for free and can never drift.
 */

const REFERENCE_POST = 'blog/terraform-iac-best-practices/index.html';

const BADGE_STYLES = {
  'badge-green': { color: '#34D399', bg: 'rgba(5,150,105,.18)' },
  'badge-sky': { color: '#38BDF8', bg: 'rgba(3,105,161,.18)' },
  'badge-purple': { color: '#A78BFA', bg: 'rgba(124,58,237,.18)' },
  'badge-orange': { color: '#FB923C', bg: 'rgba(234,88,12,.18)' },
};

function estimateReadMinutes(markdown) {
  const words = String(markdown || '').split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 225));
}

function loadTemplate(repoRoot, reference = REFERENCE_POST) {
  const file = path.join(repoRoot, reference);
  if (!fs.existsSync(file)) {
    throw new Error(`Reference post template not found at ${file}`);
  }
  return fs.readFileSync(file, 'utf8');
}

/** Replace the contents of the first `<tag ...>…</tag>` match. */
function replaceTagContent(html, tag, attrsPattern, replacement) {
  const re = new RegExp(`(<${tag}[^>]*${attrsPattern}[^>]*>)([\\s\\S]*?)(</${tag}>)`, 'i');
  if (!re.test(html)) throw new Error(`Could not locate <${tag}> matching ${attrsPattern}`);
  return html.replace(re, (_, open, __, close) => `${open}${replacement}${close}`);
}

function replaceMeta(html, attr, name, value) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(<meta[^>]+${attr}=["']${escaped}["'][^>]*content=["'])([^"']*)(["'])`, 'i');
  if (re.test(html)) return html.replace(re, (_, a, __, c) => `${a}${escapeAttr(value)}${c}`);
  const reAlt = new RegExp(`(<meta[^>]+content=["'])([^"']*)(["'][^>]*${attr}=["']${escaped}["'])`, 'i');
  if (reAlt.test(html)) return html.replace(reAlt, (_, a, __, c) => `${a}${escapeAttr(value)}${c}`);
  return html;
}

/**
 * @param {object} article
 *   { slug, title, metaTitle, excerpt, category, badgeClass, date, keywords,
 *     bodyMarkdown, headline }
 */
function renderArticle(article, { repoRoot, siteBaseUrl = 'https://up2cloud.tech', reference } = {}) {
  assertSafeSlug(article.slug);

  const required = ['title', 'excerpt', 'category', 'date', 'bodyMarkdown'];
  for (const key of required) {
    if (!String(article[key] || '').trim()) {
      throw new Error(`renderArticle: missing required field "${key}"`);
    }
  }

  const url = `${siteBaseUrl.replace(/\/+$/, '')}/blog/${article.slug}/`;
  const ogImage = `${siteBaseUrl.replace(/\/+$/, '')}/assets/img/og-image.png`;
  const metaTitle = article.metaTitle || `${article.title} — UP2CLOUD`;
  const headline = article.headline || article.title;
  const badgeClass = BADGE_STYLES[article.badgeClass] ? article.badgeClass : 'badge-sky';
  const badge = BADGE_STYLES[badgeClass];
  const readMinutes = estimateReadMinutes(article.bodyMarkdown);

  let html = loadTemplate(repoRoot, reference);

  // ── <head> metadata ───────────────────────────────────────────────────────
  html = html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapeHtml(metaTitle)}</title>`);
  html = replaceMeta(html, 'name', 'description', article.excerpt);
  html = replaceMeta(html, 'name', 'keywords', (article.keywords || []).join(', '));
  html = replaceMeta(html, 'property', 'og:title', metaTitle);
  html = replaceMeta(html, 'property', 'og:url', url);
  html = replaceMeta(html, 'property', 'og:description', article.excerpt);
  html = replaceMeta(html, 'property', 'og:image', ogImage);
  html = replaceMeta(html, 'property', 'article:published_time', article.date);
  html = replaceMeta(html, 'name', 'twitter:title', metaTitle);
  html = replaceMeta(html, 'name', 'twitter:description', article.excerpt);
  html = replaceMeta(html, 'name', 'twitter:image', ogImage);
  html = html.replace(
    /(<link[^>]+rel=["']canonical["'][^>]*href=["'])([^"']*)(["'])/i,
    (_, a, __, c) => `${a}${url}${c}`,
  );

  // ── JSON-LD ───────────────────────────────────────────────────────────────
  const blogPosting = {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline,
    description: article.excerpt,
    datePublished: article.date,
    dateModified: article.date,
    author: { '@type': 'Person', name: 'Cesar A. Nogueira', url: `${siteBaseUrl}/about/` },
    publisher: {
      '@type': 'Organization',
      name: 'UP2CLOUD',
      logo: { '@type': 'ImageObject', url: ogImage },
    },
    mainEntityOfPage: { '@type': 'WebPage', '@id': url },
    image: ogImage,
  };
  const breadcrumb = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: `${siteBaseUrl}/` },
      { '@type': 'ListItem', position: 2, name: 'Blog', item: `${siteBaseUrl}/blog/` },
      { '@type': 'ListItem', position: 3, name: headline, item: url },
    ],
  };

  // Replace the two ld+json blocks in document order.
  let ldIndex = 0;
  const ldPayloads = [blogPosting, breadcrumb];
  html = html.replace(
    /<script type="application\/ld\+json">[\s\S]*?<\/script>/gi,
    (match) => {
      if (ldIndex >= ldPayloads.length) return match;
      const payload = JSON.stringify(ldPayloads[ldIndex], null, 2);
      ldIndex += 1;
      return `<script type="application/ld+json">\n${payload}\n  </script>`;
    },
  );

  // ── Article hero ──────────────────────────────────────────────────────────
  html = html.replace(
    /(<span class="badge[^"]*"[^>]*style="background:)[^;]*(;color:)[^"]*(")/i,
    (_, a, b, c) => `${a}${badge.bg}${b}${badge.color}${c}`,
  );
  html = html.replace(
    /(<span class="badge[^>]*>)([\s\S]*?)(<\/span>)/i,
    (_, open, __, close) => `${open}${escapeHtml(article.category)}${close}`,
  );
  html = replaceTagContent(html, 'h1', 'class="font-heading', `\n      ${escapeHtml(headline)}\n    `);

  // Publication date in the hero byline.
  html = html.replace(
    /(<div class="flex items-center gap-4 text-white\/40 text-sm">\s*<span>)([^<]*)(<\/span>)/i,
    (_, a, __, c) => `${a}${escapeHtml(article.date)}${c}`,
  );
  html = html.replace(
    /(<span>)\d+(\s*<span data-i18n="blog_min_read">)/i,
    (_, a, b) => `${a}${readMinutes}${b}`,
  );

  // ── Article body ──────────────────────────────────────────────────────────
  //
  // The prose wrapper carries extra utility classes (`prose reveal`), so the
  // class attribute is matched loosely — pinning the exact class string made
  // this break the moment a presentational class was added.
  const bodyHtml = renderMarkdown(article.bodyMarkdown);
  const bodyRegion =
    /(<!-- ARTICLE BODY -->[\s\S]*?<div class="[^"]*\bprose\b[^"]*">)([\s\S]*?)(<\/div>\s*<\/article>)/i;
  if (!bodyRegion.test(html)) {
    throw new Error('Could not locate the article body region in the reference template');
  }

  // Keep the site's closing internal-links paragraph: it is a real internal
  // linking signal and part of the established article shape.
  const closingCta = [
    '    <p class="mt-8 pt-8 border-t border-white/5 text-white/50 text-sm italic">',
    '      Working through this in production? Explore the',
    '      <a href="/#services" class="text-sky-light hover:underline">Cloud &amp; DevOps services</a>',
    '      or read more <a href="/about/" class="text-sky-light hover:underline">about UP2CLOUD</a>.',
    '    </p>',
  ].join('\n');

  html = html.replace(
    bodyRegion,
    (_, open, __, close) => `${open}\n\n${bodyHtml}\n\n${closingCta}\n\n  ${close}`,
  );

  return { html, url, readMinutes, metaTitle, ogImage };
}

module.exports = { renderArticle, loadTemplate, estimateReadMinutes, REFERENCE_POST, BADGE_STYLES };
