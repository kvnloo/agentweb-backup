/**
 * ENG-239 AC3 — audit tool tests.
 *
 * The AC: "Existing campaigns are not silently modified; a report/tool lists
 * campaigns lacking UTMs so the team can opt in per client."
 *
 * These tests are written FIRST (CLAUDE.md Rule 2, TDD) and must fail until
 * `adUtmAuditService` exists. They pin the audit contract:
 *   - a campaign is "tagged" only if EVERY ad carries utm_source/medium/campaign,
 *     considering the union of the destination URL's query keys AND the platform
 *     append field (Meta url_tags / Google finalUrlSuffix);
 *   - utm_content is NOT required (LinkedIn ships without it);
 *   - the audit is strictly read-only — it never invokes anything but the port's
 *     two read methods.
 */

import {
  auditCampaigns,
  AdReadPort,
  CampaignAuditReport,
} from "../services/adUtmAuditService";

type Ad = {
  adId: string;
  destinationUrl?: string;
  appendField?: string;
};

/**
 * Build a read-only port from a fixed campaign->ads map. The read methods are
 * jest mocks so tests can assert exactly how they were called. The returned
 * object is wrapped in a Proxy that records every property access, so a test can
 * prove the audit touched nothing but the two read methods (no writes, ever).
 */
function makePort(
  data: Record<string, { name: string; ads: Ad[] }>,
): {
  port: AdReadPort;
  listCampaigns: jest.Mock;
  listAdDestinations: jest.Mock;
  accessed: Set<string>;
} {
  const listCampaigns = jest.fn(async (_userId: string, _accountId: string) =>
    Object.entries(data).map(([id, v]) => ({ id, name: v.name })),
  );
  const listAdDestinations = jest.fn(
    async (_userId: string, _accountId: string, campaignId: string) =>
      (data[campaignId]?.ads ?? []).map((a) => ({ ...a })),
  );

  const raw = { listCampaigns, listAdDestinations };
  const accessed = new Set<string>();
  const port = new Proxy(raw, {
    get(target, prop, receiver) {
      if (typeof prop === "string") accessed.add(prop);
      return Reflect.get(target, prop, receiver);
    },
  }) as unknown as AdReadPort;

  return { port, listCampaigns, listAdDestinations, accessed };
}

const byId = (reports: CampaignAuditReport[]) =>
  Object.fromEntries(reports.map((r) => [r.campaignId, r]));

