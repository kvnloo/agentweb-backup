import axios from "axios";
import { createHash } from "crypto";

// ─── Types ──────────────────────────────────────────────────────────────

export interface SmartLeadCampaign {
  name: string;
  status: string;
  totalLeads: number;
}

export interface SmartLeadMetrics {
  totalCampaigns: number;
  activeCampaigns: number;
  totalLeadsLoaded: number;
  leadsInProgress: number;
  leadsCompleted: number;
  leadsReplied: number;
  emailAccountsCount: number;
  campaigns: SmartLeadCampaign[];
  status: "ok" | "error" | "unavailable";
  error?: string;
}

// ─── Constants ──────────────────────────────────────────────────────────

const DEFAULT_BASE_URL = "https://server.smartlead.ai/api/v1";
// Test environments can point at a local stub (test-env/smartlead-stub.js). Honoured only when NODE_ENV is
// explicitly development or test, so an unset NODE_ENV (as in a real deployment) can never redirect customer keys.
const BASE_URL =
  (process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test") && process.env.SMARTLEAD_API_BASE_URL
    ? process.env.SMARTLEAD_API_BASE_URL.replace(/\/+$/, "")
    : DEFAULT_BASE_URL;
const LEADS_PAGE_LIMIT = 100;

// ─── Helpers ────────────────────────────────────────────────────────────

function emptyMetrics(status: "error" | "unavailable", error?: string): SmartLeadMetrics {
  return {
    totalCampaigns: 0,
    activeCampaigns: 0,
    totalLeadsLoaded: 0,
    leadsInProgress: 0,
    leadsCompleted: 0,
    leadsReplied: 0,
    emailAccountsCount: 0,
    campaigns: [],
    status,
    error,
  };
}

// ─── API Fetchers ───────────────────────────────────────────────────────

interface SmartLeadCampaignRaw {
  id: number;
  name: string;
  status: string;
  [key: string]: any;
}

interface SmartLeadLeadRaw {
  status: string;
  lead: {
    email: string;
    first_name?: string;
    last_name?: string;
    company_name?: string;
  };
  [key: string]: any;
}

interface SmartLeadLeadsResponse {
  total_leads: string;
  data: SmartLeadLeadRaw[];
}

// ─── Shared request client (ENG-2658) ───────────────────────────────────
//
// Every Smartlead call goes through smartleadRequest so that:
//  - 429s retry with exponential backoff + full jitter (honouring Retry-After),
//  - we self-throttle below Smartlead's rate limit (default ~60 req/min),
//  - the api_key query param never appears in thrown errors or logs.

export interface SmartleadClientOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  requestsPerMinute: number;
  timeoutMs: number;
}

const DEFAULT_CLIENT_OPTIONS: SmartleadClientOptions = {
  maxRetries: 4,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  requestsPerMinute: 60,
  timeoutMs: 15000,
};

let clientOptions: SmartleadClientOptions = { ...DEFAULT_CLIENT_OPTIONS };
let sleepFn: (ms: number) => Promise<void> = ms => new Promise(r => setTimeout(r, ms));
let randomFn: () => number = Math.random;
let nowFn: () => number = Date.now;
// Smartlead's limit is per API key, so each key has its own slot: one customer's push must not delay another's, or
// AgentWeb's own metrics key. Keyed by a hash so the key itself is never held as a map key or logged.
const nextSlotAtByKey = new Map<string, number>();
const THROTTLE_PRUNE_ABOVE = 1000;
const throttleKeyId = (apiKey: string) => createHash("sha256").update(apiKey).digest("hex").slice(0, 16);

/** Test seam: override timing/randomness and client options. Resets throttle state. */
export function __configureSmartleadClient(overrides: {
  options?: Partial<SmartleadClientOptions>;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
} = {}): void {
  clientOptions = { ...DEFAULT_CLIENT_OPTIONS, ...(overrides.options || {}) };
  sleepFn = overrides.sleep || (ms => new Promise(r => setTimeout(r, ms)));
  randomFn = overrides.random || Math.random;
  nowFn = overrides.now || Date.now;
  nextSlotAtByKey.clear();
}

