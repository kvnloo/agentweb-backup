/**
 * ENG-2108 (A2): ApiKeyTransport — a call paid for with the customer's own provider key,
 * sent through OpenRouter BYOK.
 *
 * Strict no-fallback is the whole point. `is_required` on the BYOK credential only stops
 * fallback to OpenRouter's own key for the SAME provider; it does not stop OpenRouter
 * moving a failed request to a DIFFERENT provider on AgentWeb's credits. So every request
 * here carries `provider.only = [the customer's provider]` and `allow_fallbacks: false`,
 * and any failure surfaces as an error. What happens next (stop, or switch to AgentWeb by
 * the user's setting) is A4's decision, never this transport's.
 */
import type OpenAI from "openai";
import type { RunFunding } from "../runFunding";
import { OpenRouterPlatformTransport } from "./openRouterPlatformTransport";
import { getCustomerRouteProvisioner } from "./customerRouteProvisioner";
import type { LlmTransport, LlmTransportRetryOptions } from "./llmTransport";

/**
 * OpenRouter provider slugs for `provider.only`, keyed by our BYOK provider names.
 * UNVERIFIED against live traffic: the slugs follow OpenRouter's BYOK credential API,
 * but `provider.ignore` is known to match display names instead (ENG-1702), so confirm
 * `only` accepts these before enabling a route (first live test once ENG-2383 lands).
 */
export const OPENROUTER_PROVIDER_SLUG: Record<string, string> = {
  anthropic: "anthropic",
  openai: "openai",
  google: "google-ai-studio",
};

export class CustomerRouteError extends Error {
  constructor(
    readonly code: "not_provisioned" | "unsupported_provider" | "no_connection",
  ) {
    super(`customer-funded route unavailable (${code})`);
    this.name = "CustomerRouteError";
  }
}

export class ApiKeyTransport implements LlmTransport {
  private readonly inner = new OpenRouterPlatformTransport();

  constructor(private readonly funding: RunFunding) {}

  async send(_platformClient: OpenAI, model: string, params: any, options: LlmTransportRetryOptions): Promise<any> {
    const { connectionId, provider } = this.funding;
    if (!connectionId) throw new CustomerRouteError("no_connection");
    const slug = provider ? OPENROUTER_PROVIDER_SLUG[provider] : undefined;
    if (!slug) throw new CustomerRouteError("unsupported_provider");
    const provisioner = getCustomerRouteProvisioner();
    if (!provisioner) throw new CustomerRouteError("not_provisioned");

    // The platform client is deliberately never used for a customer-funded call.
    const customerClient = await provisioner.clientFor(this.funding);
    // Drops AgentWeb's own provider preferences and the ENG-1702 `ignore` stopgap, which
    // exist for AgentWeb's credential slots; keeps only what the request itself needs.
    const { ignore: _ignore, order: _order, ...rest } = params.provider ?? {};
    params.provider = { ...rest, only: [slug], allow_fallbacks: false };
    return this.inner.send(customerClient, model, params, options);
  }
}
