export type { LlmTransport, LlmTransportRetryOptions, BackoffDecision } from "./llmTransport";
export { OpenRouterPlatformTransport } from "./openRouterPlatformTransport";
export { ApiKeyTransport, CustomerRouteError } from "./apiKeyTransport";
export { registerCustomerRouteProvisioner, getCustomerRouteProvisioner } from "./customerRouteProvisioner";
export type { CustomerRouteProvisioner } from "./customerRouteProvisioner";

import type { RunFunding } from "../runFunding";
import type { LlmTransport } from "./llmTransport";
import { OpenRouterPlatformTransport } from "./openRouterPlatformTransport";
import { ApiKeyTransport } from "./apiKeyTransport";

const openRouterPlatformTransport = new OpenRouterPlatformTransport();

/**
 * `api_key` funding (resolved per call by `resolveCallFunding`) gets the strict
 * no-fallback customer-key transport; everything else, including an unset funding,
 * keeps today's OpenRouter platform transport.
 */
export function pickTransport(runFunding: RunFunding | undefined, _model: string): LlmTransport {
  if (runFunding?.route === "api_key") return new ApiKeyTransport(runFunding);
  return openRouterPlatformTransport;
}