/** Remove api_key values from any string (URLs, error messages, serialized configs). */
export function scrubSmartleadSecrets(text: string, apiKey?: string): string {
  let out = String(text ?? "").replace(/(api_key=)[^&\s"']+/gi, "$1[REDACTED]");
  if (apiKey) out = out.split(apiKey).join("[REDACTED]");
  return out;
}

async function acquireThrottleSlot(apiKey: string): Promise<void> {
  const rpm = clientOptions.requestsPerMinute;
  if (!rpm || rpm <= 0) return;
  const interval = 60000 / rpm;
  const now = nowFn();
  if (nextSlotAtByKey.size > THROTTLE_PRUNE_ABOVE) {
    for (const [id, at] of nextSlotAtByKey) if (at <= now) nextSlotAtByKey.delete(id);
  }
  const id = throttleKeyId(apiKey);
  const slot = Math.max(now, nextSlotAtByKey.get(id) ?? 0);
  nextSlotAtByKey.set(id, slot + interval);
  const wait = slot - now;
  if (wait > 0) await sleepFn(wait);
}

function retryDelayMs(attempt: number, retryAfterHeader: unknown): number {
  const retryAfter = Number(retryAfterHeader);
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(retryAfter * 1000, clientOptions.maxDelayMs);
  }
  const cap = Math.min(clientOptions.baseDelayMs * 2 ** attempt, clientOptions.maxDelayMs);
  return Math.floor(randomFn() * cap); // full jitter
}

export class SmartleadApiError extends Error {
  /**
   * True when a write may have been applied even though the call failed: no HTTP answer at all (timeout, dropped
   * connection) or a 5xx on a non-GET, or a 2xx whose body we could not read. A caller must not report such a batch
   * as "failed" or blindly resend it as "new"; a 429 is never unknown, because a rate-limited request added nothing.
   */
  constructor(message: string, public readonly status?: number, public readonly outcomeUnknown: boolean = false) {
    super(message);
    this.name = "SmartleadApiError";
  }
}

/** A 200 whose body is not the list we asked for (a wrong-key or wrong-plan reply may look like this). */
export class SmartleadUnexpectedResponseError extends SmartleadApiError {
  constructor(message: string) {
    super(message, undefined, true);
    this.name = "SmartleadUnexpectedResponseError";
  }
}

export async function smartleadRequest<T>(
  apiKey: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  opts: { params?: Record<string, unknown>; data?: unknown; maxRetries?: number } = {},
): Promise<T> {
  const maxRetries = opts.maxRetries ?? clientOptions.maxRetries;
  for (let attempt = 0; ; attempt++) {
    await acquireThrottleSlot(apiKey);
    try {
      const response = await axios.request<T>({
        method,
        url: `${BASE_URL}${path}`,
        params: { ...(opts.params || {}), api_key: apiKey },
        data: opts.data,
        timeout: clientOptions.timeoutMs,
      });
      return response.data;
    } catch (caught: unknown) {
      const error = caught as {
        message?: string;
        response?: { status?: number; headers?: Record<string, unknown> };
      };
      const status: number | undefined = error?.response?.status;
      if (status === 429 && attempt < maxRetries) {
        await sleepFn(retryDelayMs(attempt, error?.response?.headers?.["retry-after"]));
        continue;
      }
      const raw = error?.message || "Smartlead request failed";
      throw new SmartleadApiError(
        scrubSmartleadSecrets(`Smartlead ${method} ${path} failed${status ? ` (${status})` : ""}: ${raw}`, apiKey),
        status,
        method !== "GET" && (status === undefined || status >= 500),
      );
    }
  }
}

async function fetchCampaigns(apiKey: string): Promise<SmartLeadCampaignRaw[]> {
  const data = await smartleadRequest<SmartLeadCampaignRaw[]>(apiKey, "GET", "/campaigns");
  return data || [];
}

async function fetchCampaignLeads(
  apiKey: string,
  campaignId: number,
): Promise<{ total: number; leads: SmartLeadLeadRaw[] }> {
  const allLeads: SmartLeadLeadRaw[] = [];
  let offset = 0;
  let total = 0;

  // Paginate through all leads for this campaign
  while (true) {
    const data = await smartleadRequest<SmartLeadLeadsResponse>(
      apiKey,
      "GET",
      `/campaigns/${campaignId}/leads`,
      { params: { offset, limit: LEADS_PAGE_LIMIT } },
    );

    total = parseInt(data?.total_leads || "0", 10);

    if (!data?.data || data.data.length === 0) break;

    allLeads.push(...data.data);

    // If we got fewer than the limit, we've reached the end
    if (data.data.length < LEADS_PAGE_LIMIT) break;

    offset += LEADS_PAGE_LIMIT;

    // Safety cap: don't fetch more than 10 pages (1000 leads per campaign)
    if (offset >= 1000) break;
  }

  return { total, leads: allLeads };
}

const EMAIL_ACCOUNTS_MAX_PAGES = 20;

export interface SmartleadEmailAccount {
  id: number;
  email: string;
  /** Mailbox daily cap. The docs name it `message_per_day` on the list call and `max_email_per_day` on update; either is read. */
  dailyLimit?: number;
}

/**
 * A whole number from a vendor field, or undefined. Only a finite number or a non-empty numeric string counts:
 * `Number(null)`, `Number("")` and `Number([])` are all 0, which would turn a missing field into a real "0".
 */
function asWholeNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? Math.floor(value) : undefined;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? Math.floor(n) : undefined;
  }
  return undefined;
}

/** A positive whole number, or undefined. */
function asLimit(value: unknown): number | undefined {
  const n = asWholeNumber(value);
  return n !== undefined && n > 0 ? n : undefined;
}

/**
 * The mailboxes attached to a Smartlead key (ENG-673). Also the key check on connect: a rejected
 * key or unusable plan throws a SmartleadApiError carrying the HTTP status, and so does any
 * response that is not a list (no status), so an unvalidated key is never reported as valid.
 *
 * The first request sends no paging parameters, because they are not verified against a live
 * account; later pages ask for `offset` = mailboxes seen so far, and paging stops on an empty page
 * or a page with nothing new (an API that ignores the offset).
 */
