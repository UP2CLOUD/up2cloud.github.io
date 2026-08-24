# UP2CLOUD Autopublish

Publishes one high-impact technical article (AI, cloud infrastructure, or IT) to
the UP2CLOUD blog every 7 days and promotes it through the official LinkedIn
Company Page API.

Zero runtime dependencies — Node 22 built-ins only, matching the rest of this
repo. Tests run on `node --test`.

```
node automation/publishing/src/cli.js status              # what would happen right now
node automation/publishing/src/cli.js publish --mode dry-run
node --test "automation/publishing/test/*.test.js"
```

---

## How it decides to run

The cron in `.github/workflows/blog-autopublish.yml` is a **wake-up call, not a
schedule**. Every 6 hours it wakes and asks one question:

```
now >= last_successful_publication_at + PUBLISH_INTERVAL_HOURS
```

That state-derived check is what makes the cadence survive a missed cron tick, a
GitHub Actions delay, a manual re-run, or a re-run of an *old* workflow — none
of which a `0 9 */2 * *` cron can distinguish from a legitimate slot.

`last_successful_publication_at` only advances when an article is **live and
deployment-verified**, so a failed deploy never silently burns a cycle.

### Mutual exclusion

Three layers, because the pipeline mutates a git repo and posts publicly:

| Layer | Covers |
|---|---|
| Workflow `concurrency` group | Two GitHub Actions runs of this workflow |
| Durable lease lock in the ledger | Any two runners anywhere (incl. local/manual) |
| `git push` non-fast-forward | The final merge race |

The lock is a **lease** with a TTL, renewed by a heartbeat. A runner killed
mid-run leaves an expired lease that the next run steals — so a crash costs one
cycle, not permanent deadlock.

---

## Modes

| Mode | Generates | Commits + PR | Merges | Verifies | LinkedIn |
|---|---|---|---|---|---|
| `dry-run` | yes | no | no | no | no |
| `draft` | yes | yes | no | no | no |
| `review` | yes | yes | yes | yes | no |
| `auto` | yes | yes | yes | yes | yes |

Default is `draft`. Set `PUBLISH_MODE` (repo variable) to `auto` once you have
reviewed a few generated articles.

### Kill switch

Either stops the pipeline, checked before anything else and **outranking
`--force`**:

- repo variable `AUTOPUBLISH_DISABLED=true`
- committed file `automation/publishing/DISABLED` (put the reason inside)

---

## Pipeline

```
1  select_topic       rotation + 45-day cooldown
2  research           model proposes sources → each is FETCHED and verified
3  brief              factual brief, every fact tied to a verified source
4  draft              outline + SEO metadata + body
5  review             separate technical + editorial adversarial passes, then revise
6  validate           quality gates (blocking)
7  localize           EN/PT/ES/FR metadata bundle
8  publish_blog       render → branch → PR → CI → merge
9  verify_deployment  200 / title / canonical / OG / image / noindex / sitemap / links
10 publish_linkedin   POST /rest/posts, requires a valid post URN
```

Each stage records its result in the ledger before the next starts. A retry
(`--resume <runId>`) skips completed stages, so a LinkedIn 503 does not
regenerate — or re-publish — the article.

### What blocks publication

Blocking gates fail the run; nothing is published:

- **Fabrication** — invented clients, savings, quotes, partnerships,
  certifications or scale claims. First-person business claims are blocked
  outright since the pipeline has no ground truth for them.
- **Unsourced numbers** — a statistic or benchmark with no citation nearby.
- **Citations** — fewer than 3 sources, fewer than 2 authoritative, any source
  that did not return HTTP 200 at generation time, or a malformed URL.
- **Duplicates** — identical content hash, an existing slug, or a title ≥70%
  similar to an existing post (checked against both the ledger *and* the
  human-authored `blog/posts.json`).
- **Invalid code** — unparseable JSON, tab-indented YAML.
- **Metadata** — missing title/slug/excerpt/category/date, malformed date.
- **Word count** — below `MIN_WORDS`.
- **High-severity review findings** from the technical/editorial passes.

Warnings (long titles, over-length articles, over-long excerpts) are recorded in
the PR body but do not block.

---

## LinkedIn

Official API only: `POST https://api.linkedin.com/rest/posts` with an
organization author URN. No browser automation, no cookies, no private
endpoints.

**Success is defined narrowly**: a post counts as published only when LinkedIn
returns a valid `urn:li:share:*` / `urn:li:ugcPost:*`. A 2xx with no URN is
treated as a failure, because a post we cannot identify is a post we cannot
audit or link to.

