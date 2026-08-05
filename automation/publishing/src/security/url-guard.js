'use strict';

const dns = require('node:dns').promises;
const net = require('node:net');

/**
 * SSRF guard for research fetches.
 *
 * The pipeline follows URLs suggested by a language model, which in turn read
 * from the open web — so a URL can be adversary-chosen end to end. We therefore
 * (a) allow only http(s), (b) reject credentials/non-standard ports, and
 * (c) resolve DNS and check *every* returned address against private ranges,
 * which is what stops the DNS-rebinding and `foo.local`-style bypasses that a
 * hostname blacklist misses.
 */

class UrlSecurityError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UrlSecurityError';
  }
}

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);
const ALLOWED_PORTS = new Set(['', '80', '443']);

/** Hostnames that must never be resolved, regardless of what DNS says. */
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
]);

const BLOCKED_HOST_SUFFIXES = ['.local', '.internal', '.localdomain', '.home.arpa', '.onion'];

function ipv4ToInt(ip) {
  return ip.split('.').reduce((acc, oct) => (acc << 8) + Number(oct), 0) >>> 0;
}

/** RFC1918 + loopback + link-local + CGNAT + reserved, as [network, prefix]. */
const BLOCKED_V4_CIDRS = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, incl. cloud metadata 169.254.169.254
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved
];

function isPrivateIPv4(ip) {
  const value = ipv4ToInt(ip);
  return BLOCKED_V4_CIDRS.some(([network, prefix]) => {
    const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
    return (value & mask) === (ipv4ToInt(network) & mask);
  });
}

function isPrivateIPv6(ip) {
  const addr = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (addr === '::' || addr === '::1') return true;
  if (addr.startsWith('fe80') || addr.startsWith('fec0')) return true; // link/site-local
  if (/^f[cd]/.test(addr)) return true; // unique local fc00::/7
  // IPv4-mapped (::ffff:a.b.c.d) inherits the IPv4 verdict.
  const mapped = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIPv4(mapped[1]);
  return false;
}

function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) return isPrivateIPv4(ip);
  if (net.isIPv6(ip)) return isPrivateIPv6(ip);
  return true; // unparseable -> refuse
}

/** Synchronous structural checks. Split out so tests can run without DNS. */
function assertUrlShape(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl));
  } catch {
    throw new UrlSecurityError(`Malformed URL: ${String(rawUrl).slice(0, 120)}`);
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new UrlSecurityError(`Blocked protocol "${url.protocol}" (only http/https allowed)`);
  }
  if (url.username || url.password) {
    throw new UrlSecurityError('URLs with embedded credentials are not allowed');
  }
  if (!ALLOWED_PORTS.has(url.port)) {
    throw new UrlSecurityError(`Blocked non-standard port "${url.port}"`);
  }

  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) throw new UrlSecurityError('URL has no hostname');
  if (BLOCKED_HOSTNAMES.has(host)) {
    throw new UrlSecurityError(`Blocked hostname "${host}"`);
  }
  if (BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) {
    throw new UrlSecurityError(`Blocked internal hostname suffix on "${host}"`);
  }
  // A literal private IP needs no DNS round trip to reject.
  if ((net.isIP(host) && isPrivateAddress(host)) || isPrivateIPv6(host)) {
    throw new UrlSecurityError(`Blocked private address "${host}"`);
  }

  return url;
}

/**
 * Full check: shape + DNS resolution, rejecting if *any* resolved address is
 * private. Returns the parsed URL and the addresses it resolved to.
 */
async function assertPublicUrl(rawUrl, { resolver = dns } = {}) {
  const url = assertUrlShape(rawUrl);
  const host = url.hostname.toLowerCase().replace(/\.$/, '');

  if (net.isIP(host)) return { url, addresses: [host] };

  let addresses = [];
  try {
    const records = await resolver.lookup(host, { all: true, verbatim: true });
    addresses = records.map((r) => r.address);
  } catch (err) {
    throw new UrlSecurityError(`DNS resolution failed for "${host}": ${err.code || err.message}`);
  }

  if (!addresses.length) {
    throw new UrlSecurityError(`Hostname "${host}" resolved to no addresses`);
  }
  for (const address of addresses) {
    if (isPrivateAddress(address)) {
      throw new UrlSecurityError(
        `Hostname "${host}" resolves to private address ${address} — blocked`,
      );
    }
  }
  return { url, addresses };
}

/**
 * Fetch with SSRF checks, a byte cap and manual redirect handling — each hop is
 * re-validated, because an allowed host can 302 to 169.254.169.254.
 */
async function safeFetch(rawUrl, options = {}) {
  const {
    maxBytes = 1_500_000,
    timeoutMs = 15_000,
    maxRedirects = 3,
    fetchImpl = globalThis.fetch,
    resolver = dns,
    headers = {},
  } = options;

  let current = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const { url } = await assertPublicUrl(current, { resolver });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(url.toString(), {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'user-agent': 'UP2CLOUD-Autopublish/1.0 (+https://up2cloud.tech)',
          accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
          ...headers,
        },
      });
    } finally {
      clearTimeout(timer);
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw new UrlSecurityError(`Redirect without Location from ${url}`);
      current = new URL(location, url).toString();
      continue;
    }

    const declared = Number(response.headers.get('content-length') || 0);
    if (declared && declared > maxBytes) {
      throw new UrlSecurityError(`Response exceeds ${maxBytes} bytes (declared ${declared})`);
    }

    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) {
      throw new UrlSecurityError(`Response exceeds ${maxBytes} bytes`);
    }

    return {
      url: url.toString(),
      status: response.status,
      ok: response.ok,
      contentType: response.headers.get('content-type') || '',
      body: Buffer.from(buffer).toString('utf8'),
      headers: response.headers,
    };
  }
  throw new UrlSecurityError(`Exceeded ${maxRedirects} redirects starting from ${rawUrl}`);
}

module.exports = {
  UrlSecurityError,
  assertUrlShape,
  assertPublicUrl,
  safeFetch,
  isPrivateAddress,
  isPrivateIPv4,
  isPrivateIPv6,
};
