'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { safeWriteFile, assertSafeSlug } = require('../security/paths');

/**
 * Site index updates: `blog/posts.json` and `sitemap.xml`.
 *
 * Both are read-modify-write on files that humans also edit, so every function
 * here is idempotent — re-running after a partially-completed publish updates
 * the existing entry instead of appending a duplicate. That matters because
 * stage resume can re-enter `publish_blog` after a crash.
 *
 * `posts.json` is also what `newsletter-notify.yml` watches, so appending here
 * is what triggers the existing subscriber email. We must not reorder unrelated
 * entries, or that workflow would misdetect old posts as new.
 */

function readPosts(repoRoot) {
  const file = path.join(repoRoot, 'blog', 'posts.json');
  if (!fs.existsSync(file)) return [];
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  return Array.isArray(parsed) ? parsed : [];
}

/**
 * Insert or update the post entry. New posts go to the *front* (the blog index
 * sorts by date but the featured flag reads position), and any previously
 * featured post is demoted so exactly one stays featured.
 */
function upsertPostEntry(repoRoot, entry, { featured = true } = {}) {
  assertSafeSlug(entry.slug);
  const posts = readPosts(repoRoot);

  const record = {
    slug: entry.slug,
    title: entry.title,
    excerpt: entry.excerpt,
    date: entry.date,
    category: entry.category,
    badgeClass: entry.badgeClass,
    ...(featured ? { featured: true } : {}),
  };

  const existingIndex = posts.findIndex((p) => p.slug === entry.slug);
  let next;
  if (existingIndex >= 0) {
    next = [...posts];
    next[existingIndex] = { ...posts[existingIndex], ...record };
  } else {
    next = [record, ...posts];
  }

  if (featured) {
    next = next.map((p, i) =>
      i === (existingIndex >= 0 ? existingIndex : 0) ? p : { ...p, featured: undefined },
    );
    // Drop the key entirely rather than emitting `"featured": undefined`.
    next = next.map((p) => {
      const copy = { ...p };
      if (copy.featured === undefined) delete copy.featured;
      return copy;
    });
  }

  safeWriteFile(repoRoot, 'blog/posts.json', `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

/**
 * Add the article URL to sitemap.xml, and refresh the `lastmod` on the blog
 * index (its content genuinely changed). Idempotent by `<loc>`.
 */
function upsertSitemapEntry(repoRoot, { url, lastmod, blogIndexUrl }) {
  const file = path.join(repoRoot, 'sitemap.xml');
  if (!fs.existsSync(file)) throw new Error(`sitemap.xml not found at ${file}`);
  let xml = fs.readFileSync(file, 'utf8');

  if (xml.includes(`<loc>${url}</loc>`)) {
    // Already listed — just refresh its lastmod.
    xml = xml.replace(
      new RegExp(`(<url>\\s*<loc>${escapeRe(url)}</loc>\\s*<lastmod>)([^<]*)(</lastmod>)`),
      (_, a, __, c) => `${a}${lastmod}${c}`,
    );
  } else {
    const block = [
      '  <url>',
      `    <loc>${url}</loc>`,
      `    <lastmod>${lastmod}</lastmod>`,
      '    <changefreq>monthly</changefreq>',
      '    <priority>0.7</priority>',
      '  </url>',
      '</urlset>',
    ].join('\n');
    if (!xml.includes('</urlset>')) throw new Error('sitemap.xml has no closing </urlset>');
    xml = xml.replace('</urlset>', block);
  }

  if (blogIndexUrl) {
    xml = xml.replace(
      new RegExp(`(<url>\\s*<loc>${escapeRe(blogIndexUrl)}</loc>\\s*<lastmod>)([^<]*)(</lastmod>)`),
      (_, a, __, c) => `${a}${lastmod}${c}`,
    );
  }

  safeWriteFile(repoRoot, 'sitemap.xml', xml);
  return xml;
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const BADGE_INLINE = {
  'badge-green': 'background:rgba(5,150,105,.18);color:#34D399',
  'badge-sky': 'background:rgba(3,105,161,.18);color:#38BDF8',
  'badge-purple': 'background:rgba(124,58,237,.18);color:#A78BFA',
  'badge-orange': 'background:rgba(234,88,12,.18);color:#FB923C',
};

function formatCardDate(isoDate) {
  const [y, m, d] = String(isoDate).split('-').map(Number);
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  return `${months[m - 1]} ${d}, ${y}`;
}

function escapeHtmlText(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Insert the article card into the blog index grid.
 *
 * The grid in `blog/index.html` is hand-written HTML, not rendered from
 * posts.json — verified against the live file, since assuming otherwise would
 * have published articles that never appear on /blog/ and would then fail the
 * `internal_links` deployment check. New cards are prepended so the newest
 * article leads the grid, matching how the existing cards are ordered.
 */
function upsertBlogIndexCard(repoRoot, entry) {
  assertSafeSlug(entry.slug);
  const file = path.join(repoRoot, 'blog', 'index.html');
  if (!fs.existsSync(file)) throw new Error('blog/index.html not found');
  let html = fs.readFileSync(file, 'utf8');

  const href = `/blog/${entry.slug}/`;
  if (html.includes(`href="${href}"`)) return { html, inserted: false };

  const badgeClass = BADGE_INLINE[entry.badgeClass] ? entry.badgeClass : 'badge-sky';
  const cardExcerpt = entry.cardExcerpt || entry.excerpt;

  const card = [
    '',
    `      <!-- Article: ${escapeHtmlText(entry.title)} -->`,
    `      <a href="${href}" class="block group card-hover reveal">`,
    '        <div class="glass rounded-2xl p-6 h-full flex flex-col">',
    '          <div class="flex items-center gap-2 mb-4">',
    `            <span class="badge ${badgeClass}" style="font-size:.72rem;${BADGE_INLINE[badgeClass]}">${escapeHtmlText(entry.category)}</span>`,
    '          </div>',
    `          <h3 class="font-heading font-bold text-xl text-white mb-3 group-hover:text-sky-300 transition-colors leading-tight">${escapeHtmlText(entry.title)}</h3>`,
    `          <p class="text-white/50 text-sm leading-relaxed mb-6 flex-grow">${escapeHtmlText(cardExcerpt)}</p>`,
    '          <div class="flex items-center justify-between pt-4 border-t border-white/5">',
    `            <span class="text-white/30 text-xs">${formatCardDate(entry.date)}</span>`,
    '            <span class="text-sky-light text-xs font-semibold group-hover:underline">Read post &rarr;</span>',
    '          </div>',
    '        </div>',
    '      </a>',
    '',
  ].join('\n');

  const gridMarker = '<div class="grid md:grid-cols-2 lg:grid-cols-3 gap-6">';
  const idx = html.indexOf(gridMarker);
  if (idx === -1) {
    throw new Error(
      'Could not find the article grid in blog/index.html — its markup changed. ' +
        'Update upsertBlogIndexCard() in automation/publishing/src/publish/site-index.js.',
    );
  }
  const insertAt = idx + gridMarker.length;
  html = html.slice(0, insertAt) + card + html.slice(insertAt);

  safeWriteFile(repoRoot, 'blog/index.html', html);
  return { html, inserted: true };
}

module.exports = {
  readPosts,
  upsertPostEntry,
  upsertSitemapEntry,
  upsertBlogIndexCard,
  formatCardDate,
  BADGE_INLINE,
};
