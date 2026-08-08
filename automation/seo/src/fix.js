'use strict';

const { linkTags, metaTags, stripComments } = require('./parse');

/**
 * Applies mechanical fixes to page HTML.
 *
 * Two rules govern everything here:
 *
 * 1. **Never reformat what you did not come to change.** These files are
 *    hand-maintained; a fixer that normalises quoting or re-indents produces a
 *    500-line diff for a one-tag change and nobody reviews it properly. Every
 *    edit is a surgical splice.
 * 2. **Idempotent.** The weekly run re-reads its own output. If applying a fix
 *    twice produced two tags, the head would grow without bound.
 */

/** Escape a value for use inside a double-quoted HTML attribute. */
function escapeAttr(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Indentation of the line a match sits on, so inserted tags line up. */
function indentAt(html, index) {
  const lineStart = html.lastIndexOf('\n', index) + 1;
  const m = html.slice(lineStart, index).match(/^[ \t]*/);
  return m ? m[0] : '  ';
}

/**
 * Character ranges inside <head> that a new tag must never be placed within.
 *
 * `<noscript>` is the one that bites: the last <link> in a head is very often
 * the no-JS font fallback, and anchoring to it splices the new tag *inside*
 * the noscript element — where crawlers that run JS never see it, and where it
 * corrupts the surrounding markup. `<template>` and `<script>` are inert for
 * the same reason.
 */
function forbiddenRanges(html) {
  const ranges = [];
  for (const re of [
    /<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi,
    /<template\b[^>]*>[\s\S]*?<\/template>/gi,
    /<script\b[^>]*>[\s\S]*?<\/script>/gi,
    /<!--[\s\S]*?-->/g,
  ]) {
    for (const m of html.matchAll(re)) ranges.push([m.index, m.index + m[0].length]);
  }
  return ranges;
}

const inAnyRange = (index, ranges) => ranges.some(([a, b]) => index >= a && index < b);

/**
 * Insert a tag into <head>, after the last top-level <meta>/<link>/<title> so
 * related tags stay grouped rather than landing at a random offset.
 */
function insertIntoHead(html, tag) {
  const headMatch = html.match(/<head\b[^>]*>/i);
  if (!headMatch) return null;

  const headStart = headMatch.index + headMatch[0].length;
  const headEndIdx = html.search(/<\/head>/i);
  if (headEndIdx === -1 || headEndIdx < headStart) return null;

  const ranges = forbiddenRanges(html);
  const headHtml = html.slice(headStart, headEndIdx);

  const anchors = [...headHtml.matchAll(/<(?:meta|link|title)\b[^>]*>(?:[\s\S]*?<\/title>)?/gi)]
    .map((m) => ({ start: headStart + m.index, end: headStart + m.index + m[0].length }))
    .filter((a) => !inAnyRange(a.start, ranges));

  if (anchors.length) {
    const last = anchors[anchors.length - 1];
    return `${html.slice(0, last.end)}\n${indentAt(html, last.start)}${tag}${html.slice(last.end)}`;
  }
  return `${html.slice(0, headStart)}\n  ${tag}${html.slice(headStart)}`;
}

/** Does a meta tag with this name/property already exist? */
function hasMeta(html, name) {
  const wanted = String(name).toLowerCase();
  return metaTags(html).some(
    (a) => (a.name || a.property || '').toLowerCase() === wanted,
  );
}

function hasLink(html, rel) {
  const wanted = String(rel).toLowerCase();
  return linkTags(html).some((a) =>
    (a.rel || '').toLowerCase().split(/\s+/).includes(wanted),
  );
}

/** Add or update a <meta> tag. */
function applyMetaFix(html, { attr, name, value }) {
  const tag = `<meta ${attr}="${escapeAttr(name)}" content="${escapeAttr(value)}" />`;

  if (hasMeta(html, name)) {
    // Rewrite in place, preserving surrounding formatting.
    const re = new RegExp(
      `<meta\\b(?=[^>]*\\b(?:name|property)=("|')${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\1)[^>]*>`,
      'i',
    );
    if (!re.test(html)) return null;
    return html.replace(re, tag);
  }
  return insertIntoHead(html, tag);
}

/** Add or correct <link rel="canonical">. */
function applyCanonicalFix(html, { value }) {
  const tag = `<link rel="canonical" href="${escapeAttr(value)}" />`;
  if (hasLink(html, 'canonical')) {
    const re = /<link\b(?=[^>]*\brel=("|')canonical\1)[^>]*>/i;
    if (!re.test(html)) return null;
    return html.replace(re, tag);
  }
  return insertIntoHead(html, tag);
}

/**
 * Apply every fix for one file. Returns `{ html, applied[], skipped[] }`.
 * A fix that cannot be applied cleanly is skipped and reported, never forced.
 */
function applyFixes(html, fixes) {
  let current = html;
  const applied = [];
  const skipped = [];

  for (const fix of fixes) {
    let next = null;
    if (fix.kind === 'meta') next = applyMetaFix(current, fix);
    else if (fix.kind === 'canonical') next = applyCanonicalFix(current, fix);
    else if (fix.kind === 'sitemap') {
      // Handled at the site level, not inside the page.
      continue;
    }

    if (next === null || next === current) {
      skipped.push({ ...fix, reason: next === null ? 'could not splice safely' : 'no change' });
      continue;
    }
    current = next;
    applied.push(fix);
  }

  return { html: current, applied, skipped };
}

/**
 * Add a URL to sitemap.xml if absent, keeping existing formatting.
 * Returns the new XML, or null when it was already present.
 */
function addToSitemap(xml, url, lastmod) {
  if (xml.includes(`<loc>${url}</loc>`)) return null;

  const entry = [
    '  <url>',
    `    <loc>${url}</loc>`,
    `    <lastmod>${lastmod}</lastmod>`,
    '    <changefreq>monthly</changefreq>',
    '    <priority>0.6</priority>',
    '  </url>',
  ].join('\n');

  const close = xml.lastIndexOf('</urlset>');
  if (close === -1) return null;
  return `${xml.slice(0, close)}${entry}\n${xml.slice(close)}`;
}

/** Refresh <lastmod> for a URL already in the sitemap. */
function touchSitemapLastmod(xml, url, lastmod) {
  const re = new RegExp(
    `(<loc>${url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</loc>\\s*<lastmod>)([^<]*)(</lastmod>)`,
  );
  if (!re.test(xml)) return null;
  const updated = xml.replace(re, `$1${lastmod}$3`);
  return updated === xml ? null : updated;
}

module.exports = {
  applyFixes,
  applyMetaFix,
  applyCanonicalFix,
  insertIntoHead,
  addToSitemap,
  touchSitemapLastmod,
  escapeAttr,
  hasMeta,
  hasLink,
  stripComments,
};
