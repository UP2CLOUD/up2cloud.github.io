# UP2CLOUD Website — CLAUDE.md

Codebase guide for AI assistants working on the UP2CLOUD marketing/consulting site.

---

## What This Is

Static HTML/CSS/JS website for UP2CLOUD, an IT consulting firm led by Cesar A. Nogueira. The site is a single-page marketing site at `up2cloud.tech` with a blog, AI chatbot, interactive map, and multi-language support. It is deployed to GitHub Pages (primary) with Cloudflare Pages also configured for edge functions.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Vanilla HTML5 + plain JavaScript (no framework) |
| Styling | Tailwind CSS v3 (compiled via CLI from `src/input.css`) |
| AI Chatbot | Groq API / Llama 3.1 8B Instant |
| Map | Leaflet.js + CartoDB dark tiles |
| Analytics | Hotjar (HTTPS-only, skipped on localhost) |
| Edge Functions | Cloudflare Pages Functions (`functions/api/`) |
| KV Storage | Cloudflare KV (comments, likes, rate limiting) |
| Newsletter | Brevo (formerly Sendinblue) API |
| Contact Form | FormSubmit.co (injected at deploy time) |
| Infra-as-code | Terraform (`terraform/github-pages/`, `terraform/cloudflare/`) |
| CI/CD | GitHub Actions → GitHub Pages |
| Package manager | npm (dev tooling only — no frontend bundler) |

---

## Commands

```bash
npm install          # install dev tools (tailwindcss, htmlhint, sharp)
npm run build:css    # compile Tailwind → assets/css/tailwind.min.css (one-shot)
npm run watch:css    # compile Tailwind in watch mode
npm start            # build CSS then serve (node serve.js) on http://localhost:3000
npm run dev          # serve only (node serve.js), no CSS rebuild
npm test             # htmlhint index.html (non-blocking — exit 0 always)

# Blog post scaffolding
node scripts/add-post.js   # interactive CLI to scaffold a new blog post
```

**Local dev note:** `node serve.js` reads `.env` and injects secrets (GROQ_API_KEY, etc.) at request time, mirroring the production GitHub Actions injection. Never open `index.html` via `file://` for chatbot testing — the key won't be available. Direct `file://` works for layout/content review only.

---

## Project Structure

```
up2cloud.github.io/
├── index.html                        # Main single-page site (all sections inline)
├── 404.html                          # Custom 404 page
├── serve.js                          # Node.js local dev server (secrets injection)
├── serve.py                          # Python 3 alternative dev server
├── build.sh                          # Manual build helper
├── CNAME                             # Custom domain: up2cloud.tech (must not be deleted)
├── .nojekyll                         # Disables Jekyll processing on GitHub Pages
├── robots.txt / sitemap.xml          # SEO files
├── _headers                          # Cloudflare Pages HTTP headers
├── _redirects                        # Cloudflare Pages redirects
│
├── src/
│   └── input.css                     # Tailwind CSS source (compiled → assets/css/)
│
├── assets/
│   ├── css/
│   │   └── tailwind.min.css          # Compiled Tailwind output (committed)
│   ├── i18n/
│   │   ├── en.json                   # English translations (148 tagged elements)
│   │   ├── pt.json                   # Portuguese
│   │   ├── es.json                   # Spanish
│   │   └── fr.json                   # French
│   ├── img/                          # Site images (.webp, .png, .gif)
│   └── js/
│       └── blog-engagement.js        # Blog likes/comments UI logic
│
├── about/index.html                  # About page
├── privacy/index.html                # Privacy policy page
├── blog/
│   ├── index.html                    # Blog listing page
│   ├── posts.json                    # Machine-readable blog index (source of truth for listing)
│   └── <slug>/index.html            # Individual blog post pages
│
├── functions/
│   └── api/                          # Cloudflare Pages Functions (edge serverless)
│       ├── chat.js                   # AI chatbot proxy (Groq API)
│       ├── newsletter.js             # Newsletter subscription (Brevo API)
│       ├── comments.js               # Blog comments (Cloudflare KV)
│       └── likes.js                  # Blog likes (Cloudflare KV)
│
├── scripts/
│   ├── add-post.js                   # Scaffold new blog post + update posts.json
│   ├── gen-og-image.js               # Generate OG social preview image
│   └── gen-facebook-images.js        # Generate Facebook-sized images
│
├── automation/
│   ├── n8n/up2cloud-lead-funnel.json # n8n workflow for lead automation
│   └── outbound/linkedin-playbook.md # LinkedIn outreach playbook
│
├── terraform/
│   ├── github-pages/main.tf          # GitHub Pages infra (Terraform)
│   └── cloudflare/main.tf            # Cloudflare DNS + Pages infra (Terraform)
│
├── .github/
│   └── workflows/
│       ├── deploy-pages.yml          # Main CI/CD: test → approve → build → deploy
│       ├── instagram-notify.yml      # Instagram post notification
│       ├── newsletter-notify.yml     # Newsletter notification trigger
│       └── uptime-monitor.yml        # Uptime monitoring
│
├── wrangler.toml                     # Cloudflare Pages / Workers config + KV bindings
├── tailwind.config.js                # Tailwind v3 config
├── package.json
└── .env.example                      # Secret variable template
```

