#!/usr/bin/env node
/**
 * resolve-includes.js — inline `<!-- include: _includes/foo.html -->` markers
 *
 * Used both by serve.js (resolved per-request, for local dev) and by the
 * CI build step (resolved once against the public/ artifact before deploy),
 * so local preview and production stay in sync.
 *
 * Usage: node scripts/resolve-includes.js [dir]   (defaults to repo root)
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT     = path.resolve(__dirname, '..');
const INCLUDES_DIR = path.join(ROOT, '_includes');
const INCLUDE_RE = /<!--\s*include:\s*(\S+?)\s*-->/g;

function resolveIncludes(html) {
  return html.replace(INCLUDE_RE, (match, includePath) => {
    const fullPath = path.resolve(ROOT, includePath);
    if (!(fullPath === INCLUDES_DIR || fullPath.startsWith(INCLUDES_DIR + path.sep))) {
      throw new Error(`include path escapes _includes/: ${includePath}`);
    }
    return fs.readFileSync(fullPath, 'utf8').trimEnd();
  });
}

const SKIP_DIRS = new Set(['node_modules', '.git', '_includes']);

function resolveDir(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      resolveDir(full);
    } else if (entry.name.endsWith('.html')) {
      const html = fs.readFileSync(full, 'utf8');
      const resolved = resolveIncludes(html);
      if (resolved !== html) fs.writeFileSync(full, resolved);
    }
  }
}

if (require.main === module) {
  const target = path.resolve(process.argv[2] || ROOT);
  resolveDir(target);
  console.log(`Resolved includes under ${path.relative(ROOT, target) || '.'}`);
}

module.exports = { resolveIncludes };
