'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { renderArticle } = require('../src/publish/render');
const { renderMarkdown, markdownToText } = require('../src/publish/markdown');
const { upsertPostEntry, upsertSitemapEntry, upsertBlogIndexCard, readPosts } = require('../src/publish/site-index');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

const article = {
  slug: 'test-generated-article',
  title: 'Progressive Delivery with Argo Rollouts',
  metaTitle: 'Progressive Delivery with Argo Rollouts — UP2CLOUD',
  excerpt:
    'How to run canary and blue/green releases on Kubernetes with Argo Rollouts, including analysis templates and safe rollback behaviour.',
  category: 'Cloud',
  badgeClass: 'badge-sky',
  date: '2026-08-10',
  keywords: ['Argo Rollouts', 'Kubernetes', 'canary'],
  bodyMarkdown: [
    '## Why canary releases need an abort condition',
    '',
    'A canary that cannot roll itself back is just a slower outage. See the',
    '[Argo Rollouts docs](https://argo-cd.readthedocs.io/) for detail.',
    '',
    '```yaml',
    'apiVersion: argoproj.io/v1alpha1',
    'kind: Rollout',
    'spec:',
    '  replicas: 5',
    '```',
    '',
    '- First point',
    '- Second point',
    '',
    'Use `kubectl argo rollouts get rollout` to inspect **live** state.',
  ].join('\n'),
};

// ── Markdown ──────────────────────────────────────────────────────────────

test('markdown renders the constructs the .prose CSS styles', () => {
  const html = renderMarkdown(article.bodyMarkdown);
  assert.match(html, /<h2>Why canary releases need an abort condition<\/h2>/);
  assert.match(html, /<pre><code class="language-yaml">/);
  assert.match(html, /<ul><li>First point<\/li><li>Second point<\/li><\/ul>/);
  assert.match(html, /<code>kubectl argo rollouts get rollout<\/code>/);
  assert.match(html, /<strong>live<\/strong>/);
  assert.match(html, /<a href="https:\/\/argo-cd\.readthedocs\.io\/"[^>]*>Argo Rollouts docs<\/a>/);
});

test('external links get noopener/nofollow, internal links do not', () => {
  const html = renderMarkdown('[ext](https://example.com/x) and [int](https://up2cloud.tech/blog/y/)');
  assert.match(html, /href="https:\/\/example\.com\/x"[^>]*rel="noopener noreferrer nofollow"/);
  const internal = html.match(/href="https:\/\/up2cloud\.tech\/blog\/y\/"[^>]*>/)[0];
  assert.equal(internal.includes('nofollow'), false);
});

test('raw HTML in model output cannot become live markup', () => {
  const html = renderMarkdown('Text <script>alert(1)</script> and <img src=x onerror=alert(2)>');
  // The payload may still appear as inert escaped *text* (` onerror=` inside
  // `&lt;img …&gt;` is harmless); what must never happen is it becoming a tag.
  assert.equal(/<script/i.test(html), false);
  assert.equal(/<img/i.test(html), false);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;img/);

  // The only tags present must be ones the renderer itself emits.
  const tags = [...html.matchAll(/<\/?([a-z][a-z0-9]*)/gi)].map((m) => m[1].toLowerCase());
  const allowed = new Set(['p', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'pre', 'code', 'strong', 'em', 'a', 'blockquote']);
  for (const tag of tags) {
    assert.ok(allowed.has(tag), `unexpected tag emitted: <${tag}>`);
  }
});

test('javascript: and data: links are stripped, not rendered', () => {
  const html = renderMarkdown('[click](javascript:alert(1)) [d](data:text/html,<script>x</script>)');
  assert.equal(html.includes('javascript:'), false);
  assert.equal(/href="data:/.test(html), false);
});

test('markdownToText strips code and markup for word counting', () => {
  const text = markdownToText('## Head\n\n```js\nlots of code\n```\n\nSome **bold** [link](https://x.com).');
  assert.equal(text.includes('lots of code'), false);
  assert.ok(text.includes('Some bold link.'));
});

// ── Article rendering against the real site template ──────────────────────

test('renders a complete article page from the live reference post', () => {
  const { html, url } = renderArticle(article, { repoRoot: REPO_ROOT });

  assert.equal(url, 'https://up2cloud.tech/blog/test-generated-article/');
  assert.match(html, /<title>Progressive Delivery with Argo Rollouts — UP2CLOUD<\/title>/);
  assert.match(html, /<link rel="canonical" href="https:\/\/up2cloud\.tech\/blog\/test-generated-article\/"/);
  assert.match(html, /property="og:url" content="https:\/\/up2cloud\.tech\/blog\/test-generated-article\/"/);
  assert.match(html, /property="article:published_time" content="2026-08-10"/);
  assert.match(html, /<h2>Why canary releases need an abort condition<\/h2>/);
});

test('generated page keeps the shared site chrome intact', () => {
  const { html } = renderArticle(article, { repoRoot: REPO_ROOT });
  // These come from the cloned template and must survive substitution — this is
  // the whole reason the renderer clones instead of carrying its own copy.
  assert.match(html, /<!-- include: _includes\/favicon\.html -->/);
  assert.match(html, /data-i18n="blog_nav_blog"/);
  assert.match(html, /id="article-lang-picker"/);
  assert.match(html, /blog-engagement\.js/);
  assert.match(html, /googletagmanager\.com\/gtag\/js/);
});

test('JSON-LD is rewritten, valid, and points at the new article', () => {
  const { html } = renderArticle(article, { repoRoot: REPO_ROOT });
  const blocks = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g);
  assert.ok(blocks && blocks.length >= 2, 'expected BlogPosting + BreadcrumbList');

  const parsed = blocks.map((b) =>
    JSON.parse(b.replace(/^<script type="application\/ld\+json">/, '').replace(/<\/script>$/, '')),
  );
  const posting = parsed.find((p) => p['@type'] === 'BlogPosting');
  assert.equal(posting.headline, article.title);
  assert.equal(posting.datePublished, article.date);
  assert.equal(posting.mainEntityOfPage['@id'], 'https://up2cloud.tech/blog/test-generated-article/');

  const crumbs = parsed.find((p) => p['@type'] === 'BreadcrumbList');
  assert.equal(crumbs.itemListElement.at(-1).item, 'https://up2cloud.tech/blog/test-generated-article/');
});

