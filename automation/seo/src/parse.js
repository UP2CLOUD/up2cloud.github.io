'use strict';

/**
 * HTML head parsing for the SEO auditor.
 *
 * Deliberately *not* a one-big-regex-per-field design. Matching
 * `content="([^"]*)"` breaks the moment a description contains an apostrophe
 * and the pattern allows `'` as a terminator — you get a silently truncated
 * value and a confident, wrong "description too short" finding. An automation
 * that opens PRs off that would file bogus fixes forever.
 *
 * So: find each tag, then parse its attributes properly, honouring the quote
 * character that actually opened the value.
 */

/** Attribute matcher. Double-quoted, single-quoted, and bare forms. */
const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
};

function decodeEntities(value) {
  if (!value) return '';
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => {
      const key = name.toLowerCase();
      return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, key) ? NAMED_ENTITIES[key] : m;
    });
}

/** Parse one tag's attributes into a lowercase-keyed map. */
function parseAttributes(tagHtml) {
  const attrs = {};
  ATTR_RE.lastIndex = 0;
  let m;
  while ((m = ATTR_RE.exec(tagHtml)) !== null) {
    const raw = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] || '';
    attrs[m[1].toLowerCase()] = decodeEntities(raw);
  }
  return attrs;
}

/** Strip comments so commented-out tags are never treated as present. */
function stripComments(html) {
  return html.replace(/<!--[\s\S]*?-->/g, '');
}

/**
 * Strip <script> and <style> bodies before scanning document *content*.
 *
 * Without this, a client-side template like `<a href="/blog/${post.slug}/">`
 * inside a script is scraped as a real link, and the auditor reports a broken
 * internal link for a URL that never existed as markup.
 */
function stripCode(html) {
  return stripComments(html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
}

/** Every <meta> tag as a parsed attribute map. */
function metaTags(html) {
  return (stripComments(html).match(/<meta\b[^>]*>/gi) || []).map(parseAttributes);
}

/** Every <link> tag as a parsed attribute map. */
function linkTags(html) {
  return (stripComments(html).match(/<link\b[^>]*>/gi) || []).map(parseAttributes);
}

/**
 * Look up a meta value by `name`, `property`, or `http-equiv` — whichever the
 * page used. OG tags conventionally use `property`, Twitter uses `name`, and
 * plenty of real pages mix them; treating them as separate namespaces produces
 * phantom "missing tag" findings.
 */
function meta(html, key) {
  const wanted = String(key).toLowerCase();
  for (const attrs of metaTags(html)) {
    const id = (attrs.name || attrs.property || attrs['http-equiv'] || '').toLowerCase();
    if (id === wanted) return (attrs.content || '').trim();
  }
  return null;
}

function linkHref(html, rel) {
  const wanted = String(rel).toLowerCase();
  for (const attrs of linkTags(html)) {
    const rels = (attrs.rel || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (rels.includes(wanted)) return (attrs.href || '').trim();
  }
  return null;
}

/** All hreflang alternates, as {hreflang, href}. */
function alternates(html) {
  return linkTags(html)
    .filter((a) => (a.rel || '').toLowerCase().split(/\s+/).includes('alternate') && a.hreflang)
    .map((a) => ({ hreflang: a.hreflang.trim(), href: (a.href || '').trim() }));
}

function title(html) {
  const m = stripComments(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim() : null;
}

function htmlLang(html) {
  const m = html.match(/<html\b[^>]*>/i);
  return m ? parseAttributes(m[0]).lang || null : null;
}

/** Headings of a given level, text content only. */
function headings(html, level) {
  const re = new RegExp(`<h${level}\\b[^>]*>([\\s\\S]*?)</h${level}>`, 'gi');
  return [...stripCode(html).matchAll(re)].map((m) =>
    decodeEntities(m[1].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim(),
  );
}

/** Parsed JSON-LD blocks. `invalid` counts blocks that failed to parse. */
function jsonLd(html) {
  const blocks = [
    ...stripComments(html).matchAll(
      /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
    ),
  ];
  const parsed = [];
  let invalid = 0;
  for (const b of blocks) {
    try {
      parsed.push(JSON.parse(b[1].trim()));
    } catch {
      invalid += 1;
    }
  }
  return { blocks: parsed, invalid, count: blocks.length };
}

/** <img> tags, for alt-text auditing. */
function images(html) {
  return (stripCode(html).match(/<img\b[^>]*>/gi) || []).map(parseAttributes);
}

/** Internal hrefs (site-relative or same-origin absolute). */
function internalLinks(html, origin) {
  const hrefs = [...stripCode(html).matchAll(/<a\b[^>]*>/gi)]
    .map((m) => parseAttributes(m[0]).href)
    .filter(Boolean);
  return hrefs.filter((h) => h.startsWith('/') || (origin && h.startsWith(origin)));
}

/** Everything a rule might need, parsed once per page. */
function parsePage(html, { origin } = {}) {
  const robots = meta(html, 'robots');
  return {
    title: title(html),
    description: meta(html, 'description'),
    canonical: linkHref(html, 'canonical'),
    robots,
    noindex: /\bnoindex\b/i.test(robots || ''),
    lang: htmlLang(html),
    og: {
      title: meta(html, 'og:title'),
      description: meta(html, 'og:description'),
      image: meta(html, 'og:image'),
      url: meta(html, 'og:url'),
      type: meta(html, 'og:type'),
      siteName: meta(html, 'og:site_name'),
    },
    twitter: {
      card: meta(html, 'twitter:card'),
      title: meta(html, 'twitter:title'),
      description: meta(html, 'twitter:description'),
      image: meta(html, 'twitter:image'),
    },
    viewport: meta(html, 'viewport'),
    charset: /<meta[^>]+charset=/i.test(html),
    h1: headings(html, 1),
    h2: headings(html, 2),
    alternates: alternates(html),
    jsonLd: jsonLd(html),
    images: images(html),
    internalLinks: internalLinks(html, origin),
  };
}

module.exports = {
  parsePage,
  parseAttributes,
  decodeEntities,
  stripComments,
  stripCode,
  meta,
  linkHref,
  alternates,
  title,
  htmlLang,
  headings,
  jsonLd,
  images,
  internalLinks,
  metaTags,
  linkTags,
};
