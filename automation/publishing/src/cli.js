#!/usr/bin/env node
'use strict';

const path = require('node:path');
const fs = require('node:fs');

const { loadConfig, MODES, ConfigError, requiredCapabilitiesForMode } = require('./config');
const { createLogger } = require('./logger');
const { FileBackend } = require('./state/backends/file-backend');
const { KvBackend } = require('./state/backends/kv-backend');
const { Ledger, RUN_STATUS, newRunId, firstIncompleteStage } = require('./state/ledger');
const { acquireLock, releaseLock, renewLock } = require('./state/lock');
const { evaluateSchedule } = require('./schedule');
const { Pipeline } = require('./pipeline');
const { buildAuthorizationUrl, exchangeCodeForToken, checkTokenExpiry } = require('./linkedin/oauth');

/**
 * CLI entrypoint.
 *
 * Exit codes are meaningful because CI branches on them:
 *   0 — published, or cleanly skipped (not due / lock held / kill switch)
 *   1 — a stage failed; the ledger records where, and a retry resumes there
 *   2 — misconfiguration (bad env, invalid flag)
 */

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const [rawKey, inlineValue] = token.slice(2).split('=');
      const key = rawKey.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (inlineValue !== undefined) args[key] = inlineValue;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) {
        args[key] = argv[i + 1];
        i += 1;
      } else args[key] = true;
    } else {
      args._.push(token);
    }
  }
  return args;
}

function buildBackend(config) {
  if (config.state.backend === 'kv') {
    config.requireFor('kvState');
    return new KvBackend({
      accountId: config.state.cloudflare.accountId,
      namespaceId: config.state.cloudflare.namespaceId,
      apiToken: config.state.cloudflare.apiToken,
    });
  }
  return new FileBackend({ filePath: config.state.filePath });
}

/** `--check-kill-switch`: a committed flag file also disables the pipeline. */
function killSwitchEngaged(config) {
  if (config.killSwitch) return { engaged: true, source: 'environment' };
  const flag = path.join(config.repoRoot, 'automation', 'publishing', 'DISABLED');
  if (fs.existsSync(flag)) {
    return { engaged: true, source: 'DISABLED file', note: fs.readFileSync(flag, 'utf8').trim().slice(0, 200) };
  }
  return { engaged: false };
}

