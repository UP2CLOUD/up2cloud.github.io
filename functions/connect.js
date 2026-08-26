/**
 * MCP endpoint — Cloudflare Pages Function
 *
 * A stateless remote MCP (Model Context Protocol) server exposing read-only
 * tools about UP2CLOUD: company overview, service catalog, contact channels,
 * and blog search. Any MCP-compatible client (Claude, other agents) can add
 * https://up2cloud.tech/connect as a remote connector.
 *
 * Transport: Streamable HTTP (MCP spec 2025-06-18), stateless JSON responses
 * only — no SSE, no session IDs. Every POST is handled independently, which
 * keeps this a plain serverless function instead of needing a durable
 * connection. GET is answered with a human-readable landing page for browser
 * visitors; a strict MCP client GET (Accept: text/event-stream) gets 405,
 * since this server never pushes messages on its own.
 *
 * Reference: https://modelcontextprotocol.io/specification/2025-06-18
 */

const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const DEFAULT_PROTOCOL_VERSION = '2025-06-18';

const SERVER_INFO = {
  name: 'up2cloud-mcp-server',
  title: 'UP2CLOUD MCP Server',
  version: '1.0.0',
};

const COMPANY_OVERVIEW = {
  name: 'UP2CLOUD',
  tagline: 'IT Consulting, Cloud & AI Solutions',
  founder: 'Cesar A. Nogueira',
  founderTitle: 'Senior Cloud DevOps & FinOps Consultant',
  website: 'https://up2cloud.tech',
  offices: ['Vila Real, Portugal', 'São Paulo, Brazil', 'Madrid, Spain (coming soon)'],
  summary:
    'UP2CLOUD helps organizations migrate, secure, and optimize cloud infrastructure ' +
    'across AWS, Azure, GCP, and Oracle Cloud, combining DevOps/DevSecOps practice with ' +
    'FinOps cost discipline and applied AI.',
};

const SERVICES = [
  { id: 'cloud-migration', name: 'Cloud Migration', description: 'Migration and modernization across AWS, Azure, GCP, and Oracle Cloud.' },
  { id: 'devops-devsecops', name: 'DevOps & DevSecOps', description: 'Kubernetes, Terraform IaC, CI/CD pipelines (Jenkins, GitHub Actions), security-integrated delivery.' },
  { id: 'finops', name: 'FinOps & Cost Optimization', description: 'Cloud cost audits, tagging strategy, rightsizing, reserved/spot capacity — average 42% spend reduction.' },
  { id: 'security', name: 'Cybersecurity', description: 'ISO 27001 alignment, Zero Trust architecture, GDPR/LGPD compliance.' },
  { id: 'ai-solutions', name: 'AI Solutions', description: 'OpenClaw autonomous ops installation, AI agent teams, custom chatbots and automation.' },
  { id: 'offshore-teams', name: 'APAC Offshore Teams', description: 'Offshore engineering teams delivering up to 60% cost savings versus EU/US hires.' },
  { id: 'digital-transformation', name: 'Digital Transformation', description: 'RPA, AI/ML integration, and legacy system modernization.' },
];

const CONTACT = {
  email: 'hello@up2cloud.tech',
  whatsapp: '+351 937 471 554',
  whatsappLink: 'https://wa.me/351937471554',
  linkedin: 'https://www.linkedin.com/in/cesarnog/',
  github: 'https://github.com/UP2CLOUD',
  website: 'https://up2cloud.tech',
};

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, MCP-Protocol-Version',
};

