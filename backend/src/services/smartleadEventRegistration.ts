import { signWebhookToken } from "./smartleadWebhookToken";
import type { SmartleadWebhook } from "./smartleadService";

/**
 * Putting AgentWeb's event webhook on a customer's Smartlead campaign, and taking it off again (ENG-673, slice 3). Pure: the Smartlead calls are
 * injected.
 *
 * What the customer sees in their own Smartlead settings is ONE webhook per campaign we pushed into, named for the product (never a ticket or
 * a project), that tells AgentWeb about replies, bounces and unsubscribes. We only ever touch webhooks with exactly that name AND a URL that
 * points at this AgentWeb account's path: the customer's own webhooks, and any other tool's, are never read for content, changed or deleted.
 */
export const EVENT_WEBHOOK_NAME = "AgentWeb: replies, bounces and unsubscribes";
export const EVENT_TYPES = ["EMAIL_REPLY", "EMAIL_BOUNCE", "LEAD_UNSUBSCRIBED"];
const PATH = "/api/webhooks/smartlead/";

export interface WebhookApi {
  list(apiKey: string, campaignId: number): Promise<SmartleadWebhook[]>;
  save(apiKey: string, campaignId: number, input: { id?: number; name: string; url: string; eventTypes: string[] }): Promise<number>;
  del(apiKey: string, campaignId: number, webhookId: number): Promise<void>;
}

/**
 * The address Smartlead must call: this deployment's public base URL (BACKEND_URL). Production needs https; a test environment may use http.
 * Null means "no usable public address", and nothing is registered (a webhook pointing at localhost would only fail for the customer).
 */
export function publicBaseUrl(env: Record<string, string | undefined> = process.env): string | null {
  const raw = (env.BACKEND_URL ?? "").trim().replace(/\/+$/, "");
  if (!raw) return null;
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && env.NODE_ENV !== "production")) return null;
  if (/^(localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(u.hostname)) return null;
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`;
}

export const webhookUrlFor = (baseUrl: string, secret: string, accountId: string, campaignId: number): string =>
  `${baseUrl}${PATH}${encodeURIComponent(accountId)}/${campaignId}/${signWebhookToken(secret, accountId, campaignId)}`;

const sameTypes = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join(",") === [...b].sort().join(",");

/**
 * Is this webhook ours for this account? Name AND this deployment's own address AND this account's path. So another AgentWeb account's, a lookalike
 * name, or another deployment's (the test environment and production share a Smartlead account and a connection id) is left alone. The cost: after
 * BACKEND_URL changes, the old address's webhook is not recognised, so it stays (harmless, but a duplicate delivery until the customer deletes it).
 */
const isOurs = (w: SmartleadWebhook, accountId: string, baseUrl: string): boolean =>
  w.name === EVENT_WEBHOOK_NAME && w.url.startsWith(`${baseUrl}${PATH}${encodeURIComponent(accountId)}/`);

export type EnsureResult = "created" | "updated" | "present" | "no_public_url";

/** Makes sure the campaign has exactly one webhook of ours with the right address and events. Idempotent; safe to run on every push. */
export async function ensureEventWebhook(api: WebhookApi, args: { apiKey: string; accountId: string; campaignId: number; baseUrl: string | null; secret: string }): Promise<EnsureResult> {
  if (!args.baseUrl) return "no_public_url";
  const wanted = webhookUrlFor(args.baseUrl, args.secret, args.accountId, args.campaignId);
  const ours = (await api.list(args.apiKey, args.campaignId)).filter(w => isOurs(w, args.accountId, args.baseUrl!));
  const exact = ours.find(w => w.url === wanted && sameTypes(w.eventTypes, EVENT_TYPES));
  // Duplicates (a retry that raced, an old copy) are removed so one event is not delivered twice.
  for (const extra of ours.filter(w => w !== (exact ?? ours[0]))) await api.del(args.apiKey, args.campaignId, extra.id);
  if (exact) return "present";
  const existing = ours[0];
  await api.save(args.apiKey, args.campaignId, { ...(existing ? { id: existing.id } : {}), name: EVENT_WEBHOOK_NAME, url: wanted, eventTypes: EVENT_TYPES });
  return existing ? "updated" : "created";
}

export interface RemoveOutcome { campaigns: number; removed: number; failed: number }

/** Removes our webhook for this account from the given campaigns. One campaign failing does not stop the others. */
export async function removeEventWebhooks(api: WebhookApi, args: { apiKey: string; accountId: string; baseUrl: string; campaignIds: number[] }, log: (line: string) => void = () => undefined): Promise<RemoveOutcome> {
  const out: RemoveOutcome = { campaigns: 0, removed: 0, failed: 0 };
  for (const campaignId of args.campaignIds) {
    out.campaigns++;
    try {
      for (const w of (await api.list(args.apiKey, campaignId)).filter(x => isOurs(x, args.accountId, args.baseUrl))) {
        await api.del(args.apiKey, campaignId, w.id);
        out.removed++;
      }
    } catch (e) {
      out.failed++;
      log(`[SmartleadEvents] could not remove the event webhook from campaign ${campaignId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return out;
}
