/**
 * Tests for docsKnowledgeSource — the Mintlify-backed docs source that replaced
 * the retired hand-rolled docs corpus (Notion user-guide + api.ts) in ENG-163.
 *
 * The support chatbot's knowledge base is now sourced from Mintlify
 * (docs.agentweb.pro/llms-full.txt). These tests mock `fetch` so no network is
 * touched.
 */
import {
  MINTLIFY_DOCS_URL,
  fetchMintlifyDocsContent,
  chunkDocsContent,
} from '../docsKnowledgeSource';

const mockFetch = jest.fn();
global.fetch = mockFetch as any;

// A representative slice of what Mintlify's llms-full.txt returns.
const MINTLIFY_DOCS = [
  '# Integrations',
  'To connect HubSpot, open Settings then Integrations and click Connect HubSpot.',
  'Authorize AgentWeb in the HubSpot popup to finish linking your CRM.',
  '# Tasks',
  'Create a task from natural language on the Tasks page and click Run to execute it.',
].join('\n');

describe('fetchMintlifyDocsContent', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('points at the Mintlify llms-full.txt docs source', () => {
    expect(MINTLIFY_DOCS_URL).toBe('https://docs.agentweb.pro/llms-full.txt');
  });

  it('fetches the Mintlify docs corpus and returns its text', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: () => Promise.resolve(MINTLIFY_DOCS),
    });

    const content = await fetchMintlifyDocsContent();

    expect(mockFetch).toHaveBeenCalledWith(MINTLIFY_DOCS_URL);
    expect(content).toContain('To connect HubSpot');
  });

  it('throws loudly on a non-OK response (no silent ingest of an error page)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: () => Promise.resolve('upstream error'),
    });

    await expect(fetchMintlifyDocsContent()).rejects.toThrow(/HTTP 503/);
  });
});

describe('chunkDocsContent', () => {
  it('chunks Mintlify docs into KB chunks tagged with the guide source', () => {
    const chunks = chunkDocsContent(MINTLIFY_DOCS, 'guide');

    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(chunk.metadata.source).toBe('guide');
      expect(typeof chunk.content).toBe('string');
    }

    // The docs answer to a support question is present in the chunked KB content.
    const combined = chunks.map((c) => c.content).join(' ');
    expect(combined).toContain('connect HubSpot');
  });

  it('returns no chunks for empty/whitespace content', () => {
    expect(chunkDocsContent('', 'guide')).toEqual([]);
    expect(chunkDocsContent('   \n  ', 'guide')).toEqual([]);
  });

  it('keeps each chunk within the 2000-char budget', () => {
    const big = ('Sentence about connecting HubSpot. ').repeat(400); // ~13k chars
    const chunks = chunkDocsContent(big, 'guide');

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(2000);
    }
  });
});

/**
 * End-to-end for AC2 at the source layer: given Mintlify content (mocked fetch),
 * the produced KB chunks answer a docs question. Uses the same keyword-scoring
 * the chatbot's retrieval falls back to, so the assertion mirrors real behavior
 * without importing the heavy chatbotService module.
 */
describe('KB answers a docs question sourced from Mintlify content', () => {
  beforeEach(() => jest.clearAllMocks());

  function bestChunk(query: string, chunks: { content: string }[]) {
    const keywords = query
      .toLowerCase()
      .replace(/[^\w\s]/g, '')
      .split(/\s+/)
      .filter((w) => w.length > 3);
    let best = chunks[0];
    let bestScore = -1;
    for (const chunk of chunks) {
      const content = chunk.content.toLowerCase();
      let score = 0;
      for (const kw of keywords) {
        const m = content.match(new RegExp(`\\b${kw}\\b`, 'g'));
        if (m) score += m.length;
      }
      if (score > bestScore) {
        bestScore = score;
        best = chunk;
      }
    }
    return best;
  }

  it('retrieves the HubSpot setup answer from Mintlify-sourced chunks', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: () => Promise.resolve(MINTLIFY_DOCS),
    });

    const docs = await fetchMintlifyDocsContent();
    const chunks = chunkDocsContent(docs, 'guide');

    const answer = bestChunk('How do I connect HubSpot?', chunks);
    expect(answer.content).toContain('connect HubSpot');
  });
});