---

## Environment Variables

Copy `.env.example` to `.env` for local development:

| Variable | Purpose | Where set |
|---|---|---|
| `GROQ_API_KEY` | Groq AI chatbot API key | `.env` locally; GitHub Secret in CI |
| `FORM_ENDPOINT` | FormSubmit.co contact form URL | `.env` locally; hardcoded in CI workflow env |
| `BREVO_API_KEY` | Brevo newsletter API key | Cloudflare Pages env vars + GitHub Secret |
| `BREVO_LIST_ID` | Brevo contact list ID (integer) | Cloudflare Pages env vars + GitHub Secret |
| `BREVO_SENDER_EMAIL` | Verified Brevo sender email | Cloudflare Pages env vars |
| `PORT` | Dev server port (default 3000) | `.env` only |

**Never commit `.env`.** The `.gitignore` already excludes it.

---

## CI/CD Pipeline (deploy-pages.yml)

Pipeline runs on every push to `main` and on PRs against `main`:

1. **test** — htmlhint on `index.html` + validate required static assets
2. **terraform-validate** — `terraform fmt -check` + `terraform validate` on both Terraform dirs
3. **approve** — manual approval gate (GitHub Environment: `production-approval`)
4. **build** *(push only, not PRs)* — compile Tailwind, copy assets to `public/`, inject `GROQ_API_KEY` and `FORM_ENDPOINT` via `sed`, add FormSubmit hidden fields, inject cache-busting `?v=<git-sha>` into all HTML asset URLs
5. **deploy** *(push only)* — deploy `public/` artifact to GitHub Pages

**Required GitHub secrets:**
- `GROQ_API_KEY`

**Required GitHub environment:** `production-approval` (Settings → Environments → required reviewers).

---

## i18n System

The site supports 4 languages: English (default), Portuguese, Spanish, French.

- HTML elements that need translation carry a `data-i18n="key"` attribute.
- The inline JS in `index.html` fetches `assets/i18n/{code}.json` on language switch and caches it in memory.
- Embedded fallback translations are baked into `index.html` so the page works fully offline or when opened via `file://`.

**Adding a new language:**
1. Create `assets/i18n/{code}.json` using `en.json` as the template.
2. Register in `LANG_META` inside `index.html`: `de: { flag: '🇩🇪', label: 'Deutsch', code: 'DE' }`.
3. Add a button to the language picker dropdown in the navbar.

---

## Adding a Blog Post

Use the scaffold script — do not create blog posts manually:

