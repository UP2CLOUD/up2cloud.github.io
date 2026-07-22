#!/usr/bin/env node
/**
 * UP2CLOUD — Local Dev Server
 * Simulates CI/CD production injection of secrets.
 * Usage: node serve.js   or   npm start
 * Reads GROQ_API_KEY from .env and injects it into index.html at request time.
 */

const http = require('http');
const fs   = require('fs');
const path = require('path');
const { resolveIncludes } = require('./scripts/resolve-includes');

/* ── Load .env ─────────────────────────────────────────────────── */
function loadEnv(file = '.env') {
  const env = {};
  try {
    fs.readFileSync(file, 'utf8').split('\n').forEach(line => {
      line = line.trim();
      if (!line || line.startsWith('#')) return;
      const eq = line.indexOf('=');
      if (eq < 0) return;
      const key = line.slice(0, eq).trim();
      const val = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      env[key] = val;
    });
  } catch { /* .env optional */ }
  return env;
}

const ENV  = loadEnv();
const PORT = parseInt(ENV.PORT || process.env.PORT || '3000', 10);

/* ── MIME types ─────────────────────────────────────────────────── */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.woff2':'font/woff2',
  '.woff': 'font/woff',
  '.ttf':  'font/ttf',
};

/* ── Server ─────────────────────────────────────────────────────── */
const ROOT = __dirname;

http.createServer((req, res) => {
  let pathname = new URL(req.url, 'http://localhost').pathname;

  // Default to index.html
  if (pathname === '/' || pathname === '') pathname = '/index.html';

  // ── AI Chat Proxy Simulation ──────────────────────────────────
  if (req.method === 'POST' && pathname === '/api/chat') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      if (!ENV.GROQ_API_KEY) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'GROQ_API_KEY not found in .env' }));
      }
      try {
        const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${ENV.GROQ_API_KEY}`
          },
          body: body
        });
        const data = await groqRes.json();
        res.writeHead(groqRes.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      } catch (e) {
        res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Resolve & guard against path traversal
  const filePath = path.resolve(ROOT, '.' + pathname);
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403); return res.end('Forbidden');
  }

  const ext         = path.extname(filePath).toLowerCase();
  const contentType = MIME[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, raw) => {
    if (err) {
      if (err.code === 'ENOENT') {
        // Return a transparent 1×1 PNG for missing images instead of a noisy 404
        if (['.jpg','.jpeg','.png','.webp','.gif'].includes(path.extname(filePath).toLowerCase())) {
          const px = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==','base64');
          res.writeHead(200, {'Content-Type':'image/png','Content-Length':px.length,'Cache-Control':'no-store'});
          return res.end(px);
        }
        res.writeHead(404); return res.end('Not found');
      }
      res.writeHead(500); return res.end('Server error');
    }

    let body = raw;
    if (ext === '.html') {
      try {
        body = Buffer.from(resolveIncludes(raw.toString('utf8')));
      } catch (e) {
        res.writeHead(500); return res.end('Include resolution error: ' + e.message);
      }
    }
    res.writeHead(200, {
      'Content-Type':   contentType,
      'Content-Length': body.length,
      'Cache-Control':  'no-store',
    });
    res.end(body);
  });

}).listen(PORT, '127.0.0.1', () => {
  const keyStatus = ENV.GROQ_API_KEY
    ? `✅  ${ENV.GROQ_API_KEY.slice(0, 8)}••••••••`
    : '❌  not found in .env';

  console.log('\n  ┌─────────────────────────────────────────┐');
  console.log(`  │  🚀  http://localhost:${PORT}               │`);
  console.log('  │                                         │');
  console.log(`  │  GROQ_API_KEY  ${keyStatus.padEnd(25)}│`);
  console.log('  │  Mode          production simulation    │');
  console.log('  └─────────────────────────────────────────┘\n');
  console.log('  Press Ctrl+C to stop.\n');
});
