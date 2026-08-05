'use strict';

const { checkTokenExpiry } = require('./oauth');

/**
 * LinkedIn Posts API client.
 *
 * Only `POST https://api.linkedin.com/rest/posts` with an organization author
 * URN. Success is defined narrowly and deliberately: a post counts as published
 * **only** when LinkedIn returns a syntactically valid `urn:li:share:*` /
 * `urn:li:ugcPost:*` identifier. A 2xx with no URN is treated as a failure,
 * because we cannot link to or audit a post we cannot identify.
 */

const POSTS_URL = 'https://api.linkedin.com/rest/posts';
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const URN_PATTERN = /^urn:li:(share|ugcPost):[A-Za-z0-9_-]+$/;

class LinkedInApiError extends Error {
  constructor(message, { status, retryable, body } = {}) {
    super(message);
    this.name = 'LinkedInApiError';
    this.status = status;
    this.retryable = Boolean(retryable);
    this.body = body;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

class LinkedInClient {
  constructor(config, { fetchImpl, logger, sleepImpl, clock } = {}) {
    this.accessToken = config.accessToken;
    this.organizationUrn = config.organizationUrn;
    this.apiVersion = config.apiVersion;
    this.maxRetries = config.maxRetries ?? 5;
    this.tokenExpiresAt = config.tokenExpiresAt || null;
    this.fetchImpl = fetchImpl || globalThis.fetch;
    this.logger = logger;
    this.sleep = sleepImpl || sleep;
    // Injectable so expiry behaviour is deterministically testable rather than
    // depending on the wall clock at test time.
    this.clock = clock || Date.now;
  }

  headers() {
    return {
      authorization: `Bearer ${this.accessToken}`,
      'content-type': 'application/json',
      'linkedin-version': this.apiVersion,
      'x-restli-protocol-version': '2.0.0',
    };
  }

  /**
   * Publish a text post with a link. Idempotency: LinkedIn honours
   * `x-restli-request-id`, so a retried request that already succeeded returns
   * the original post instead of creating a duplicate — which is what keeps
   * "one LinkedIn post per article" true across retries.
   */
  async createPost({ commentary, articleUrl, idempotencyKey, visibility = 'PUBLIC' }) {
    if (!this.accessToken) {
      throw new LinkedInApiError('LINKEDIN_ACCESS_TOKEN is not configured');
    }
    if (!URN_PATTERN.test(this.organizationUrn) && !/^urn:li:organization:\d+$/.test(this.organizationUrn)) {
      throw new LinkedInApiError(`Invalid organization URN "${this.organizationUrn}"`);
    }

    const expiry = checkTokenExpiry(this.tokenExpiresAt, { now: this.clock() });
    if (expiry.status === 'expired') {
      throw new LinkedInApiError(expiry.message, { status: 401 });
    }
    if (expiry.status === 'expiring_soon') {
      this.logger?.warn(expiry.message, { daysRemaining: expiry.daysRemaining });
    }

    const payload = {
      author: this.organizationUrn,
      commentary,
      visibility,
      distribution: {
        feedDistribution: 'MAIN_FEED',
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
      ...(articleUrl
        ? {
            content: {
              article: {
                source: articleUrl,
                // Title/description are optional; LinkedIn scrapes OG tags,
                // which deployment verification already confirmed exist.
              },
            },
          }
        : {}),
    };

    let lastError;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        const res = await this.fetchImpl(POSTS_URL, {
          method: 'POST',
          headers: {
            ...this.headers(),
            ...(idempotencyKey ? { 'x-restli-request-id': idempotencyKey } : {}),
          },
          body: JSON.stringify(payload),
        });

        // The URN comes back in a header on create; some versions also include
        // it in the body, so check both before declaring success.
        const headerUrn = res.headers.get('x-restli-id') || res.headers.get('x-linkedin-id');
        const rawBody = await res.text();

        if (res.ok || res.status === 201) {
          let bodyUrn = null;
          if (rawBody.trim()) {
            try {
              const json = JSON.parse(rawBody);
              bodyUrn = json.id || json.urn || null;
            } catch {
              /* body is optional on 201 */
            }
          }
          const urn = normaliseUrn(headerUrn || bodyUrn);
          if (!urn) {
            // 2xx without an identifier is NOT success for our purposes.
            throw new LinkedInApiError(
              `LinkedIn returned HTTP ${res.status} but no post URN — cannot confirm publication`,
              { status: res.status, retryable: false, body: rawBody.slice(0, 300) },
            );
          }
          return {
            urn,
            status: res.status,
            postUrl: `https://www.linkedin.com/feed/update/${urn}/`,
            attempts: attempt + 1,
          };
        }

        const retryable = RETRYABLE_STATUS.has(res.status);
        lastError = new LinkedInApiError(
          `LinkedIn API ${res.status}: ${rawBody.slice(0, 300)}`,
          { status: res.status, retryable, body: rawBody.slice(0, 300) },
        );

        if (res.status === 401) {
          throw new LinkedInApiError(
            'LinkedIn returned 401 — access token is invalid or expired. Reauthorization required.',
            { status: 401, retryable: false },
          );
        }
        if (res.status === 403) {
          throw new LinkedInApiError(
            `LinkedIn returned 403 — the token likely lacks w_organization_social or the member does not administer ${this.organizationUrn}.`,
            { status: 403, retryable: false },
          );
        }
        if (!retryable || attempt === this.maxRetries) throw lastError;

        const retryAfter = Number(res.headers.get('retry-after'));
        const backoff =
          Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : Math.min(2 ** attempt * 1000, 60_000) + Math.floor(Math.random() * 1000);
        this.logger?.warn('LinkedIn call failed, retrying', {
          status: res.status,
          attempt: attempt + 1,
          backoffMs: backoff,
        });
        await this.sleep(backoff);
      } catch (err) {
        if (err instanceof LinkedInApiError) {
          if (!err.retryable || attempt === this.maxRetries) throw err;
          lastError = err;
          await this.sleep(Math.min(2 ** attempt * 1000, 60_000));
          continue;
        }
        lastError = new LinkedInApiError(`LinkedIn request failed: ${err.message}`, { retryable: true });
        if (attempt === this.maxRetries) throw lastError;
        await this.sleep(Math.min(2 ** attempt * 1000, 60_000));
      }
    }
    throw lastError || new LinkedInApiError('LinkedIn post failed with no recorded error');
  }
}

/** Accept a bare id or a full URN; return a canonical URN or null. */
function normaliseUrn(value) {
  if (!value) return null;
  const v = String(value).trim();
  if (URN_PATTERN.test(v)) return v;
  if (/^\d+$/.test(v)) return `urn:li:share:${v}`;
  if (/^urn:li:(share|ugcPost):/.test(v)) return v;
  return null;
}

function isValidPostUrn(value) {
  return URN_PATTERN.test(String(value || ''));
}

module.exports = { LinkedInClient, LinkedInApiError, normaliseUrn, isValidPostUrn, POSTS_URL, URN_PATTERN };
