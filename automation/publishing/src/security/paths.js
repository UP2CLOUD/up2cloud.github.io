'use strict';

const path = require('node:path');
const fs = require('node:fs');

/**
 * Write allow-list.
 *
 * The generator produces attacker-influenced strings (a slug derived from a
 * model response derived from fetched web pages), and those strings end up in
 * filesystem paths. Everything written by the pipeline must therefore resolve
 * inside one of these directories, checked *after* path resolution so `..`,
 * absolute paths and symlink escapes are all caught.
 */
const ALLOWED_WRITE_DIRS = Object.freeze([
  'blog',
  'automation/publishing/state',
  'automation/publishing/artifacts',
  'assets/img/blog',
]);

/** Files the pipeline may rewrite in place at the repo root. */
const ALLOWED_ROOT_FILES = Object.freeze(['sitemap.xml']);

class PathSecurityError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PathSecurityError';
  }
}

/**
 * A slug becomes a directory name and a public URL segment, so it is the single
 * highest-risk model-controlled string in the system. Rather than blacklisting
 * traversal sequences, we re-derive the slug from an explicit safe alphabet and
 * reject anything that does not survive the round trip unchanged.
 */
function assertSafeSlug(slug) {
  if (typeof slug !== 'string' || !slug.length) {
    throw new PathSecurityError('Slug must be a non-empty string');
  }
  if (slug.length > 80) {
    throw new PathSecurityError(`Slug exceeds 80 characters: ${slug.length}`);
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new PathSecurityError(
      `Slug must be lowercase alphanumeric words separated by single hyphens: "${slug}"`,
    );
  }
  // Defence in depth: these can never match the regex above, but the cost of
  // asserting is nil and the cost of being wrong is a repo-root write.
  if (slug === '.' || slug === '..' || slug.includes('/') || slug.includes('\\')) {
    throw new PathSecurityError(`Slug contains path separators: "${slug}"`);
  }
  return slug;
}

function slugify(input) {
  return String(input || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
}

/**
 * Resolve `candidate` against `repoRoot` and assert it lands inside the
 * allow-list. Returns the resolved absolute path.
 */
function resolveWritePath(repoRoot, candidate) {
  if (typeof candidate !== 'string' || !candidate.length) {
    throw new PathSecurityError('Write path must be a non-empty string');
  }
  if (candidate.includes('\0')) {
    throw new PathSecurityError('Write path contains a null byte');
  }

  const root = path.resolve(repoRoot);
  const resolved = path.resolve(root, candidate);

  // `path.relative` gives us containment without string-prefix pitfalls
  // (e.g. /repo-evil sharing a prefix with /repo).
  const rel = path.relative(root, resolved);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new PathSecurityError(`Write path escapes the repository root: "${candidate}"`);
  }

  const relPosix = rel.split(path.sep).join('/');

  if (ALLOWED_ROOT_FILES.includes(relPosix)) return resolved;

  const permitted = ALLOWED_WRITE_DIRS.some(
    (dir) => relPosix === dir || relPosix.startsWith(`${dir}/`),
  );
  if (!permitted) {
    throw new PathSecurityError(
      `Write path "${relPosix}" is outside the allow-list ` +
        `(${ALLOWED_WRITE_DIRS.join(', ')}, ${ALLOWED_ROOT_FILES.join(', ')})`,
    );
  }

  // A symlink inside an allowed directory could still point outside the repo.
  // Check the nearest existing ancestor's real path.
  let probe = resolved;
  while (probe !== root && !fs.existsSync(probe)) probe = path.dirname(probe);
  if (fs.existsSync(probe)) {
    const realProbe = fs.realpathSync(probe);
    const realRoot = fs.realpathSync(root);
    const realRel = path.relative(realRoot, realProbe);
    if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
      throw new PathSecurityError(
        `Write path "${relPosix}" resolves outside the repository via a symlink`,
      );
    }
  }

  return resolved;
}

/** Write a file only if its path survives `resolveWritePath`. */
function safeWriteFile(repoRoot, candidate, contents) {
  const target = resolveWritePath(repoRoot, candidate);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents, 'utf8');
  return target;
}

module.exports = {
  ALLOWED_WRITE_DIRS,
  ALLOWED_ROOT_FILES,
  PathSecurityError,
  assertSafeSlug,
  slugify,
  resolveWritePath,
  safeWriteFile,
};
