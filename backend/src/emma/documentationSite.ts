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
  url: string;
}

const INTEGRATION_PATH = new RegExp(`^${DOCS_SITE_BASE_URL}/integrations/([a-z0-9-]+)/?$`);

/**
 * Derive the integration guides Emma may link to from the published corpus.
 *
 * This list is NOT maintained here. A hand-written copy drifted from the docs
 * site: it advertised a guide that had been removed (a dead link Emma handed
 * to clients) while omitting live ones, which made Emma report real, paid
 * channels as unsupported. The corpus is the only source of truth (ENG-1029).
 */
export function integrationsFromPages(pages: DocumentationPage[]): DocsIntegration[] {
  return pages
    .map((page) => ({ page, match: INTEGRATION_PATH.exec(page.url) }))
    .filter((entry): entry is { page: DocumentationPage; match: RegExpExecArray } => entry.match !== null)
    .map(({ page, match }) => ({ slug: match[1], name: page.title, url: page.url }))
    .sort((left, right) => left.slug.localeCompare(right.slug));
}

/** Drop the cached corpus so the next read re-fetches it. */
export function resetDocumentationCache(): void {
  docsCorpusCache = null;
  docsCorpusRequest = null;
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
    return { content: (await getDocumentationReference()).trim(), results: [] };
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
 * Reference block used for broad/no-query requests and outages.
 *
 * Pass the integrations derived from the live corpus. With none — the only
 * honest state during a docs outage, when the deep links would be unreachable
 * anyway — it emits no link list and says so, rather than asserting a list it
 * cannot verify.
 */
export function buildDocumentationReference(integrations: DocsIntegration[] = []): string {
  const header = ['', '---', '## AgentWeb Documentation Site'];

  if (integrations.length === 0) {
    return [
      ...header,
      `The canonical product documentation lives at ${DOCS_SITE_BASE_URL}/. The integration guide index is unavailable right now, so there are no deep links to give this turn — point the client at ${DOCS_SITE_BASE_URL}/ and do not invent a docs URL. Do not conclude from this reply that an integration is unsupported: the index could not be read, which is not the same as an integration being absent from it.`,
    ].join('\n');
  }

  return [
    ...header,
    `The canonical product documentation lives at ${DOCS_SITE_BASE_URL}/. When a client asks how to set up, connect, or use an integration, return the specific integration guide deep link below. Only return the deep links listed here — do not invent a docs URL for an integration that isn't listed. If a client asks about an integration that isn't listed, tell them it isn't a supported integration yet and offer the relevant workaround instead of guessing a link.`,
    '',
    '### Integration guides',
    ...integrations.map((i) => `- ${i.name}: ${i.url}`),
  ].join('\n');
}

/**
 * The reference block built from the live corpus. Throws if the corpus cannot
 * be read, so the caller reaches its explicit outage path instead of silently
 * serving an empty list as though the docs site published nothing.
 */
export async function getDocumentationReference(): Promise<string> {
  const pages = await fetchDocumentationCorpus();
  return buildDocumentationReference(integrationsFromPages(pages));
}
