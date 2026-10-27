#!/usr/bin/env node
// Fake Smartlead for testing the ENG-673 key flow without a real key.
// Answers GET /api/v1/email-accounts based on the api_key sent. It is OUR GUESS at Smartlead's
// replies, so it proves our handling, not Smartlead's real behaviour.
//
//   key            reply
//   good-<n>       200, n mailboxes (good-0 = empty list), paged 100 at a time by ?offset
//   bad            401
//   forbidden      403
//   limited        429 (with Retry-After: 1)
//   boom           500
//   weird          200 with a non-list body ({"message":"Plan expired!"})
//   slow           hangs 40 s
//   flip-<n>       like good-2 for its first n requests, then 401 (revoked mid-use)
//   anything else  401
//
// Slice 2 (campaigns and lead import), same keys plus:
//   GET  /campaigns/                   good-<n>: three campaigns (DRAFTED, ACTIVE, PAUSED); wrap-camps: the same inside {success, campaigns}
//   GET  /campaigns/:id/email-accounts good-<n>: {ok, data:[...]} (no daily limit, as in the reference example)
//   POST /campaigns/:id/leads          lead-*: the real reply shape (upload_count = submitted, total_leads = added, emailToLeadIdMap with return_lead_ids);
//                                      lead-weird: 200 with no counts; lead-401: 401; more than 400 leads: 422. Dedupes by email per campaign.
//   email accounts carry message_per_day and fake passwords, to prove nothing downstream keeps them.
const http = require("http");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 4010);
const PAGE = 100;
const leadsByCampaign = {}; // campaignId -> Map(email -> lead id)
const flipCalls = {};
// flip-<n>: behaves like good-2 for its first n requests since the stub started, then answers 401 (a key revoked mid-use).
function flipAlive(key) {
  const m = /^flip-(\d+)$/.exec(key);
  if (!m) return null;
  flipCalls[key] = (flipCalls[key] || 0) + 1;
  return flipCalls[key] <= Number(m[1]);
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

http
  .createServer((req, res) => {
    const url = new URL(req.url, "http://stub");
    const key = url.searchParams.get("api_key") || "";
    console.log(`${req.method} ${url.pathname} key=${key.slice(0, 12)} offset=${url.searchParams.get("offset")}`);

    const campaignsList = /\/campaigns\/?$/.test(url.pathname) && req.method === "GET";
    const campaignMailboxes = /\/campaigns\/(\d+)\/email-accounts$/.exec(url.pathname);
    const campaignLeads = /\/campaigns\/(\d+)\/leads$/.exec(url.pathname);

    if (campaignLeads && req.method === "POST") {
      if (key === "lead-401" || !key.startsWith("lead-")) return send(res, 401, { message: "Invalid API key" });
      let raw = "";
      req.on("data", chunk => (raw += chunk));
      req.on("end", () => {
        let body = {};
        try { body = JSON.parse(raw || "{}"); } catch (e) { return send(res, 400, { error: "bad json" }); }
        const list = Array.isArray(body.lead_list) ? body.lead_list : [];
        if (list.length > 400) return send(res, 422, { error: "lead_list cannot exceed 400 leads per request", provided_count: list.length, max_allowed: 400 });
        const seen = (leadsByCampaign[campaignLeads[1]] = leadsByCampaign[campaignLeads[1]] || new Map());
        const newly = {}, existing = {}, invalid = [];
        let nextId = 9000 + seen.size;
        for (const lead of list) {
          const email = String((lead && lead.email) || "").toLowerCase();
          if (!email.includes("@")) invalid.push(email);
          else if (seen.has(email)) existing[email] = seen.get(email);
          else { seen.set(email, String(++nextId)); newly[email] = seen.get(email); }
        }
        const added = Object.keys(newly).length;
        console.log(`  leads campaign=${campaignLeads[1]} sent=${list.length} added=${added} settings=${JSON.stringify(body.settings)}`);
        if (key === "lead-weird") return send(res, 200, { message: "ok" });
        // The shape a live Smartlead returned on 2026-10-27: upload_count is everything SUBMITTED, total_leads is what was ADDED.
        const reply = {
          ok: true, upload_count: list.length, total_leads: added, skipped_in_other_campaign_count: 0, block_count: 0, duplicate_count: 0,
          invalid_email_count: invalid.length, invalid_emails: invalid, already_added_to_campaign: Object.keys(existing).length,
          unsubscribed_leads: [], is_lead_limit_exhausted: false, lead_import_stopped_count: 0, bounce_count: 0,
        };
        if (body.settings && body.settings.return_lead_ids) reply.emailToLeadIdMap = { newlyAddedLeads: newly, existingLeads: existing, existingLeadsInOtherCampaigns: {} };
        return send(res, 200, reply);
      });
      return;
    }

    if (campaignsList || campaignMailboxes) {
      if (key !== "wrap-camps" && !/^good-\d+$/.test(key) && !key.startsWith("lead-")) return send(res, 401, { message: "Invalid API key" });
      if (campaignMailboxes) {
        const total = Math.min(Number((/^good-(\d+)$/.exec(key) || [])[1] || 2), 5);
        return send(res, 200, { ok: true, data: Array.from({ length: total }, (_, i) => ({ id: 1000 + i, from_email: `box${i + 1}@stub-outreach.test`, from_name: "Stub", type: "SMTP", warmup_enabled: true, warmup_reputation: "excellent" })) });
      }
      const camps = [
        { id: 501, name: "Mindd Q4 (draft)", status: "DRAFTED", max_leads_per_day: 100 },
        { id: 502, name: "Mindd live", status: "ACTIVE", max_leads_per_day: 200 },
        { id: 503, name: "Mindd paused", status: "PAUSED" },
      ];
      return send(res, 200, key === "wrap-camps" ? { success: true, campaigns: camps } : camps);
    }

    if (!url.pathname.endsWith("/email-accounts") || req.method !== "GET") {
      return send(res, 404, { message: "stub: not implemented" });
    }
    if (key === "bad") return send(res, 401, { message: "Invalid API key" });
    if (key === "forbidden") return send(res, 403, { message: "Forbidden" });
    if (key === "limited") return send(res, 429, { message: "Too many requests" }, { "retry-after": "1" });
    if (key === "boom") return send(res, 500, { message: "Internal error" });
    if (key === "weird") return send(res, 200, { message: "Plan expired!" });
    if (key === "slow") return void setTimeout(() => send(res, 200, []), 40000);

    const alive = flipAlive(key);
    if (alive === false) return send(res, 401, { message: "Invalid API key" });
    const m = alive || key.startsWith("lead-") ? [null, "2"] : /^good-(\d+)$/.exec(key);
    if (!m) return send(res, 401, { message: "Invalid API key" });
    const total = Number(m[1]);
    const offset = Number(url.searchParams.get("offset") || 0);
    const rows = [];
    for (let i = offset; i < Math.min(total, offset + PAGE); i++) {
      rows.push({ id: 1000 + i, from_email: `box${i + 1}@stub-outreach.test`, message_per_day: i % 2 ? 30 : 50, password: "stub-smtp-secret", imap_password: "stub-imap-secret" });
    }
    send(res, 200, rows);
  })
  .listen(PORT, () => console.log(`smartlead stub on :${PORT}`));