export async function listEmailAccounts(
  apiKey: string,
  opts: { maxRetries?: number; maxPages?: number } = {},
): Promise<SmartleadEmailAccount[]> {
  const maxPages = Math.min(opts.maxPages ?? EMAIL_ACCOUNTS_MAX_PAGES, EMAIL_ACCOUNTS_MAX_PAGES);
  // Keyed by id; a row whose id we cannot read (the field name is unverified) is still a mailbox, so it is kept under a position key.
  const seen = new Map<number | string, SmartleadEmailAccount>();
  for (let page = 0; page < maxPages; page++) {
    const data = await smartleadRequest<unknown>(apiKey, "GET", "/email-accounts", {
      params: page === 0 ? undefined : { offset: seen.size },
      maxRetries: opts.maxRetries,
    });
    if (!Array.isArray(data)) {
      throw new SmartleadUnexpectedResponseError("Smartlead GET /email-accounts returned an unexpected response");
    }
    const before = seen.size;
    // Project to the fields we use: the list response also carries SMTP/IMAP passwords, which must never be kept or logged.
    data.forEach((row: { id?: unknown; from_email?: unknown; max_email_per_day?: unknown; message_per_day?: unknown } | null, i) => {
      const id = asWholeNumber(row?.id);
      const key = id !== undefined ? id : `row-${before + i}`;
      if (!seen.has(key)) {
        seen.set(key, {
          id: id !== undefined ? id : 0,
          email: String(row?.from_email ?? ""),
          dailyLimit: asLimit(row?.max_email_per_day ?? row?.message_per_day),
        });
      }
    });
    if (data.length === 0 || seen.size === before) break;
  }
  return [...seen.values()];
}

async function fetchEmailAccounts(apiKey: string): Promise<number> {
  const data = await smartleadRequest<unknown[]>(apiKey, "GET", "/email-accounts");
  return Array.isArray(data) ? data.length : 0;
}

// ─── Campaigns and lead import (ENG-673 slice 2) ────────────────────────
//
// Shapes below are from Smartlead's reference (api.smartlead.ai, read 2026-10-27), which contradicts itself in
// places, so every reader accepts the variants the docs show and projects only the fields we use.

export interface SmartleadCampaignSummary {
  id: number;
  name: string;
  /** Upper-cased as sent. Documented values: ACTIVE, PAUSED, STOPPED, ARCHIVED, DRAFTED (elsewhere DRAFT, COMPLETED). */
  status: string;
  maxLeadsPerDay?: number;
}

/** A list reply is a bare array (the "direct array" note) or wrapped as `campaigns` / `data` (the response table). */
function unwrapList(data: unknown, wrappers: string[]): unknown[] | undefined {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    for (const key of wrappers) {
      const inner = (data as Record<string, unknown>)[key];
      if (Array.isArray(inner)) return inner;
    }
  }
  return undefined;
}

function assertCampaignId(campaignId: number): void {
  if (!Number.isInteger(campaignId) || campaignId <= 0) throw new SmartleadApiError("A Smartlead campaign id must be a positive whole number");
}

/** The customer's own campaigns, newest first as Smartlead returns them. Rows without a usable id are dropped. */
export async function listCampaigns(apiKey: string, opts: { maxRetries?: number } = {}): Promise<SmartleadCampaignSummary[]> {
  const data = await smartleadRequest<unknown>(apiKey, "GET", "/campaigns/", { maxRetries: opts.maxRetries });
  const rows = unwrapList(data, ["campaigns", "data"]);
  if (!rows) throw new SmartleadUnexpectedResponseError("Smartlead GET /campaigns returned an unexpected response");
  const out: SmartleadCampaignSummary[] = [];
  for (const row of rows as Array<Record<string, unknown> | null>) {
    const id = asWholeNumber(row?.id);
    if (id === undefined || id <= 0) continue;
    out.push({
      id,
      name: String(row?.name ?? ""),
      status: String(row?.status ?? "").toUpperCase(),
      maxLeadsPerDay: asLimit(row?.max_leads_per_day),
    });
  }
  return out;
}

export type UpdateLeadEmailOutcome = "ok" | "rejected" | "not_found" | "no_update";

/**
 * Changes the address of a lead that is already in a campaign, in place (`POST /campaigns/{campaign_id}/leads/{lead_id}/` with only `email`).
 * Verified live (2026-10-28): the SAME lead id gets the new address, the old address is no longer in Smartlead (so it is no longer emailed),
 * the lead's name, phone, website and custom fields are untouched, its campaign status is kept, and a lead that was unsubscribed stays
 * unsubscribed. An address that already belongs to another lead is refused with HTTP 500 {"error":"Validation error"} and nothing changes:
 * that is "rejected" (the body is not readable through the shared client, so any 500 from this call is read as a refusal, which the caller
 * handles safely; a genuine outage that also answers 500 is retried on the next pass).
 */
export async function updateLeadEmail(apiKey: string, campaignId: number, leadId: string | number, email: string, opts: { maxRetries?: number } = {}): Promise<UpdateLeadEmailOutcome> {
  assertCampaignId(campaignId);
  const id = String(leadId);
  if (!/^[1-9]\d{0,15}$/.test(id)) throw new SmartleadApiError("A Smartlead lead id must be a positive whole number");
  const address = String(email ?? "").trim().toLowerCase();
  if (!address || address.length > 254) throw new SmartleadApiError("An email address is required");
  try {
    const data = await smartleadRequest<unknown>(apiKey, "POST", `/campaigns/${encodeURIComponent(String(campaignId))}/leads/${id}/`, { data: { email: address }, maxRetries: opts.maxRetries });
    const ok = (data as { ok?: unknown } | null)?.ok;
    if (ok === true) return "ok";
    if (ok === false) return "no_update";
    throw new SmartleadUnexpectedResponseError("Smartlead POST /campaigns/{id}/leads/{id}/ returned an unexpected response");
  } catch (error) {
    if (error instanceof SmartleadApiError && error.status === 404) return "not_found";
    if (error instanceof SmartleadApiError && error.status === 500) return "rejected";
    throw error;
  }
}

