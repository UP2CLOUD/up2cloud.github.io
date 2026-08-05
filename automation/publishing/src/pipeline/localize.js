'use strict';

/**
 * Localization.
 *
 * The site ships four locales (en/pt/es/fr) and blog articles are English-only
 * today — the per-article language picker switches the surrounding *chrome*
 * via `data-i18n`, not the article body. So this stage does not invent a new
 * translation mechanism: it emits a localized metadata bundle (title, excerpt,
 * card copy) stored alongside the article, which is what the existing chrome
 * i18n can consume, and leaves the body canonical in English.
 *
 * That is a deliberate scope decision. Machine-translating 2,000 words of
 * technical prose into three languages and publishing it unreviewed would
 * create three times the surface area for exactly the factual errors the
 * quality gates exist to prevent, with no reviewer able to check them.
 */

const SUPPORTED_LOCALES = ['en', 'pt', 'es', 'fr'];
const CANONICAL_LOCALE = 'en';

/**
 * Terms that must survive translation byte-for-byte: code, commands, URLs,
 * product names and identifiers.
 */
const PRESERVE_INSTRUCTION = [
  'Preserve EXACTLY, without translation or reformatting:',
  '- all code, commands, flags and file paths',
  '- all URLs',
  '- product, project and vendor names (Kubernetes, Terraform, OpenTofu, Argo CD, Prometheus,',
  '  OpenTelemetry, AWS, GCP, Azure, GitHub Actions, UP2CLOUD, …)',
  '- technical identifiers and acronyms (SLO, RBAC, IaC, FinOps, DevSecOps, SBOM, SLSA, CRD, …)',
  '- numbers and units',
].join('\n');

async function localizeMetadata({ client, metadata, locales = SUPPORTED_LOCALES }) {
  const targets = locales.filter((l) => l !== CANONICAL_LOCALE);
  if (!targets.length) return { [CANONICAL_LOCALE]: canonicalBundle(metadata) };

  const prompt = [
    `Translate the following article metadata into these locales: ${targets.join(', ')}.`,
    ``,
    PRESERVE_INSTRUCTION,
    ``,
    `Source (English):`,
    JSON.stringify(
      { title: metadata.title, excerpt: metadata.excerpt, category: metadata.category },
      null,
      2,
    ),
    ``,
    `Return JSON keyed by locale code:`,
    `{`,
    targets.map((l) => `  "${l}": { "title": "…", "excerpt": "…", "category": "…" }`).join(',\n'),
    `}`,
    ``,
    `Keep the excerpt within 120-155 characters in each language.`,
    `Category names that are established English technical terms (FinOps, DevOps, AI, Cloud,`,
    `Security) stay in English.`,
  ].join('\n');

  const translated = await client.json({
    system:
      'You are a technical translator for cloud engineering content. You never translate code, ' +
      'commands, URLs, product names or technical identifiers.',
    prompt,
    temperature: 0.2,
    validate: (obj) => {
      const problems = [];
      for (const locale of targets) {
        if (!obj[locale]) problems.push(`missing locale ${locale}`);
        else if (!obj[locale].title || !obj[locale].excerpt) {
          problems.push(`locale ${locale} missing title/excerpt`);
        }
      }
      return problems;
    },
  });

  const bundle = { [CANONICAL_LOCALE]: canonicalBundle(metadata) };
  for (const locale of targets) {
    bundle[locale] = {
      title: translated[locale].title,
      excerpt: translated[locale].excerpt,
      category: translated[locale].category || metadata.category,
    };
  }
  return bundle;
}

function canonicalBundle(metadata) {
  return { title: metadata.title, excerpt: metadata.excerpt, category: metadata.category };
}

/**
 * Verify that preserved terms survived. A translation that mangled a command or
 * dropped a URL is a defect, so this is asserted rather than assumed.
 */
function verifyPreservation(bundle, mustContain = []) {
  const problems = [];
  for (const [locale, entry] of Object.entries(bundle)) {
    if (locale === CANONICAL_LOCALE) continue;
    const haystack = `${entry.title} ${entry.excerpt}`;
    for (const term of mustContain) {
      // Only assert for terms that appear in the English source, otherwise a
      // legitimately reworded translation would trip the check.
      if (!term) continue;
      const inSource = `${bundle[CANONICAL_LOCALE].title} ${bundle[CANONICAL_LOCALE].excerpt}`.includes(term);
      if (inSource && !haystack.includes(term)) {
        problems.push(`Locale "${locale}" dropped preserved term "${term}"`);
      }
    }
  }
  return problems;
}

module.exports = {
  localizeMetadata,
  verifyPreservation,
  SUPPORTED_LOCALES,
  CANONICAL_LOCALE,
  PRESERVE_INSTRUCTION,
};
