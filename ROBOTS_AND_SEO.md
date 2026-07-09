# SEO & Crawling Configuration

## `robots.txt` — Search Engine Crawler Rules

**Location:** `/robots.txt`  
**Purpose:** Instructs search engines (Google, Bing, DuckDuckGo) which pages to crawl

- ✅ Allows all public pages by default
- ❌ Blocks admin, node_modules, .env files
- ✅ Links to `sitemap.xml` for discovery
- ✅ Crawl-delay: 1 second (respectful crawling)

## `sitemap.xml` — URL Index

**Location:** `/sitemap.xml`  
**Purpose:** Provides search engines a structured list of all pages

**Includes:**
- Homepage (priority 1.0, weekly updates)
- `/about/` (priority 0.8, monthly updates)
- `/privacy/` (priority 0.5, quarterly updates)

**Submit to:**
- [Google Search Console](https://search.google.com/search-console)
- [Bing Webmaster Tools](https://www.bing.com/webmasters/)
- [Yandex Webmaster](https://webmaster.yandex.com/)

## Meta Tags for SEO

All pages include:
- ✅ `<meta charset="UTF-8">` — Encoding
- ✅ `<meta name="viewport">` — Mobile-responsive
- ✅ `<meta name="description">` — Search snippet (155 chars)
- ✅ `<meta name="robots" content="index, follow">` — Crawl directive
- ✅ `<meta property="og:*">` — Open Graph (social shares)
- ✅ `<meta name="twitter:card">` — Twitter cards
- ✅ `og:image` (high-res hero image URL) added to all pages
- ✅ Canonical URLs added to all pages (about, privacy, blog posts)

## Structured Data (Schema.org)

**Completed:**
- ✅ `Organization` schema (name, logo, contact, social profiles)
- ✅ `LocalBusiness` schema (Vila Real HQ, GPS coordinates)
- ✅ `Person` schema (Cesar A. Nogueira, job title, social profiles)
- ✅ `WebSite` schema (site search potential)
- ✅ `BlogPosting` schema (active for all 8 blog posts)
- ✅ `Service` schema (ItemList of 6 service offerings, homepage `#services`)

**Next phase improvements:**
- [ ] Add `Review` schema once client testimonials are expanded

## Performance & Core Web Vitals

- ✅ Lazy-load images (`loading="lazy"`)
- ✅ Image dimensions (`width/height`) added to prevent layout shift
- ✅ Semantic HTML landmarks (nav, main, article, footer)
- [ ] Minify HTML/CSS/JS (Partially done via build.sh)

Test with: [PageSpeed Insights](https://pagespeed.web.dev/)

## Target Keywords (2026 Strategy)

| Category | Primary Keywords |
|---|---|
| **Brand** | UP2CLOUD, UP2CLOUD consulting |
| **Service** | Cloud Consulting, DevOps Consulting, FinOps Consulting |
| **Local** | Cloud DevOps consultant Portugal, DevOps expert Vila Real |
| **Tech** | AWS consultant, GCP DevOps, Azure Kubernetes expert, Terraform consulting |
| **Strategic** | Platform Engineering, Cloud Cost Optimization, AI-Powered DevOps |

## Google Search Console (Manual Steps)

1. **Verify Ownership:** Ensure the `up2cloud.tech` property is verified in Google Search Console.
2. **Submit Sitemap:** Submit `https://up2cloud.tech/sitemap.xml`.
3. **Request Indexing:** For new blog posts, manually request indexing.

---

**Last Updated:** May 9, 2026
### Security Header Note: GitHub Pages
GitHub Pages does not allow custom response headers (e.g., CSP, HSTS). To implement these, it is recommended to place the site behind a CDN like Cloudflare, Netlify, or Vercel, which can inject headers automatically.