test('a traversal slug is refused by the renderer', () => {
  assert.throws(() => renderArticle({ ...article, slug: '../evil' }, { repoRoot: REPO_ROOT }), /Slug/);
});

test('missing required fields are refused', () => {
  assert.throws(() => renderArticle({ ...article, excerpt: '' }, { repoRoot: REPO_ROOT }), /excerpt/);
});

// ── Site index updates ────────────────────────────────────────────────────

function sandboxRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopub-site-'));
  fs.mkdirSync(path.join(dir, 'blog'), { recursive: true });
  fs.copyFileSync(path.join(REPO_ROOT, 'blog', 'posts.json'), path.join(dir, 'blog', 'posts.json'));
  fs.copyFileSync(path.join(REPO_ROOT, 'blog', 'index.html'), path.join(dir, 'blog', 'index.html'));
  fs.copyFileSync(path.join(REPO_ROOT, 'sitemap.xml'), path.join(dir, 'sitemap.xml'));
  return dir;
}

test('posts.json gains the entry and only one post stays featured', () => {
  const repo = sandboxRepo();
  const before = readPosts(repo).length;
  upsertPostEntry(repo, article, { featured: true });

  const after = readPosts(repo);
  assert.equal(after.length, before + 1);
  assert.equal(after[0].slug, article.slug);
  assert.equal(after.filter((p) => p.featured).length, 1, 'exactly one featured post');
});

test('re-running the publish step does not duplicate the posts.json entry', () => {
  const repo = sandboxRepo();
  upsertPostEntry(repo, article, { featured: true });
  const first = readPosts(repo).length;
  upsertPostEntry(repo, article, { featured: true });
  assert.equal(readPosts(repo).length, first, 'idempotent on retry');
});

test('sitemap gains the URL once and refreshes lastmod on retry', () => {
  const repo = sandboxRepo();
  const url = 'https://up2cloud.tech/blog/test-generated-article/';

  upsertSitemapEntry(repo, { url, lastmod: '2026-08-10', blogIndexUrl: 'https://up2cloud.tech/blog/' });
  let xml = fs.readFileSync(path.join(repo, 'sitemap.xml'), 'utf8');
  assert.equal((xml.match(new RegExp(url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length, 1);
  assert.match(xml, /<loc>https:\/\/up2cloud\.tech\/blog\/<\/loc>\s*<lastmod>2026-08-10<\/lastmod>/);

  upsertSitemapEntry(repo, { url, lastmod: '2026-08-11', blogIndexUrl: 'https://up2cloud.tech/blog/' });
  xml = fs.readFileSync(path.join(repo, 'sitemap.xml'), 'utf8');
  assert.equal((xml.match(new RegExp(url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length, 1);
  assert.match(xml, /2026-08-11/);
  assert.doesNotThrow(() => xml.includes('</urlset>'));
});

test('blog index gains a card so the article is not orphaned', () => {
  const repo = sandboxRepo();
  const r = upsertBlogIndexCard(repo, article);
  assert.equal(r.inserted, true);

  const html = fs.readFileSync(path.join(repo, 'blog', 'index.html'), 'utf8');
  assert.ok(html.includes(`href="/blog/${article.slug}/"`));
  assert.ok(html.includes(article.title));
  assert.ok(html.includes('August 10, 2026'));

  // Idempotent: a resumed run must not add a second card.
  const again = upsertBlogIndexCard(repo, article);
  assert.equal(again.inserted, false);
  const html2 = fs.readFileSync(path.join(repo, 'blog', 'index.html'), 'utf8');
  assert.equal((html2.match(new RegExp(`href="/blog/${article.slug}/"`, 'g')) || []).length, 1);
});

test('card content is HTML-escaped', () => {
  const repo = sandboxRepo();
  upsertBlogIndexCard(repo, { ...article, title: 'A <script>alert(1)</script> title' });
  const html = fs.readFileSync(path.join(repo, 'blog', 'index.html'), 'utf8');
  assert.equal(html.includes('<script>alert(1)</script>'), false);
  assert.ok(html.includes('&lt;script&gt;'));
});
