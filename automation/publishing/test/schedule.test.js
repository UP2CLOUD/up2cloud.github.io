'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateSchedule, SKIP_REASON, HOUR_MS } = require('../src/schedule');

const NOW = Date.parse('2026-08-10T09:00:00Z');

test('publishes when there is no previous publication', () => {
  const r = evaluateSchedule({ lastSuccessfulPublicationAt: null, now: NOW });
  assert.equal(r.due, true);
  assert.equal(r.reason, 'no_previous_publication');
});

test('blocks before the 48h interval has elapsed', () => {
  const last = new Date(NOW - 47 * HOUR_MS).toISOString();
  const r = evaluateSchedule({ lastSuccessfulPublicationAt: last, intervalHours: 48, now: NOW });
  assert.equal(r.due, false);
  assert.equal(r.reason, SKIP_REASON.NOT_DUE);
  assert.ok(r.waitHours > 0.9 && r.waitHours < 1.1, `waitHours=${r.waitHours}`);
});

test('publishes exactly at the interval boundary', () => {
  const last = new Date(NOW - 48 * HOUR_MS).toISOString();
  const r = evaluateSchedule({ lastSuccessfulPublicationAt: last, intervalHours: 48, now: NOW });
  assert.equal(r.due, true);
  assert.equal(r.reason, 'interval_elapsed');
});

test('publishes well after the interval', () => {
  const last = new Date(NOW - 100 * HOUR_MS).toISOString();
  const r = evaluateSchedule({ lastSuccessfulPublicationAt: last, intervalHours: 48, now: NOW });
  assert.equal(r.due, true);
});

test('a cron double-fire inside the window does NOT double publish', () => {
  // This is the core reason scheduling is state-based rather than cron-based:
  // two triggers minutes apart must not both publish.
  const last = new Date(NOW - 1 * HOUR_MS).toISOString();
  const first = evaluateSchedule({ lastSuccessfulPublicationAt: last, now: NOW });
  const second = evaluateSchedule({ lastSuccessfulPublicationAt: last, now: NOW + 5 * 60 * 1000 });
  assert.equal(first.due, false);
  assert.equal(second.due, false);
});

test('a missed cron tick still publishes on the next wake-up', () => {
  // Cron skipped for 3 days; the next run must publish rather than wait for
  // the "scheduled" slot.
  const last = new Date(NOW - 72 * HOUR_MS).toISOString();
  const r = evaluateSchedule({ lastSuccessfulPublicationAt: last, intervalHours: 48, now: NOW });
  assert.equal(r.due, true);
});

test('force overrides the interval', () => {
  const last = new Date(NOW - 1 * HOUR_MS).toISOString();
  const r = evaluateSchedule({ lastSuccessfulPublicationAt: last, now: NOW, force: true });
  assert.equal(r.due, true);
  assert.equal(r.reason, 'forced');
});

test('kill switch outranks force', () => {
  const r = evaluateSchedule({
    lastSuccessfulPublicationAt: null,
    now: NOW,
    force: true,
    killSwitch: true,
  });
  assert.equal(r.due, false);
  assert.equal(r.reason, SKIP_REASON.KILL_SWITCH);
});

test('rejects an unparseable last-publication timestamp', () => {
  assert.throws(
    () => evaluateSchedule({ lastSuccessfulPublicationAt: 'not-a-date', now: NOW }),
    /not a valid timestamp/,
  );
});

test('respects a custom interval', () => {
  const last = new Date(NOW - 13 * HOUR_MS).toISOString();
  assert.equal(evaluateSchedule({ lastSuccessfulPublicationAt: last, intervalHours: 12, now: NOW }).due, true);
  assert.equal(evaluateSchedule({ lastSuccessfulPublicationAt: last, intervalHours: 24, now: NOW }).due, false);
});
