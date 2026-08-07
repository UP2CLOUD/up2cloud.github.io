# UP2CLOUD — IT Consulting, Cloud & AI Solutions

> **Live site → [up2cloud.tech](https://up2cloud.tech)**

Landing page for UP2CLOUD, led by **Cesar A. Nogueira** — Senior Cloud DevOps & FinOps Consultant with 10+ years scaling infrastructure across GCP, AWS, Azure, and Oracle Cloud.

---

## What's Inside

| Feature | Detail |
|---|---|
| **i18n** | 🇺🇸 EN · 🇧🇷 PT · 🇪🇸 ES · 🇫🇷 FR — 148 tagged elements, embedded fallback (works offline) |
| **AI Chatbot** | Groq / Llama 3.1 8B Instant — injected via GitHub Secrets at deploy time |
| **Interactive Map** | Leaflet.js + CartoDB dark tiles — pins for Vila Real 🇵🇹, São Paulo 🇧🇷, Madrid 🇪🇸 |
| **Analytics** | Hotjar (HTTPS-only guard — skips on localhost) |
| **CI/CD** | GitHub Actions → GitHub Pages — auto-deploys on every push to `main` |
| **Local dev** | `node serve.js` or `python3 serve.py` — reads `.env`, injects secrets locally |

---

## Services Covered

- ☁️ Cloud Migration (AWS · Azure · GCP · Oracle Cloud)
- 🔧 DevOps & DevSecOps — Kubernetes, Terraform IaC, Jenkins, GitHub Actions
- 💰 FinOps & Cost Optimisation — avg. −42% cloud spend
- 🛡️ Cybersecurity — ISO 27001, Zero Trust, GDPR/LGPD
- 🤖 AI Solutions — OpenClaw installation, AI Agent Teams, custom chatbots
- 🌏 APAC Offshore Teams — up to 60% engineering cost savings vs EU/US hire
- 🔄 Digital Transformation — RPA, AI/ML integration, legacy modernisation

---

## Local Development

**Requirements:** Node.js 18+ or Python 3.9+

```bash
# Clone
git clone https://github.com/UP2CLOUD/up2cloud.github.io.git
cd up2cloud.github.io

# Configure secrets
cp .env.example .env
# Edit .env → add your GROQ_API_KEY from https://console.groq.com

# Start (Node.js) — recommended
npm start

# Start (Python alternative)
python3 serve.py
```

Open **[http://localhost:3000](http://localhost:3000)** — the Groq key is injected at request time, identical to production.

> **Note:** Opening `index.html` via `file://` also works — translations use embedded fallbacks (EN/PT/ES/FR) with zero network requests.

---

## Deployment

Every push to `main` triggers the **CI/CD — Test and Deploy UP2CLOUD Website** workflow:

1. Runs `htmlhint` on `index.html`
2. Validates Terraform configuration (`terraform fmt`, `terraform validate`)
3. Copies assets to `public/` build folder
4. Injects `GROQ_API_KEY` and `FORM_ENDPOINT` from repository secrets via `sed`
5. Uploads artifact and deploys to GitHub Pages

### Required Secrets

Go to **Settings → Secrets and variables → Actions** to configure:

| Secret | Source |
|---|---|
| `GROQ_API_KEY` | [console.groq.com](https://console.groq.com) → API Keys (free tier — 14,400 req/day) |

---

## Adding a New Language

The i18n system is designed for zero-friction expansion:

1. **Create** `assets/i18n/{code}.json` — use `assets/i18n/en.json` as template
2. **Register** in `LANG_META` inside `index.html`:
   ```js
   de: { flag: '🇩🇪', label: 'Deutsch', code: 'DE' }
   ```
3. **Add** a button to the language picker dropdown in the navbar

The engine fetches the JSON on first switch and caches it. No build step required.

---

## Project Structure

```
up2cloud.github.io/
├── index.html                    # Single-page site — all sections
├── serve.js                      # Node.js local dev server (secrets injection)
├── serve.py                      # Python alternative dev server
├── .env.example                  # Secret template — copy to .env
├── assets/
│   ├── i18n/                     # Translation JSON files (EN · PT · ES · FR)
│   └── img/
│       └── cesar.jpg             # Profile photo (add manually — gitignored)
├── terraform/
│   └── github-pages/             # Terraform — GitHub Pages infra
├── automation/
│   └── n8n/                      # n8n lead funnel workflow
└── .github/
    └── workflows/
        └── deploy-pages.yml      # CI/CD pipeline
```

---

## Tech Stack

![GCP](https://img.shields.io/badge/GCP-4285F4?style=flat&logo=google-cloud&logoColor=white)
![AWS](https://img.shields.io/badge/AWS-FF9900?style=flat&logo=amazonaws&logoColor=white)
![Azure](https://img.shields.io/badge/Azure-0078D4?style=flat&logo=microsoftazure&logoColor=white)
![Terraform](https://img.shields.io/badge/Terraform-7B42BC?style=flat&logo=terraform&logoColor=white)
![Kubernetes](https://img.shields.io/badge/Kubernetes-326CE5?style=flat&logo=kubernetes&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-2496ED?style=flat&logo=docker&logoColor=white)
![Python](https://img.shields.io/badge/Python-3776AB?style=flat&logo=python&logoColor=white)
![GitHub Actions](https://img.shields.io/badge/GitHub_Actions-2088FF?style=flat&logo=github-actions&logoColor=white)
![Groq](https://img.shields.io/badge/Groq_AI-F97316?style=flat&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PC9zdmc+&logoColor=white)

---

## Contact

| | |
|---|---|
| 🌐 Website | [up2cloud.tech](https://up2cloud.tech) |
| 📧 Email | [hello@up2cloud.tech](mailto:hello@up2cloud.tech) |
| 📱 WhatsApp | [+351 937 471 554](https://wa.me/351937471554) |
| 💼 LinkedIn | [linkedin.com/in/cesarnog](https://www.linkedin.com/in/cesarnog/) |
| 🐙 GitHub Org | [github.com/UP2CLOUD](https://github.com/UP2CLOUD) |
| 📍 Offices | 🇵🇹 Vila Real · 🇧🇷 São Paulo · 🇪🇸 Madrid *(coming soon)* |

---

© 2026 UP2CLOUD · Cesar A. Nogueira · [Privacy Policy](https://up2cloud.tech/privacy/)
