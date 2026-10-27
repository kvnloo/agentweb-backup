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
  added: number;
  skipped: number;
  /** Per-lead reasons, only when Smartlead sends them. */
  skippedLeads: Array<{ email: string; reason: string }>;
  /** False when Smartlead gave no skipped tally and `skipped` is inferred as (sent - added). */
  skippedKnown: boolean;
}

const count = (value: unknown): number | undefined => {
  const n = asWholeNumber(value);
  return n !== undefined && n >= 0 ? n : undefined;
};

/**
 * Add up to 400 leads to a campaign the customer already made. The block-list/duplicate overrides are sent as
 * false on purpose (all four overrides in the reference): AgentWeb never asks Smartlead to bypass its own protection. A reply with no count we recognise is
 * an error, never "0 added" and never "success", because the real reply shape is unverified against a live account.
 * Retrying a 429 is safe here: a rate-limited request added nothing.
 */
export async function addLeadsToCampaign(
  apiKey: string,
  campaignId: number,
  leads: SmartleadLeadInput[],
  opts: { maxRetries?: number } = {},
): Promise<SmartleadAddLeadsResult> {
  assertCampaignId(campaignId);
  if (leads.length === 0) return { added: 0, skipped: 0, skippedLeads: [], skippedKnown: true };
  if (leads.length > SMARTLEAD_LEADS_PER_REQUEST) {
    throw new SmartleadApiError(`Smartlead accepts at most ${SMARTLEAD_LEADS_PER_REQUEST} leads per request (got ${leads.length})`);
  }
  const data = await smartleadRequest<Record<string, unknown>>(apiKey, "POST", `/campaigns/${encodeURIComponent(String(campaignId))}/leads`, {
    data: {
      lead_list: leads,
      settings: {
        ignore_global_block_list: false,
        ignore_unsubscribe_list: false,
        ignore_duplicate_leads_in_other_campaign: false,
        ignore_community_bounce_list: false,
      },
    },
    maxRetries: opts.maxRetries,
  });
  const body = data && typeof data === "object" ? data : {};
  // Reference shape: added_count / skipped_count. Older shape: upload_count plus separate duplicate/invalid/unsubscribed tallies.
  const added = count(body.added_count) ?? count(body.upload_count);
  const skippedList = Array.isArray(body.skipped_leads) ? body.skipped_leads : undefined;
  const legacySkipped = [body.duplicate_count, body.invalid_email_count, body.block_count, body.bounce_count].map(count);
  const reported =
    count(body.skipped_count) ??
    (legacySkipped.some(n => n !== undefined)
      ? legacySkipped.reduce<number>((sum, n) => sum + (n ?? 0), 0) +
        (Array.isArray(body.unsubscribed_leads) ? body.unsubscribed_leads.length : 0)
      : undefined) ??
    skippedList?.length;
  if (added === undefined) {
    // A 2xx with no added count: the leads may be in the campaign. Say so, never "0 added" and never a plain failure.
    throw new SmartleadUnexpectedResponseError(`Smartlead POST /campaigns/{id}/leads returned an unexpected response`);
  }
  // Added is known but skipped is not: the import happened, so report it, with skipped inferred, rather than throw.
  const skippedKnown = reported !== undefined;
  const skipped = skippedKnown ? reported : Math.max(leads.length - added, 0);
  const skippedLeads = (skippedList ?? [])
    .map(row => row as { email?: unknown; reason?: unknown })
    .filter(row => typeof row?.email === "string")
    .map(row => ({ email: String(row.email), reason: String(row.reason ?? "") }));
  return { added, skipped, skippedLeads, skippedKnown };
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
