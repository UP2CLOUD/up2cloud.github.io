/**
 * Newsletter subscription API — Cloudflare Pages Function
 * Proxies to Brevo (formerly Sendinblue) API.
 *
 * Required env vars (set in Cloudflare Pages → Settings → Environment Variables):
 *   BREVO_API_KEY   — your Brevo API key
 *   BREVO_LIST_ID   — numeric ID of your Brevo contact list (e.g. "2")
 *
 * POST /api/newsletter → { email } → { ok } | { error }
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': 'https://up2cloud.tech',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

export async function onRequestOptions() {
  return new Response(null, { headers: CORS_HEADERS });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.BREVO_API_KEY) {
    return json({ error: 'Newsletter service not configured' }, 503);
  }

  // Origin guard
  const origin = request.headers.get('Origin') || '';
  const ALLOWED_ORIGINS = ['https://up2cloud.tech', 'https://up2cloud-tech.pages.dev'];
  if (!ALLOWED_ORIGINS.includes(origin)) {
    return json({ error: 'Forbidden' }, 403);
  }

  // Rate limit by IP — 3 attempts per hour
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const rlKey = `rl:newsletter:${ip}`;
  if (env.UP2CLOUD_LIKES) { // reuse any available KV for rate limiting
    const raw = await env.UP2CLOUD_LIKES.get(rlKey);
    const count = raw ? parseInt(raw, 10) : 0;
    if (count >= 3) return json({ error: 'Too many requests' }, 429);
    await env.UP2CLOUD_LIKES.put(rlKey, String(count + 1), { expirationTtl: 3600 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  // Honeypot
  if (body.website) return json({ ok: true });

  const { email } = body;
  if (!email || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ error: 'Invalid email address' }, 400);
  }

  const listId = parseInt(env.BREVO_LIST_ID || '1', 10);

  const brevoRes = await fetch('https://api.brevo.com/v3/contacts', {
    method: 'POST',
    headers: {
      'api-key': env.BREVO_API_KEY,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({
      email: email.trim().toLowerCase(),
      listIds: [listId],
      updateEnabled: true, // re-subscribe if they unsubscribed before
      attributes: {
        SOURCE: 'up2cloud-website',
      },
    }),
  });

  if (brevoRes.ok || brevoRes.status === 204) {
    return json({ ok: true });
  }

  // 400 with code "duplicate_parameter" means already subscribed — treat as success
  const errBody = await brevoRes.json().catch(() => ({}));
  if (errBody.code === 'duplicate_parameter') {
    return json({ ok: true, alreadySubscribed: true });
  }

  console.error('Brevo error:', brevoRes.status, JSON.stringify(errBody));
  return json({ error: 'Subscription failed. Please try again.' }, 502);
}
