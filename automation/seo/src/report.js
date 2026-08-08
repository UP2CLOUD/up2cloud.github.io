'use strict';

const { SEVERITY } = require('./rules');

const ICON = { error: '🔴', warn: '🟡', info: '🔵' };

function groupBy(items, key) {
  const map = new Map();
  for (const item of items) {
    const k = key(item);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(item);
  }
  return map;
}

/**
 * Markdown report for the PR body and the Actions step summary.
 *
 * Structured around the one question a reader actually has: "is there anything
 * left for *me* to do?" Fixed items are collapsed into a summary line; the
 * judgement calls are listed in full, because those are the whole reason a
 * human is being shown this at all.
 */
function renderReport(result, { applied = [], title = 'Weekly SEO audit' } = {}) {
  const { counts, pagesScanned, findings, baseUrl } = result;
  const remaining = findings.filter((f) => !f.fixable);
  const lines = [];

  lines.push(`## ${title}`);
  lines.push('');
  lines.push(`Scanned **${pagesScanned} pages** on ${baseUrl}.`);
  lines.push('');
  lines.push('| | Errors | Warnings | Info | Auto-fixed |');
  lines.push('|---|---:|---:|---:|---:|');
  lines.push(`| Count | ${counts.error} | ${counts.warn} | ${counts.info} | ${applied.length} |`);
  lines.push('');

  if (applied.length) {
    lines.push('### Fixed automatically');
    lines.push('');
    lines.push('Mechanical tags with exactly one correct value. No prose was rewritten.');
    lines.push('');
    for (const change of applied) {
      lines.push(`- \`${change.file}\` — ${change.fixes.join(', ')}`);
    }
    lines.push('');
  }

  const needsHuman = remaining.filter((f) => f.severity !== SEVERITY.INFO);
  if (needsHuman.length) {
    lines.push('### Needs a human decision');
    lines.push('');
    lines.push('These require judgement about what a page *means*, so the automation reports them rather than guessing.');
    lines.push('');
    for (const [rule, items] of groupBy(needsHuman, (f) => f.rule)) {
      lines.push(`**${ICON[items[0].severity]} ${rule}**`);
      lines.push('');
      for (const f of items) {
        lines.push(`- ${f.file ? `\`${f.file}\` — ` : ''}${f.message}`);
      }
      lines.push('');
    }
  }

  const info = remaining.filter((f) => f.severity === SEVERITY.INFO);
  if (info.length) {
    lines.push('<details><summary>Informational</summary>');
    lines.push('');
    for (const f of info) {
      lines.push(`- \`${f.rule}\` ${f.file ? `\`${f.file}\` — ` : ''}${f.message}`);
    }
    lines.push('');
    lines.push('</details>');
    lines.push('');
  }

  if (!applied.length && !needsHuman.length) {
    lines.push('Nothing to change — every indexable page has complete, well-formed SEO metadata.');
    lines.push('');
  }

  return lines.join('\n');
}

/** One-line status for logs and the job summary header. */
function summaryLine(result, applied = []) {
  return `${result.pagesScanned} pages · ${result.counts.error} errors · ${result.counts.warn} warnings · ${applied.length} auto-fixed`;
}

module.exports = { renderReport, summaryLine };
