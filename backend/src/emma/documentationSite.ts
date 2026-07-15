/**
 * Canonical AgentWeb documentation site.
 *
 * The Notion-backed portal guide (see search_user_guide) covers general
 * onboarding but has no per-integration walkthroughs and no awareness of the
 * public docs site. This module lets Emma surface the correct documentation
 * deep links (e.g. https://docs.agentweb.pro/integrations/hubspot) when a
 * client asks how to set up or use an integration.
 */

export const DOCS_SITE_BASE_URL = 'https://docs.agentweb.pro';

export interface DocsIntegration {
  slug: string;
  name: string;
}

/**
 * Integration setup guides published under /integrations/<slug> on the docs
 * site. Keep slugs in sync with the docs.agentweb.pro URL structure.
 */
export const DOCS_INTEGRATIONS: DocsIntegration[] = [
  { slug: 'hubspot', name: 'HubSpot' },
  { slug: 'clickup', name: 'ClickUp' },
  { slug: 'google-drive', name: 'Google Drive' },
  { slug: 'slack', name: 'Slack' },
  { slug: 'linkedin', name: 'LinkedIn' },
];

/** Build the canonical deep link for an integration guide. */
export function integrationDocUrl(slug: string): string {
  return `${DOCS_SITE_BASE_URL}/integrations/${slug}`;
}

/**
 * Markdown reference to the documentation site, appended to search_user_guide
 * results so Emma always knows the canonical docs destination and returns the
 * correct deep link for integration questions.
 */
export function buildDocumentationReference(): string {
  const integrationLines = DOCS_INTEGRATIONS.map(
    (i) => `- ${i.name}: ${integrationDocUrl(i.slug)}`
  );

  return [
    '',
    '---',
    '## AgentWeb Documentation Site',
    `The canonical product documentation lives at ${DOCS_SITE_BASE_URL}/. When a client asks how to set up, connect, or use an integration, return the specific integration guide deep link below. Only return the deep links listed here — do not invent a docs URL for an integration that isn't listed. If a client asks about an integration that isn't listed, tell them it isn't a supported integration yet and offer the relevant workaround instead of guessing a link.`,
    '',
    '### Integration guides',
    ...integrationLines,
  ].join('\n');
}
