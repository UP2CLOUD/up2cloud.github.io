#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { auditSite } = require('./audit');
const { renderReport, summaryLine } = require('./report');
const { createLogger } = require('../../publishing/src/logger');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

const USAGE = `
SEO auditor — checks every page's search metadata and fixes what is mechanical.

  node automation/seo/src/cli.js audit            # report only, never writes
  node automation/seo/src/cli.js fix              # apply mechanical fixes
  node automation/seo/src/cli.js audit --json     # machine-readable output

Options
  --base-url <url>     Site origin (default https://up2cloud.tech)
  --og-image <url>     Fallback og:image for pages missing one
  --strict             Exit 1 on warnings too, not just errors
  --json               Emit JSON instead of markdown
  --report <file>      Also write the markdown report to a file

Exit codes
  0  clean (or fixes applied successfully)
  1  findings remain that need a human
  2  bad usage
`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const [rawKey, inline] = token.slice(2).split('=');
      const key = rawKey.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (inline !== undefined) args[key] = inline;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) {
        args[key] = argv[i + 1];
        i += 1;
      } else args[key] = true;
    } else args._.push(token);
  }
  return args;
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const command = args._[0] || 'audit';

  if (args.help || command === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }
  if (!['audit', 'fix'].includes(command)) {
    process.stderr.write(`Unknown command "${command}"\n${USAGE}`);
    return 2;
  }

  // Diagnostics go to stderr because stdout is this CLI's data channel:
  // `--json` output is piped into other tools, and a stray log line appended
  // after the JSON makes it unparseable.
  const logger = createLogger({
    context: { tool: 'seo', command },
    stream: process.stderr,
    errStream: process.stderr,
  });
  const baseUrl = String(args.baseUrl || process.env.SITE_BASE_URL || 'https://up2cloud.tech').replace(/\/+$/, '');
  const defaultOgImage =
    args.ogImage || process.env.SEO_DEFAULT_OG_IMAGE || `${baseUrl}/assets/img/og-image.png`;

  const result = auditSite({
    repoRoot: args.repoRoot ? path.resolve(String(args.repoRoot)) : REPO_ROOT,
    baseUrl,
    defaultOgImage,
    apply: command === 'fix',
  });

  if (args.json) {
    process.stdout.write(`${JSON.stringify(
      {
        baseUrl: result.baseUrl,
        pagesScanned: result.pagesScanned,
        counts: result.counts,
        fixable: result.fixable,
        changed: result.changed,
        skipped: result.skipped,
        findings: result.findings,
      },
      null,
      2,
    )}\n`);
  } else {
    const md = renderReport(result, { applied: result.changed });
    process.stdout.write(`${md}\n`);
    if (args.report) fs.writeFileSync(String(args.report), md, 'utf8');
  }

  logger.info('SEO audit complete', {
    summary: summaryLine(result, result.changed),
    changedFiles: result.changed.length,
    skippedFixes: result.skipped.length,
  });

  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      [
        `pages=${result.pagesScanned}`,
        `errors=${result.counts.error}`,
        `warnings=${result.counts.warn}`,
        `changed=${result.changed.length}`,
        `summary=${summaryLine(result, result.changed)}`,
      ].join('\n') + '\n',
    );
  }

  // After `fix`, only findings a human must handle should fail the run.
  const blocking =
    command === 'fix'
      ? result.findings.filter((f) => !f.fixable && f.severity === 'error')
      : result.findings.filter((f) => f.severity === 'error');
  const strictExtra = args.strict ? result.findings.filter((f) => f.severity === 'warn') : [];

  return blocking.length + strictExtra.length > 0 ? 1 : 0;
}

if (require.main === module) {
  try {
    process.exit(main());
  } catch (err) {
    process.stderr.write(`Fatal: ${err.stack || err.message}\n`);
    process.exit(2);
  }
}

module.exports = { main, parseArgs };
