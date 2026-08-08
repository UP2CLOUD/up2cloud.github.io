# Weekly SEO audit

Checks every page's search metadata, fixes what is mechanical, and reports what
needs a person. Runs Mondays 08:00 UTC and opens a PR only when something
actually changed.

Zero runtime dependencies — Node 22 built-ins, matching the rest of this repo.

```bash
node automation/seo/src/cli.js audit          # report only, never writes
node automation/seo/src/cli.js fix            # apply mechanical fixes
node automation/seo/src/cli.js audit --json   # machine-readable
node --test "automation/seo/test/*.test.js"
```

---

## The one design decision

Every rule declares whether it is **mechanically** fixable, and that split is
the whole thing.

A missing `og:url` has exactly one correct value, derivable from the page's own
canonical. A machine can write it unattended, forever, and never be wrong.

A 25-character title does *not* have one correct value. Fixing it means deciding
what the page is about. A bot rewriting titles every Monday would churn the SERP
snippet, reset Google's understanding of the page, and quietly drift the site's
voice — while looking productive in the diff.

So: **mechanical tags get fixed and committed. Judgement calls get reported in
the PR body and never touched.**

| Fixed automatically | Reported for a human |
|---|---|
| Missing `og:title` / `og:description` / `og:url` / `og:type` / `og:image` | Title and description **length** |
| Missing `twitter:card` / `twitter:title` / `twitter:description` | Duplicate titles or descriptions across pages |
| Missing `rel=canonical` | A canonical pointing at another page |
| Missing `viewport` | Missing or multiple `<h1>` |
| Indexable page absent from `sitemap.xml` | Broken internal links, orphaned sitemap URLs, missing `alt` text |

---

## Three things it deliberately will not do

**It will not rewrite a canonical that points elsewhere.** `privacy/index_old.html`
canonicalises to `/privacy/`, which is correct — it consolidates a stale
duplicate into the page that should rank. An early version of this rule
"corrected" that to point at itself, which would have promoted a suppressed
duplicate into a competitor of the real page. Rewriting a canonical can de-index
a URL; no weekly bot should do it unattended. It is reported, never changed.

**It will not nag a `noindex` page.** A 404 needs no canonical, meta
description, `<h1>`, or sitemap entry. Demanding them produces findings that can
never legitimately be cleared, and a permanently non-zero report is one nobody
reads. `noindex` pages are still checked for things that are simply *broken* —
malformed JSON-LD, missing charset, missing viewport.

**It will not touch a consolidated duplicate.** A page canonicalising elsewhere
will never rank or be shared, so adding social tags to it is diff churn on a
file that is probably heading for deletion.

---

## Parsing

The parser finds each tag, then parses its attributes honouring the quote
character that actually opened the value.

That sounds pedantic until you try the obvious `content="([^"']*)"` shortcut on
this repo: it stops at the apostrophe in *"How UP2CLOUD's FinOps audit…"* and
reports a 12-character meta description. Every affected page then gets a
confident, completely wrong "description too short" finding — and an automation
that opens PRs off that files bogus fixes forever.

Content scanning also skips `<script>` and `<style>` bodies. The homepage
renders cards from a JS template containing `<a href="/blog/${post.slug}/">`,
which a naive scan reports as a broken internal link.

## Writing

Fixes are surgical splices, never reformatting. A fixer that normalises quoting
turns a one-tag change into a 500-line diff that nobody reviews properly.

New tags anchor to the last **top-level** `<meta>`/`<link>`/`<title>` in `<head>` —
explicitly skipping anything inside `<noscript>`, `<template>`, `<script>`, or a
comment. The privacy page ends its head with a no-JS font fallback, and
anchoring to "the last `<link>`" spliced the new tag *inside* the `<noscript>`,
where crawlers that run JS never see it.

Every fix is idempotent. The weekly run re-reads its own output; a
non-idempotent fixer would grow the `<head>` without bound.

---

## When it runs

| Trigger | Behaviour |
|---|---|
| Mondays 08:00 UTC | Audit, apply mechanical fixes, open a PR **only if something changed** |
| Pull request touching HTML / sitemap / robots | Report only — never rewrites a contributor's branch. Fails the check on **errors** |
| `workflow_dispatch` | Same as the weekly run |

A settled site opens no PR and fails nothing. Only errors fail a PR check;
judgement calls never do — a check that goes red for a stylistic opinion is a
check people learn to ignore.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `SITE_BASE_URL` | `https://up2cloud.tech` | Origin used to derive canonical URLs |
| `SEO_DEFAULT_OG_IMAGE` | `<base>/assets/img/og-image.png` | Fallback `og:image` |

Exit codes: `0` clean · `1` findings need a human · `2` bad usage.

## Tests

53 tests, gating the workflow before it edits a single file. They cover the
apostrophe-truncation bug, script/template false positives, `noscript` splicing,
idempotency, byte-for-byte preservation of untouched markup, attribute escaping,
`noindex` exemptions, the never-rewrite-a-canonical rule, and sitemap
add/orphan detection.

One test asserts the live site has **zero SEO errors**, so a future commit that
ships a page without a canonical fails on the PR that caused it rather than a
week later.