export type UnsubscribeOutcome = "ok" | "not_found" | "no_update";

/**
 * Unsubscribes a lead from EVERY campaign of the account, now and later (`POST /leads/{id}/unsubscribe`, no campaign in the path). It is the
 * call for an opt-out recorded in AgentWeb. Verified live (2026-10-28): `{ok: true}`, idempotent (a repeat also answers `{ok: true}`), 404 for a
 * lead that does not exist, and the docs say it cannot be undone through the API. `{ok: false}` means Smartlead changed nothing: the caller must
 * not treat the lead as withdrawn. Any other shape is an error, never "ok".
 */
export async function unsubscribeLeadGlobally(apiKey: string, leadId: string | number, opts: { maxRetries?: number } = {}): Promise<UnsubscribeOutcome> {
  const id = String(leadId);
  if (!/^[1-9]\d{0,15}$/.test(id)) throw new SmartleadApiError("A Smartlead lead id must be a positive whole number");
  try {
    const data = await smartleadRequest<unknown>(apiKey, "POST", `/leads/${id}/unsubscribe`, { maxRetries: opts.maxRetries });
    const ok = (data as { ok?: unknown } | null)?.ok;
    if (ok === true) return "ok";
    if (ok === false) return "no_update";
    throw new SmartleadUnexpectedResponseError("Smartlead POST /leads/{id}/unsubscribe returned an unexpected response");
  } catch (error) {
    if (error instanceof SmartleadApiError && error.status === 404) return "not_found";
    throw error;
  }
}

/**
 * Smartlead's id for the lead with this email in the account, or null when there is none. Verified live (2026-10-28): a found lead is an object
 * with `id`; an unknown email is HTTP 200 with an EMPTY object, which is "not found", not an error. A reply for a different address is an error.
 */
export async function findLeadIdByEmail(apiKey: string, email: string, opts: { maxRetries?: number } = {}): Promise<string | null> {
  const wanted = String(email ?? "").trim().toLowerCase();
  if (!wanted || wanted.length > 254) throw new SmartleadApiError("An email address is required");
  const data = await smartleadRequest<unknown>(apiKey, "GET", "/leads/", { params: { email: wanted }, maxRetries: opts.maxRetries });
  if (data === "" || data === null || data === undefined) return null;
  if (typeof data !== "object" || Array.isArray(data)) throw new SmartleadUnexpectedResponseError("Smartlead GET /leads/ returned an unexpected response");
  const row = data as Record<string, unknown>;
  if (Object.keys(row).length === 0) return null;
  const id = asWholeNumber(row.id);
  if (id === undefined || id <= 0) throw new SmartleadUnexpectedResponseError("Smartlead GET /leads/ returned a lead without an id");
  if (typeof row.email === "string" && row.email.trim().toLowerCase() !== wanted) throw new SmartleadUnexpectedResponseError("Smartlead GET /leads/ returned a different lead than asked for");
  return String(id);
}

export interface SmartleadCampaignDetail extends SmartleadCampaignSummary {
  /** Whether Smartlead adds its own unsubscribe link to each email (the sequence check warns when it does not and the body has none). */
  addUnsubscribeTag?: boolean;
  /**
   * The campaign's unsubscribe footer text. Verified with received emails (2026-10-28): Smartlead adds the unsubscribe link (and the
   * List-Unsubscribe header) only when `add_unsubscribe_tag` is on AND this text is set; with the setting on and the text empty it adds
   * nothing. `null` here means the campaign has no text; absent means Smartlead did not say.
   */
  unsubscribeText?: string | null;
}

/**
 * One campaign, read fresh (the engine re-reads status before every batch). Verified on a real account (2026-10-28): an id that does
 * not exist returns HTTP 200 with an EMPTY body, not a 404, so an empty reply means "no such campaign" and gives null; any other
 * reply that is not a campaign object is an error, never a campaign.
 */
export async function getCampaign(apiKey: string, campaignId: number, opts: { maxRetries?: number } = {}): Promise<SmartleadCampaignDetail | null> {
  assertCampaignId(campaignId);
  const data = await smartleadRequest<unknown>(apiKey, "GET", `/campaigns/${encodeURIComponent(String(campaignId))}`, { maxRetries: opts.maxRetries });
  if (data === "" || data === null || data === undefined) return null;
  if (typeof data !== "object" || Array.isArray(data)) throw new SmartleadUnexpectedResponseError("Smartlead GET /campaigns/{id} returned an unexpected response");
  const row = data as Record<string, unknown>;
  const id = asWholeNumber(row.id);
  if (id === undefined || id !== campaignId) throw new SmartleadUnexpectedResponseError("Smartlead GET /campaigns/{id} returned a different campaign than asked for");
  return {
    id,
    name: String(row.name ?? ""),
    status: String(row.status ?? "").toUpperCase(),
    maxLeadsPerDay: asLimit(row.max_leads_per_day),
    ...(typeof row.add_unsubscribe_tag === "boolean" ? { addUnsubscribeTag: row.add_unsubscribe_tag } : {}),
    ...("unsubscribe_text" in row ? { unsubscribeText: typeof row.unsubscribe_text === "string" ? row.unsubscribe_text : null } : {}),
  };
}

/**
 * One campaign's counters as Smartlead reports them (ENG-2737). Opens and clicks are left out on purpose: connector campaigns do not turn
 * tracking on, so those numbers would read zero and mislead.
 */
