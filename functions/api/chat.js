export async function onRequestPost(context) {
  const { env, request } = context;
  const apiKey = env.GROQ_API_KEY;

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

  try {
    const groqResponse = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
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
