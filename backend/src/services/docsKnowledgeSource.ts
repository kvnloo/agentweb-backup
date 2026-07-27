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
export const MINTLIFY_DOCS_TIMEOUT_MS = 10_000;
export const MAX_DOC_CHUNK_CHARS = 2_000;

/**
 * Fetch the full Mintlify docs corpus as plain text. Fails loudly (throws) on a
 * non-OK response so the KB loader logs a real error instead of silently
 * ingesting an error page.
 */
export async function fetchMintlifyDocsContent(): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MINTLIFY_DOCS_TIMEOUT_MS);

  try {
    const res = await fetch(MINTLIFY_DOCS_URL, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(
        `Failed to fetch Mintlify docs (${MINTLIFY_DOCS_URL}): HTTP ${res.status}`
      );
    }
    return await res.text();
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      throw new Error(
        `Mintlify docs request timed out after ${MINTLIFY_DOCS_TIMEOUT_MS}ms`
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Split docs text into knowledge-base chunks (<= 2000 chars each), tagged with
 * the given `source`. Sentence-boundary chunking, matching the chunker the KB
 * loader already uses for the other content sources.
 */
export function chunkDocsContent(text: string, source = 'guide'): ContextChunk[] {
  const chunks: ContextChunk[] = [];
  const content = text?.trim();
  if (!content) return chunks;

  let cursor = 0;
  while (cursor < content.length) {
    let end = Math.min(cursor + MAX_DOC_CHUNK_CHARS, content.length);

    if (end < content.length) {
      const window = content.slice(cursor, end);
      const preferredBoundary = Math.max(
        window.lastIndexOf('\n'),
        window.lastIndexOf('.'),
        window.lastIndexOf('!'),
        window.lastIndexOf('?')
      );
      if (preferredBoundary >= MAX_DOC_CHUNK_CHARS / 2) {
        end = cursor + preferredBoundary + 1;
      }
    }

    chunks.push({
      id: `chunk-${source}-${chunks.length}`,
      content: content.slice(cursor, end),
      metadata: { source },
    });
    cursor = end;
  }

  return chunks;
}