const TOOLS = [
  {
    name: 'up2cloud_get_company_overview',
    title: 'Get UP2CLOUD company overview',
    description: 'Get a short overview of UP2CLOUD — founder, tagline, offices, and what the company does.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'up2cloud_list_services',
    title: 'List UP2CLOUD services',
    description: 'List UP2CLOUD\'s consulting service offerings (cloud migration, DevOps, FinOps, security, AI, offshore teams, digital transformation) with a short description of each.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'up2cloud_get_contact',
    title: 'Get UP2CLOUD contact details',
    description: 'Get UP2CLOUD\'s contact channels — email, WhatsApp, LinkedIn, GitHub, and website.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'up2cloud_search_blog',
    title: 'Search UP2CLOUD blog',
    description: 'Search UP2CLOUD\'s blog posts by keyword across title, excerpt, and category. Returns matching posts with title, URL, excerpt, category, and publish date.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keyword(s) to search for, e.g. "FinOps" or "Kubernetes".' },
        limit: { type: 'integer', description: 'Max results to return.', minimum: 1, maximum: 50, default: 10 },
      },
      required: ['query'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS, ...headers },
  });
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message, data) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data ? { data } : {}) } };
}

function toolTextResult(structured, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }],
    structuredContent: structured,
    isError,
  };
}

async function callTool(name, args, { request, env }) {
  switch (name) {
    case 'up2cloud_get_company_overview':
      return toolTextResult(COMPANY_OVERVIEW);

    case 'up2cloud_list_services':
      return toolTextResult({ services: SERVICES });

    case 'up2cloud_get_contact':
      return toolTextResult(CONTACT);

    case 'up2cloud_search_blog': {
      const query = typeof args?.query === 'string' ? args.query.trim() : '';
      if (!query) {
        return {
          content: [{ type: 'text', text: 'Error: "query" is required and must be a non-empty string.' }],
          isError: true,
        };
      }
      const limit = Number.isInteger(args?.limit) ? Math.min(Math.max(args.limit, 1), 50) : 10;

      if (!env.ASSETS) {
        return {
          content: [{ type: 'text', text: 'Error: blog index is not available on this deployment.' }],
          isError: true,
        };
      }

      let posts;
      try {
        const assetUrl = new URL('/blog/posts.json', request.url);
        const res = await env.ASSETS.fetch(new Request(assetUrl));
        if (!res.ok) throw new Error(`status ${res.status}`);
        posts = await res.json();
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error: failed to load blog index (${err.message}).` }],
          isError: true,
        };
      }

      const needle = query.toLowerCase();
      const matches = (Array.isArray(posts) ? posts : [])
        .filter((p) =>
          p.title?.toLowerCase().includes(needle) ||
          p.excerpt?.toLowerCase().includes(needle) ||
          p.category?.toLowerCase().includes(needle),
        )
        .sort((a, b) => (a.date < b.date ? 1 : -1))
        .slice(0, limit)
        .map((p) => ({
          title: p.title,
          url: `https://up2cloud.tech/blog/${p.slug}/`,
          excerpt: p.excerpt,
          category: p.category,
          date: p.date,
        }));

      return toolTextResult({ query, count: matches.length, posts: matches });
    }

    default:
      return null; // signals "unknown tool" to the caller, which raises a protocol error
  }
}

async function handleRpc(msg, ctx) {
  const { id, method, params } = msg || {};
  const isNotification = id === undefined;

  switch (method) {
    case 'initialize': {
      const requested = params?.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : DEFAULT_PROTOCOL_VERSION;
      return rpcResult(id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions:
          'Read-only tools describing UP2CLOUD, an IT consulting firm (cloud, DevOps, FinOps, ' +
          'security, AI). Use up2cloud_get_company_overview to start, up2cloud_list_services ' +
          'for the service catalog, up2cloud_search_blog to find articles, and ' +
          'up2cloud_get_contact for how to reach the team.',
      });
    }

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null; // notification — no response body, handled by the caller as 202

    case 'ping':
      return rpcResult(id, {});

    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });

    case 'tools/call': {
      const name = params?.name;
      const args = params?.arguments || {};
      if (typeof name !== 'string' || !TOOLS.some((t) => t.name === name)) {
        return rpcError(id, -32602, `Unknown tool: ${name}`);
      }
      try {
        const result = await callTool(name, args, ctx);
        return rpcResult(id, result);
      } catch (err) {
        return rpcResult(id, {
          content: [{ type: 'text', text: `Error: ${err.message}` }],
          isError: true,
        });
      }
    }

    default:
      if (isNotification) return null;
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: CORS_HEADERS });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  const protocolVersionHeader = request.headers.get('MCP-Protocol-Version');
  if (protocolVersionHeader && !SUPPORTED_PROTOCOL_VERSIONS.includes(protocolVersionHeader)) {
    return jsonResponse(
      rpcError(null, -32602, 'Unsupported protocol version', {
        supported: SUPPORTED_PROTOCOL_VERSIONS,
        requested: protocolVersionHeader,
      }),
      { status: 400 },
    );
  }

  let msg;
  try {
    msg = await request.json();
  } catch {
    return jsonResponse(rpcError(null, -32700, 'Parse error'), { status: 400 });
  }

  if (Array.isArray(msg)) {
    // JSON-RPC batching was removed from MCP as of the 2025-06-18 spec.
    return jsonResponse(rpcError(null, -32600, 'Batch requests are not supported'), { status: 400 });
  }

  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return jsonResponse(rpcError(msg?.id ?? null, -32600, 'Invalid Request'), { status: 400 });
  }

  const response = await handleRpc(msg, { request, env });

  // A JSON-RPC notification (no "id") never gets a body — 202 Accepted per spec.
  if (response === null) {
    return new Response(null, { status: 202, headers: CORS_HEADERS });
  }

  return jsonResponse(response);
}

