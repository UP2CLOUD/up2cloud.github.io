const ALLOWED_ORIGINS = ["https://up2cloud.tech", "https://up2cloud-tech.pages.dev"];

// Kept as its own constant (rather than inline in safeBody below) so
// scripts/groq-model-failover.js can find-and-replace it by exact string
// match when Groq deprecates it.
const MODEL = "openai/gpt-oss-20b";

// Reasoning models (openai/gpt-oss-*) accept reasoning_effort/reasoning_format;
// other models reject those fields with a 400. Keep this in sync with
// whatever MODEL is set to, including when the failover script swaps it.
const REASONING_MODELS = new Set(["openai/gpt-oss-20b", "openai/gpt-oss-120b"]);

export async function onRequestPost(context) {
  const { env, request } = context;
  const apiKey = env.GROQ_API_KEY;

  const origin = request.headers.get("Origin") || "";
  if (!ALLOWED_ORIGINS.includes(origin)) {
    return new Response(JSON.stringify({ error: "Forbidden" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!apiKey) {
    return new Response(JSON.stringify({ error: "Groq API key not configured on server." }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Rate limit by IP — 20 requests per hour, same KV namespace as newsletter/likes
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const rlKey = `rl:chat:${ip}`;
  if (env.UP2CLOUD_LIKES) {
    const raw = await env.UP2CLOUD_LIKES.get(rlKey);
    const count = raw ? parseInt(raw, 10) : 0;
    if (count >= 20) {
      return new Response(JSON.stringify({ error: "Too many requests. Please try again later." }), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      });
    }
    await env.UP2CLOUD_LIKES.put(rlKey, String(count + 1), { expirationTtl: 3600 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Whitelist only the fields the proxy should relay; enforce model and cap tokens
  const messages = Array.isArray(body.messages) ? body.messages.slice(0, 50) : [];
  const maxTokens = typeof body.max_tokens === "number"
    ? Math.min(Math.max(Math.round(body.max_tokens), 1), 500)
    : 350;
  const temperature = typeof body.temperature === "number"
    ? Math.min(Math.max(body.temperature, 0), 2)
    : 0.7;

  const safeBody = {
    model: MODEL,
    messages,
    max_tokens: maxTokens,
    temperature,
    stream: false,
  };

  if (REASONING_MODELS.has(MODEL)) {
    // Reasoning models spend part of max_tokens thinking before writing the
    // visible answer. "low" keeps that budget small so short max_tokens
    // callers (e.g. the terminal demo's 220) still get a populated `content`
    // instead of finish_reason "length" with nothing to show. "hidden" drops
    // the reasoning trace from the response entirely — callers here only
    // ever read `.content`.
    safeBody.reasoning_effort = "low";
    safeBody.reasoning_format = "hidden";
  }

  try {
    const groqResponse = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(safeBody),
    });

    const data = await groqResponse.json();
    return new Response(JSON.stringify(data), {
      status: groqResponse.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch {
    return new Response(JSON.stringify({ error: "Failed to communicate with Groq API." }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
