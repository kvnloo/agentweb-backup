/**
 * ENG-113: "Compare models" multiverse view - keep the UNCHOSEN answers on the chosen assistant message.
 *
 * Switch: AW-Settings row `compare_save_alternatives`. ONLY the exact string 'true' (no trim, no case folding)
 * enables saving; absent / any other value / a cold-start read failure => off, i.e. exactly today's behaviour
 * (one user+assistant pair, the other columns are lost). A successful read is cached ~60s; a failed refresh keeps
 * the last-known value. Same pattern as compareProviderPolicy.ts.
 *
 * Storage is the free-form message `metadata` of the assistant row /compare/select already appends (owner-approved
 * additive key: no schema, index or table change):
 *   metadata.compareId, metadata.compareAlternatives: [{model,name,provider,content,latencyMs}]
 *   metadata.compareAlternativesOmitted: 'size'   (the answers would not fit: NONE are stored, never a partial set)
 *
 * Pure module apart from the injected settings reader (and constants shared with the size-guard test).
 */
import type { ChatMessage } from '../chatbotService';
import { MAX_PERSISTED_MESSAGE_BYTES } from '../../utils/messageSizeGuard';

export const COMPARE_SAVE_ALTERNATIVES_SETTING = 'compare_save_alternatives';

/** A comparison has 2-4 models; one is the chosen answer, so at most 3 alternatives. */
export const MAX_COMPARE_ALTERNATIVES = 3;
/**
 * Hard budget for the serialized `compareAlternatives` array (UTF-8 bytes of its JSON, i.e. what DynamoDB counts).
 * The per-row persistence cap is 350,000 bytes (chatbotService MAX_MESSAGE_CONTENT_SIZE, enforced by
 * messageSizeGuard.shrinkMessageForPersistence, which drops `metadata` once it is exceeded). The row is
 * accepted ONLY when its whole serialization is <= COMPARE_ROW_CAP_BYTES (cap minus 8 KiB headroom), so the guard
 * returns it untouched now AND after a later feedback/edit write.
 */
export const COMPARE_ALTERNATIVES_BUDGET_BYTES = 120_000;
/**
 * Headroom under the persistence cap. A later like/dislike/edit rewrites the row through the same guard, and that
 * guard truncates the CHOSEN ANSWER (step 3) before it sheds metadata (step 4): a row accepted right at the cap
 * lost characters of the answer after a feedback write. Rows accepted here therefore stay >= 8 KiB below the cap.
 */
export const COMPARE_ROW_HEADROOM_BYTES = 8_192;
export const COMPARE_ROW_CAP_BYTES = MAX_PERSISTED_MESSAGE_BYTES - COMPARE_ROW_HEADROOM_BYTES;
export const COMPARE_ALTERNATIVES_OMITTED_SIZE = 'size';
/** Display-only latency is clamped to something a 60s deadline could never exceed by much. */
export const MAX_ALTERNATIVE_LATENCY_MS = 3_600_000;

const CACHE_TTL_MS = 60_000;
const ERROR_RETRY_MS = 5_000;

export interface SavedAlternative {
  model: string;
  name: string;
  provider: string;
  content: string;
  latencyMs: number;
}

export const serializedBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');

/**
 * Attach the alternatives (or the explicit size marker) to a fully-built assistant message. Fail closed:
 *  - the alternatives array must be <= COMPARE_ALTERNATIVES_BUDGET_BYTES AND the whole row <= COMPARE_ROW_CAP_BYTES,
 *    otherwise NONE are stored and the marker is set (when even the marker would push the row over the cap the
 *    message is returned unchanged: the chosen answer is never put at risk for a marker);
 *  - the chosen answer, `llm` and every other field are never altered.
 */
export function withSavedAlternatives(
  message: ChatMessage,
  compareId: string,
  alternatives: readonly SavedAlternative[],
): ChatMessage {
  const base = message.metadata as NonNullable<ChatMessage['metadata']>;
  const stored: ChatMessage = {
    ...message,
    metadata: { ...base, compareId, compareAlternatives: alternatives.map((a) => ({ ...a })) },
  };
  if (serializedBytes(alternatives) <= COMPARE_ALTERNATIVES_BUDGET_BYTES && serializedBytes(stored) <= COMPARE_ROW_CAP_BYTES) {
    return stored;
  }
  const marked: ChatMessage = {
    ...message,
    metadata: { ...base, compareId, compareAlternativesOmitted: COMPARE_ALTERNATIVES_OMITTED_SIZE },
  };
  return serializedBytes(marked) <= COMPARE_ROW_CAP_BYTES ? marked : message;
}

export interface CompareSaveAlternativesDeps {
  getSetting(name: string): Promise<{ settingValue?: unknown } | null>;
  now(): number;
  log(message: string, fields?: Record<string, unknown>): void;
}

export function createCompareSaveAlternatives(deps: CompareSaveAlternativesDeps) {
  let known = false; // last successfully read value; cold start => off
  let validUntil = 0;
  let inFlight: Promise<void> | null = null;

  async function refresh(now: number): Promise<void> {
    try {
      const row = await deps.getSetting(COMPARE_SAVE_ALTERNATIVES_SETTING);
      known = row?.settingValue === 'true';
      validUntil = now + CACHE_TTL_MS;
    } catch (error) {
      deps.log('ModelCompare: failed to read save-alternatives switch; keeping last-known value (off if none)', {
        errorClass: (error as Error)?.name ?? 'Error',
        known,
      });
      validUntil = now + ERROR_RETRY_MS;
    }
  }

  async function isEnabled(): Promise<boolean> {
    const now = deps.now();
    if (now >= validUntil) {
      inFlight ??= refresh(now).finally(() => { inFlight = null; });
      await inFlight;
    }
    return known;
  }

  return { isEnabled };
}