export interface SmartleadCampaignAnalytics {
  campaignId: number;
  name: string;
  status: string;
  /** Leads in the campaign, whatever their state (`campaign_lead_stats.total`); absent when Smartlead did not say. */
  leadsInCampaign?: number;
  /** Contacts emailed at least once (`unique_sent_count`). */
  contactsEmailed: number;
  /** Every email sent, follow-ups included (`sent_count`). */
  emailsSent: number;
  replies: number;
  bounces: number;
  unsubscribes: number;
}

/**
 * A counter Smartlead sends as a string ("38"). Strict: plain digits (or a safe whole number), nothing else. Missing, negative, fractional,
 * hex or exponent forms and absurd sizes are an unexpected reply, never a silent zero or a plausible-looking wrong number.
 */
function analyticsCount(row: Record<string, unknown>, key: string): number {
  const raw = row[key];
  const n = typeof raw === "number" ? raw : typeof raw === "string" && /^\d{1,15}$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  if (!Number.isSafeInteger(n) || n < 0) throw new SmartleadUnexpectedResponseError(`Smartlead GET /campaigns/{id}/analytics returned no usable ${key}`);
  return n;
}

/**
 * Read-only counters for one campaign (`GET /campaigns/{id}/analytics`). An id that does not exist (or is not this key's) comes back as an
 * empty object (or, as with `getCampaign`, an empty body), which gives null; a body that is not a campaign, or is a different campaign than
 * asked for, is an error.
 */
export async function getCampaignAnalytics(apiKey: string, campaignId: number, opts: { maxRetries?: number } = {}): Promise<SmartleadCampaignAnalytics | null> {
  assertCampaignId(campaignId);
  const data = await smartleadRequest<unknown>(apiKey, "GET", `/campaigns/${encodeURIComponent(String(campaignId))}/analytics`, { maxRetries: opts.maxRetries });
  if (data === "" || data === null || data === undefined) return null;
  if (typeof data !== "object" || Array.isArray(data)) throw new SmartleadUnexpectedResponseError("Smartlead GET /campaigns/{id}/analytics returned an unexpected response");
  const row = data as Record<string, unknown>;
  // Verified on a real account (2026-11-04): an id that does not exist, or is not this key's, returns HTTP 200 with an EMPTY object.
  if (Object.keys(row).length === 0) return null;
  const id = asWholeNumber(row.id);
  if (id === undefined || id !== campaignId) throw new SmartleadUnexpectedResponseError("Smartlead GET /campaigns/{id}/analytics returned a different campaign than asked for");
  const leadStats = row.campaign_lead_stats && typeof row.campaign_lead_stats === "object" ? (row.campaign_lead_stats as Record<string, unknown>) : undefined;
  const leadsInCampaign = asWholeNumber(leadStats?.total);
  return {
    campaignId: id,
    name: String(row.name ?? ""),
    status: String(row.status ?? "").toUpperCase(),
    ...(leadsInCampaign !== undefined && leadsInCampaign >= 0 ? { leadsInCampaign } : {}),
    contactsEmailed: analyticsCount(row, "unique_sent_count"),
    emailsSent: analyticsCount(row, "sent_count"),
    replies: analyticsCount(row, "reply_count"),
    bounces: analyticsCount(row, "bounce_count"),
    unsubscribes: analyticsCount(row, "unsubscribed_count"),
  };
}

export type SmartleadEmailStatus = "is_replied" | "is_bounced" | "is_unsubscribed" | "is_sender_bounced";

export interface SmartleadLeadRow {
  /** Smartlead's own lead id. */
  leadId: string;
  email: string;
  /** Smartlead's own flag on the lead (`lead.is_unsubscribed`); true after an unsubscribe by link, by us through the API, or by the customer. */
  unsubscribed: boolean;
}

/**
 * One page of a campaign's contacts, optionally only those Smartlead says replied or bounced (`GET /campaigns/{id}/leads?emailStatus=...`; verified
 * live 2026-10-30: `{total_leads (a string), data[{campaign_lead_map_id, status, lead{id, email, is_unsubscribed, ...}}], offset, limit}`, and an
 * unknown emailStatus is a 400 that names the allowed values). It carries no timestamp and no message text, so it can only say THAT a contact did
 * it. LIVE FINDING: the `is_unsubscribed` filter does NOT list a contact unsubscribed through the API (it stays empty although the contact is
 * `BLOCKED` with `lead.is_unsubscribed: true`), and `status=BLOCKED` is not an allowed filter, so opt-outs are found by reading the pages with no
 * filter and keeping the rows whose own flag is set. That listing lags behind a large add, which is harmless here: the poll only ever acts on a row
 * that IS there, so a lagging page just means a contact is found on a later pass. A row without a usable id or address is dropped; a reply that
 * is not this shape is an error, never "nobody".
 */
