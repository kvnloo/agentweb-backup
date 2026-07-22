/**
 * Canonical AgentWeb documentation site.
 *
 * Mintlify publishes an agent-readable copy of the full docs corpus. Emma
 * searches that canonical source directly and returns one bounded, relevant
 * page instead of loading the entire manual into the model context.
 */

export const DOCS_SITE_BASE_URL = 'https://docs.agentweb.pro';
export const DOCS_CORPUS_URL = `${DOCS_SITE_BASE_URL}/llms-full.txt`;

const DOCS_CACHE_TTL_MS = 10 * 60 * 1000;
const DOCS_FETCH_TIMEOUT_MS = 6_000;
const MAX_EXCERPT_CHARS = 7_500;

const STOP_WORDS = new Set([
  'about',
  'after',
  'agentweb',
  'connect',
  'could',
  'does',
  'from',
  'have',
  'help',
  'into',
  'setup',
  'that',
  'their',
  'this',
  'what',
  'when',
  'where',
  'with',
  'would',
]);

export interface DocumentationPage {
  title: string;
  url: string;
  content: string;
}

export interface DocumentationSearchResult {
  title: string;
  url: string;
  recommended: true;
}

let docsCorpusCache: { pages: DocumentationPage[]; expiresAt: number } | null = null;
let docsCorpusRequest: Promise<DocumentationPage[]> | null = null;

export interface DocsIntegration {
  slug: string;
  name: string;
}

/**
 * Integration setup guides published under /integrations/<slug> on the docs
 * site. Keep slugs in sync with the docs.agentweb.pro URL structure.
 */
export const DOCS_INTEGRATIONS: DocsIntegration[] = [
  { slug: 'meta', name: 'Meta Ads' },
  { slug: 'gmail', name: 'Gmail' },
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

function tokenize(value: string): string[] {
  return [...new Set(
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(/\s+/)
      .filter((token) => token.length > 2 && !STOP_WORDS.has(token))
  )];
}

function parseDocumentationCorpus(corpus: string): DocumentationPage[] {
  const headerPattern = /^# ([^\n]+)\n+Source:\s+(https:\/\/docs\.agentweb\.pro\/[^\s]+)\s*\n/gm;
  const headers = [...corpus.matchAll(headerPattern)];
  const pages = headers.map((header, index) => {
    const contentStart = (header.index ?? 0) + header[0].length;
    const contentEnd = headers[index + 1]?.index ?? corpus.length;
    return {
      title: header[1].trim(),
      url: header[2].trim(),
      content: corpus.slice(contentStart, contentEnd).trim(),
    };
  });

  if (pages.length === 0) {
    throw new Error('Mintlify returned an unreadable documentation corpus');
  }
  return pages;
}

async function fetchDocumentationCorpus(): Promise<DocumentationPage[]> {
  const now = Date.now();
  if (docsCorpusCache && docsCorpusCache.expiresAt > now) {
    return docsCorpusCache.pages;
  }
  if (docsCorpusRequest) return docsCorpusRequest;

  docsCorpusRequest = (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DOCS_FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(DOCS_CORPUS_URL, {
        headers: { Accept: 'text/plain' },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Mintlify documentation request failed (${response.status})`);
      }
      const pages = parseDocumentationCorpus(await response.text());
      docsCorpusCache = { pages, expiresAt: Date.now() + DOCS_CACHE_TTL_MS };
      return pages;
    } finally {
      clearTimeout(timeout);
      docsCorpusRequest = null;
    }
  })();

  return docsCorpusRequest;
}

function scorePage(page: DocumentationPage, queryTokens: string[]): number {
  const title = page.title.toLowerCase();
  const url = page.url.toLowerCase();
  const content = page.content.toLowerCase();
  const slug = page.url.split('/').filter(Boolean).pop() || '';
  const slugTokens = tokenize(slug);

  const lexicalScore = queryTokens.reduce((score, token) => {
    if (title.includes(token)) score += 10;
    if (url.includes(token)) score += 6;
    if (content.includes(token)) score += 2;
    return score;
  }, 0);

  // An explicit integration/page name in the query should beat a generic page
  // that merely mentions it. For example, "Meta ads account" must rank
  // /integrations/meta above a Google Ads page that compares itself to Meta.
  const exactSlugBonus = slugTokens.length > 0 &&
    slugTokens.every((token) => queryTokens.includes(token))
    ? 30
    : 0;
  return lexicalScore + exactSlugBonus;
}

function createExcerpt(page: DocumentationPage, queryTokens: string[]): string {
  if (page.content.length <= MAX_EXCERPT_CHARS) return page.content;

  const lowerContent = page.content.toLowerCase();
  const firstMatch = queryTokens
    .map((token) => lowerContent.indexOf(token))
    .filter((position) => position >= 0)
    .sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, firstMatch - 1_000);
  const prefix = start > 0 ? '…\n' : '';
  const suffix = start + MAX_EXCERPT_CHARS < page.content.length ? '\n…' : '';
  return `${prefix}${page.content.slice(start, start + MAX_EXCERPT_CHARS)}${suffix}`;
}

/** Search the canonical Mintlify corpus and return one model- and UI-friendly page. */
export async function searchDocumentation(
  query: string
): Promise<{ content: string; results: DocumentationSearchResult[] }> {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) {
    return { content: buildDocumentationReference().trim(), results: [] };
  }

  const pages = await fetchDocumentationCorpus();
  const bestPage = pages
    .map((page) => ({ page, score: scorePage(page, queryTokens) }))
    .sort((left, right) => right.score - left.score)[0];

  if (!bestPage || bestPage.score === 0) {
    return {
      content: `No exact documentation page matched "${query}". Browse the canonical docs at ${DOCS_SITE_BASE_URL}/.`,
      results: [],
    };
  }

  const excerpt = createExcerpt(bestPage.page, queryTokens);
  const result: DocumentationSearchResult = {
    title: bestPage.page.title,
    url: bestPage.page.url,
    recommended: true,
  };
  return {
    content: [`# ${result.title}`, excerpt, `Source: ${result.url}`].join('\n\n'),
    results: [result],
  };
}

/**
 * Small static fallback used for broad/no-query requests and outages.
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
