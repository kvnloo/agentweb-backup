/**
 * ENG-2103 (F2 pilot) — shared, stateless tool-cost helpers.
 *
 * Extracted verbatim from `AgentModeService.prototype.estimateCost` and
 * `AgentModeService.prototype.makeToolUsageCallback`. Neither reads real instance
 * state: `estimateCost` is pure pricing arithmetic, and `makeToolUsageCallback`'s
 * only "state" was calling `this.estimateCost` and the module-level `chatbotDb`
 * singleton — so both are promoted here per the F2 design draft's §3.2 treatment
 * for pure/stateless helpers, the same way F1 promoted pure caches to their own
 * modules. `AgentModeService.prototype.*` now delegates to these.
 *
 * IMPORTANT — this is NOT the RunFunding/billingUserId usage-metering choke point
 * (`meterWithResolvedBilling` / `recordLlmUsage`, `services/funding/recordLlmUsage.ts`).
 * `addToolCostToSession` only appends a display-only cost figure to the chat
 * session's `toolCosts` map for the session UI; it carries no `userId`/
 * `billingUserId` and never reaches the per-user quota/billing ledger. The real
 * metering for an LLM call this callback observes usage from happens inside
 * `AgentModeService.callLLM` itself (see `emma/impl/books.ts`'s audit note on
 * `generateBookContent`).
 */
import { getModelPrice, cacheWriteCost, type CacheWriteByTtl } from '../../../utils/llmPricing';
import type { LLMUsageData } from '../../../utils/llmService';

/**
 * Estimate cost in USD for an LLM call based on model pricing.
 * Prices are per 1M tokens (input/output).
 */
export function estimateLlmCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number = 0,
  cacheWriteTokens: number = 0,
  /** ENG-893: per-TTL cache-write split from Bedrock's `usage.cacheDetails`. */
  cacheWriteByTtl?: CacheWriteByTtl
): number {
  // Single source of truth for rates: llmPricing.MODEL_PRICING (via getModelPrice).
  // Unknown models fall back to Sonnet pricing here, preserving long-standing behavior.
  const price = getModelPrice(model);
  const inputPrice = price?.inPerM ?? 3;
  const outputPrice = price?.outPerM ?? 15;
  // Cache reads are 10% of input price. Cache WRITES depend on the TTL that was
  // applied (1.25x at 5m, 2x at 1h), so they bill off the response's breakdown
  // when Bedrock reported one — see cacheWriteCost (ENG-893).
  const cacheReadPrice = price?.cacheReadPerM ?? inputPrice * 0.1;
  const effectivePrice = price ?? { inPerM: inputPrice, outPerM: outputPrice };
  return (inputTokens * inputPrice + outputTokens * outputPrice
    + cacheReadTokens * cacheReadPrice
    + cacheWriteCost(effectivePrice, cacheWriteTokens, cacheWriteByTtl)) / 1_000_000;
}

/**
 * Build an `onUsage` callback that records a tool's estimated LLM cost onto the
 * chat session (for the session-cost UI only — see the module doc comment above
 * for why this is NOT the billing/quota metering path).
 */
export function makeToolUsageCallback(sessionId: string | undefined, toolName: string): (usage: LLMUsageData) => void {
  return (usage) => {
    if (sessionId) {
      const cost = estimateLlmCost(usage.model, usage.inputTokens, usage.outputTokens);
      // Lazy require, not a top-level import: chatbotService.ts top-level-imports
      // agentModeService.ts (circular) and constructs a real AWS.DynamoDB.DocumentClient
      // at module load. A static import here would drag both back into every
      // importer of this standalone module — exactly the transitive-import trap
      // ENG-1816 F1's postmortem (lesson-lazy-require-aws-sdk-modules) describes.
      // require(), not await import(): the original call was synchronous from the
      // caller's perspective (no awaited import in between), so this keeps identical
      // timing once the module is warm in Node's require cache (true for every real
      // process, since agentModeService.ts already imports chatbotService.ts eagerly).
      const { chatbotDb } = require('../../../services/chatbotService') as typeof import('../../../services/chatbotService');
      chatbotDb.addToolCostToSession(sessionId, cost, toolName).catch((err: unknown) =>
        console.error(`AgentMode: Failed to add ${toolName} cost to session:`, err)
      );
    }
  };
}
