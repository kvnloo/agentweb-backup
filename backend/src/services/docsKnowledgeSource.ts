import type { ContextChunk } from './chatbotService';

/**
 * Canonical product docs live on Mintlify (docs.agentweb.pro). Mintlify
 * auto-publishes a plain-text `llms-full.txt` of the entire docs site, which is
 * the clean, single source for the support chatbot's knowledge base.
 *
 * This replaces the retired hand-rolled docs corpus (the Notion user-guide sync
 * engine + the `controllers/api.ts` endpoint-docs array) removed in ENG-163, so
 * the chatbot no longer answers from a stale shadow copy.
 */
export const MINTLIFY_DOCS_URL =
  process.env.MINTLIFY_DOCS_URL || 'https://docs.agentweb.pro/llms-full.txt';

/**
 * Fetch the full Mintlify docs corpus as plain text. Fails loudly (throws) on a
 * non-OK response so the KB loader logs a real error instead of silently
 * ingesting an error page.
 */
export async function fetchMintlifyDocsContent(): Promise<string> {
  const res = await fetch(MINTLIFY_DOCS_URL);
  if (!res.ok) {
    throw new Error(
      `Failed to fetch Mintlify docs (${MINTLIFY_DOCS_URL}): HTTP ${res.status}`
    );
  }
  return res.text();
}

/**
 * Split docs text into knowledge-base chunks (<= 2000 chars each), tagged with
 * the given `source`. Sentence-boundary chunking, matching the chunker the KB
 * loader already uses for the other content sources.
 */
export function chunkDocsContent(text: string, source = 'guide'): ContextChunk[] {
  const chunks: ContextChunk[] = [];
  if (!text || !text.trim()) return chunks;

  const sentences = text.match(/[^\.!\?]+[\.!\?]+/g) || [text];
  let currentChunk = '';
  let chunkId = 0;

  const flush = () => {
    if (currentChunk.trim()) {
      chunks.push({
        id: `chunk-${source}-${chunkId++}`,
        content: currentChunk.trim(),
        metadata: { source },
      });
    }
  };

  for (const sentence of sentences) {
    if ((currentChunk + sentence).length > 2000) {
      flush();
      currentChunk = sentence;
    } else {
      currentChunk += ' ' + sentence;
    }
  }
  flush();

  return chunks;
}
