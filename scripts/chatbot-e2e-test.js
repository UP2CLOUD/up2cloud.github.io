#!/usr/bin/env node
/**
 * Chatbot end-to-end smoke test.
 *
 * Hits the live https://up2cloud.tech/api/chat proxy with the same
 * SYSTEM_PROMPT and quick-reply questions real visitors use, and asserts a
 * real, populated answer comes back — not just a 200 status. This is
 * deliberately separate from groq-model-healthcheck.yml: that one auto-fixes
 * a deprecated model; this one is a broader "is the chat experience actually
 * working" check that only alerts (exits non-zero), it never edits files.
 *
 * Exit code 0 = every case passed. Exit code 1 = at least one failed —
 * details printed to stdout/stderr for the workflow to surface.
 */

const ENDPOINT = 'https://up2cloud.tech/api/chat';
const ORIGIN = 'https://up2cloud.tech';
const TIMEOUT_MS = 20000;
const MAX_LATENCY_MS = 15000;

// Mirrors index.html's SYSTEM_PROMPT — kept as a literal copy rather than
// parsed out of index.html so this test still catches a broken chat even if
// index.html itself is mid-edit or malformed.
const SYSTEM_PROMPT = `You are Cloud Advisor, UP2CLOUD's website assistant.
You help visitors understand UP2CLOUD services: Platform Engineering, DevOps, FinOps, Cloud Security, Kubernetes, Terraform, AWS, Azure, GCP, SRE, CI/CD and AI-assisted infrastructure operations.

Critical rules:
- Never say you sent an email, sent a booking link, scheduled an audit, created a calendar invite, or submitted a form. You do not have those automations.
- Never use placeholders like [insert link].
- Never recommend up2cloud.tech. For company/contact/booking references, use only https://up2cloud.tech, hello@up2cloud.tech, or +351 937 471 554.
- If the user says 'Book', 'Book free audit', or asks to schedule/contact, do not call the AI flow if possible. Answer with the contact form on this page, hello@up2cloud.tech, and +351 937 471 554. Never say you can connect them to Cesar or that you sent anything.
- Be concise, premium, and honest. Do not make up information.`;

// Two of the real quick-reply questions from the chatbot UI — enough to
// catch a broken model/proxy without hammering the shared rate limit
// (20 req/hour/IP) on every daily run.
const TEST_CASES = [
  { name: 'services question', question: 'Quais serviços vocês oferecem?' },
  { name: 'OpenClaw question', question: 'O que é o OpenClaw?' },
];

function withTimeout(promise, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return promise(controller.signal).finally(() => clearTimeout(timer));
}

async function runCase({ name, question }) {
  const started = Date.now();
  let res;
  try {
    res = await withTimeout(
      (signal) => fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
        body: JSON.stringify({
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: question },
          ],
          max_tokens: 500,
          temperature: 0.65,
        }),
        signal,
      }),
      TIMEOUT_MS,
    );
  } catch (err) {
    return { name, ok: false, reason: `Request failed: ${err.message}` };
  }
  const latencyMs = Date.now() - started;

  if (!res.ok) {
    const text = await res.text().catch(() => '<unreadable body>');
    return { name, ok: false, reason: `HTTP ${res.status}: ${text.slice(0, 300)}` };
  }

  let data;
  try {
    data = await res.json();
  } catch {
    return { name, ok: false, reason: 'Response was not valid JSON' };
  }

  if (data.error) {
    return { name, ok: false, reason: `Groq/proxy error: ${data.error.message || data.error}` };
  }

  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.trim() === '') {
    return {
      name,
      ok: false,
      reason: `Empty or missing content (finish_reason: ${data?.choices?.[0]?.finish_reason})`,
    };
  }

  if (latencyMs > MAX_LATENCY_MS) {
    return { name, ok: false, reason: `Latency ${latencyMs}ms exceeded ${MAX_LATENCY_MS}ms budget` };
  }

  return { name, ok: true, latencyMs, contentLength: content.length };
}

async function main() {
  const results = [];
  for (const testCase of TEST_CASES) {
    // Sequential, not parallel — stays well under the proxy's per-IP rate
    // limit and makes failures easier to attribute to one case.
    results.push(await runCase(testCase));
  }

  let allOk = true;
  for (const r of results) {
    if (r.ok) {
      console.log(`✔ ${r.name}: OK (${r.latencyMs}ms, ${r.contentLength} chars)`);
    } else {
      allOk = false;
      console.error(`✘ ${r.name}: FAILED — ${r.reason}`);
    }
  }

  if (process.env.GITHUB_OUTPUT) {
    const fs = require('fs');
    const failures = results.filter((r) => !r.ok).map((r) => `${r.name}: ${r.reason}`).join('\n');
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `failures=${failures.replace(/\n/g, ' | ')}\n`);
  }

  process.exit(allOk ? 0 : 1);
}

main();
