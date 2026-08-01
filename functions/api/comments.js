/**
 * Comments API — Cloudflare Pages Function
 * KV binding required: UP2CLOUD_COMMENTS
 *
 * GET  /api/comments?post=<slug>  → { comments: [{name, message, date, id}] }
 * POST /api/comments              → { name, email, message, post, website } → { ok, count }
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': 'https://up2cloud.tech',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function slugify(s) {
  return (s || '').replace(/[^a-z0-9-]/g, '').slice(0, 120);
}

async function rateLimit(env, ip) {
  if (!env.UP2CLOUD_COMMENTS) return false;
  const key = `rl:comment:${ip}`;
  const raw = await env.UP2CLOUD_COMMENTS.get(key);
  const count = raw ? parseInt(raw, 10) : 0;
  if (count >= 5) return true; // blocked: 5 comments per 10 min per IP
  await env.UP2CLOUD_COMMENTS.put(key, String(count + 1), { expirationTtl: 600 });
  return false;
}

export async function onRequestOptions() {
  return new Response(null, { headers: CORS_HEADERS });
}

export async function onRequestGet(context) {
  const { request, env } = context;

  if (!env.UP2CLOUD_COMMENTS) {
    return json({ error: 'Comments storage not configured' }, 503);
  }

  const url = new URL(request.url);
  const post = slugify(url.searchParams.get('post'));
  if (!post) return json({ error: 'Missing post parameter' }, 400);

  const raw = await env.UP2CLOUD_COMMENTS.get(`comments:${post}`);
  const comments = raw ? JSON.parse(raw) : [];

  // Only expose safe fields — never email
  const safe = comments.map(({ name, message, date, id }) => ({ name, message, date, id }));
  return json({ comments: safe });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.UP2CLOUD_COMMENTS) {
    return json({ error: 'Comments storage not configured' }, 503);
  }

  // Origin guard
  const origin = request.headers.get('Origin') || '';
  const ALLOWED_ORIGINS = ['https://up2cloud.tech', 'https://up2cloud-tech.pages.dev'];
  if (!ALLOWED_ORIGINS.includes(origin)) {
    return json({ error: 'Forbidden' }, 403);
  }

  // Rate limiting by IP
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (await rateLimit(env, ip)) {
    return json({ error: 'Too many requests. Please wait a few minutes.' }, 429);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  // Honeypot — bot submitted the hidden field
  if (body.website) {
    return json({ ok: true, count: 0 }); // silently discard
  }

  const { post, name, email, message } = body;

  // Validation
  if (!post || !name || !email || !message) {
    return json({ error: 'All fields are required' }, 400);
  }
  if (typeof name !== 'string' || name.trim().length < 2 || name.length > 80) {
    return json({ error: 'Name must be 2–80 characters' }, 400);
  }
  if (typeof message !== 'string' || message.trim().length < 5 || message.length > 2000) {
    return json({ error: 'Comment must be 5–2000 characters' }, 400);
  }
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ error: 'Invalid email address' }, 400);
  }
  // Reject if comment contains excessive URLs (spam signal)
  const urlCount = (message.match(/https?:\/\//gi) || []).length;
  if (urlCount > 2) {
    return json({ error: 'Comment contains too many links' }, 400);
  }

  const slug = slugify(post);
  const raw = await env.UP2CLOUD_COMMENTS.get(`comments:${slug}`);
  const comments = raw ? JSON.parse(raw) : [];

  // Store raw text — escaping happens client-side via textContent
  comments.push({
    id: crypto.randomUUID(),
    name: name.trim().slice(0, 80),
    email, // stored but never returned to client
    message: message.trim().slice(0, 2000),
    date: new Date().toISOString(),
  });

  await env.UP2CLOUD_COMMENTS.put(`comments:${slug}`, JSON.stringify(comments));

  return json({ ok: true, count: comments.length });
}