async function commandPublish(config, args, logger) {
  const backend = buildBackend(config);
  const ledger = new Ledger(backend);

  const kill = killSwitchEngaged(config);
  if (kill.engaged) {
    logger.warn('Kill switch engaged — not publishing', kill);
    return 0;
  }

  // Preflight the credentials this mode will certainly need. Discovering a
  // missing LINKEDIN_ACCESS_TOKEN at stage 10 costs a whole generation cycle
  // and leaves an article published but unpromoted; discovering it here costs
  // nothing. Deliberately before the lock, so a misconfigured invocation
  // cannot take a lease and block a correctly configured one.
  for (const capability of requiredCapabilitiesForMode(config.mode, config.state.backend)) {
    config.requireFor(capability);
  }

  const state = await backend.read();
  const schedule = evaluateSchedule({
    lastSuccessfulPublicationAt: state.lastSuccessfulPublicationAt,
    intervalHours: config.publishIntervalHours,
    now: Date.now(),
    force: Boolean(args.force),
    killSwitch: false,
  });

  logger.info('Schedule evaluated', {
    due: schedule.due,
    reason: schedule.reason,
    lastPublished: state.lastSuccessfulPublicationAt,
    nextEligibleAt: schedule.nextEligibleAt,
  });

  if (!schedule.due) {
    logger.info('Not due yet — exiting cleanly', {
      waitHours: schedule.waitHours?.toFixed(2),
      nextEligibleAt: schedule.nextEligibleAt,
    });
    return 0;
  }

  const lockResult = await acquireLock(backend, {
    ttlSeconds: config.lockTtlSeconds,
    reason: `publish:${config.mode}`,
  });
  if (!lockResult.acquired) {
    logger.warn('Another run holds the publish lock — exiting cleanly', {
      heldBy: lockResult.lock.owner,
      expiresAt: lockResult.lock.expiresAt,
    });
    return 0;
  }
  const owner = lockResult.lock.owner;
  if (lockResult.stolenFrom) {
    logger.warn('Stole an expired lock', { previousOwner: lockResult.stolenFrom });
  }

  // Heartbeat keeps the lease alive across long model calls without holding a
  // lock so long that a crashed runner blocks the next cycle for hours.
  const heartbeat = setInterval(() => {
    renewLock(backend, owner, { ttlSeconds: config.lockTtlSeconds }).catch((err) =>
      logger.warn('Lock renewal failed', { error: err.message }),
    );
  }, Math.max(30_000, (config.lockTtlSeconds * 1000) / 3));
  heartbeat.unref?.();

  let exitCode = 0;
  try {
    let run;
    if (config.resumeRunId) {
      run = await ledger.getRun(config.resumeRunId);
      if (!run) throw new Error(`Cannot resume unknown run "${config.resumeRunId}"`);
      logger.info('Resuming run', {
        runId: run.runId,
        resumeAt: firstIncompleteStage(run),
      });
    } else {
      run = await ledger.startRun({
        runId: config.runId || newRunId(),
        mode: config.mode,
        trigger: args.trigger || process.env.GITHUB_EVENT_NAME || 'manual',
        topic: config.forcedTopic,
      });
      logger.info('Run started', { runId: run.runId, mode: config.mode });
    }

    const runLogger = logger.child({ runId: run.runId });
    const pipeline = new Pipeline({ config, ledger, logger: runLogger });
    const result = await pipeline.run({ run, forcedTopic: config.forcedTopic });

    runLogger.info('Pipeline finished', {
      dryRun: Boolean(result.dryRun),
      slug: result.metadata?.slug,
      blogUrl: result.blogUrl,
      linkedinUrn: result.linkedin?.urn || null,
    });

    if (process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(
        process.env.GITHUB_OUTPUT,
        [
          `run_id=${run.runId}`,
          `slug=${result.metadata?.slug || ''}`,
          `blog_url=${result.blogUrl || ''}`,
          `linkedin_urn=${result.linkedin?.urn || ''}`,
          `published=${result.dryRun ? 'false' : 'true'}`,
        ].join('\n') + '\n',
      );
    }
  } catch (err) {
    logger.error('Run failed', { error: err });
    exitCode = 1;
  } finally {
    clearInterval(heartbeat);
    await releaseLock(backend, owner).catch(() => {});
  }
  return exitCode;
}