```bash
node scripts/add-post.js
```

This prompts for slug, title, excerpt, date, and category, then:
- Creates `blog/<slug>/index.html` from an HTML template with correct OG tags, structured data, and styling.
- Appends the entry to `blog/posts.json` (the blog listing page reads this file).

**Categories and their badge styles:**
- `finops` → green
- `devops` → sky blue
- `ai` → purple
- `security` → orange
- `cloud` → sky blue

After scaffolding, fill in the `<article>` body in the generated `blog/<slug>/index.html`.

---

## Cloudflare Pages Functions

Edge functions live in `functions/api/` and are deployed automatically with Cloudflare Pages.

| Endpoint | File | Purpose |
|---|---|---|
| `POST /api/chat` | `chat.js` | Proxy to Groq (Llama 3.1 8B) for the site chatbot |
| `POST /api/newsletter` | `newsletter.js` | Subscribe email to Brevo list; honeypot + rate-limit via KV |
| `GET/POST /api/comments` | `comments.js` | Blog comment read/write via Cloudflare KV (`UP2CLOUD_COMMENTS`) |
| `POST /api/likes` | `likes.js` | Blog post like toggle via Cloudflare KV (`UP2CLOUD_LIKES`) |

**KV namespaces** (configured in `wrangler.toml` and Cloudflare dashboard):
- `UP2CLOUD_COMMENTS` — stores blog comments
- `UP2CLOUD_LIKES` — stores post like counts (also reused for rate-limit keys)

---

## Terraform

Two Terraform modules in `terraform/`:
- `github-pages/` — manages GitHub Pages configuration
- `cloudflare/` — manages Cloudflare DNS, pages project, and related settings

The CI pipeline validates both with `terraform fmt -check` and `terraform validate` on every run. **Do not break Terraform formatting** — always run `terraform fmt` before committing changes to `.tf` files.

---

## Key Conventions

### HTML/CSS
- The site is static HTML — no framework, no build step for JS. Keep it that way unless explicitly requested.
- Tailwind v3 is used. After editing `src/input.css` or adding new Tailwind classes to HTML, run `npm run build:css` to recompile.
- `assets/css/tailwind.min.css` is committed — rebuild and commit it whenever Tailwind config or classes change.
- CNAME must always exist in the repo root. Deleting it will break the `up2cloud.tech` custom domain on the next deploy.
- `.nojekyll` must always exist. Without it, GitHub Pages runs Jekyll and may corrupt the site.

### Secrets
- Secrets are **never** hardcoded in HTML or JS — they are injected at build time (CI) or at request time (local dev server).
- The `GROQ_API_KEY` placeholder in `index.html` is replaced by `sed` during the GitHub Actions build step.
- The `FORM_ENDPOINT` placeholder (`https://formspree.io/f/REPLACE_WITH_YOUR_ID`) is replaced at build time.

### Blog Posts
- Always use `node scripts/add-post.js` — it keeps `blog/posts.json` in sync.
- Blog post slugs must be URL-safe: lowercase, hyphens, no spaces.
- Each post needs correct `<link rel="canonical">` and OG meta tags — the scaffold generates these automatically.

### Terraform
- Run `terraform fmt` before committing any `.tf` file change — CI checks formatting.
- Do not run `terraform apply` locally without explicit permission; apply happens via CI or manual Cloudflare dashboard.

---

## What Not to Do

- Do not delete `CNAME` or `.nojekyll`.
- Do not commit `.env` or any file containing real API keys.
- Do not manually create blog post directories — use `node scripts/add-post.js`.
- Do not edit `assets/css/tailwind.min.css` directly — it is generated output; edit `src/input.css` and rebuild.
- Do not bypass the `production-approval` gate without explicit authorization.
- Do not add `<script>` tags that inline API keys or secrets into HTML.
- Do not modify `wrangler.toml` KV namespace IDs without updating the matching Cloudflare dashboard bindings.