Retries cover 429/5xx with backoff and honour `retry-after`. 401 and 403 are
never retried — they mean reauthorization or a missing scope, and retrying just
burns the rate limit. An idempotency key derived from the slug means a retried
request returns the original post instead of creating a duplicate.

### One-time OAuth setup

The token must belong to a LinkedIn member who is an **ADMINISTRATOR** of the
company page.

```bash
export LINKEDIN_CLIENT_ID=...        # from the LinkedIn developer app
export LINKEDIN_CLIENT_SECRET=...

node automation/publishing/src/cli.js oauth url \
  --redirect-uri https://up2cloud.tech/oauth/linkedin/callback
# open the printed URL, approve, copy the ?code= from the callback

node automation/publishing/src/cli.js oauth exchange \
  --code <CODE> --redirect-uri https://up2cloud.tech/oauth/linkedin/callback
```

The command prints the token **once** to stdout and stores nothing. Paste the
values into repository secrets/variables.

Required product on the LinkedIn app: *Community Management API*.
Required scopes: `w_organization_social` (plus `r_organization_social` /
`rw_organization_admin` for the role pre-check).

**Access tokens last ~60 days.** Set `LINKEDIN_TOKEN_EXPIRES_AT` so the pipeline
warns 14 days ahead; `cli.js status` reports token health on every run.

---

## Configuration

**Until every credential required by the selected mode is set, the workflow is
dormant.** For example, `auto` needs a model provider, GitHub, and LinkedIn configuration,
while `draft` does not need LinkedIn. Scheduled runs exit green with a notice
rather than failing every 6 hours — a partially configured pipeline is not a
broken pipeline, and a workflow that is always red is a workflow nobody reads.
A manual `workflow_dispatch` still fails loudly: you asked for a run, so you
should hear why you did not get one.

**`auto` without a LinkedIn token degrades rather than fails.** A *scheduled*
run set to `auto` with no `LINKEDIN_ACCESS_TOKEN` runs in `draft` and logs why.
The article is still worth generating and shipping; only the promotion step is
unavailable, and failing the cron every few hours while LinkedIn's Community
Management API approval is pending would leave this workflow permanently red.
A manual `workflow_dispatch` asking for `auto` still errors — someone clicked
that button expecting a LinkedIn post.

Secrets (Settings → Secrets and variables → Actions → **Secrets**):

