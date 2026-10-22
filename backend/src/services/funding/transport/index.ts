export type { LlmTransport, LlmTransportRetryOptions, BackoffDecision } from "./llmTransport";
export { OpenRouterPlatformTransport } from "./openRouterPlatformTransport";
export { ApiKeyTransport, CustomerRouteError, pinToCustomerProvider } from "./apiKeyTransport";
export { registerCustomerRouteProvisioner, getCustomerRouteProvisioner } from "./customerRouteProvisioner";
export type { CustomerRouteProvisioner, MessagesClient } from "./customerRouteProvisioner";

import type { RunFunding } from "../runFunding";
import type { LlmTransport } from "./llmTransport";
import { OpenRouterPlatformTransport } from "./openRouterPlatformTransport";
import { ApiKeyTransport, CustomerRouteError } from "./apiKeyTransport";

const openRouterPlatformTransport = new OpenRouterPlatformTransport();

/**
 * `api_key` funding (resolved per call by `resolveCallFunding`) gets the strict
 * no-fallback customer-key transport; everything else, including an unset funding,
 * keeps today's OpenRouter platform transport.
 */
export function pickTransport(runFunding: RunFunding | undefined, _model: string): LlmTransport {
  if (!runFunding || runFunding.route === "agentweb") return openRouterPlatformTransport;
  if (runFunding.route === "api_key") return new ApiKeyTransport(runFunding);
  // A subscription route is served by its own runner, never by callLLM. Sending it out
  // on AgentWeb's key would bill AgentWeb for a call recorded as customer-funded.
  throw new CustomerRouteError("unsupported_route");
}
