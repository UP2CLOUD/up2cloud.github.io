'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_TOPICS_PATH = path.join(__dirname, '..', 'config', 'topics.json');
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Topic selection with a hard cooldown.
 *
 * "Don't repeat a primary topic within 45 days" is enforced against two
 * sources, not one: the ledger (what this system published) *and* the existing
 * `blog/posts.json` (what humans published). Reading only the ledger would let
 * the automation immediately re-cover a topic a person wrote about last week.
 *
 * Among eligible domains we pick the least-recently-used, so rotation is
 * deterministic and self-balancing rather than random — which also makes the
 * selection reproducible in tests and reviewable in a PR.
 */

function loadTopics(topicsPath = DEFAULT_TOPICS_PATH) {
  const raw = JSON.parse(fs.readFileSync(topicsPath, 'utf8'));
  if (!Array.isArray(raw.domains) || !raw.domains.length) {
    throw new Error(`Topic config at ${topicsPath} has no domains`);
  }
  for (const d of raw.domains) {
    if (!d.id || !d.label || !d.category) {
      throw new Error(`Topic domain missing id/label/category: ${JSON.stringify(d)}`);
    }
  }
  return raw.domains;
}

/**
 * Map each domain id to the most recent publication date covering it.
 * Historic `posts.json` entries have no topicId, so they are matched by the
 * `category` field they do carry — coarse, but it is the only signal available
 * for human-authored posts and it errs toward *more* cooldown, not less.
 */
function buildLastUsedIndex({ publications = [], legacyPosts = [], domains }) {
  const lastUsed = new Map();

  const note = (id, dateStr) => {
    if (!id || !dateStr) return;
    const t = new Date(dateStr).getTime();
    if (!Number.isFinite(t)) return;
    const prev = lastUsed.get(id);
    if (prev === undefined || t > prev) lastUsed.set(id, t);
  };

  for (const pub of publications) {
    if (pub.status === 'published' || pub.deploymentVerified) {
      note(pub.topicId, pub.publishedAt || pub.createdAt);
    }
  }

  const byCategory = new Map();
  for (const d of domains) {
    if (!byCategory.has(d.category)) byCategory.set(d.category, []);
    byCategory.get(d.category).push(d.id);
  }
  for (const post of legacyPosts) {
    const ids = byCategory.get(post.category) || [];
    for (const id of ids) note(id, post.date);
  }

  return lastUsed;
}

function daysSince(ms, now) {
  return ms === undefined ? Infinity : (now - ms) / DAY_MS;
}

/**
 * Choose the next primary topic.
 *
 * @returns {{domain: object, angle: string, eligible: object[], cooldownDays: number}}
 * @throws if a forced topic is on cooldown or unknown, or if every domain is
 *         on cooldown (which means the cooldown window is misconfigured
 *         relative to the publish interval — worth failing loudly).
 */
function selectTopic({
  domains,
  publications = [],
  legacyPosts = [],
  cooldownDays = 45,
  now = Date.now(),
  forcedTopicId = null,
  rng = Math.random,
} = {}) {
  const lastUsed = buildLastUsedIndex({ publications, legacyPosts, domains });

  const annotated = domains.map((domain) => {
    const last = lastUsed.get(domain.id);
    return {
      domain,
      lastUsedMs: last,
      daysSinceLastUse: daysSince(last, now),
      onCooldown: daysSince(last, now) < cooldownDays,
    };
  });

  if (forcedTopicId) {
    const match = annotated.find((a) => a.domain.id === forcedTopicId);
    if (!match) {
      throw new Error(
        `Forced topic "${forcedTopicId}" is not a known domain. Known: ${domains.map((d) => d.id).join(', ')}`,
      );
    }
    if (match.onCooldown) {
      // A forced topic still respects the cooldown: the cooldown exists to stop
      // duplicate-ish content, and honouring an override here would defeat the
      // duplicate-content quality gate downstream anyway.
      throw new Error(
        `Forced topic "${forcedTopicId}" is on cooldown ` +
          `(last used ${match.daysSinceLastUse.toFixed(1)}d ago, cooldown ${cooldownDays}d)`,
      );
    }
    return {
      domain: match.domain,
      angle: pickAngle(match.domain, publications, rng),
      eligible: annotated.filter((a) => !a.onCooldown).map((a) => a.domain),
      cooldownDays,
      selectionReason: 'forced',
    };
  }

  const eligible = annotated.filter((a) => !a.onCooldown);
  if (!eligible.length) {
    const soonest = annotated.reduce((a, b) => (a.daysSinceLastUse > b.daysSinceLastUse ? a : b));
    throw new Error(
      `Every topic domain is on ${cooldownDays}-day cooldown. ` +
        `Closest to eligible: "${soonest.domain.id}" at ${soonest.daysSinceLastUse.toFixed(1)}d. ` +
        `Reduce TOPIC_COOLDOWN_DAYS or add more domains to config/topics.json.`,
    );
  }

  // Least-recently-used wins; never-used domains (Infinity) sort first.
  eligible.sort((a, b) => {
    if (a.daysSinceLastUse !== b.daysSinceLastUse) return b.daysSinceLastUse - a.daysSinceLastUse;
    return a.domain.id.localeCompare(b.domain.id);
  });

  const chosen = eligible[0];
  return {
    domain: chosen.domain,
    angle: pickAngle(chosen.domain, publications, rng),
    eligible: eligible.map((a) => a.domain),
    cooldownDays,
    selectionReason: 'least_recently_used',
    daysSinceLastUse: chosen.daysSinceLastUse,
  };
}

/** Prefer an angle whose keywords do not already appear in recent titles. */
function pickAngle(domain, publications, rng = Math.random) {
  const angles = Array.isArray(domain.angles) && domain.angles.length ? domain.angles : [domain.label];
  const recentTitles = publications
    .slice(0, 40)
    .map((p) => String(p.title || '').toLowerCase());

  const unused = angles.filter((angle) => {
    const keywords = angle
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 4);
    return !recentTitles.some((t) => keywords.filter((k) => t.includes(k)).length >= 2);
  });

  const pool = unused.length ? unused : angles;
  return pool[Math.floor(rng() * pool.length) % pool.length];
}

function loadLegacyPosts(repoRoot) {
  const file = path.join(repoRoot, 'blog', 'posts.json');
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

module.exports = {
  loadTopics,
  selectTopic,
  buildLastUsedIndex,
  loadLegacyPosts,
  pickAngle,
  DEFAULT_TOPICS_PATH,
  DAY_MS,
};
