#!/usr/bin/env node
/**
 * Groq model self-heal.
 *
 * Probes the live chatbot proxy (https://up2cloud.tech/api/chat). Groq
 * regularly deprecates free/developer-tier models (llama-3.1-8b-instant was
 * pulled 2026-08-16 with no warning visible from this codebase — every chat
 * request failed until a human noticed and fixed it manually). This script
 * lets a scheduled workflow catch that automatically and roll the hardcoded
 * model forward to the next entry in FALLBACK_MODELS, instead of waiting for
 * a customer-facing bug report.
 *
 * Exit codes:
 *   0 — healthy, current model still works, nothing to do.
 *   1 — was broken, rewrote functions/api/chat.js and index.html to the next
 *       fallback model; caller (the workflow) should commit + PR + deploy.
 *   2 — broken and every model in FALLBACK_MODELS has already failed, or the
 *       current model string couldn't be found; needs a human to refresh the
 *       list with Groq's current catalog. Nothing written to disk.
 */

const fs = require('fs');
const path = require('path');

// Ordered fallback chain of Groq chat-completion models, most-recommended
// first. Groq's catalog changes over time — once this whole list is
// exhausted the workflow opens an issue instead of guessing further.
const FALLBACK_MODELS = [
  'openai/gpt-oss-20b',
  'openai/gpt-oss-120b',
  'llama-3.3-70b-versatile',
  'moonshotai/kimi-k2-instruct',
];

const CHAT_JS = path.join(__dirname, '..', 'functions', 'api', 'chat.js');
const INDEX_HTML = path.join(__dirname, '..', 'index.html');
const PROBE_URL = 'https://up2cloud.tech/api/chat';

function writeOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${String(value).replace(/\n/g, ' ')}\n`);
  }
}

async function main() {
  const chatJsSrc = fs.readFileSync(CHAT_JS, 'utf8');
  const currentMatch = chatJsSrc.match(/const MODEL = "([^"]+)"/);
  const currentModel = currentMatch ? currentMatch[1] : null;

  if (!currentModel) {
    console.error('Could not find `const MODEL = "..."` in functions/api/chat.js — script needs updating.');
    process.exit(2);
  }

  console.log(`Current configured model: ${currentModel}`);
  console.log(`Probing ${PROBE_URL} ...`);

  let data;
  try {
    const res = await fetch(PROBE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://up2cloud.tech' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'ping' }], max_tokens: 5 }),
    });
    data = await res.json();
  } catch (err) {
    // Network/DNS failure is the uptime monitor's job, not this script's —
    // treat as healthy-enough-to-not-touch-the-model rather than guessing.
    console.log(`Probe request failed (${err.message}) — not a model problem, leaving as-is.`);
    process.exit(0);
  }

  const errorCode = data?.error?.code;
  const isModelError = errorCode === 'model_not_found' || errorCode === 'model_decommissioned';

  if (!isModelError) {
    console.log(`Healthy — "${currentModel}" responded without a model error.`);
    process.exit(0);
  }

  const errorMessage = data?.error?.message || errorCode || 'unknown error';
  console.log(`Model error: ${errorMessage}`);

  const currentIndex = FALLBACK_MODELS.indexOf(currentModel);
  const nextModel = FALLBACK_MODELS[currentIndex + 1];

  if (!nextModel) {
    console.error(
      `All fallback models exhausted (tried through "${currentModel}"). ` +
      'FALLBACK_MODELS in scripts/groq-model-failover.js needs a human to add ' +
      "Groq's current model catalog.",
    );
    writeOutput('error_message', errorMessage);
    writeOutput('old_model', currentModel);
    process.exit(2);
  }

  const updatedChatJs = chatJsSrc.replace(`const MODEL = "${currentModel}"`, `const MODEL = "${nextModel}"`);
  fs.writeFileSync(CHAT_JS, updatedChatJs);

  const indexHtmlSrc = fs.readFileSync(INDEX_HTML, 'utf8');
  const updatedIndexHtml = indexHtmlSrc.split(`model: '${currentModel}'`).join(`model: '${nextModel}'`);
  fs.writeFileSync(INDEX_HTML, updatedIndexHtml);

  console.log(`Rewrote model: "${currentModel}" -> "${nextModel}"`);
  writeOutput('old_model', currentModel);
  writeOutput('new_model', nextModel);
  writeOutput('error_message', errorMessage);
  process.exit(1);
}

main();
