'use strict';

const { safeFetch } = require('../security/url-guard');

/**
 * Post-deploy verification.
 *
 * This is the gate that stands between "we committed a file" and "we told the
 * world about it on LinkedIn". A LinkedIn post pointing at a 404 — or at a page
 * that deployed with `noindex`, or without its OG image — is worse than no post
 * at all, because it is public and permanent.
 *
 * Every check returns a structured result; `verifyDeployment()` fails closed:
 * anything it could not positively confirm counts as a failure.
 */

function extract(html, regex) {
  const m = html.match(regex);
  return m ? m[1].trim() : null;
}

function metaContent(html, attr, name) {
  // Attribute order varies, so try content-last and content-first forms.
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return (
    extract(html, new RegExp(`<meta[^>]+${attr}=["']${escaped}["'][^>]*content=["']([^"']*)["']`, 'i')) ||
    extract(html, new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*${attr}=["']${escaped}["']`, 'i'))
  );
}

function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'");
}

/**
 * @param {object} article  { slug, title, canonicalUrl, ogImage }
 * @returns {{ok: boolean, checks: object[], failures: object[]}}
 */
async function verifyDeployment(article, options = {}) {
  const {
    siteBaseUrl = 'https://up2cloud.tech',
    fetchImpl,
    resolver,
    retries = 6,
    retryDelayMs = 15_000,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = options;

  const url = article.canonicalUrl || `${siteBaseUrl}/blog/${article.slug}/`;
  const checks = [];
  const record = (name, ok, detail, extra = {}) => {
    checks.push({ name, ok, detail, ...extra });
    return ok;
  };

  // A CDN needs a moment after merge; poll rather than fail on the first 404.
  let page = null;
  let lastStatus = null;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const res = await safeFetch(url, { fetchImpl, resolver, timeoutMs: 20_000 });
      lastStatus = res.status;
      if (res.status === 200) {
        page = res;
        break;
      }
    } catch (err) {
      lastStatus = err.message;
    }
    if (attempt < retries - 1) await sleep(retryDelayMs);
  }

  if (!page) {
    record('http_200', false, `Article URL never returned 200 (last: ${lastStatus})`, { url });
    return { ok: false, url, checks, failures: checks.filter((c) => !c.ok) };
  }
  record('http_200', true, `HTTP 200 from ${url}`, { url });

  const html = page.body;

  const title = decodeEntities(extract(html, /<title>([\s\S]*?)<\/title>/i) || '');
  const expectedTitle = String(article.title || '').trim();
  record(
    'title',
    Boolean(title) && (!expectedTitle || title.includes(expectedTitle.slice(0, 30))),
    `Found <title>: "${title}"`,
    { expected: expectedTitle, actual: title },
  );

  const canonical = extract(html, /<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["']/i);
  record(
    'canonical',
    canonical === url,
    canonical ? `Canonical is "${canonical}"` : 'No canonical link found',
    { expected: url, actual: canonical },
  );

  const ogTitle = metaContent(html, 'property', 'og:title');
  const ogUrl = metaContent(html, 'property', 'og:url');
  const ogDescription = metaContent(html, 'property', 'og:description');
  const ogImage = metaContent(html, 'property', 'og:image');
  record(
    'open_graph',
    Boolean(ogTitle && ogUrl && ogDescription && ogImage),
    `og:title=${Boolean(ogTitle)} og:url=${Boolean(ogUrl)} og:description=${Boolean(ogDescription)} og:image=${Boolean(ogImage)}`,
    { ogTitle, ogUrl, ogDescription, ogImage },
  );

  // The OG image must actually load — LinkedIn will scrape it.
  if (ogImage) {
    try {
      const abs = new URL(ogImage, url).toString();
      const img = await safeFetch(abs, { fetchImpl, resolver, timeoutMs: 20_000, maxBytes: 8_000_000 });
      record(
        'og_image_reachable',
        img.status === 200 && /^image\//i.test(img.contentType),
        `og:image ${abs} → HTTP ${img.status} (${img.contentType})`,
        { url: abs },
      );
    } catch (err) {
      record('og_image_reachable', false, `og:image fetch failed: ${err.message}`, { url: ogImage });
    }
  } else {
    record('og_image_reachable', false, 'No og:image to verify');
  }

  const robots = (metaContent(html, 'name', 'robots') || '').toLowerCase();
  record(
    'indexable',
    !robots.includes('noindex'),
    robots ? `meta robots="${robots}"` : 'No meta robots (indexable by default)',
    { robots },
  );

  const hasJsonLd = /<script[^>]+type=["']application\/ld\+json["'][^>]*>/i.test(html);
  let jsonLdValid = false;
  if (hasJsonLd) {
    jsonLdValid = true;
    const blocks = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
    for (const block of blocks) {
      const inner = block.replace(/^[\s\S]*?>/, '').replace(/<\/script>$/i, '');
      try {
        JSON.parse(inner);
      } catch {
        jsonLdValid = false;
      }
    }
  }
  record('structured_data', hasJsonLd && jsonLdValid, hasJsonLd ? `JSON-LD present, valid=${jsonLdValid}` : 'No JSON-LD found');

  // Sitemap inclusion — the article must be discoverable, not just reachable.
  try {
    const sitemap = await safeFetch(`${siteBaseUrl}/sitemap.xml`, { fetchImpl, resolver, timeoutMs: 20_000 });
    record(
      'sitemap',
      sitemap.status === 200 && sitemap.body.includes(url),
      sitemap.status === 200
        ? `sitemap.xml ${sitemap.body.includes(url) ? 'includes' : 'does NOT include'} ${url}`
        : `sitemap.xml returned HTTP ${sitemap.status}`,
    );
  } catch (err) {
    record('sitemap', false, `sitemap.xml fetch failed: ${err.message}`);
  }

  // Blog index linkage keeps the post from being an orphan page.
  try {
    const index = await safeFetch(`${siteBaseUrl}/blog/`, { fetchImpl, resolver, timeoutMs: 20_000 });
    const linked = index.body.includes(`/blog/${article.slug}/`);
    record('internal_links', linked, linked ? 'Linked from /blog/' : 'Not linked from /blog/ index');
  } catch (err) {
    record('internal_links', false, `blog index fetch failed: ${err.message}`);
  }

  const failures = checks.filter((c) => !c.ok);
  return { ok: failures.length === 0, url, checks, failures, html };
}

module.exports = { verifyDeployment, metaContent, decodeEntities };
