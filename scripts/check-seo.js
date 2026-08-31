const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const canonicalUrl = 'https://up2cloud.tech/ai-assistent-model/';
const socialImageUrl = 'https://up2cloud.tech/assets/img/ai-assistant-og.png';
const page = fs.readFileSync(path.join(root, 'ai-assistent-model/index.html'), 'utf8');
const robots = fs.readFileSync(path.join(root, 'robots.txt'), 'utf8');
const sitemap = fs.readFileSync(path.join(root, 'sitemap.xml'), 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function contentFor(attribute, value) {
  const escapedValue = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`<meta\\s+${attribute}="${escapedValue}"\\s+content="([^"]+)"`, 'i');
  return page.match(pattern)?.[1];
}

const title = page.match(/<title>([^<]+)<\/title>/i)?.[1];
const description = contentFor('name', 'description');
const canonical = page.match(/<link\s+rel="canonical"\s+href="([^"]+)"/i)?.[1];

assert(title === 'AI Cloud Engineering Assistant | UP2CLOUD', 'Unexpected assistant page title');
assert(description && description.length >= 120 && description.length <= 160, 'Meta description must be 120-160 characters');
assert(canonical === canonicalUrl, 'Canonical URL is missing or incorrect');
assert(contentFor('name', 'robots')?.includes('max-image-preview:large'), 'Robots meta must allow large image previews');
assert(contentFor('name', 'googlebot')?.includes('max-snippet:-1'), 'Googlebot meta is incomplete');
assert(contentFor('property', 'og:title'), 'Open Graph title is missing');
assert(contentFor('property', 'og:description'), 'Open Graph description is missing');
assert(contentFor('property', 'og:url') === canonicalUrl, 'Open Graph URL must match the canonical URL');
assert(contentFor('property', 'og:image') === socialImageUrl, 'Open Graph image is missing or incorrect');
assert(contentFor('property', 'og:image:width') === '1200', 'Open Graph image width must be 1200');
assert(contentFor('property', 'og:image:height') === '630', 'Open Graph image height must be 630');
assert(contentFor('name', 'twitter:card') === 'summary_large_image', 'Large Twitter/X card metadata is missing');

const schemaBlocks = [...page.matchAll(/<script\s+type="application\/ld\+json">([\s\S]*?)<\/script>/gi)];
assert(schemaBlocks.length === 1, 'Expected exactly one JSON-LD block');
const schema = JSON.parse(schemaBlocks[0][1]);
assert(Array.isArray(schema['@graph']), 'JSON-LD graph is missing');
assert(schema['@graph'].some((node) => node['@type'] === 'WebApplication' && node.url === canonicalUrl), 'WebApplication structured data is missing');

assert(/User-agent:\s*LinkedInBot[\s\S]*?Allow:\s*\//i.test(robots), 'LinkedInBot must be allowed to crawl social metadata');
assert(robots.includes('Sitemap: https://up2cloud.tech/sitemap.xml'), 'robots.txt must advertise the sitemap');
assert(sitemap.includes(`<loc>${canonicalUrl}</loc>`), 'Sitemap is missing the assistant canonical URL');
assert(sitemap.includes(`<image:loc>${socialImageUrl}</image:loc>`), 'Sitemap is missing the assistant social image');

const image = fs.readFileSync(path.join(root, 'assets/img/ai-assistant-og.png'));
assert(image.subarray(1, 4).toString('ascii') === 'PNG', 'Social image must be a PNG');
assert(image.readUInt32BE(16) === 1200 && image.readUInt32BE(20) === 630, 'Social image must be exactly 1200x630');
assert(image.length < 5 * 1024 * 1024, 'Social image must be smaller than 5 MB');

console.log('SEO checks passed: metadata, JSON-LD, robots, sitemap, and social image.');
