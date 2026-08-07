# Security Policy — UP2CLOUD

## Reporting Security Vulnerabilities

If you discover a security vulnerability in this repository, please email **hello@up2cloud.tech** instead of using the public issue tracker.

Include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

We will respond within 48 hours and work with you to patch the issue responsibly.

---

## Security Practices

### API Keys & Secrets

**❌ NEVER:**
- Hardcode API keys in `.html`, `.js`, or `.py` files
- Commit `.env` files to Git
- Share secrets in pull requests or issues
- Expose keys in browser console (use environment variables + server-side injection)

**✅ ALWAYS:**
- Store secrets in `.env` (gitignored)
- Use GitHub repository secrets for CI/CD (`Settings → Secrets and variables → Actions`)
- Rotate compromised keys immediately
- Use least-privilege API scopes

### Example: Groq API Key Management

**Local Development:**
```bash
cp .env.example .env
# Edit .env and add your GROQ_API_KEY
node serve.js  # or python3 serve.py
```

**GitHub Actions (CI/CD):**
- Add `GROQ_API_KEY` secret in repository settings
- GitHub Actions injects it at deploy time via `sed` in `deploy-pages.yml`
- The compiled HTML receives the key, NOT the source files

### Content Security Policy (CSP)

- Defined in `_headers` file
- Restricts script/style sources to trusted domains
- Blocks inline scripts (except Tailwind and essential setup)
- Prevents XSS attacks and data exfiltration

### HTTPS & Transport Security

- GitHub Pages enforces HTTPS (all traffic encrypted)
- `Strict-Transport-Security` header forces HTTPS for 1 year + preload
- All third-party APIs (Groq, FormSubmit, Hotjar) use HTTPS

### Data Protection

- No sensitive user data stored on server
- Contact form data processed via FormSubmit (encrypted in transit)
- Analytics via Hotjar (anonymized, no PII)
- See `privacy/index.html` for full privacy policy

### Dependency Security

- Third-party scripts pinned to specific versions in CSP
- Tailwind CSS, Leaflet.js loaded from pinned CDN URLs
- No npm dependencies in root (all via CDN)

### Recommended Monitoring

- Monitor GitHub security alerts for dependency vulnerabilities
- Use [Mozilla Observatory](https://observatory.mozilla.org) to audit security headers
- Test CSP via browser DevTools (Network → Response Headers)
- Rotate API keys quarterly

---

## Security Checklist for Contributors

- [ ] No hardcoded API keys or passwords in commits
- [ ] All secrets in `.env`, added to `.gitignore`
- [ ] CSP headers align with new domains (if adding third-party scripts)
- [ ] HTTPS used for all external resources
- [ ] Input validation on forms (client-side + server-side via FormSubmit)
- [ ] No sensitive logging in JavaScript console
- [ ] Test with browser security console for CSP violations

---

## Compliance

- ✅ GDPR compliant (Privacy Policy in `/privacy`)
- ✅ ISO 27001 aligned (zero-trust principles, minimal data collection)
- ✅ OWASP Top 10 mitigations (CSP, HTTPS, input validation, secure headers)

---

**Last Updated:** May 6, 2026  
**Contact:** hello@up2cloud.tech