describe("adUtmAuditService.auditCampaigns", () => {
  // ---- Edge case 1: campaign with zero ads ----
  it("treats a campaign with zero ads as tagged (vacuous — nothing to opt in)", async () => {
    const { port } = makePort({
      c_empty: { name: "Empty Campaign", ads: [] },
    });

    const reports = await auditCampaigns("meta", "u1", "acct1", port);

    expect(reports).toHaveLength(1);
    expect(reports[0]).toEqual({
      campaignId: "c_empty",
      name: "Empty Campaign",
      tagged: true,
      missingKeys: [],
      untaggedAdIds: [],
    });
  });

  // ---- Edge case 2: malformed destination URL must not crash the audit ----
  it("degrades a malformed destination URL to untagged and records the ad, without throwing", async () => {
    const { port } = makePort({
      c_bad: {
        name: "Broken URL Campaign",
        ads: [
          {
            adId: "ad_ok",
            destinationUrl:
              "https://x.com/lp?utm_source=meta&utm_medium=paid&utm_campaign=123",
          },
          { adId: "ad_bad", destinationUrl: "http://[not a url" },
        ],
      },
    });

    const reports = await auditCampaigns("meta", "u1", "acct1", port);

    expect(reports[0].tagged).toBe(false);
    expect(reports[0].untaggedAdIds).toEqual(["ad_bad"]);
    // A malformed URL yields no parseable keys, so all three are reported missing.
    expect(reports[0].missingKeys).toEqual([
      "utm_source",
      "utm_medium",
      "utm_campaign",
    ]);
  });

  // ---- Edge case 3: ad tagged ONLY via the append field (url_tags / finalUrlSuffix) ----
  it("counts an ad as tagged when the append field alone supplies the UTMs", async () => {
    const { port } = makePort({
      c_append: {
        name: "Append-only Campaign",
        ads: [
          {
            adId: "ad_append",
            destinationUrl: "https://x.com/lp",
            appendField:
              "utm_source=google&utm_medium=paid&utm_campaign={campaignid}&utm_content={creative}",
          },
        ],
      },
    });

    const reports = await auditCampaigns("google", "u1", "acct1", port);

    expect(reports[0].tagged).toBe(true);
    expect(reports[0].missingKeys).toEqual([]);
    expect(reports[0].untaggedAdIds).toEqual([]);
  });

  // ---- Edge case 4: union of URL keys AND append field keys ----
  it("unions the destination URL's keys with the append field's keys", async () => {
    const { port } = makePort({
      c_union: {
        name: "Union Campaign",
        ads: [
          {
            adId: "ad_union",
            // URL carries source only; append field supplies medium + campaign.
            destinationUrl: "https://x.com/lp?utm_source=meta",
            appendField: "utm_medium=paid&utm_campaign=42",
          },
        ],
      },
    });

    const reports = await auditCampaigns("meta", "u1", "acct1", port);
    expect(reports[0].tagged).toBe(true);
  });

  // ---- Happy path: every ad fully tagged via the destination URL ----
  it("reports a fully tagged campaign as tagged with no missing keys", async () => {
    const { port } = makePort({
      c_good: {
        name: "Good Campaign",
        ads: [
          {
            adId: "a1",
            destinationUrl:
              "https://x.com/lp?utm_source=meta&utm_medium=paid&utm_campaign=1",
          },
          {
            adId: "a2",
            destinationUrl:
              "https://x.com/lp2?utm_campaign=1&utm_medium=paid&utm_source=meta",
          },
        ],
      },
    });

    const reports = await auditCampaigns("meta", "u1", "acct1", port);

    expect(reports[0]).toEqual({
      campaignId: "c_good",
      name: "Good Campaign",
      tagged: true,
      missingKeys: [],
      untaggedAdIds: [],
    });
  });

  // ---- utm_content is NOT required ----
  it("does not require utm_content (LinkedIn ships without it)", async () => {
    const { port } = makePort({
      c_li: {
        name: "LinkedIn Campaign",
        ads: [
          {
            adId: "li1",
            destinationUrl:
              "https://x.com/lp?utm_source=linkedin&utm_medium=paid&utm_campaign=9",
          },
        ],
      },
    });

    const reports = await auditCampaigns("linkedin", "u1", "acct1", port);
    expect(reports[0].tagged).toBe(true);
  });

  // ---- Missing / undefined destination URL and no append field => untagged ----
  it("treats an ad with a missing destination URL and no append field as untagged", async () => {
    const { port } = makePort({
      c_missing: {
        name: "Missing URL Campaign",
        ads: [{ adId: "no_url" }],
      },
    });

    const reports = await auditCampaigns("meta", "u1", "acct1", port);
    expect(reports[0].tagged).toBe(false);
    expect(reports[0].untaggedAdIds).toEqual(["no_url"]);
    expect(reports[0].missingKeys).toEqual([
      "utm_source",
      "utm_medium",
      "utm_campaign",
    ]);
  });

  // ---- Partial: one tagged ad, one missing only some keys ----
  it("aggregates missing keys and untagged ad ids across a campaign", async () => {
    const { port } = makePort({
      c_partial: {
        name: "Partial Campaign",
        ads: [
          {
            adId: "full",
            destinationUrl:
              "https://x.com/lp?utm_source=meta&utm_medium=paid&utm_campaign=7",
          },
          {
            // has source only -> missing medium + campaign
            adId: "half",
            destinationUrl: "https://x.com/lp?utm_source=meta",
          },
        ],
      },
    });

    const reports = await auditCampaigns("meta", "u1", "acct1", port);
    expect(reports[0].tagged).toBe(false);
    expect(reports[0].untaggedAdIds).toEqual(["half"]);
    expect(reports[0].missingKeys).toEqual(["utm_medium", "utm_campaign"]);
  });

  // ---- Multiple campaigns are each reported ----
  it("reports every campaign returned by the port", async () => {
    const { port, listAdDestinations, listCampaigns } = makePort({
      c1: {
        name: "One",
        ads: [
          {
            adId: "x",
            destinationUrl:
              "https://x.com/lp?utm_source=meta&utm_medium=paid&utm_campaign=1",
          },
        ],
      },
      c2: { name: "Two", ads: [{ adId: "y", destinationUrl: "https://x.com/lp" }] },
    });

    const reports = await auditCampaigns("meta", "u9", "acctZ", port);
    const map = byId(reports);

    expect(reports).toHaveLength(2);
    expect(map.c1.tagged).toBe(true);
    expect(map.c2.tagged).toBe(false);

    // Read methods were called with the audit's userId/accountId.
    expect(listCampaigns).toHaveBeenCalledWith("u9", "acctZ");
    expect(listAdDestinations).toHaveBeenCalledWith("u9", "acctZ", "c1");
    expect(listAdDestinations).toHaveBeenCalledWith("u9", "acctZ", "c2");
  });

  // ---- Read-only guarantee: no property beyond the two reads is ever touched ----
  it("is strictly read-only: touches only listCampaigns and listAdDestinations", async () => {
    const { port, accessed } = makePort({
      c: {
        name: "RO",
        ads: [{ adId: "a", destinationUrl: "https://x.com/lp" }],
      },
    });

    await auditCampaigns("meta", "u1", "acct1", port);

    const unexpected = [...accessed].filter(
      (p) => p !== "listCampaigns" && p !== "listAdDestinations",
    );
    expect(unexpected).toEqual([]);
  });

  // ---- Error path: unsupported platform is rejected ----
  it("throws on an unsupported platform", async () => {
    const { port } = makePort({ c: { name: "x", ads: [] } });
    await expect(
      auditCampaigns("tiktok" as any, "u1", "acct1", port),
    ).rejects.toThrow(/unsupported platform/i);
  });
});
