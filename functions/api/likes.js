/**
 * Likes API — Cloudflare Pages Function
 * KV binding required: UP2CLOUD_LIKES
 *
 * GET  /api/likes?post=<slug>  → { count: number }
 * POST /api/likes              → { post } → { count: number }
 *
 * Duplicate-like prevention: one like per IP per post per 24h (server-side),
 * combined with localStorage flag (client-side) for instant UI feedback.
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

export async function onRequestOptions() {
  return new Response(null, { headers: CORS_HEADERS });
}

export async function onRequestGet(context) {
  const { request, env } = context;

  if (!env.UP2CLOUD_LIKES) {
    return json({ error: 'Likes storage not configured' }, 503);
  }

  const url = new URL(request.url);
  const post = slugify(url.searchParams.get('post'));
  if (!post) return json({ error: 'Missing post parameter' }, 400);

  const raw = await env.UP2CLOUD_LIKES.get(`likes:${post}`);
  return json({ count: raw ? parseInt(raw, 10) : 0 });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.UP2CLOUD_LIKES) {
    return json({ error: 'Likes storage not configured' }, 503);
  }

  // Origin guard
  const origin = request.headers.get('Origin') || '';
  const ALLOWED_ORIGINS = ['https://up2cloud.tech', 'https://up2cloud-tech.pages.dev'];
  if (!ALLOWED_ORIGINS.includes(origin)) {
    return json({ error: 'Forbidden' }, 403);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const post = slugify(body.post);
  if (!post) return json({ error: 'Missing post' }, 400);

  // Per-IP dedup: one like per post per IP per 24h
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const dupKey = `liked:${ip}:${post}`;
  const alreadyLiked = await env.UP2CLOUD_LIKES.get(dupKey);
  if (alreadyLiked) {
    const count = parseInt((await env.UP2CLOUD_LIKES.get(`likes:${post}`)) || '0', 10);
    return json({ count, alreadyLiked: true });
  }

  // Increment like count
  const raw = await env.UP2CLOUD_LIKES.get(`likes:${post}`);
  const newCount = (raw ? parseInt(raw, 10) : 0) + 1;
  await env.UP2CLOUD_LIKES.put(`likes:${post}`, String(newCount));

  // Record IP dedup for 24h (we store a marker, not the IP itself as a value)
  await env.UP2CLOUD_LIKES.put(dupKey, '1', { expirationTtl: 86400 });

  return json({ count: newCount, alreadyLiked: false });
}
