import { getOpenAIClient } from './llmClients';

/**
 * Lightweight embeddings helper, intentionally free of AWS / secrets-manager side effects
 * so it can be imported from routes and services without dragging in heavy module graphs.
 *
 * Uses the same Azure OpenAI embeddings deployment (text-embedding-3-large, 1536 dims) the
 * in-app chatbot already relies on, so relevance-based memory reuses capacity we already pay
 * for — no new vector database or API key.
 */
const embeddingsClientOptions = {
  apiKey: process.env.AZURE_OPENAI_EMBEDDINGS_API_KEY,
  baseURL: `${
    process.env.AZURE_OPENAI_EMBEDDINGS_ENDPOINT
  }/openai/deployments/${
    process.env.AZURE_OPENAI_EMBEDDINGS_DEPLOYMENT || 'text-embedding-3-large'
  }`,
  defaultQuery: {
    'api-version':
      process.env.AZURE_OPENAI_EMBEDDINGS_API_VERSION || '2024-08-01-preview',
  },
  defaultHeaders: { 'api-key': process.env.AZURE_OPENAI_EMBEDDINGS_API_KEY },
};

/**
 * Embed arbitrary text. Returns null on empty input or any failure, so callers can degrade
 * gracefully (e.g. fall back to recency-based retrieval) instead of failing the request.
 *
 * `meterCtx` is shadow-metering attribution only (Ship 1): when omitted, usage is
 * recorded under userId "system". It never affects the embedding call itself.
 */
export async function embedText(
  text: string,
  meterCtx?: { userId?: string; feature?: string },
): Promise<number[] | null> {
  try {
    if (!text || !text.trim()) return null;
    const embeddingsClient = getOpenAIClient(
      { userId: meterCtx?.userId, feature: meterCtx?.feature || 'embeddings' },
      embeddingsClientOptions,
    );
    const response = await embeddingsClient.embeddings.create({
      model: `${process.env.AZURE_OPENAI_EMBEDDINGS_DEPLOYMENT}`,
      input: text,
      dimensions: 1536,
    });
    return response.data[0].embedding;
  } catch (error) {
    console.error('[embedText] Failed to embed text:', error);
    return null;
  }
}
