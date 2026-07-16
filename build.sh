#!/bin/bash
set -e

# 1. Install deps and build Tailwind
npm ci
./node_modules/.bin/tailwindcss -i src/input.css -o assets/css/tailwind.min.css --minify

# 2. Inject form endpoint into index.html
if [ -n "$FORM_ENDPOINT" ]; then
  sed -i "s|https://formspree.io/f/REPLACE_WITH_YOUR_ID|${FORM_ENDPOINT}|g" index.html
fi

# 3. Cache-bust asset URLs in every HTML page.
#
# Why: _headers marks HTML as no-cache but assets (notably
# assets/css/tailwind.min.css, which this script REGENERATES on every
# deploy) get default long caching. Without a version param, every deploy
# opens a window where returning visitors get fresh HTML + a stale cached
# stylesheet — missing utility classes, i.e. a broken-looking page,
# most visibly on mobile. The GitHub Pages workflow has an equivalent
# step, but production deploys through Cloudflare Pages running THIS
# script, which had none — and the workflow's pattern also only matched
# leading-slash /assets/ URLs while the site's stylesheet link is the
# relative "assets/css/tailwind.min.css".
#
# Pattern notes: anchors on the ="..." attribute quote; tolerates
# optional ../ prefixes (blog/about subpages) and an optional leading
# slash; skips URLs that already carry a query string.
SHA="${CF_PAGES_COMMIT_SHA:-$(git rev-parse --short HEAD 2>/dev/null || echo dev)}"
SHA="${SHA:0:8}"
find . -name "*.html" -not -path "./node_modules/*" | while read -r f; do
  sed -i "s|\(=[\"']\)\(\(\.\./\)*/\{0,1\}assets/[^\"'?]*\)\([\"']\)|\1\2?v=${SHA}\4|g" "$f"
done
echo "Cache-busting version: ${SHA}"

echo "Build complete."
