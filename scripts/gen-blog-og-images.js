#!/usr/bin/env node
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const W = 1200, H = 630;

const ACCENTS = {
  FinOps:   { fg: '#34D399', bg: 'rgba(5,150,105,0.16)', border: 'rgba(52,211,153,0.35)', glow: '#059669' },
  DevOps:   { fg: '#38BDF8', bg: 'rgba(3,105,161,0.16)',  border: 'rgba(56,189,248,0.35)', glow: '#0EA5E9' },
  AI:       { fg: '#A78BFA', bg: 'rgba(124,58,237,0.16)', border: 'rgba(167,139,250,0.35)', glow: '#7C3AED' },
  Security: { fg: '#FB923C', bg: 'rgba(234,88,12,0.16)',  border: 'rgba(251,146,60,0.35)',  glow: '#EA580C' },
};

function escapeXml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Greedy word-wrap by estimated glyph width (Space Grotesk bold ~0.58*fontSize per char average)
function wrapTitle(title, maxWidth, fontSize) {
  const charWidth = fontSize * 0.56;
  const maxChars = Math.floor(maxWidth / charWidth);
  const words = title.split(' ');
  const lines = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? current + ' ' + word : word;
    if (candidate.length > maxChars && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function buildSvg(post) {
  const accent = ACCENTS[post.category] || ACCENTS.DevOps;
  const contentWidth = W - 144; // 72px margin each side
  let fontSize = post.title.length > 70 ? 46 : post.title.length > 50 ? 52 : 58;
  let lines = wrapTitle(post.title, contentWidth, fontSize);
  if (lines.length > 3) {
    fontSize = 42;
    lines = wrapTitle(post.title, contentWidth, fontSize);
  }
  lines = lines.slice(0, 3);
  const lineHeight = fontSize * 1.18;
  const titleStartY = 260;

  const titleLines = lines.map((line, i) =>
    `<text x="72" y="${titleStartY + i * lineHeight}" font-family="'Space Grotesk','Inter',Arial,sans-serif" font-size="${fontSize}" font-weight="800" fill="white" letter-spacing="-1">${escapeXml(line)}</text>`
  ).join('\n  ');

  const dateStr = new Date(post.date + 'T00:00:00Z').toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%"   stop-color="#020617"/>
      <stop offset="35%"  stop-color="#0F172A"/>
      <stop offset="68%"  stop-color="#0C4A6E"/>
      <stop offset="100%" stop-color="#0369A1"/>
    </linearGradient>
    <radialGradient id="glowA" cx="88%" cy="12%" r="38%">
      <stop offset="0%" stop-color="${accent.glow}" stop-opacity="0.30"/>
      <stop offset="100%" stop-color="${accent.glow}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="glowB" cx="10%" cy="95%" r="35%">
      <stop offset="0%" stop-color="#0EA5E9" stop-opacity="0.16"/>
      <stop offset="100%" stop-color="#0EA5E9" stop-opacity="0"/>
    </radialGradient>
  </defs>

  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <rect width="${W}" height="${H}" fill="url(#glowA)"/>
  <rect width="${W}" height="${H}" fill="url(#glowB)"/>

  <circle cx="1060" cy="60" r="240" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="1.5"/>

  <!-- Logo -->
  <rect x="72" y="64" width="52" height="52" rx="13" fill="rgba(15,23,42,0.80)" stroke="rgba(14,165,233,0.30)" stroke-width="1.5"/>
  <path d="M83 96a7.5 7.5 0 007.5 7.5h16.8a9.3 9.3 0 100-18.6 9.3 9.3 0 00-18.2 3.9A7.5 7.5 0 0083 96z" stroke="#0EA5E9" stroke-width="2" stroke-linejoin="round" fill="none"/>
  <text x="140" y="98" font-family="'Space Grotesk','Inter',Arial,sans-serif" font-size="30" font-weight="800" fill="white" letter-spacing="-0.5">UP<tspan fill="#F97316">2</tspan><tspan fill="#0EA5E9">CLOUD</tspan></text>

  <!-- Category badge -->
  <rect x="72" y="150" width="${58 + post.category.length * 13}" height="34" rx="17" fill="${accent.bg}" stroke="${accent.border}" stroke-width="1"/>
  <text x="${72 + (58 + post.category.length * 13) / 2}" y="172" font-family="'Space Grotesk',Arial,sans-serif" font-size="15" font-weight="700" fill="${accent.fg}" letter-spacing="1" text-anchor="middle">${escapeXml(post.category.toUpperCase())}</text>

  <!-- Title -->
  ${titleLines}

  <!-- Divider -->
  <line x1="72" y1="500" x2="1128" y2="500" stroke="rgba(255,255,255,0.08)" stroke-width="1"/>

  <!-- Byline -->
  <circle cx="88" cy="546" r="16" fill="rgba(14,165,233,0.18)" stroke="rgba(14,165,233,0.4)" stroke-width="1.5"/>
  <text x="88" y="551" font-family="'Space Grotesk',Arial,sans-serif" font-size="14" font-weight="700" fill="#38BDF8" text-anchor="middle">CN</text>
  <text x="116" y="542" font-family="'Inter',Arial,sans-serif" font-size="17" font-weight="600" fill="rgba(255,255,255,0.85)">Cesar A. Nogueira</text>
  <text x="116" y="562" font-family="'Inter',Arial,sans-serif" font-size="14" fill="rgba(255,255,255,0.45)">${escapeXml(dateStr)}</text>

  <!-- URL badge -->
  <rect x="900" y="524" width="228" height="48" rx="10" fill="rgba(255,255,255,0.05)" stroke="rgba(255,255,255,0.12)" stroke-width="1"/>
  <text x="1014" y="554" font-family="'Inter',Arial,sans-serif" font-size="18" font-weight="600" fill="rgba(255,255,255,0.60)" text-anchor="middle">up2cloud.tech/blog</text>
</svg>`;
}

const posts = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'blog', 'posts.json'), 'utf8'));
const outputDir = path.join(__dirname, '..', 'assets', 'img', 'blog');
fs.mkdirSync(outputDir, { recursive: true });

(async () => {
  for (const post of posts) {
    const svg = buildSvg(post);
    const outPath = path.join(outputDir, `${post.slug}-og.png`);
    await sharp(Buffer.from(svg)).png().toFile(outPath);
    console.log(`OG image generated: ${outPath}`);
  }
})().catch(err => { console.error(err); process.exit(1); });
