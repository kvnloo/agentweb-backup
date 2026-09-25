export type { LlmTransport, LlmTransportRetryOptions, BackoffDecision } from "./llmTransport";
export { OpenRouterPlatformTransport } from "./openRouterPlatformTransport";

import type { RunFunding } from "../runFunding";
import type { LlmTransport } from "./llmTransport";
import { OpenRouterPlatformTransport } from "./openRouterPlatformTransport";

const openRouterPlatformTransport = new OpenRouterPlatformTransport();

/** F1 always resolves the OpenRouter transport. A2 adds ApiKeyTransport (BYOK). */
export function pickTransport(_runFunding: RunFunding | undefined, _model: string): LlmTransport {
  return openRouterPlatformTransport;
}
