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

  const TOOL_ICONS = {
    up2cloud_get_company_overview: '<path d="M4 21V7a2 2 0 012-2h5a2 2 0 012 2v14M4 21h16M4 21H2m11-14h5a2 2 0 012 2v12m0 0h2m-2 0h-4M9 9h1m-1 4h1m-1 4h1"/>',
    up2cloud_list_services: '<path d="M9 5h11M9 12h11M9 19h11M5 5h.01M5 12h.01M5 19h.01"/>',
    up2cloud_get_contact: '<path d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/>',
    up2cloud_search_blog: '<path d="M21 21l-4.35-4.35M11 19a8 8 0 100-16 8 8 0 000 16z"/>',
  };

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>UP2CLOUD MCP Connector</title>
<meta name="robots" content="noindex">
<meta name="description" content="Remote MCP (Model Context Protocol) server for UP2CLOUD — add it to any MCP-compatible AI client.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=DM+Sans:wght@400;500;700&display=swap" rel="stylesheet">
<style>
  /* ── Same design system as up2cloud.tech: colors, gradients, fonts and
     keyframes copied verbatim from src/input.css so this page reads as
     part of the same site rather than a bolted-on developer doc. Kept
     self-contained (no dependency on the compiled Tailwind bundle) so this
     Function never has to worry about class purging. ── */
  *,*::before,*::after{box-sizing:border-box}
  :root{color-scheme:dark}
  html{scroll-behavior:smooth}
  body{margin:0;font-family:'DM Sans',-apple-system,sans-serif;background:#020617;color:#e2e8f0}
  h1,h2,h3{font-family:'Space Grotesk',sans-serif;margin:0}
  a{color:inherit}

  .hero-bg{background:radial-gradient(circle at 15% 20%,rgba(14,165,233,.28),transparent 28%),radial-gradient(circle at 85% 15%,rgba(124,58,237,.28),transparent 26%),radial-gradient(circle at 50% 85%,rgba(249,115,22,.18),transparent 30%),linear-gradient(135deg,#020617 0%,#0F172A 35%,#0C4A6E 68%,#0369A1 100%)}
  .ai-bg{background:linear-gradient(135deg,#1e0533 0%,#2d1060 40%,#0F172A 100%)}
  .glass{background:rgba(255,255,255,.08);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border:1px solid rgba(255,255,255,.15)}
  .blob{position:absolute;border-radius:50%;filter:blur(80px);opacity:.28;animation:float 8s ease-in-out infinite;pointer-events:none}
  .orb-ring{position:absolute;border-radius:999px;border:1px solid rgba(255,255,255,.14);box-shadow:0 0 80px rgba(14,165,233,.16) inset;animation:slowSpin 26s linear infinite;pointer-events:none}
  .ai-badge{display:inline-flex;align-items:center;gap:5px;background:linear-gradient(90deg,rgba(124,58,237,.18),rgba(14,165,233,.18));color:#c4b5fd;font-size:.7rem;font-weight:700;padding:5px 12px;border-radius:999px;letter-spacing:.08em;text-transform:uppercase;border:1px solid rgba(196,181,253,.25)}
  .btn-primary{background:#F97316;color:#fff;font-family:'Space Grotesk',sans-serif;font-weight:600;padding:.8rem 1.6rem;border-radius:8px;transition:background .2s,transform .15s,box-shadow .2s;cursor:pointer;border:none;display:inline-flex;align-items:center;gap:.5rem;min-height:44px;position:relative;overflow:hidden;font-size:.92rem}
  .btn-primary:hover{background:#ea6500;transform:translateY(-1px);box-shadow:0 8px 20px rgba(249,115,22,.35)}
  .btn-outline{background:transparent;color:#fff;font-family:'Space Grotesk',sans-serif;font-weight:600;padding:.8rem 1.6rem;border-radius:8px;border:2px solid rgba(255,255,255,.35);transition:border-color .2s,background .2s;cursor:pointer;display:inline-flex;align-items:center;gap:.5rem;min-height:44px;font-size:.92rem}
  .btn-outline:hover{border-color:#fff;background:rgba(255,255,255,.08)}
  .shine{position:relative;overflow:hidden}
  .shine::after{content:"";position:absolute;top:-120%;left:-30%;width:35%;height:320%;background:linear-gradient(90deg,transparent,rgba(255,255,255,.18),transparent);transform:rotate(25deg);animation:shineSweep 7s ease-in-out infinite}
  .reveal{opacity:0;transform:translateY(24px);transition:opacity .6s ease,transform .6s ease}
  .reveal.visible{opacity:1;transform:none}

  @keyframes float{0%,100%{transform:translateY(0) scale(1)}50%{transform:translateY(-28px) scale(1.04)}}
  @keyframes slowSpin{to{transform:rotate(360deg)}}
  @keyframes shineSweep{0%,72%{left:-45%;opacity:0}78%{opacity:1}100%{left:125%;opacity:0}}
  @keyframes chipFloat{0%,100%{transform:translateY(0px)}50%{transform:translateY(-10px)}}

  .wrap{max-width:880px;margin:0 auto;padding:0 1.5rem}
  header.topbar{position:relative;z-index:2;padding:1.5rem 0}
  header.topbar .wrap{display:flex;align-items:center;justify-content:space-between}
  .logo{display:flex;align-items:center;gap:.65rem;text-decoration:none}
  .logo-mark{width:34px;height:34px;border-radius:8px;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#0369A1,#0EA5E9);flex-shrink:0}
  .logo-word{font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:1.15rem;color:#fff;letter-spacing:-.01em}
  .back-link{font-size:.85rem;color:rgba(255,255,255,.6);text-decoration:none;transition:color .2s}
  .back-link:hover{color:#fff}

  section.hero{position:relative;overflow:hidden;padding:3rem 0 4rem}
  .chip{position:absolute;pointer-events:none;animation:chipFloat 9s ease-in-out infinite;background:rgba(15,23,42,.72);border:1px solid rgba(148,163,184,.25);border-radius:12px;padding:.5rem .85rem;font-size:.72rem;color:rgba(255,255,255,.75);backdrop-filter:blur(10px);display:flex;align-items:center;gap:.4rem}
  .hero h1{font-size:clamp(1.9rem,4.5vw,2.6rem);color:#fff;margin:1rem 0 .75rem;line-height:1.15}
  .hero p.lead{color:rgba(226,232,240,.72);font-size:1.05rem;max-width:560px;line-height:1.6;margin:0 0 1.75rem}
  .endpoint-pill{display:inline-flex;align-items:center;gap:.6rem;padding:.7rem 1rem;border-radius:10px;margin-bottom:1.75rem;font-size:.9rem}
  .endpoint-pill code{font-family:'Space Grotesk',monospace;color:#7dd3fc}
  .copy-btn{background:rgba(255,255,255,.1);border:none;color:#fff;border-radius:6px;padding:.35rem .6rem;font-size:.72rem;cursor:pointer;transition:background .2s;font-family:'DM Sans',sans-serif}
  .copy-btn:hover{background:rgba(255,255,255,.22)}
  .cta-row{display:flex;flex-wrap:wrap;gap:.85rem}

  section.tools{padding:1rem 0 3.5rem}
  section.tools h2, section.test h2{color:#fff;font-size:1.4rem;margin-bottom:1.5rem}
  .tool-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:1rem}
  .tool-card{border-radius:14px;padding:1.35rem;transition:transform .2s ease,box-shadow .2s ease}
  .tool-card:hover{transform:translateY(-4px);box-shadow:0 20px 40px rgba(3,105,161,.22)}
  .tool-icon{width:38px;height:38px;border-radius:9px;background:linear-gradient(135deg,rgba(124,58,237,.25),rgba(14,165,233,.25));display:flex;align-items:center;justify-content:center;margin-bottom:.85rem}
  .tool-icon svg{width:19px;height:19px;stroke:#a5b4fc}
  .tool-card h3{font-size:.85rem;color:#93c5fd;margin-bottom:.4rem;font-family:'Space Grotesk',monospace;word-break:break-word}
  .tool-card p{margin:0;color:rgba(226,232,240,.68);font-size:.86rem;line-height:1.55}

  section.test{padding:0 0 4rem}
  .code-block{border-radius:12px;padding:1.25rem;position:relative;overflow-x:auto}
  .code-block pre{margin:0;font-family:'Space Grotesk',monospace;font-size:.8rem;color:#bae6fd;white-space:pre-wrap;word-break:break-word}
  .meta-line{color:rgba(226,232,240,.55);font-size:.85rem;margin-top:1rem}
  .meta-line code{color:#c4b5fd}

  footer.site-footer{border-top:1px solid rgba(255,255,255,.08);padding:2rem 0;color:rgba(148,163,184,.7);font-size:.82rem}
  footer.site-footer .wrap{display:flex;flex-wrap:wrap;gap:1rem;justify-content:space-between;align-items:center}
  footer.site-footer a{color:rgba(226,232,240,.7);text-decoration:none;transition:color .2s}
  footer.site-footer a:hover{color:#fff}
  footer.site-footer .links{display:flex;gap:1.25rem}

  @media(prefers-reduced-motion:reduce){.blob,.orb-ring,.chip,.shine::after{animation:none}}
</style>
</head>
<body class="hero-bg">

<div class="blob" style="width:340px;height:340px;background:#0EA5E9;top:-60px;left:-80px;animation-delay:0s"></div>
<div class="blob" style="width:300px;height:300px;background:#7C3AED;top:120px;right:-100px;animation-delay:2.5s"></div>
<div class="blob" style="width:260px;height:260px;background:#F97316;bottom:-60px;left:35%;animation-delay:5s;opacity:.16"></div>
<div class="orb-ring" style="width:520px;height:520px;top:-140px;right:-160px"></div>

<header class="topbar">
  <div class="wrap">
    <a href="/" class="logo" aria-label="UP2CLOUD Home">
      <span class="logo-mark"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z" stroke="white" stroke-width="2" stroke-linejoin="round"/></svg></span>
      <span class="logo-word">UP<span style="color:#F97316">2</span><span style="color:#0EA5E9">CLOUD</span></span>
    </a>
    <a href="/" class="back-link">← Back to up2cloud.tech</a>
  </div>
</header>

<section class="hero">
  <div class="chip" style="top:8%;right:6%;animation-delay:.5s" aria-hidden="true">
    <span style="color:#4ade80;font-weight:700">●</span> streamable-http
  </div>
  <div class="chip" style="top:38%;right:2%;animation-delay:3s" aria-hidden="true">
    <span style="color:#7dd3fc">{ }</span> json-rpc 2.0
  </div>
  <div class="wrap">
    <span class="ai-badge">🤖 MCP · AI Connector</span>
    <h1>UP2CLOUD MCP Connector</h1>
    <p class="lead">A remote <a href="https://modelcontextprotocol.io" style="color:#7dd3fc">MCP</a> (Model Context Protocol) server for UP2CLOUD — add it to Claude or any MCP-compatible AI agent to give it read-only access to company info, services, contact details, and blog search.</p>

    <div class="endpoint-pill glass">
      <code id="endpoint-url">https://up2cloud.tech/connect</code>
      <button class="copy-btn" onclick="copyText('endpoint-url', this)">Copy</button>
    </div>

    <div class="cta-row">
      <a href="#test" class="btn-primary shine">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 17l6-6-6-6M12 19h8"/></svg>
        Try it with curl
      </a>
      <a href="/" class="btn-outline">Explore UP2CLOUD</a>
    </div>
  </div>
</section>

<section class="tools">
  <div class="wrap">
    <h2>Available Tools</h2>
    <div class="tool-grid">
      ${TOOLS.map((t) => `<div class="tool-card glass reveal">
        <div class="tool-icon"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${TOOL_ICONS[t.name] || ''}</svg></div>
        <h3>${t.name}</h3>
        <p>${t.description}</p>
      </div>`).join('\n      ')}
    </div>
  </div>
</section>

<section class="test" id="test">
  <div class="wrap">
    <h2>Quick Test</h2>
    <div class="code-block glass">
      <pre id="curl-example">curl -X POST https://up2cloud.tech/connect \\
  -H "Content-Type: application/json" \\
  -H "Accept: application/json" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}'</pre>
    </div>
    <p style="margin-top:.85rem"><button class="copy-btn" onclick="copyText('curl-example', this)">Copy command</button></p>
    <p class="meta-line">Transport: <code>Streamable HTTP</code> · Protocol version: <code>2025-06-18</code> (also accepts <code>2025-03-26</code> and <code>2024-11-05</code>) · No auth required — every tool is read-only.</p>
  </div>
</section>

<footer class="site-footer">
  <div class="wrap">
    <span>© <span id="year"></span> UP2CLOUD · Cesar A. Nogueira</span>
    <div class="links">
      <a href="/">up2cloud.tech</a>
      <a href="/blog/">Blog</a>
      <a href="/privacy/">Privacy</a>
      <a href="https://github.com/UP2CLOUD" target="_blank" rel="noopener noreferrer">GitHub</a>
    </div>
  </div>
</footer>

<script>
  document.getElementById('year').textContent = new Date().getFullYear();

  function copyText(id, btn) {
    var text = document.getElementById(id).textContent;
    navigator.clipboard.writeText(text).then(function () {
      var original = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(function () { btn.textContent = original; }, 1500);
    });
  }

  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('visible');
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.15 });
    document.querySelectorAll('.reveal').forEach(function (el) { io.observe(el); });
  } else {
    document.querySelectorAll('.reveal').forEach(function (el) { el.classList.add('visible'); });
  }
</script>
</body>
</html>`;

  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