export async function listCampaignLeadsByEmailStatus(
  apiKey: string,
  campaignId: number,
  emailStatus: SmartleadEmailStatus | null,
  opts: { offset?: number; limit?: number; maxRetries?: number } = {},
): Promise<{ total: number; rows: SmartleadLeadRow[] }> {
  assertCampaignId(campaignId);
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 100);
  const offset = Math.max(opts.offset ?? 0, 0);
  const data = await smartleadRequest<unknown>(apiKey, "GET", `/campaigns/${encodeURIComponent(String(campaignId))}/leads`, {
    params: { ...(emailStatus ? { emailStatus } : {}), limit, offset },
    maxRetries: opts.maxRetries,
  });
  if (!data || typeof data !== "object" || Array.isArray(data) || !Array.isArray((data as { data?: unknown }).data)) {
    throw new SmartleadUnexpectedResponseError("Smartlead GET /campaigns/{id}/leads returned an unexpected response");
  }
  const body = data as { total_leads?: unknown; data: Array<Record<string, any> | null> };
  const total = asWholeNumber(body.total_leads);
  if (total === undefined || total < 0) throw new SmartleadUnexpectedResponseError("Smartlead GET /campaigns/{id}/leads returned no usable total");
  const rows: SmartleadLeadRow[] = [];
  for (const row of body.data) {
    const lead = row?.lead;
    const id = lead && typeof lead === "object" ? (typeof lead.id === "number" || typeof lead.id === "string" ? String(lead.id) : "") : "";
    const address = lead && typeof lead.email === "string" ? lead.email.trim().toLowerCase() : "";
    if (id && address.includes("@")) rows.push({ leadId: id, email: address, unsubscribed: lead.is_unsubscribed === true });
  }
  return { total, rows };
}

export interface SmartleadWebhook {
  id: number;
  name: string;
  url: string;
  eventTypes: string[];
}

/**
 * The webhooks registered on one campaign. Verified live (2026-10-30): `GET /campaigns/{id}/webhooks` answers a bare array of
 * `{id, name, webhook_url, event_types, categories, ...}` (an empty array when there are none). Anything else is an error, so an odd reply can
 * never be read as "no webhooks" and trigger a duplicate registration.
 */
export async function listCampaignWebhooks(apiKey: string, campaignId: number, opts: { maxRetries?: number } = {}): Promise<SmartleadWebhook[]> {
  assertCampaignId(campaignId);
  const data = await smartleadRequest<unknown>(apiKey, "GET", `/campaigns/${encodeURIComponent(String(campaignId))}/webhooks`, { maxRetries: opts.maxRetries });
  if (!Array.isArray(data)) throw new SmartleadUnexpectedResponseError("Smartlead GET /campaigns/{id}/webhooks returned an unexpected response");
  const out: SmartleadWebhook[] = [];
  for (const row of data) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const id = asWholeNumber(r.id);
    if (id === undefined) continue;
    out.push({ id, name: String(r.name ?? ""), url: String(r.webhook_url ?? ""), eventTypes: Array.isArray(r.event_types) ? r.event_types.filter((e): e is string => typeof e === "string") : [] });
  }
  return out;
}

/** Creates a campaign webhook, or updates the one with `id` (the same POST; verified live 2026-10-30). Returns its id. */
export async function saveCampaignWebhook(
  apiKey: string,
  campaignId: number,
  input: { id?: number; name: string; url: string; eventTypes: string[] },
  opts: { maxRetries?: number } = {},
): Promise<number> {
  assertCampaignId(campaignId);
  const data = await smartleadRequest<unknown>(apiKey, "POST", `/campaigns/${encodeURIComponent(String(campaignId))}/webhooks`, {
    data: { ...(input.id !== undefined ? { id: input.id } : {}), name: input.name, webhook_url: input.url, event_types: input.eventTypes },
    maxRetries: opts.maxRetries,
  });
  const id = data && typeof data === "object" ? asWholeNumber((data as Record<string, unknown>).id) : undefined;
  if (id === undefined) throw new SmartleadUnexpectedResponseError("Smartlead POST /campaigns/{id}/webhooks returned an unexpected response");
  return id;
}

/** Deletes one campaign webhook: `DELETE /campaigns/{id}/webhooks` with `{id}` in the body (verified live 2026-10-30). */
export async function deleteCampaignWebhook(apiKey: string, campaignId: number, webhookId: number, opts: { maxRetries?: number } = {}): Promise<void> {
  assertCampaignId(campaignId);
  const data = await smartleadRequest<unknown>(apiKey, "DELETE", `/campaigns/${encodeURIComponent(String(campaignId))}/webhooks`, { data: { id: webhookId }, maxRetries: opts.maxRetries });
  if (!data || typeof data !== "object" || (data as Record<string, unknown>).ok !== true) throw new SmartleadUnexpectedResponseError("Smartlead DELETE /campaigns/{id}/webhooks did not confirm the delete");
}

/**
 * The raw sequence steps of a campaign, for `analyseSequence`. Verified live (2026-10-28): a real campaign gives a bare array (empty
 * for a campaign with no steps), and an id that does not exist gives an `{error: "Campaign not found..."}` object. Anything that is
 * not an array is an error here, so a "campaign not found" reply can never be read as an empty sequence and pushed against.
 */
export async function getCampaignSequences(apiKey: string, campaignId: number, opts: { maxRetries?: number } = {}): Promise<unknown[]> {
  assertCampaignId(campaignId);
  const data = await smartleadRequest<unknown>(apiKey, "GET", `/campaigns/${encodeURIComponent(String(campaignId))}/sequences`, { maxRetries: opts.maxRetries });
  if (!Array.isArray(data)) throw new SmartleadUnexpectedResponseError("Smartlead GET /campaigns/{id}/sequences did not return a list of steps");
  return data;
}

