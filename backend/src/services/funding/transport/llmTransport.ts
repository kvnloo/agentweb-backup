/**
 * ENG-1816 F1 — LlmTransport: call-level seam used by `callLLM`.
 *
 * Bounded to send/validate/retry only. Param construction (provider order/ignore
 * rules, the Gemini schema sanitizer, cache breakpoints, the ENG-1831 parameter
 * chain) stays in `agentModeService.ts` — those rules are empirically verified
 * (e.g. the `'Google'` vs `'google-ai-studio'` BYOK slot inversion, confirmed by 10
 * live A/B calls) and moving them risks silently changing routing for no benefit.
 *
 * This refines the originally-sketched `send(model, messages, options)` signature
 * (`decision-shared-skeleton-contracts.md`) to match what the code actually builds:
 * one finished request `params` object (messages is only one field of it), not a
 * bare messages array — "given finished params, get a validated response back" is
 * the real boundary, and `params` is exactly that finished thing.
 */
import type OpenAI from "openai";

export interface BackoffDecision {
  ms: number;
  /** Whether `ms` came from the provider's own Retry-After signal, for the retry-warn log. */
  honoredRetryAfter: boolean;
}

export interface LlmTransportRetryOptions {
  timeoutMs: number;
  maxAttempts: number;
  isRetryableError: (error: unknown) => boolean;
  /** `attempt` is 1-indexed, the attempt that just failed. */
  computeBackoff: (error: unknown, attempt: number) => BackoffDecision;
  /**
   * Injected rather than a local `setTimeout` wrapper: `agentModeService.openRouterClient.test.ts`
   * spies on `AgentModeService.prototype.sleep` to assert exact backoff values without
   * actually waiting. Passing `(ms) => this.sleep(ms)` from `callLLM` keeps that spy
   * point working; a transport-local sleep would silently run real timers instead
   * (which is exactly what broke 8 tests, 2 of them via a genuine 7.5s/20s wait,
   * the first time this was tried without the injection).
   */
  sleep: (ms: number) => Promise<void>;
}

export interface LlmTransport {
  // `params` is deliberately `any`, matching the loose typing `callLLM` already
  // builds it with (see agentModeService.ts) — the OpenAI SDK's own request types
  // require `messages`/`model` as directly-typed literals that the constructed
  // params object satisfies at runtime but not structurally, the same gap the
  // original inline call already lived with.
  send(client: OpenAI, model: string, params: any, options: LlmTransportRetryOptions): Promise<any>;
}
