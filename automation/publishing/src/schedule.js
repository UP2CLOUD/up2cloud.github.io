'use strict';

/**
 * Durable scheduling.
 *
 * The cron expression is only a *wake-up*, never the source of truth. Whether a
 * run may publish is decided purely by state:
 *
 *     now >= lastSuccessfulPublicationAt + intervalHours
 *
 * This is what makes the schedule survive a missed cron tick, a runner outage,
 * a re-run of an old workflow, or someone hitting "Run workflow" twice: the
 * answer is derived from when we last actually published, not from how often
 * the trigger fired. A cron-only design double-publishes on manual re-run and
 * silently skips a cycle whenever GitHub delays a scheduled job.
 */

const HOUR_MS = 60 * 60 * 1000;

const SKIP_REASON = Object.freeze({
  KILL_SWITCH: 'kill_switch_enabled',
  NOT_DUE: 'interval_not_elapsed',
  ALREADY_RUNNING: 'another_run_holds_lock',
});

/**
 * Decide whether publishing is due.
 *
 * @param {object}  opts
 * @param {string?} opts.lastSuccessfulPublicationAt ISO timestamp, or null if never published
 * @param {number}  opts.intervalHours               minimum gap between publications
 * @param {number}  opts.now                         epoch ms
 * @param {boolean} opts.force                       manual override (still respects the kill switch)
 * @param {boolean} opts.killSwitch
 */
function evaluateSchedule({
  lastSuccessfulPublicationAt = null,
  intervalHours = 48,
  now = Date.now(),
  force = false,
  killSwitch = false,
} = {}) {
  // The kill switch outranks everything, including an explicit manual force —
  // it exists so a human can stop the system without racing the operator who
  // is pressing "run".
  if (killSwitch) {
    return {
      due: false,
      reason: SKIP_REASON.KILL_SWITCH,
      nextEligibleAt: null,
      hoursSinceLast: null,
    };
  }

  if (!lastSuccessfulPublicationAt) {
    return {
      due: true,
      reason: force ? 'forced' : 'no_previous_publication',
      nextEligibleAt: null,
      hoursSinceLast: null,
    };
  }

  const lastMs = new Date(lastSuccessfulPublicationAt).getTime();
  if (!Number.isFinite(lastMs)) {
    throw new TypeError(
      `lastSuccessfulPublicationAt is not a valid timestamp: ${lastSuccessfulPublicationAt}`,
    );
  }

  const nextEligibleMs = lastMs + intervalHours * HOUR_MS;
  const hoursSinceLast = (now - lastMs) / HOUR_MS;
  const nextEligibleAt = new Date(nextEligibleMs).toISOString();

  if (force) {
    return { due: true, reason: 'forced', nextEligibleAt, hoursSinceLast };
  }
  if (now >= nextEligibleMs) {
    return { due: true, reason: 'interval_elapsed', nextEligibleAt, hoursSinceLast };
  }
  return {
    due: false,
    reason: SKIP_REASON.NOT_DUE,
    nextEligibleAt,
    hoursSinceLast,
    waitHours: (nextEligibleMs - now) / HOUR_MS,
  };
}

module.exports = { evaluateSchedule, SKIP_REASON, HOUR_MS };