| Secret | Needed for |
|---|---|
| `GEMINI_API_KEY` | primary generation provider |
| `GROQ_API_KEY` | free-tier fallback; can also run without Gemini |
| `CEREBRAS_API_KEY` | free open-source-model fallback (gpt-oss-120b on Cerebras); can also run alone |
| `CLOUDFLARE_AI_API_TOKEN` | fourth fallback — Workers AI on the same Cloudflare account as `CLOUDFLARE_ACCOUNT_ID` below, deliberately a separate token from `CLOUDFLARE_API_TOKEN` (that one's scoped for KV) so a leak or misconfig of either can't reach the other's permissions. Needs the account's **Workers AI: Edit** permission |
| `LINKEDIN_ACCESS_TOKEN` | LinkedIn posting |
| `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_KV_NAMESPACE_ID` | `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_KV_NAMESPACE_ID` only if `STATE_BACKEND=kv`; `CLOUDFLARE_ACCOUNT_ID` also doubles as the account for `CLOUDFLARE_AI_API_TOKEN` above |

`GITHUB_TOKEN` is provided by Actions automatically.

Variables (→ **Variables**):

| Variable | Default | Purpose |
|---|---|---|
| `PUBLISH_MODE` | `draft` | `dry-run` \| `draft` \| `review` \| `auto` |
| `GEMINI_MODEL` | `gemini-2.5-pro` | model id, rolled forward without a code change |
| `GROQ_MODEL` | `openai/gpt-oss-120b` | fallback model id |
| `CEREBRAS_MODEL` | `gpt-oss-120b` | second fallback model id — check `GET /v1/models` on the account's key before changing, Cerebras' catalog is account-scoped |
| `CLOUDFLARE_AI_MODEL` | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | third fallback model id — see the [model catalog](https://developers.cloudflare.com/workers-ai/models/) for other `@cf/...` ids |
| `LINKEDIN_ORGANIZATION_URN` | — | `urn:li:organization:12345678` |
| `LINKEDIN_TOKEN_EXPIRES_AT` | — | ISO timestamp, drives expiry warnings |
| `PUBLISH_INTERVAL_HOURS` | `48` | cadence (one article every 48h) |
| `TOPIC_COOLDOWN_DAYS` | `45` | primary-topic repeat window |
| `AUTOPUBLISH_DISABLED` | — | kill switch |
| `STATE_BACKEND` | `file` | `file` (git-committed) or `kv` (Cloudflare) |
| `UTM_CAMPAIGN` | `up2cloud_blog` | campaign tag |

Generation prefers Gemini, then Groq, then Cerebras, then Cloudflare Workers
AI — whichever of the four has a key configured, tried in that order. If the
active provider is unavailable, rate-limited, over its quota, or returns
payment-required (free credits/tier exhausted), the run falls through to the
next one and stays there for all remaining stages (sticky, so later stages
don't repeat a known-failing call). Schema-validation and content-quality
failures never trigger a provider switch — a different provider would likely
produce the same bad answer. Any single credential is enough to run; none of
the four free plans have unlimited daily capacity, so having several
configured is what makes the weekly cadence resilient to one or more of them
being tapped out on a given day.

### State backends

`file` (default) commits `automation/publishing/state/ledger.json` to the
default branch. Durable, auditable in git history, no extra infrastructure.

`kv` uses Cloudflare KV, which this site already depends on. Faster and avoids
ledger commits, but KV has no native compare-and-swap, so the git push at merge
time remains the final arbiter.

---

## Topics

Nine rotation domains in `config/topics.json`: platform engineering,
DevOps/DevSecOps, FinOps, cloud platforms, Terraform/OpenTofu,
Kubernetes/GitOps, CI/CD, SRE/observability, AI-assisted operations.

Selection is **least-recently-used among eligible domains**, so rotation is
deterministic and reviewable rather than random. Cooldown is enforced against
both automated publications and human-written posts in `blog/posts.json` — the
automation will not re-cover a topic a person wrote about last week.

A forced topic (`--topic finops`) still respects the cooldown; overriding it
would just push the duplicate-content problem into the quality gate.

---

## Security

- **Path traversal** — the slug is re-derived from a safe alphabet and rejected
  unless it round-trips unchanged; writes resolve against an allow-list
  (`blog/`, `sitemap.xml`, the state and artifact dirs) with symlink escape
  checks.
- **SSRF** — research fetches allow only http(s), no credentials, no odd ports;
  DNS is resolved and **every** returned address checked against private ranges,
  which is what defeats rebinding and `*.internal` tricks. Redirects are
  re-validated per hop.
- **Prompt injection** — fetched pages are fenced in a nonce-delimited untrusted
  block with a standing "this is data, not instructions" directive. Common
  override phrasings are defanged and zero-width/bidi smuggling characters are
  stripped. The fencing is the boundary; the pattern filter is hardening only.
- **Output escaping** — markdown rendering escapes HTML *first*, then re-adds a
  fixed tag set, so model output cannot inject live markup into a published page.
- **Secrets** — a redacting logger scrubs known secret values and token-shaped
  strings from every log line, including error stacks and API response bodies.
  Git auth uses a per-command header, never a URL-embedded token.

---

## Operations

```bash
# What would happen right now?
node automation/publishing/src/cli.js status

# Full pipeline, no writes, no API mutations
node automation/publishing/src/cli.js publish --mode dry-run

# Resume a run that failed partway
node automation/publishing/src/cli.js publish --resume run_20260810T090000_a1b2c3

# Publish now regardless of the interval (kill switch still applies)
node automation/publishing/src/cli.js publish --force --mode auto
```

Exit codes: `0` published or cleanly skipped · `1` a stage failed (ledger records
where; retry resumes there) · `2` misconfiguration.

### Interaction with existing workflows

Appending to `blog/posts.json` triggers the existing
`newsletter-notify.yml`, which emails subscribers via Brevo. That is intended —
the article ships, subscribers are notified, then LinkedIn is posted.

Production deploys through **Cloudflare Pages running `build.sh`**, which is
what actually serves `up2cloud.tech`; deployment verification polls the live
site rather than assuming a merge means a deploy.

---

## Known limitations

- **Article bodies are English-only.** The localize stage produces a localized
  *metadata* bundle (title/excerpt/category) for the four site locales and
  leaves the body canonical in English. Machine-translating 2,000 words of
  technical prose into three languages and publishing it unreviewed would
  triple the surface area for exactly the factual errors the quality gates
  exist to catch, with no reviewer able to verify them. Article-body
  translation should be a deliberate, separately-reviewed feature.
- **Deployment verification polls for ~90s** (6 × 15s). A slower Cloudflare
  propagation will fail the check; the run is resumable and the next attempt
  picks up at `verify_deployment` without regenerating anything.
- **The `review` mode merge gate** waits up to 25 minutes for checks. The
  repo's `deploy-pages.yml` has a manual `production-approval` environment gate;
  if that gate is enabled for these branches, `auto` mode will time out rather
  than merge, which is the safe failure direction.