/** The mailboxes attached to one campaign. The reference example omits their daily limit; join with listEmailAccounts for it. */
export async function getCampaignEmailAccounts(
  apiKey: string,
  campaignId: number,
  opts: { maxRetries?: number } = {},
): Promise<SmartleadEmailAccount[]> {
  assertCampaignId(campaignId);
  const data = await smartleadRequest<unknown>(apiKey, "GET", `/campaigns/${encodeURIComponent(String(campaignId))}/email-accounts`, {
    maxRetries: opts.maxRetries,
  });
  const rows = unwrapList(data, ["data", "email_accounts"]);
  if (!rows) throw new SmartleadUnexpectedResponseError("Smartlead GET /campaigns/{id}/email-accounts returned an unexpected response");
  return (rows as Array<Record<string, unknown> | null>).map(row => {
    const id = asWholeNumber(row?.id);
    return {
      id: id !== undefined ? id : 0,
      email: String(row?.from_email ?? ""),
      dailyLimit: asLimit(row?.max_email_per_day ?? row?.message_per_day),
    };
  });
}

export const SMARTLEAD_LEADS_PER_REQUEST = 400;

export interface SmartleadLeadInput {
  email: string;
  first_name?: string;
  last_name?: string;
  company_name?: string;
  phone_number?: string;
  website?: string;
  location?: string;
  linkedin_profile?: string;
  company_url?: string;
  /** Free-form keys, case-sensitive in the customer's templates. Smartlead allows up to 200. */
  custom_fields?: Record<string, string>;
}

export interface SmartleadAddLeadsResult {
  /** Leads we sent in this request. */
  submitted: number;
  /** Leads newly added to this campaign (Smartlead's `total_leads`). NOT `upload_count`, which counts every row we sent, invalid ones included. */
  added: number;
  /** Leads that were already in this campaign (a resend returns these, not an error). */
  alreadyInCampaign: number;
  /** Everything Smartlead did not newly add: submitted minus added. */
  skipped: number;
  /** Smartlead's own tallies of why; they do not name the leads (only `invalidEmails` and `unsubscribedEmails` do). */
  skippedBy: {
    invalidEmail: number;
    alreadyInCampaign: number;
    blockList: number;
    duplicate: number;
    inOtherCampaign: number;
    unsubscribed: number;
    bounced: number;
    importStopped: number;
  };
  invalidEmails: string[];
  unsubscribedEmails: string[];
  /** True when Smartlead stopped importing because the account's lead limit is used up. */
  limitExhausted: boolean;
  /**
   * Per-lead truth from `return_lead_ids`: lower-cased email to Smartlead lead id, split into leads newly added, leads
   * already in this campaign, and leads that already exist in another campaign (with ignore_duplicate_leads_in_other_campaign on, those are
   * skipped and NOT added here; verified live 2026-10-28).
   * Undefined if Smartlead sent no map.
   */
  leads?: {
    newlyAdded: Record<string, string>;
    existingInCampaign: Record<string, string>;
    existingInOtherCampaigns: Record<string, string>;
  };
}

const count = (value: unknown): number | undefined => {
  const n = asWholeNumber(value);
  return n !== undefined && n >= 0 ? n : undefined;
};

const toIdMap = (value: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  if (value && typeof value === "object") {
    for (const [email, id] of Object.entries(value as Record<string, unknown>)) {
      if (typeof id === "string" || typeof id === "number") out[email.toLowerCase()] = String(id);
    }
  }
  return out;
};

const toStringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

/**
 * Add up to 400 leads to a campaign the customer already made. The block-list, unsubscribe-list and bounce-list overrides are sent as
 * false on purpose: AgentWeb never asks Smartlead to bypass its own protection. Leads already in another campaign are skipped
 * (ignore_duplicate_leads_in_other_campaign: true), so nobody is emailed by two campaigns.
 * `return_lead_ids` is always on: it makes Smartlead say, per lead, whether it was newly added, was already in this
 * campaign, or already existed in another one, and gives the Smartlead lead id (needed to pause or unsubscribe a lead later).
 *
 * The reply shape here is the one a live Smartlead account returned on 2026-10-27, which differs from its docs:
 * `upload_count` is everything submitted, `total_leads` is what was newly added. A reply with no count we recognise
 * is an error, never "0 added" and never success. Retrying a 429 is safe: a rate-limited request added nothing.
 *
 * Do not verify an add by re-reading the campaign's lead listing right afterwards (GET /campaigns/{id}/leads, or Smartlead's MCP list): that
 * listing can lag behind a large add. Seen once, on production on 2026-10-29: after a 450-lead add (one lead was already in the campaign, so 451
 * in all) it showed 1 lead for several minutes, while the account-wide lead total and a status-filtered listing (`status=STARTED`) were right
 * immediately. The cause, the size at which it starts, how long it lasts, and whether the status filter is always reliable are all unconfirmed.
 * Treat THIS response (per-lead outcome and ids from `return_lead_ids`) as the source of truth; any check or test that counts a campaign's leads
 * should wait for the listing to settle, or use the account total or a status filter, and say so if it is wrong.
 */
