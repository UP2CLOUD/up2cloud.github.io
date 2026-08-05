'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { selectTopic, loadTopics, buildLastUsedIndex, DAY_MS } = require('../src/topics');

const NOW = Date.parse('2026-08-10T09:00:00Z');
const domains = loadTopics();

function daysAgo(n) {
  return new Date(NOW - n * DAY_MS).toISOString();
}

test('config exposes all nine required rotation domains', () => {
  const ids = domains.map((d) => d.id);
  for (const expected of [
    'platform-engineering',
    'devsecops',
    'finops',
    'cloud-platforms',
    'terraform-iac',
    'kubernetes-gitops',
    'cicd',
    'sre-observability',
    'ai-assisted-ops',
  ]) {
    assert.ok(ids.includes(expected), `missing rotation domain "${expected}"`);
  }
});

test('never repeats a primary topic within the cooldown window', () => {
  const publications = [
    { topicId: 'finops', publishedAt: daysAgo(10), status: 'published', title: 'x' },
  ];
  const r = selectTopic({ domains, publications, cooldownDays: 45, now: NOW });
  assert.notEqual(r.domain.id, 'finops');
  assert.ok(!r.eligible.some((d) => d.id === 'finops'));
});

test('a topic becomes eligible again once past the cooldown', () => {
  const publications = domains
    .filter((d) => d.id !== 'finops')
    .map((d) => ({ topicId: d.id, publishedAt: daysAgo(5), status: 'published', title: 'x' }));
  publications.push({ topicId: 'finops', publishedAt: daysAgo(46), status: 'published', title: 'x' });

  const r = selectTopic({ domains, publications, cooldownDays: 45, now: NOW });
  assert.equal(r.domain.id, 'finops', 'the only off-cooldown topic must be chosen');
});

test('human-authored posts.json entries also enforce the cooldown', () => {
  // A person published a FinOps post 3 days ago; automation must not pick FinOps.
  const legacyPosts = [{ slug: 'x', title: 'FinOps thing', category: 'FinOps', date: daysAgo(3) }];
  const r = selectTopic({ domains, publications: [], legacyPosts, cooldownDays: 45, now: NOW });
  assert.notEqual(r.domain.category, 'FinOps');
});

test('selection is least-recently-used, so rotation is deterministic', () => {
  const publications = domains.map((d, i) => ({
    topicId: d.id,
    // Everything off cooldown, but with different ages.
    publishedAt: daysAgo(50 + i),
    status: 'published',
    title: 'x',
  }));
  const r = selectTopic({ domains, publications, cooldownDays: 45, now: NOW });
  // The oldest is the last domain in the list (largest daysAgo).
  assert.equal(r.domain.id, domains[domains.length - 1].id);
  assert.equal(r.selectionReason, 'least_recently_used');
});

test('never-used domains are preferred over previously used ones', () => {
  const publications = [
    { topicId: 'finops', publishedAt: daysAgo(60), status: 'published', title: 'x' },
  ];
  const r = selectTopic({ domains, publications, cooldownDays: 45, now: NOW });
  assert.notEqual(r.domain.id, 'finops', 'an unused domain should outrank a used-but-eligible one');
});

test('a forced topic on cooldown is rejected rather than silently honoured', () => {
  const publications = [
    { topicId: 'finops', publishedAt: daysAgo(5), status: 'published', title: 'x' },
  ];
  assert.throws(
    () => selectTopic({ domains, publications, cooldownDays: 45, now: NOW, forcedTopicId: 'finops' }),
    /on cooldown/,
  );
});

test('a forced topic that is eligible is honoured', () => {
  const r = selectTopic({ domains, publications: [], cooldownDays: 45, now: NOW, forcedTopicId: 'cicd' });
  assert.equal(r.domain.id, 'cicd');
  assert.equal(r.selectionReason, 'forced');
});

test('an unknown forced topic is a hard error', () => {
  assert.throws(
    () => selectTopic({ domains, publications: [], now: NOW, forcedTopicId: 'nope' }),
    /not a known domain/,
  );
});

test('fails loudly when every domain is on cooldown', () => {
  const publications = domains.map((d) => ({
    topicId: d.id,
    publishedAt: daysAgo(1),
    status: 'published',
    title: 'x',
  }));
  assert.throws(
    () => selectTopic({ domains, publications, cooldownDays: 45, now: NOW }),
    /Every topic domain is on 45-day cooldown/,
  );
});

test('unpublished entries do not consume a rotation slot', () => {
  const publications = [
    { topicId: 'finops', publishedAt: daysAgo(2), status: 'failed', deploymentVerified: false, title: 'x' },
  ];
  const index = buildLastUsedIndex({ publications, legacyPosts: [], domains });
  assert.equal(index.has('finops'), false, 'a failed publication must not block the topic');
});
