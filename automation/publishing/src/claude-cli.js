'use strict';

/**
 * Claude, via the `claude` CLI's headless mode, authenticated with a Claude
 * Pro/Max/Team subscription (`CLAUDE_CODE_OAUTH_TOKEN`, from `claude
 * setup-token`) instead of pay-per-token API billing. Mirrors the interface
 * every other provider exposes — `messages()` / `json()` — so it drops into
 * ModelClient's fallback chain exactly like Groq/Gemini/Cerebras/Cloudflare
 * AI/OpenRouter, and every existing pipeline stage needs zero changes.
 *
 * Unlike those HTTP-based clients, the `claude` CLI is a full coding agent
 * by default — it can read/write files and run shell commands in whatever
 * directory it's invoked from, which here is the checked-out repo. This
 * client always passes `--allowedTools ""`, disabling every tool, so a call
 * can only ever return generated text: no filesystem or shell access, same
 * blast radius as a plain chat-completion API call.
 */

const { spawn } = require('node:child_process');

const MAX_BACKOFF_MS = 30_000;

class ClaudeCliError extends Error {
  constructor(message, { exitCode, retryable, fallbackEligible } = {}) {
    super(message);
    this.name = 'ClaudeCliError';
    this.exitCode = exitCode;
    this.retryable = Boolean(retryable);
    this.fallbackEligible = Boolean(fallbackEligible);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Runs the CLI once, feeding `input` on stdin, and collects stdout/stderr/exit code. */
function runOnce(cliPath, args, { input, env, timeoutMs, spawnImpl }) {
  return new Promise((resolve, reject) => {
    const child = (spawnImpl || spawn)(cliPath, args, { env });
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new ClaudeCliError(`Failed to run "${cliPath}": ${err.message}`, {
        retryable: false,
        fallbackEligible: true,
      }));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new ClaudeCliError(`Claude CLI timed out after ${timeoutMs}ms`, {
          retryable: true,
          fallbackEligible: true,
        }));
        return;
      }
      resolve({ code, stdout, stderr });
    });

    child.stdin.write(input);
    child.stdin.end();
  });
}

/**
 * A subscription usage-limit hit ("Claude usage limit reached") means this
 * account is out of budget until it resets — retrying the same call can't
 * help, but it says nothing about whether another provider is available, so
 * fall through like the HTTP clients' 429/402 cases.
 */
function isUsageLimitError(text) {
  return /usage limit|rate limit|resets? at/i.test(text || '');
}

class ClaudeCliClient {
  constructor(config, { spawnImpl, logger, sleepImpl } = {}) {
    this.oauthToken = config.oauthToken;
    this.model = config.model;
    this.cliPath = config.cliPath || 'claude';
    this.maxRetries = config.maxRetries ?? 2;
    this.spawnImpl = spawnImpl;
    this.logger = logger;
    this.sleep = sleepImpl || sleep;
    if (!this.oauthToken) throw new ClaudeCliError('CLAUDE_CODE_OAUTH_TOKEN is required');
  }

  async messages({ system, messages, maxTokens, temperature, timeoutMs = 180_000 }) {
    // Every call site in this codebase sends exactly one user message per
    // call (see research.js/author.js/localize.js) — there is no multi-turn
    // chat to flatten, so this only needs the latest user content.
    const prompt = messages[messages.length - 1]?.content || '';
    const args = ['-p', '--output-format', 'json', '--allowedTools', ''];
    if (this.model) args.push('--model', this.model);
    if (system) args.push('--append-system-prompt', system);

    const env = { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: this.oauthToken };

    let lastError;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      let result;
      try {
        result = await runOnce(this.cliPath, args, {
          input: prompt,
          env,
          timeoutMs,
          spawnImpl: this.spawnImpl,
        });
      } catch (err) {
        lastError = err;
        if (!err.retryable || attempt === this.maxRetries) throw err;
        const backoff = Math.min(2 ** attempt * 1000, MAX_BACKOFF_MS);
        this.logger?.warn('Claude CLI call failed, retrying', { attempt: attempt + 1, backoffMs: backoff });
        await this.sleep(backoff);
        continue;
      }

      if (result.code === 0) {
        let parsed;
        try {
          parsed = JSON.parse(result.stdout);
        } catch {
          // `--output-format json` should always emit one JSON object, but
          // fall back to raw stdout as the text rather than hard-failing —
          // the caller's own json()/extractJsonObject() already tolerates
          // stray prose around the content it actually wants.
          return { text: result.stdout.trim(), raw: result.stdout };
        }
        if (parsed.is_error) {
          lastError = new ClaudeCliError(
            `Claude CLI reported an error: ${parsed.result || result.stderr}`,
            { fallbackEligible: isUsageLimitError(parsed.result) },
          );
          throw lastError;
        }
        return { text: parsed.result ?? '', raw: parsed, requestId: parsed.session_id };
      }

      const combined = `${result.stdout}\n${result.stderr}`;
      const usageLimited = isUsageLimitError(combined);
      lastError = new ClaudeCliError(
        `Claude CLI exited ${result.code}: ${combined.slice(0, 400)}`,
        { exitCode: result.code, retryable: !usageLimited, fallbackEligible: true },
      );
      if (usageLimited || attempt === this.maxRetries) throw lastError;
      const backoff = Math.min(2 ** attempt * 1000, MAX_BACKOFF_MS);
      this.logger?.warn('Claude CLI call failed, retrying', {
        exitCode: result.code,
        attempt: attempt + 1,
        backoffMs: backoff,
      });
      await this.sleep(backoff);
    }
    throw lastError;
  }

  /** Same JSON.parse + validate + retry contract as GroqClient.json()/GeminiClient.json(). */
  async json({ system, prompt, maxTokens, temperature, validate, maxJsonRetries = 2 }) {
    const { extractJsonObject } = require('./gemini');
    let lastErr;
    for (let attempt = 0; attempt <= maxJsonRetries; attempt += 1) {
      const { text } = await this.messages({
        system,
        messages: [{ role: 'user', content: prompt }],
        maxTokens,
        temperature,
      });

      let parsed;
      try {
        parsed = JSON.parse(extractJsonObject(text.trim()));
      } catch (err) {
        lastErr = new ClaudeCliError(`Claude did not return valid JSON: ${err.message}`);
        if (attempt === maxJsonRetries) throw lastErr;
        this.logger?.warn('Claude JSON did not parse, retrying', { attempt: attempt + 1, error: err.message });
        continue;
      }

      if (typeof validate === 'function') {
        const problems = validate(parsed);
        if (Array.isArray(problems) && problems.length) {
          lastErr = new ClaudeCliError(`Claude JSON failed schema validation: ${problems.join('; ')}`);
          if (attempt === maxJsonRetries) throw lastErr;
          this.logger?.warn('Claude JSON failed schema validation, retrying', { attempt: attempt + 1, problems });
          continue;
        }
      }
      return parsed;
    }
    throw lastErr;
  }
}

module.exports = { ClaudeCliClient, ClaudeCliError };
