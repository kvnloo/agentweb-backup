/**
 * ENG-2108 (A2): the seam for the half of customer-key routing that needs OpenRouter's
 * Management key (ENG-2383): creating a per-customer OpenRouter key and registering the
 * customer's provider key with it as a BYOK credential. Nothing implements it yet, and
 * with nothing registered no call is ever routed to a customer key
 * (`resolveCallFunding` checks), so the whole customer path stays dark.
 */
import type OpenAI from "openai";
import type { RunFunding } from "../runFunding";

/** The one call the coding agent makes: an Anthropic Messages-style client. */
export interface MessagesClient {
  messages: { create: (params: any) => Promise<any> };
}

export interface CustomerRouteProvisioner {
  /**
   * An OpenRouter client that bills the customer's own key for `funding.connectionId`.
   * Must throw rather than return a client that could bill AgentWeb.
   */
  clientFor(funding: RunFunding): Promise<OpenAI>;
  /**
   * Same, as an Anthropic Messages client pointed at OpenRouter (the coding agent's
   * wire format). Optional: a provisioner without it makes a customer-funded coding run
   * fail closed with `not_provisioned`, never fall back to AgentWeb's key.
   */
  messagesClientFor?(funding: RunFunding): Promise<MessagesClient>;
}

let provisioner: CustomerRouteProvisioner | null = null;

export function registerCustomerRouteProvisioner(next: CustomerRouteProvisioner | null): void {
  provisioner = next;
}

export function getCustomerRouteProvisioner(): CustomerRouteProvisioner | null {
  return provisioner;
}
