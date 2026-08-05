'use strict';

const crypto = require('node:crypto');

/**
 * LinkedIn OAuth 2.0 (authorization code) + token lifecycle.
 *
 * Only the official OAuth endpoints are used. There is deliberately no
 * cookie/password/browser-automation path anywhere in this module: posting as
 * an organization requires a member token with `w_organization_social` granted
 * by a page ADMINISTRATOR, and the only supported way to obtain one is this
 * flow.
 *
 * LinkedIn access tokens last ~60 days and refresh tokens ~365 days, and
 * refresh tokens are only issued to approved apps — so many installs will be
 * manual-reauth. That makes *expiry warning* a first-class feature rather than
 * an afterthought: we surface a warning well before the token dies.
 */

const AUTH_URL = 'https://www.linkedin.com/oauth/v2/authorization';
const TOKEN_URL = 'https://www.linkedin.com/oauth/v2/accessToken';

/** Scopes needed to post as an organization and read the admin relationship. */
const REQUIRED_SCOPES = ['w_organization_social', 'r_organization_social', 'rw_organization_admin'];

const WARN_BEFORE_EXPIRY_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

class LinkedInAuthError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = 'LinkedInAuthError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Build the consent URL. `state` is CSRF protection and must be verified on
 * callback — generated here so callers cannot forget it.
 */
function buildAuthorizationUrl({ clientId, redirectUri, scopes = REQUIRED_SCOPES, state } = {}) {
  if (!clientId) throw new LinkedInAuthError('clientId is required');
  if (!redirectUri) throw new LinkedInAuthError('redirectUri is required');
  const csrfState = state || crypto.randomBytes(16).toString('hex');
  const url = new URL(AUTH_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', scopes.join(' '));
  url.searchParams.set('state', csrfState);
  return { url: url.toString(), state: csrfState };
}

async function exchangeCodeForToken({ code, clientId, clientSecret, redirectUri, fetchImpl = globalThis.fetch }) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
  });
  return postToken(body, fetchImpl);
}

async function refreshAccessToken({ refreshToken, clientId, clientSecret, fetchImpl = globalThis.fetch }) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });
  return postToken(body, fetchImpl);
}

async function postToken(body, fetchImpl) {
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    // The response body can echo the client_secret back on some errors, so it
    // is truncated and never logged verbatim by callers (logger redacts too).
    throw new LinkedInAuthError(`Token endpoint returned HTTP ${res.status}: ${text.slice(0, 200)}`, {
      status: res.status,
    });
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new LinkedInAuthError('Token endpoint returned non-JSON response');
  }
  const now = Date.now();
  return {
    accessToken: json.access_token,
    expiresIn: json.expires_in,
    expiresAt: new Date(now + Number(json.expires_in || 0) * 1000).toISOString(),
    refreshToken: json.refresh_token || null,
    refreshTokenExpiresAt: json.refresh_token_expires_in
      ? new Date(now + Number(json.refresh_token_expires_in) * 1000).toISOString()
      : null,
    scope: json.scope || '',
  };
}

/**
 * Classify token health. Returns `{ status, daysRemaining, message }` where
 * status is `valid` | `expiring_soon` | `expired` | `unknown`.
 */
function checkTokenExpiry(expiresAt, { now = Date.now(), warnDays = WARN_BEFORE_EXPIRY_DAYS } = {}) {
  if (!expiresAt) {
    return {
      status: 'unknown',
      daysRemaining: null,
      message:
        'LINKEDIN_TOKEN_EXPIRES_AT is not set — cannot warn before the token dies. ' +
        'Set it when provisioning the token so reauthorization can be scheduled.',
    };
  }
  const ms = new Date(expiresAt).getTime();
  if (!Number.isFinite(ms)) {
    return { status: 'unknown', daysRemaining: null, message: `Unparseable expiry "${expiresAt}"` };
  }
  const daysRemaining = (ms - now) / DAY_MS;
  if (daysRemaining <= 0) {
    return {
      status: 'expired',
      daysRemaining,
      message: `LinkedIn access token expired ${Math.abs(daysRemaining).toFixed(1)} days ago — reauthorization required`,
    };
  }
  if (daysRemaining <= warnDays) {
    return {
      status: 'expiring_soon',
      daysRemaining,
      message: `LinkedIn access token expires in ${daysRemaining.toFixed(1)} days — reauthorize soon`,
    };
  }
  return {
    status: 'valid',
    daysRemaining,
    message: `LinkedIn access token valid for ${daysRemaining.toFixed(0)} more days`,
  };
}

function hasRequiredScopes(grantedScope, required = ['w_organization_social']) {
  const granted = new Set(
    String(grantedScope || '')
      .split(/[\s,]+/)
      .filter(Boolean),
  );
  const missing = required.filter((s) => !granted.has(s));
  return { ok: missing.length === 0, missing, granted: [...granted] };
}

/**
 * Confirm the authenticated member actually administers the target org.
 * Posting with an org URN the member cannot administer fails at the API with an
 * opaque 403, so we check first and produce an actionable error instead.
 */
async function verifyOrganizationRole({
  accessToken,
  organizationUrn,
  apiVersion,
  fetchImpl = globalThis.fetch,
}) {
  const url = new URL('https://api.linkedin.com/rest/organizationAcls');
  url.searchParams.set('q', 'roleAssignee');
  url.searchParams.set('role', 'ADMINISTRATOR');
  url.searchParams.set('state', 'APPROVED');

  const res = await fetchImpl(url.toString(), {
    headers: {
      authorization: `Bearer ${accessToken}`,
      'linkedin-version': apiVersion,
      'x-restli-protocol-version': '2.0.0',
    },
  });

  if (res.status === 401) {
    throw new LinkedInAuthError('LinkedIn rejected the access token (401) — reauthorization required', {
      status: 401,
    });
  }
  if (!res.ok) {
    // Some app configurations cannot read ACLs even though posting works, so a
    // non-401 failure is reported as indeterminate rather than fatal.
    return {
      verified: false,
      indeterminate: true,
      message: `Could not verify organization role (HTTP ${res.status}); posting will still be attempted`,
    };
  }

  const json = await res.json().catch(() => ({}));
  const elements = Array.isArray(json.elements) ? json.elements : [];
  const orgs = elements.map((e) => e.organization).filter(Boolean);
  const verified = orgs.includes(organizationUrn);
  return {
    verified,
    indeterminate: false,
    administeredOrganizations: orgs,
    message: verified
      ? `Member administers ${organizationUrn}`
      : `Member does NOT administer ${organizationUrn}. Administers: ${orgs.join(', ') || 'none'}`,
  };
}

module.exports = {
  buildAuthorizationUrl,
  exchangeCodeForToken,
  refreshAccessToken,
  checkTokenExpiry,
  hasRequiredScopes,
  verifyOrganizationRole,
  LinkedInAuthError,
  REQUIRED_SCOPES,
  AUTH_URL,
  TOKEN_URL,
  WARN_BEFORE_EXPIRY_DAYS,
};
