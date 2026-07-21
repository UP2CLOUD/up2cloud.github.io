#!/usr/bin/env node
/**
 * add-post.js — scaffold a new UP2CLOUD blog post
 *
 * Usage:
 *   node scripts/add-post.js
 *
 * Interactive prompts for: slug, title, excerpt, date, category.
 * Creates blog/<slug>/index.html from template and adds entry to blog/posts.json.
 */

'use strict';

const fs       = require('fs');
const path     = require('path');
const readline = require('readline');

const ROOT      = path.resolve(__dirname, '..');
const POSTS_JSON = path.join(ROOT, 'blog', 'posts.json');
const BLOG_DIR   = path.join(ROOT, 'blog');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise(res => rl.question(q, res));

const BADGE_MAP = {
  finops:    { cls: 'badge-green',  color: '#34D399', bg: 'rgba(5,150,105,.18)' },
  devops:    { cls: 'badge-sky',    color: '#38BDF8', bg: 'rgba(3,105,161,.18)' },
  ai:        { cls: 'badge-purple', color: '#A78BFA', bg: 'rgba(124,58,237,.18)' },
  security:  { cls: 'badge-orange', color: '#FB923C', bg: 'rgba(234,88,12,.18)'  },
  cloud:     { cls: 'badge-sky',    color: '#38BDF8', bg: 'rgba(3,105,161,.18)'  },
};

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function postTemplate({ slug, title, excerpt, date, category, badgeClass, badgeColor, badgeBg }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title} — UP2CLOUD</title>
  <meta name="description" content="${excerpt}" />
  <meta property="og:title" content="${title} — UP2CLOUD" />
  <meta property="og:type" content="article" />
  <meta property="og:url" content="https://up2cloud.tech/blog/${slug}/" />
  <link rel="canonical" href="https://up2cloud.tech/blog/${slug}/" />
  <meta property="og:image" content="https://up2cloud.tech/assets/img/og-image.png" />
  <meta property="article:published_time" content="${date}" />
  <meta name="twitter:card" content="summary_large_image" />
  <link rel="icon" type="image/svg+xml" href="/assets/img/favicon.svg" />
  <link rel="icon" type="image/png" sizes="32x32" href="/assets/img/favicon-32.png" />
  <link rel="icon" type="image/png" sizes="16x16" href="/assets/img/favicon-16.png" />
  <link rel="shortcut icon" href="/favicon.ico" />
  <link rel="apple-touch-icon" sizes="180x180" href="/assets/img/apple-touch-icon.png" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=DM+Sans:wght@300;400;500;700&display=swap" rel="stylesheet" />
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      theme: { extend: {
        fontFamily: { heading: ['Space Grotesk','sans-serif'], body: ['DM Sans','sans-serif'] },
        colors: {
          navy:  { DEFAULT:'#0F172A', 700:'#1E293B' },
          sky:   { brand:'#0369A1', light:'#0EA5E9' },
        }
      }}
    };
  </script>
  <style>
    *,*::before,*::after { box-sizing:border-box }
    html { scroll-behavior:smooth; overscroll-behavior:none }
    body { font-family:'DM Sans',sans-serif; background:#0F172A; color:#fff; margin:0 }
    h1,h2,h3,h4 { font-family:'Space Grotesk',sans-serif }
    .glass { background:rgba(255,255,255,.07); backdrop-filter:blur(14px); border:1px solid rgba(255,255,255,.12) }
    .gradient-text { background:linear-gradient(90deg,#0EA5E9,#38BDF8,#7DD3FC); -webkit-background-clip:text; -webkit-text-fill-color:transparent; background-clip:text }
    .badge { background:rgba(3,105,161,.15); color:#38BDF8; font-size:.72rem; font-weight:600; padding:.25rem .75rem; border-radius:999px; letter-spacing:.05em; text-transform:uppercase }
    .reveal { opacity:0; transform:translateY(24px); transition:opacity .6s ease,transform .6s ease }
    .reveal.visible { opacity:1; transform:none }
    .prose p { color:rgba(255,255,255,.72); line-height:1.8; margin-bottom:1.25rem; font-size:1.0625rem }
    .prose h2 { font-family:'Space Grotesk',sans-serif; font-weight:700; font-size:1.5rem; color:#fff; margin-top:2.5rem; margin-bottom:1rem }
    .prose h3 { font-family:'Space Grotesk',sans-serif; font-weight:600; font-size:1.2rem; color:rgba(255,255,255,.9); margin-top:2rem; margin-bottom:.75rem }
    .prose ul { color:rgba(255,255,255,.72); line-height:1.8; margin-bottom:1.25rem; padding-left:1.5rem; list-style-type:disc }
    .prose ul li { margin-bottom:.5rem }
    .prose strong { color:#fff; font-weight:600 }
    @media(prefers-reduced-motion:reduce){.reveal{animation:none;transition:none}}
  </style>
</head>
<body>

<!-- NAV -->
<nav class="fixed top-0 left-0 right-0 z-50 transition-all duration-300" style="background:rgba(15,23,42,.92);backdrop-filter:blur(12px);border-bottom:1px solid rgba(255,255,255,.07)">
  <div class="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
    <a href="/" class="flex items-center gap-3 focus-visible:outline-2 focus-visible:outline-white rounded" aria-label="UP2CLOUD Home">
      <div class="w-9 h-9 rounded-lg flex items-center justify-center" style="background:linear-gradient(135deg,#0369A1,#0EA5E9)">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z" stroke="white" stroke-width="2" stroke-linejoin="round"/></svg>
      </div>
      <span class="font-heading font-700 text-xl text-white tracking-tight">UP<span style="color:#F97316">2</span><span style="color:#0EA5E9">CLOUD</span></span>
    </a>
    <div class="flex items-center gap-4">
      <a href="/blog" class="text-white/70 hover:text-white text-sm transition-colors">← All posts</a>
      <a href="/#contact" class="text-xs font-semibold text-white px-4 py-2 rounded-lg" style="background:linear-gradient(135deg,#0369A1,#0EA5E9)">Get in Touch</a>
    </div>
  </div>
</nav>

<!-- ARTICLE HERO -->
<section class="pt-28 pb-12" style="background:linear-gradient(135deg,#020617 0%,#0F172A 40%,#0C4A6E 75%,#0369A1 100%)">
  <div class="max-w-3xl mx-auto px-6">
    <div class="flex items-center gap-3 mb-5">
      <span class="badge" style="background:${badgeBg};color:${badgeColor}">${category}</span>
    </div>
    <h1 class="font-heading font-bold text-4xl sm:text-5xl leading-tight text-white mb-6">
      ${title}
    </h1>
    <div class="flex items-center gap-4 text-white/40 text-sm">
      <span>${date}</span>
      <span>·</span>
      <span>8 min read</span>
    </div>
  </div>
</section>

<!-- ARTICLE BODY -->
<article class="py-14" style="background:#0F172A">
  <div class="max-w-3xl mx-auto px-6 prose">

    <p>${excerpt}</p>

    <h2>Introduction</h2>
    <p>
      Write your article content here. Use &lt;h2&gt; for section headings, &lt;p&gt; for paragraphs,
      and &lt;ul&gt; / &lt;li&gt; for bullet points.
    </p>

    <h2>Section Two</h2>
    <p>
      Continue writing…
    </p>

    <h2>Conclusion</h2>
    <p>
      Wrap up your article here.
    </p>

  </div>
</article>

<!-- Blog Engagement: Likes + Comments -->
<section class="max-w-3xl mx-auto px-6 py-2">
  <div id="likes-mount"></div>
  <div id="comments-mount"></div>
</section>
<script src="/assets/js/blog-engagement.js" defer></script>

<!-- CTA -->
<section class="py-16" style="background:#020617">
  <div class="max-w-3xl mx-auto px-6 reveal">
    <div class="rounded-2xl p-10 text-center relative overflow-hidden" style="background:linear-gradient(135deg,rgba(3,105,161,.15),rgba(124,58,237,.12));border:1px solid rgba(14,165,233,.2)">
      <h2 class="font-heading font-bold text-3xl text-white mb-4">Ready to optimise your cloud?</h2>
      <p class="text-white/60 mb-8 leading-relaxed max-w-xl mx-auto">
        Book a free 45-minute cloud audit. We'll identify quick wins and build a prioritised action plan — no strings attached.
      </p>
      <a href="/#contact" class="inline-flex items-center gap-2 font-semibold text-white px-8 py-3.5 rounded-xl transition-all hover:opacity-90" style="background:linear-gradient(135deg,#0369A1,#0EA5E9)">
        Book Free Audit
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
      </a>
    </div>
  </div>
</section>

<!-- FOOTER -->
<footer style="background:#020617;border-top:1px solid rgba(255,255,255,.07)" class="py-12 mt-0">
  <div class="max-w-6xl mx-auto px-6 flex flex-col sm:flex-row justify-between items-center gap-6 text-sm text-white/40">
    <div class="flex items-center gap-3">
      <div class="w-7 h-7 rounded-lg flex items-center justify-center" style="background:linear-gradient(135deg,#0369A1,#0EA5E9)">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z" stroke="white" stroke-width="2" stroke-linejoin="round"/></svg>
      </div>
      <span>© 2026 UP2CLOUD · Cesar A. Nogueira. All rights reserved.</span>
    </div>
    <div class="flex gap-6">
      <a href="/" class="hover:text-white/70 transition-colors">Home</a>
      <a href="/blog" class="hover:text-white/70 transition-colors">Blog</a>
      <a href="/about" class="hover:text-white/70 transition-colors">About</a>
      <a href="/#contact" class="hover:text-white/70 transition-colors">Contact</a>
    </div>
  </div>
</footer>

<script>
  const ro = new IntersectionObserver(entries => {
    entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add('visible'); ro.unobserve(e.target); }});
  }, { threshold: 0.1 });
  document.querySelectorAll('.reveal').forEach(el => ro.observe(el));
</script>
</body>
</html>
`;
}

async function main() {
  console.log('\n📝  UP2CLOUD — Add new blog post\n');

  let slug = slugify(await ask('Slug (e.g. my-new-post): '));
  if (!slug) { console.error('Slug is required'); process.exit(1); }

  const postDir = path.join(BLOG_DIR, slug);
  if (fs.existsSync(postDir)) {
    console.error(`✗ Directory already exists: ${postDir}`);
    process.exit(1);
  }

  const title    = (await ask('Title: ')).trim();
  const excerpt  = (await ask('Excerpt (1–2 sentences): ')).trim();
  const dateIn   = (await ask(`Date [${new Date().toISOString().slice(0,10)}]: `)).trim()
                    || new Date().toISOString().slice(0,10);
  const catIn    = (await ask('Category (finops/devops/ai/security/cloud): ')).trim().toLowerCase();
  const badge    = BADGE_MAP[catIn] || BADGE_MAP.cloud;
  const category = catIn.charAt(0).toUpperCase() + catIn.slice(1);

  rl.close();

  // Create directory and HTML file
  fs.mkdirSync(postDir, { recursive: true });
  const html = postTemplate({
    slug, title, excerpt, date: dateIn,
    category, badgeClass: badge.cls,
    badgeColor: badge.color, badgeBg: badge.bg,
  });
  fs.writeFileSync(path.join(postDir, 'index.html'), html);

  // Update posts.json — prepend new post (newest first)
  const posts = JSON.parse(fs.readFileSync(POSTS_JSON, 'utf8'));
  posts.unshift({
    slug, title, excerpt,
    date: dateIn,
    category,
    badgeClass: badge.cls,
    featured: false,
  });
  fs.writeFileSync(POSTS_JSON, JSON.stringify(posts, null, 2) + '\n');

  // Update blog/index.html — add entry to grid
  const indexHtmlPath = path.join(BLOG_DIR, 'index.html');
  let indexHtml = fs.readFileSync(indexHtmlPath, 'utf8');

  const newPostCard = `
      <!-- Article: ${title} -->
      <a href="/blog/${slug}/" class="block group card-hover reveal">
        <div class="glass rounded-2xl p-6 h-full flex flex-col">
          <div class="flex items-center gap-2 mb-4">
            <span class="badge ${badge.cls}" style="font-size:.72rem;background:${badge.bg};color:${badge.color}">${category}</span>
          </div>
          <h3 class="font-heading font-bold text-xl text-white mb-3 group-hover:text-sky-300 transition-colors leading-tight">${title}</h3>
          <p class="text-white/50 text-sm leading-relaxed mb-6 flex-grow">${excerpt.length > 100 ? excerpt.slice(0, 100) + '...' : excerpt}</p>
          <div class="flex items-center justify-between pt-4 border-t border-white/5">
            <span class="text-white/30 text-xs">${dateIn}</span>
            <span class="text-sky-light text-xs font-semibold group-hover:underline">Read post &rarr;</span>
          </div>
        </div>
      </a>
`;

  // Insert at the beginning of the grid
  indexHtml = indexHtml.replace('<div class="grid md:grid-cols-2 lg:grid-cols-3 gap-6">', `<div class="grid md:grid-cols-2 lg:grid-cols-3 gap-6">${newPostCard}`);
  fs.writeFileSync(indexHtmlPath, indexHtml);

  console.log(`
✓ Post created:  blog/${slug}/index.html
✓ posts.json updated (${posts.length} total posts)
✓ blog/index.html updated (grid entry added)
`);
}

main().catch(err => { console.error(err); process.exit(1); });