async function commandStatus(config, args, logger) {
  const backend = buildBackend(config);
  const state = await backend.read();
  const schedule = evaluateSchedule({
    lastSuccessfulPublicationAt: state.lastSuccessfulPublicationAt,
    intervalHours: config.publishIntervalHours,
    killSwitch: config.killSwitch,
  });
  const tokenHealth = checkTokenExpiry(config.linkedin.tokenExpiresAt);

  const report = {
    killSwitch: killSwitchEngaged(config),
    lastSuccessfulPublicationAt: state.lastSuccessfulPublicationAt,
    due: schedule.due,
    reason: schedule.reason,
    nextEligibleAt: schedule.nextEligibleAt,
    lock: state.lock
      ? { owner: state.lock.owner, expiresAt: state.lock.expiresAt }
      : null,
    publications: (state.publications || []).length,
    recent: (state.publications || []).slice(0, 5).map((p) => ({
      slug: p.slug,
      publishedAt: p.publishedAt,
      linkedin: p.linkedinStatus,
      urn: p.linkedinPostUrn,
    })),
    linkedinToken: { status: tokenHealth.status, message: tokenHealth.message },
    incompleteRuns: (state.runs || [])
      .filter((r) => r.status === RUN_STATUS.RUNNING || r.status === RUN_STATUS.FAILED)
      .map((r) => ({ runId: r.runId, status: r.status, resumeAt: firstIncompleteStage(r) })),
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return 0;
}

/** `oauth-url` / `oauth-exchange`: the only supported way to mint a token. */
async function commandOauth(config, args, logger) {
  config.requireFor('linkedinOAuth');
  const sub = args._[1];

  if (sub === 'url') {
    const redirectUri = args.redirectUri || config.linkedin.redirectUri;
    if (!redirectUri) throw new Error('Provide --redirect-uri or set LINKEDIN_REDIRECT_URI');
    const { url, state } = buildAuthorizationUrl({
      clientId: config.linkedin.clientId,
      redirectUri,
    });
    process.stdout.write(
      [
        'Open this URL as a LinkedIn user who is an ADMINISTRATOR of the company page:',
        '',
        url,
        '',
        `Verify this state value on the callback: ${state}`,
        '',
        'Then run:',
        `  node automation/publishing/src/cli.js oauth exchange --code <CODE> --redirect-uri ${redirectUri}`,
        '',
      ].join('\n'),
    );
    return 0;
  }

  if (sub === 'exchange') {
    if (!args.code) throw new Error('Provide --code from the OAuth callback');
    const redirectUri = args.redirectUri || config.linkedin.redirectUri;
    const token = await exchangeCodeForToken({
      code: String(args.code),
      clientId: config.linkedin.clientId,
      clientSecret: config.linkedin.clientSecret,
      redirectUri,
    });
    // The token itself is printed once, to stdout, for the operator to paste
    // into secret storage. It is never written to disk or logged.
    process.stdout.write(
      [
        'Store these as repository secrets — they are NOT saved anywhere by this command:',
        '',
        `  LINKEDIN_ACCESS_TOKEN=${token.accessToken}`,
        `  LINKEDIN_TOKEN_EXPIRES_AT=${token.expiresAt}`,
        token.refreshToken ? `  LINKEDIN_REFRESH_TOKEN=${token.refreshToken}` : '',
        '',
        `Granted scopes: ${token.scope}`,
        `Access token expires: ${token.expiresAt}`,
        '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
    return 0;
  }

  throw new Error(`Unknown oauth subcommand "${sub}". Use "url" or "exchange".`);
}

const USAGE = `
UP2CLOUD autopublish

Usage:
  node automation/publishing/src/cli.js <command> [options]

Commands:
  publish              Run the pipeline if publishing is due
  status               Print schedule, lock, token and publication state
  oauth url            Print the LinkedIn consent URL
  oauth exchange       Exchange an OAuth code for an access token

Options:
  --mode <m>           dry-run | draft | review | auto   (default: draft)
  --force              Bypass the weekly interval (kill switch still applies)
  --topic <id>         Force a topic domain id
  --resume <runId>     Resume an incomplete run at its first unfinished stage
  --trigger <name>     Label the run's trigger in the ledger

Environment: see automation/publishing/README.md
`;

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const command = args._[0] || 'publish';

  if (args.help || command === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }

  let config;
  try {
    config = loadConfig(process.env, args);
  } catch (err) {
    process.stderr.write(`Configuration error: ${err.message}\n`);
    return 2;
  }

  const logger = createLogger({ context: { mode: config.mode, command } });

  try {
    switch (command) {
      case 'publish':
        return await commandPublish(config, args, logger);
      case 'status':
        return await commandStatus(config, args, logger);
      case 'oauth':
        return await commandOauth(config, args, logger);
      default:
        process.stderr.write(`Unknown command "${command}"\n${USAGE}`);
        return 2;
    }
  } catch (err) {
    logger.error('Command failed', { error: err });
    // A config error is never worth retrying — surface it as misconfiguration
    // so CI reports "fix your environment" rather than "try again".
    return err instanceof ConfigError ? 2 : 1;
  }
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`Fatal: ${err.stack || err.message}\n`);
      process.exit(1);
    },
  );
}

module.exports = { main, parseArgs, buildBackend, killSwitchEngaged, MODES };
