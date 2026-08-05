'use strict';

const { assertSafeSlug } = require('../security/paths');

/**
 * LinkedIn post composition + UTM tagging.
 *
 * Structure is fixed by the brief: technical opening → problem → 2–4 takeaways
 * → article URL → at most 3 hashtags. Composition is deterministic string
 * assembly from already-reviewed article metadata rather than a second model
 * call, so the promoted copy cannot drift from the article that passed the
 * quality gates.
 */

const MAX_HASHTAGS = 3;
const MAX_COMMENTARY_LENGTH = 2900; // LinkedIn hard limit is 3000

/** Build the tracked URL. Slug is re-validated: it lands in a public link. */
function buildTrackedUrl({ siteBaseUrl, slug, utm }) {
  assertSafeSlug(slug);
  const url = new URL(`${siteBaseUrl.replace(/\/+$/, '')}/blog/${slug}/`);
  url.searchParams.set('utm_source', utm.source);
  url.searchParams.set('utm_medium', utm.medium);
  url.searchParams.set('utm_campaign', utm.campaign);
  url.searchParams.set('utm_content', slug);
  return url.toString();
}

/** `Platform Engineering` → `#PlatformEngineering`. */
function toHashtag(label) {
  const cleaned = String(label || '')
    .replace(/[^A-Za-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join('');
  return cleaned ? `#${cleaned}` : null;
}

function normaliseTakeaways(takeaways) {
  const list = (Array.isArray(takeaways) ? takeaways : [])
    .map((t) => String(t || '').trim().replace(/^[-•*]\s*/, ''))
    .filter(Boolean);
  if (list.length < 2) {
    throw new Error(`LinkedIn post needs at least 2 takeaways, got ${list.length}`);
  }
  return list.slice(0, 4);
}

/**
 * @param {object} article  { title, slug, opening, problem, takeaways, hashtags, topicLabel }
 * @returns {{commentary: string, url: string, hashtags: string[]}}
 */
function composeLinkedInPost(article, { siteBaseUrl, utm }) {
  const url = buildTrackedUrl({ siteBaseUrl, slug: article.slug, utm });

  const opening = String(article.opening || '').trim();
  const problem = String(article.problem || '').trim();
  if (!opening) throw new Error('LinkedIn post requires a technical opening line');
  if (!problem) throw new Error('LinkedIn post requires a problem statement');

  const takeaways = normaliseTakeaways(article.takeaways);

  const rawTags = Array.isArray(article.hashtags) && article.hashtags.length
    ? article.hashtags
    : [article.topicLabel, 'CloudEngineering'].filter(Boolean);

  const hashtags = [...new Set(rawTags.map(toHashtag).filter(Boolean))].slice(0, MAX_HASHTAGS);

  const body = [
    opening,
    '',
    problem,
    '',
    ...takeaways.map((t) => `→ ${t}`),
    '',
    `Full article: ${url}`,
    '',
    hashtags.join(' '),
  ]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (body.length > MAX_COMMENTARY_LENGTH) {
    // Trim takeaways rather than truncating mid-sentence, so the post always
    // ends with the URL and hashtags intact.
    const trimmed = [
      opening,
      '',
      problem,
      '',
      ...takeaways.slice(0, 2).map((t) => `→ ${t}`),
      '',
      `Full article: ${url}`,
      '',
      hashtags.join(' '),
    ]
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return { commentary: trimmed.slice(0, MAX_COMMENTARY_LENGTH), url, hashtags, trimmed: true };
  }

  return { commentary: body, url, hashtags, trimmed: false };
}

/** Structural assertions used by tests and by the pipeline before posting. */
function validateComposedPost({ commentary, url, hashtags }) {
  const problems = [];
  if (!commentary || commentary.length < 80) problems.push('Commentary is too short');
  if (commentary && commentary.length > 3000) problems.push('Commentary exceeds LinkedIn 3000-char limit');
  if (!commentary?.includes(url)) problems.push('Commentary does not contain the article URL');
  if (hashtags.length > MAX_HASHTAGS) problems.push(`More than ${MAX_HASHTAGS} hashtags`);
  const arrows = (commentary?.match(/^→ /gm) || []).length;
  if (arrows < 2 || arrows > 4) problems.push(`Expected 2–4 takeaways, found ${arrows}`);
  for (const key of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content']) {
    if (!url.includes(`${key}=`)) problems.push(`URL missing ${key}`);
  }
  return problems;
}

module.exports = {
  composeLinkedInPost,
  buildTrackedUrl,
  validateComposedPost,
  toHashtag,
  MAX_HASHTAGS,
  MAX_COMMENTARY_LENGTH,
};