export async function onRequestGet(context) {
  const { request } = context;
  const accept = request.headers.get('Accept') || '';

  if (!accept.includes('text/html')) {
    // A strict MCP client probing for a server-initiated SSE stream: this
    // server never pushes messages on its own, so decline per spec rather
    // than pretending to open a stream.
    return new Response(
      JSON.stringify({ error: 'This server does not support server-initiated streams. Send JSON-RPC requests via POST.' }),
      { status: 405, headers: { 'Content-Type': 'application/json', Allow: 'POST, OPTIONS', ...CORS_HEADERS } },
    );
  }

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>UP2CLOUD MCP Connector</title>
<meta name="robots" content="noindex">
<style>
  :root { color-scheme: dark; }
  body { margin: 0; background: #0b0f19; color: #e2e8f0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  main { max-width: 720px; margin: 0 auto; padding: 4rem 1.5rem; }
  h1 { font-size: 1.75rem; margin-bottom: 0.25rem; }
  p.lead { color: #94a3b8; margin-top: 0; }
  code, pre { background: #131a2a; border: 1px solid #1f2937; border-radius: 6px; }
  code { padding: 0.15rem 0.4rem; font-size: 0.9em; }
  pre { padding: 1rem; overflow-x: auto; }
  .tool { border: 1px solid #1f2937; border-radius: 8px; padding: 1rem; margin: 0.75rem 0; }
  .tool h3 { margin: 0 0 0.35rem; font-size: 1rem; color: #93c5fd; }
  .tool p { margin: 0; color: #cbd5e1; font-size: 0.92rem; }
  a { color: #60a5fa; }
  footer { margin-top: 3rem; color: #64748b; font-size: 0.85rem; }
</style>
</head>
<body>
<main>
  <h1>UP2CLOUD MCP Connector</h1>
  <p class="lead">A remote MCP (Model Context Protocol) server for UP2CLOUD — add it to any MCP-compatible client (Claude, other AI agents) as a remote connector.</p>

  <p><strong>Endpoint URL:</strong> <code>https://up2cloud.tech/connect</code></p>
  <p>Transport: Streamable HTTP · Protocol version: <code>2025-06-18</code> (also accepts <code>2025-03-26</code> and <code>2024-11-05</code>)</p>

  <h2>Available tools</h2>
  ${TOOLS.map((t) => `<div class="tool"><h3>${t.name}</h3><p>${t.description}</p></div>`).join('\n  ')}

  <h2>Quick test</h2>
  <pre>curl -X POST https://up2cloud.tech/connect \\
  -H "Content-Type: application/json" \\
  -H "Accept: application/json" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}'</pre>

  <footer>UP2CLOUD · <a href="https://up2cloud.tech">up2cloud.tech</a> · <a href="https://up2cloud.tech/privacy/">Privacy</a></footer>
</main>
</body>
</html>`;

  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
