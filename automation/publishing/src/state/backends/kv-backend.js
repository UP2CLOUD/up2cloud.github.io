'use strict';

/**
 * Cloudflare KV state backend (REST API).
 *
 * The site already depends on Cloudflare KV for comments and likes, so using it
 * for publication state adds no new infrastructure. KV is eventually consistent
 * and has no native compare-and-swap, so the version field is advisory here: we
 * re-read before writing and reject on mismatch, which closes the common race
 * but is not a hard guarantee. The *authoritative* mutual exclusion for
 * publishing is the lock lease in `lock.js` combined with the git push CAS at
 * merge time — KV is the fast path, git is the arbiter.
 */
class KvBackend {
  constructor({ accountId, namespaceId, apiToken, key = 'autopublish:state', fetchImpl } = {}) {
    if (!accountId || !namespaceId || !apiToken) {
      throw new Error('KvBackend requires accountId, namespaceId and apiToken');
    }
    this.accountId = accountId;
    this.namespaceId = namespaceId;
    this.apiToken = apiToken;
    this.key = key;
    this.fetchImpl = fetchImpl || globalThis.fetch;
    this.baseUrl =
      `https://api.cloudflare.com/client/v4/accounts/${accountId}` +
      `/storage/kv/namespaces/${namespaceId}/values`;
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
    const res = await this.fetchImpl(`${this.baseUrl}/${encodeURIComponent(this.key)}`, {
      headers: { authorization: `Bearer ${this.apiToken}` },
    });
    if (res.status === 404) return KvBackend.emptyDocument();
    if (!res.ok) {
      throw new Error(`Cloudflare KV read failed: HTTP ${res.status}`);
    }
    const text = await res.text();
    if (!text.trim()) return KvBackend.emptyDocument();
    try {
      return { ...KvBackend.emptyDocument(), ...JSON.parse(text) };
    } catch (err) {
      throw new Error(`Corrupt KV state document: ${err.message}`);
    }
  }

  async write(document, { expectedVersion = null } = {}) {
    if (expectedVersion !== null) {
      const current = await this.read();
      if (current.version !== expectedVersion) {
        const err = new Error(
          `State version conflict: expected ${expectedVersion}, found ${current.version}`,
        );
        err.code = 'VERSION_CONFLICT';
        throw err;
      }
    }
    const next = {
      ...document,
      version: (document.version ?? 0) + 1,
      updatedAt: new Date().toISOString(),
    };

    const form = new FormData();
    form.append('value', JSON.stringify(next));
    form.append('metadata', JSON.stringify({ version: next.version, updatedAt: next.updatedAt }));

    const res = await this.fetchImpl(`${this.baseUrl}/${encodeURIComponent(this.key)}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${this.apiToken}` },
      body: form,
    });
    if (!res.ok) {
      throw new Error(`Cloudflare KV write failed: HTTP ${res.status}`);
    }
    return next;
  }
}

module.exports = { KvBackend };
