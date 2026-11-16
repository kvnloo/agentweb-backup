/**
 * ENG-1816 F1 — OpenRouterPlatformTransport: today's OpenRouter call path, extracted
 * from `callLLM` unchanged in behavior. Relocated code, not rewritten code — see
 * `llmTransport.ts` for the boundary this respects.
 *
 * What moved here: the attempt loop, response validation, and retry/backoff
 * mechanics (ENG-1626, ENG-1681). What did NOT move, and stays in `callLLM`: request
 * `params` construction, the success log line and its `reasoningEffort` annotation
 * (both use a value `callLLM` computes before ever calling this transport), and
 * metering (now routed through `recordLlmUsage`, per this same ticket). This is a
 * pure mechanical relocation of the retry loop's body — no retry/backoff logic here
 * was changed, only moved.
 */
import type OpenAI from "openai";
import { assertOpenRouterResponseHasChoices, assertOpenRouterResponseHasContent } from "../../agentMode/openRouterResponseValidation";
import { normalizeOpenRouterErrorMetadata } from "../../agentMode/openRouterMetadata";
import type { LlmTransport, LlmTransportRetryOptions } from "./llmTransport";

export class OpenRouterPlatformTransport implements LlmTransport {
  async send(client: OpenAI, model: string, params: any, options: LlmTransportRetryOptions): Promise<any> {
    const { timeoutMs, maxAttempts, requireContent, isRetryableError, computeBackoff, sleep, adjustParamsForRetry } = options;

    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await client.chat.completions.create(params, { timeout: timeoutMs, maxRetries: 0 });
        // ENG-1681: see openRouterResponseValidation.ts — converts a response with no
        // `choices` array into an explicit, retryable error before it ever reaches
        // the unguarded `response.choices[0].message` downstream.
        assertOpenRouterResponseHasChoices(res, model);
        if (requireContent) assertOpenRouterResponseHasContent(res, model);
        return res;
      } catch (error) {
        lastError = error;
        // ENG-2185: a deterministic correction (e.g. capping max_tokens to what
        // the provider says the account can afford), not a "hope it clears"
        // retry — checked ahead of isRetryableError/backoff and unconditional on
        // attempt count, since it's still bounded by the same maxAttempts loop.
        if (adjustParamsForRetry?.(error, params)) {
          continue;
        }
        if (attempt < maxAttempts && isRetryableError(error)) {
          const { ms: backoffMs, honoredRetryAfter } = computeBackoff(error, attempt);
          console.warn(
            `AgentMode: OpenRouter call failed with a transient error for model "${model}"; retrying (attempt ${attempt + 1}/${maxAttempts}) after ${backoffMs}ms${honoredRetryAfter ? ' (honoring Retry-After)' : ''}`,
            // ENG-2721: single-line JSON so line-based log sinks (CloudWatch) keep
            // provider + upstream_error on the same line as the message.
            JSON.stringify({
              error: error instanceof Error ? error.message : String(error),
              // ENG-1712: OpenRouter surfaces the attempted provider/BYOK slot on some
              // error shapes too (varies by failure type); include when present.
              ...normalizeOpenRouterErrorMetadata(error),
            }),
          );
          await sleep(backoffMs);
          continue;
        }
        break;
      }
    }
    console.error(
      `AgentMode: OpenRouter call failed for model "${model}":`,
      JSON.stringify({
        error: lastError instanceof Error ? lastError.message : String(lastError),
        ...normalizeOpenRouterErrorMetadata(lastError),
      }),
    );
    if (lastError instanceof Error && lastError.stack) {
      console.error(`AgentMode: OpenRouter failure stack for model "${model}":`, lastError.stack);
    }
    throw lastError;
  }
}