export async function addLeadsToCampaign(
  apiKey: string,
  campaignId: number,
  leads: SmartleadLeadInput[],
  opts: { maxRetries?: number } = {},
): Promise<SmartleadAddLeadsResult> {
  assertCampaignId(campaignId);
  const empty: SmartleadAddLeadsResult = {
    submitted: 0,
    added: 0,
    alreadyInCampaign: 0,
    skipped: 0,
    skippedBy: { invalidEmail: 0, alreadyInCampaign: 0, blockList: 0, duplicate: 0, inOtherCampaign: 0, unsubscribed: 0, bounced: 0, importStopped: 0 },
    invalidEmails: [],
    unsubscribedEmails: [],
    limitExhausted: false,
  };
  if (leads.length === 0) return empty;
  if (leads.length > SMARTLEAD_LEADS_PER_REQUEST) {
    throw new SmartleadApiError(`Smartlead accepts at most ${SMARTLEAD_LEADS_PER_REQUEST} leads per request (got ${leads.length})`);
  }
  const data = await smartleadRequest<Record<string, unknown>>(apiKey, "POST", `/campaigns/${encodeURIComponent(String(campaignId))}/leads`, {
    data: {
      lead_list: leads,
      settings: {
        ignore_global_block_list: false,
        ignore_unsubscribe_list: false,
        // TRUE skips a lead that is already in another of the account's campaigns (verified live 2026-10-28: skipped_in_other_campaign_count
        // counts it and the map lists it under existingLeadsInOtherCampaigns); FALSE adds it anyway, so it would be emailed by both campaigns.
        ignore_duplicate_leads_in_other_campaign: true,
        ignore_community_bounce_list: false,
        return_lead_ids: true,
      },
    },
    maxRetries: opts.maxRetries,
  });
  const body = data && typeof data === "object" ? data : {};
  // `total_leads` is the live shape; `added_count` is what the reference documents but a live account did not send.
  const added = count(body.total_leads) ?? count(body.added_count);
  if (added === undefined) {
    // A 2xx with no added count: the leads may be in the campaign. Say so, never "0 added" and never a plain failure.
    throw new SmartleadUnexpectedResponseError(`Smartlead POST /campaigns/{id}/leads returned an unexpected response`);
  }
  const submitted = count(body.upload_count) ?? leads.length;
  const invalidEmails = toStringList(body.invalid_emails);
  const unsubscribedEmails = toStringList(body.unsubscribed_leads);
  const map = body.emailToLeadIdMap && typeof body.emailToLeadIdMap === "object" ? (body.emailToLeadIdMap as Record<string, unknown>) : undefined;
  const alreadyInCampaign = count(body.already_added_to_campaign) ?? 0;
  return {
    submitted,
    added,
    alreadyInCampaign,
    skipped: Math.max(submitted - added, 0),
    skippedBy: {
      invalidEmail: count(body.invalid_email_count) ?? invalidEmails.length,
      alreadyInCampaign,
      blockList: count(body.block_count) ?? 0,
      duplicate: count(body.duplicate_count) ?? 0,
      inOtherCampaign: count(body.skipped_in_other_campaign_count) ?? 0,
      unsubscribed: unsubscribedEmails.length,
      bounced: count(body.bounce_count) ?? 0,
      importStopped: count(body.lead_import_stopped_count) ?? 0,
    },
    invalidEmails,
    unsubscribedEmails,
    limitExhausted: body.is_lead_limit_exhausted === true,
    ...(map
      ? {
          leads: {
            newlyAdded: toIdMap(map.newlyAddedLeads),
            existingInCampaign: toIdMap(map.existingLeads),
            existingInOtherCampaigns: toIdMap(map.existingLeadsInOtherCampaigns),
          },
        }
      : {}),
  };
}

// ─── Main Function ──────────────────────────────────────────────────────

export async function getSmartLeadMetrics(): Promise<SmartLeadMetrics> {
  const apiKey = process.env.SMARTLEAD_API_KEY;
  if (!apiKey) {
    return emptyMetrics("unavailable", "SMARTLEAD_API_KEY not configured");
  }

  try {
    // Fetch campaigns and email accounts in parallel
    const [campaigns, emailAccountsCount] = await Promise.all([
      fetchCampaigns(apiKey),
      fetchEmailAccounts(apiKey),
    ]);

    const totalCampaigns = campaigns.length;
    const activeCampaigns = campaigns.filter(
      c => c.status && c.status.toUpperCase() === "ACTIVE",
    );

    // Fetch leads for all active campaigns in parallel
    const leadResults = await Promise.all(
      activeCampaigns.map(c => fetchCampaignLeads(apiKey, c.id)),
    );

    let totalLeadsLoaded = 0;
    let leadsInProgress = 0;
    let leadsCompleted = 0;
    let leadsReplied = 0;

    const campaignSummaries: SmartLeadCampaign[] = [];

    for (let i = 0; i < activeCampaigns.length; i++) {
      const campaign = activeCampaigns[i];
      const result = leadResults[i];

      totalLeadsLoaded += result.total;

      for (const lead of result.leads) {
        const status = (lead.status || "").toUpperCase();
        if (status === "INPROGRESS" || status === "IN_PROGRESS") {
          leadsInProgress++;
        } else if (status === "COMPLETED") {
          leadsCompleted++;
        } else if (status === "REPLIED" || status === "INTERESTED" || status === "MEETING_BOOKED") {
          leadsReplied++;
        }
      }

      campaignSummaries.push({
        name: campaign.name,
        status: campaign.status,
        totalLeads: result.total,
      });
    }

    return {
      totalCampaigns,
      activeCampaigns: activeCampaigns.length,
      totalLeadsLoaded,
      leadsInProgress,
      leadsCompleted,
      leadsReplied,
      emailAccountsCount,
      campaigns: campaignSummaries,
      status: "ok",
    };
  } catch (error: unknown) {
    const message = scrubSmartleadSecrets((error as { message?: string })?.message || "Unknown error", apiKey);
    console.error("[SmartLeadService] Error fetching SmartLead metrics:", message);
    return emptyMetrics("error", message);
  }
}
