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

async function fetchCampaigns(apiKey: string): Promise<SmartLeadCampaignRaw[]> {
  const response = await axios.get<SmartLeadCampaignRaw[]>(`${BASE_URL}/campaigns`, {
    params: { api_key: apiKey },
    timeout: 15000,
  });
  return response.data || [];
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
    const response = await axios.get<SmartLeadLeadsResponse>(
      `${BASE_URL}/campaigns/${campaignId}/leads`,
      {
        params: { api_key: apiKey, offset, limit: LEADS_PAGE_LIMIT },
        timeout: 15000,
      },
    );

    const data = response.data;
    total = parseInt(data.total_leads || "0", 10);

    if (!data.data || data.data.length === 0) break;

    allLeads.push(...data.data);

    // If we got fewer than the limit, we've reached the end
    if (data.data.length < LEADS_PAGE_LIMIT) break;

    offset += LEADS_PAGE_LIMIT;

    // Safety cap: don't fetch more than 10 pages (1000 leads per campaign)
    if (offset >= 1000) break;
  }

  return { total, leads: allLeads };
}

async function fetchEmailAccounts(apiKey: string): Promise<number> {
  const response = await axios.get<any[]>(`${BASE_URL}/email-accounts`, {
    params: { api_key: apiKey },
    timeout: 15000,
  });
  return Array.isArray(response.data) ? response.data.length : 0;
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
  } catch (error: any) {
    console.error("[SmartLeadService] Error fetching SmartLead metrics:", error.message);
    return emptyMetrics("error", error.message);
  }
}
