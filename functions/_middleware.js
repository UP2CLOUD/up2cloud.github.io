/**
 * Site-wide middleware — runs in front of every request, including static
 * assets (see functions/api/*.js for the API-only handlers).
 *
 * www -> apex 301 redirect. This used to live in `_redirects`
 * (`https://www.up2cloud.tech/* https://up2cloud.tech/:splat 301`), but
 * Cloudflare Pages' `_redirects` file does not support hostname-based
 * matching at all (only path matching) — that rule was silently ignored
 * from day one, regardless of whether the www custom domain was active.
 * A Pages Function has full access to the Host header, so it can actually
 * do this.
 */
export async function onRequest(context) {
  const url = new URL(context.request.url);
  if (url.hostname === "www.up2cloud.tech") {
    url.hostname = "up2cloud.tech";
    return Response.redirect(url.toString(), 301);
  }
  return context.next();
}
