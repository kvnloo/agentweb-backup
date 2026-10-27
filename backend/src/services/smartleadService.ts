import axios from "axios";

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

const BASE_URL = "https://server.smartlead.ai/api/v1";
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
let nextSlotAt = 0;

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
  nextSlotAt = 0;
}

/** Remove api_key values from any string (URLs, error messages, serialized configs). */
export function scrubSmartleadSecrets(text: string, apiKey?: string): string {
  let out = String(text ?? "").replace(/(api_key=)[^&\s"']+/gi, "$1[REDACTED]");
  if (apiKey) out = out.split(apiKey).join("[REDACTED]");
  return out;
}

async function acquireThrottleSlot(): Promise<void> {
  const rpm = clientOptions.requestsPerMinute;
  if (!rpm || rpm <= 0) return;
  const interval = 60000 / rpm;
  const now = nowFn();
  const slot = Math.max(now, nextSlotAt);
  nextSlotAt = slot + interval;
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
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "SmartleadApiError";
  }
}

export async function smartleadRequest<T>(
  apiKey: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  opts: { params?: Record<string, unknown>; data?: unknown } = {},
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    await acquireThrottleSlot();
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
      if (status === 429 && attempt < clientOptions.maxRetries) {
        await sleepFn(retryDelayMs(attempt, error?.response?.headers?.["retry-after"]));
        continue;
      }
      const raw = error?.message || "Smartlead request failed";
      throw new SmartleadApiError(
        scrubSmartleadSecrets(`Smartlead ${method} ${path} failed${status ? ` (${status})` : ""}: ${raw}`, apiKey),
        status,
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

const EMAIL_ACCOUNTS_PAGE_LIMIT = 100;
const EMAIL_ACCOUNTS_MAX_PAGES = 20;

export interface SmartleadEmailAccount {
  id: number;
  email: string;
}

/**
 * The mailboxes attached to a Smartlead key (ENG-673). Also the key check on connect: a rejected
 * key or unusable plan throws a SmartleadApiError carrying the HTTP status. Pages by offset, and
 * stops early if a page adds no new ids, in case the API ignores the offset.
 */
export async function listEmailAccounts(apiKey: string): Promise<SmartleadEmailAccount[]> {
  const byId = new Map<number, SmartleadEmailAccount>();
  for (let page = 0; page < EMAIL_ACCOUNTS_MAX_PAGES; page++) {
    const data = await smartleadRequest<unknown>(apiKey, "GET", "/email-accounts", {
      params: { offset: page * EMAIL_ACCOUNTS_PAGE_LIMIT, limit: EMAIL_ACCOUNTS_PAGE_LIMIT },
    });
    const rows = Array.isArray(data) ? (data as Array<{ id?: number; from_email?: string }>) : [];
    const before = byId.size;
    for (const row of rows) {
      if (typeof row?.id === "number" && !byId.has(row.id)) {
        byId.set(row.id, { id: row.id, email: String(row.from_email ?? "") });
      }
    }
    if (rows.length < EMAIL_ACCOUNTS_PAGE_LIMIT || byId.size === before) break;
  }
  return [...byId.values()];
}

async function fetchEmailAccounts(apiKey: string): Promise<number> {
  return (await listEmailAccounts(apiKey)).length;
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
