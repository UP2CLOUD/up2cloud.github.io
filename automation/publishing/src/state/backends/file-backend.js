'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Git-committed JSON state backend.
 *
 * Durability and cross-runner mutual exclusion come from git itself: the
 * ledger is committed and pushed, and `git push` to a ref is a genuine
 * compare-and-swap — a second concurrent runner's push is rejected as
 * non-fast-forward. Local reads/writes additionally use an atomic
 * `O_EXCL` lockfile so two processes on the same runner cannot interleave.
 *
 * The document carries a monotonically increasing `version`; `write()` refuses
 * to clobber a document whose version moved underneath the caller, which is the
 * optimistic-concurrency half of the contract.
 */
class FileBackend {
  constructor({ filePath, lockTimeoutMs = 10_000 } = {}) {
    if (!filePath) throw new Error('FileBackend requires filePath');
    this.filePath = path.resolve(filePath);
    this.lockPath = `${this.filePath}.lock`;
    this.lockTimeoutMs = lockTimeoutMs;
  }

  static emptyDocument() {
    return {
      version: 0,
      updatedAt: null,
      lastSuccessfulPublicationAt: null,
      lock: null,
      runs: [],
      publications: [],
    };
  }

  async read() {
    if (!fs.existsSync(this.filePath)) return FileBackend.emptyDocument();
    const raw = fs.readFileSync(this.filePath, 'utf8').trim();
    if (!raw) return FileBackend.emptyDocument();
    try {
      const doc = JSON.parse(raw);
      return { ...FileBackend.emptyDocument(), ...doc };
    } catch (err) {
      throw new Error(`Corrupt state ledger at ${this.filePath}: ${err.message}`);
    }
  }

  /**
   * Optimistic write. `expectedVersion === null` skips the check (first write);
   * otherwise a mismatch throws so the caller can re-read and retry.
   */
  async write(document, { expectedVersion = null } = {}) {
    return this.#withLocalLock(async () => {
      const current = await this.read();
      if (expectedVersion !== null && current.version !== expectedVersion) {
        const err = new Error(
          `State version conflict: expected ${expectedVersion}, found ${current.version}`,
        );
        err.code = 'VERSION_CONFLICT';
        throw err;
      }
      const next = {
        ...document,
        version: current.version + 1,
        updatedAt: new Date().toISOString(),
      };
      // Write to a temp file then rename: rename is atomic on POSIX, so a
      // crash mid-write can never leave a truncated ledger behind.
      const tmp = `${this.filePath}.tmp.${process.pid}`;
      fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
      fs.renameSync(tmp, this.filePath);
      return next;
    });
  }

  async #withLocalLock(fn) {
    // The lockfile lives beside the ledger, so the directory has to exist
    // before we can even take the lock. On a fresh checkout it does not —
    // which is precisely the CI first-run path.
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });

    const deadline = Date.now() + this.lockTimeoutMs;
    let handle = null;
    for (;;) {
      try {
        // wx = fail if it already exists. Atomic across processes.
        handle = fs.openSync(this.lockPath, 'wx');
        break;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        // Reap a lockfile left behind by a killed process.
        try {
          const age = Date.now() - fs.statSync(this.lockPath).mtimeMs;
          if (age > this.lockTimeoutMs) fs.unlinkSync(this.lockPath);
        } catch {
          /* raced with another reaper; loop and retry */
        }
        if (Date.now() > deadline) {
          throw new Error(`Timed out acquiring local state lock at ${this.lockPath}`);
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    try {
      return await fn();
    } finally {
      try {
        fs.closeSync(handle);
        fs.unlinkSync(this.lockPath);
      } catch {
        /* best effort */
      }
    }
  }
}

module.exports = { FileBackend };
