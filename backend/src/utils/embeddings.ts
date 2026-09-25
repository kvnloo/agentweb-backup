import { getOpenAIClient, meterUsageFromResponse } from './llmClients';
import { getSecret } from './secretsManager';

// Keep the model and output size fixed across all embedding callers.
const EMBEDDING_MODEL = 'openai/text-embedding-3-large';
const EMBEDDING_DIMENSIONS = 3072;

/**
 * Embed arbitrary text. Returns null on empty input or any failure, so callers can degrade
 * gracefully (e.g. fall back to recency-based retrieval) instead of failing the request.
 *
 * `meterCtx` attributes the embedding spend: with a real userId it is charged to
 * that user's cap (tokens + cost); with no userId it is absorbed under "system"
 * (ENG-200). It never affects the embedding call itself.
 */
export async function embedText(
  text: string,
  meterCtx?: { userId?: string; feature?: string },
): Promise<number[] | null> {
  try {
    if (!text || !text.trim()) return null;
    const environment = process.env.NODE_ENV === 'production' ? 'prod' : 'dev';
    const apiKey = (process.env.OPENROUTER_API_KEY ||
      await getSecret(`${environment}/AgentWeb/OpenRouter`)).trim();
    if (!apiKey) throw new Error('OpenRouter API key is empty');
    // Un-metered client + explicit meter below so the spend is CHARGED (not just
    // recorded) when a userId is present. metered:false avoids double-recording.
    const embeddingsClient = getOpenAIClient(
      { userId: meterCtx?.userId, feature: meterCtx?.feature || 'embeddings' },
      { apiKey, baseURL: 'https://openrouter.ai/api/v1' },
      { metered: false },
    );
    const response = await embeddingsClient.embeddings.create({
      model: EMBEDDING_MODEL,
      input: text,
      dimensions: EMBEDDING_DIMENSIONS,
    });
    meterUsageFromResponse(
      { userId: meterCtx?.userId, model: EMBEDDING_MODEL, provider: 'openrouter', feature: meterCtx?.feature || 'embeddings' },
      response,
    );
    const embedding = Array.isArray(response?.data) ? response.data[0]?.embedding : undefined;
    if (!Array.isArray(embedding) || embedding.length !== EMBEDDING_DIMENSIONS ||
        !embedding.every(value => typeof value === 'number' && Number.isFinite(value))) {
      throw new Error('Invalid embedding vector');
    }
    return embedding;
  } catch (error) {
    console.error('[embedText] Failed to embed text:', error);
    return null;
  }
}
