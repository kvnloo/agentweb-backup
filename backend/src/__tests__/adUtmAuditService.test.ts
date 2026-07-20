/**
 * ENG-239 AC3 — audit tool tests.
 *
 * The AC: "Existing campaigns are not silently modified; a report/tool lists
 * campaigns lacking UTMs so the team can opt in per client."
 *
 * The contract this pins:
 *   - an ad is tagged only if EVERY one of its destination URLs carries
 *     utm_source/medium/campaign, counting the union of the URL's own query keys
 *     and the platform append field (Meta url_tags / Google finalUrlSuffix), which
 *     the platforms merge into every link at delivery;
 *   - utm_content is NOT required (LinkedIn ships without it);
 *   - an ad whose destination we cannot READ is reported `unreadable`, never
 *     `untagged`. That distinction matters: acting on a false "untagged" means
 *     swapping a live Meta creative, which resets the ad's learning phase. A
 *     wrong audit is worse than no audit;
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
  destinationUrls?: string[];
  appendField?: string;
};

/** Fully tagged URL, for brevity in fixtures. */
const TAGGED = "https://x.com/lp?utm_source=meta&utm_medium=paid&utm_campaign=1";

/**
 * Build a read-only port from a fixed campaign->ads map. The returned object is
 * wrapped in a Proxy recording every property access, so a test can prove the audit
 * touched nothing but the two read methods (no writes, ever).
 */
function makePort(data: Record<string, { name: string; ads: Ad[] }>): {
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
  it("treats a campaign with zero ads as tagged (vacuous — nothing to opt in)", async () => {
    const { port } = makePort({ c_empty: { name: "Empty Campaign", ads: [] } });

    const reports = await auditCampaigns("meta", "u1", "acct1", port);

    expect(reports).toHaveLength(1);
    expect(reports[0]).toEqual({
      campaignId: "c_empty",
      name: "Empty Campaign",
      tagged: true,
      missingKeys: [],
      untaggedAdIds: [],
      unreadableAdIds: [],
    });
  });

  it("reports a malformed destination URL as UNREADABLE, not untagged, and never throws", async () => {
    // We cannot know what a URL we can't parse already carries. Calling it
    // "untagged" would send the team to swap a creative that may be perfectly fine.
    const { port } = makePort({
      c_bad: {
        name: "Broken URL Campaign",
        ads: [
          { adId: "ad_ok", destinationUrls: [TAGGED] },
          { adId: "ad_bad", destinationUrls: ["http://[not a url"] },
        ],
      },
    });

    const reports = await auditCampaigns("meta", "u1", "acct1", port);

    expect(reports[0].untaggedAdIds).toEqual([]);
    expect(reports[0].unreadableAdIds).toEqual(["ad_bad"]);
    // Nothing is *definitively* missing — we simply could not read that ad.
    expect(reports[0].missingKeys).toEqual([]);
    // But the campaign still needs a human, so it is not "no action needed".
    expect(reports[0].tagged).toBe(false);
  });

  it("reports an ad with no destination URL at all as unreadable", async () => {
    const { port } = makePort({
      c_missing: { name: "Missing URL Campaign", ads: [{ adId: "no_url" }] },
    });

    const reports = await auditCampaigns("meta", "u1", "acct1", port);
    expect(reports[0].unreadableAdIds).toEqual(["no_url"]);
    expect(reports[0].untaggedAdIds).toEqual([]);
    expect(reports[0].tagged).toBe(false);
  });

  it("counts an ad as tagged when the append field alone supplies the UTMs", async () => {
    const { port } = makePort({
      c_append: {
        name: "Append-only Campaign",
        ads: [
          {
            adId: "ad_append",
            destinationUrls: ["https://x.com/lp"],
            appendField:
              "utm_source=google&utm_medium=paid&utm_campaign={campaignid}&utm_content={creative}",
          },
        ],
      },
    });

    const reports = await auditCampaigns("google", "u1", "acct1", port);
    expect(reports[0].tagged).toBe(true);
    expect(reports[0].missingKeys).toEqual([]);
  });

  it("unions the destination URL's keys with the append field's keys", async () => {
    const { port } = makePort({
      c_union: {
        name: "Union Campaign",
        ads: [
          {
            adId: "ad_union",
            destinationUrls: ["https://x.com/lp?utm_source=meta"],
            appendField: "utm_medium=paid&utm_campaign=42",
          },
        ],
      },
    });

    const reports = await auditCampaigns("meta", "u1", "acct1", port);
    expect(reports[0].tagged).toBe(true);
  });

  it("marks a carousel ad untagged when ANY one of its card URLs lacks a key", async () => {
    // A Meta carousel has one destination URL per card. One untagged card is a hole
    // in the attribution, so the whole ad must be flagged.
    const { port } = makePort({
      c_carousel: {
        name: "Carousel Campaign",
        ads: [
          {
            adId: "ad_carousel",
            destinationUrls: [
              TAGGED,
              "https://x.com/card2?utm_source=meta", // missing medium + campaign
            ],
          },
        ],
      },
    });

    const reports = await auditCampaigns("meta", "u1", "acct1", port);
    expect(reports[0].tagged).toBe(false);
    expect(reports[0].untaggedAdIds).toEqual(["ad_carousel"]);
    expect(reports[0].missingKeys).toEqual(["utm_medium", "utm_campaign"]);
  });

  it("reports a fully tagged campaign as tagged with no missing keys", async () => {
    const { port } = makePort({
      c_good: {
        name: "Good Campaign",
        ads: [
          { adId: "a1", destinationUrls: [TAGGED] },
          {
            adId: "a2",
            destinationUrls: [
              "https://x.com/lp2?utm_campaign=1&utm_medium=paid&utm_source=meta",
            ],
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
      unreadableAdIds: [],
    });
  });

  it("does not require utm_content (LinkedIn ships without it)", async () => {
    const { port } = makePort({
      c_li: {
        name: "LinkedIn Campaign",
        ads: [
          {
            adId: "li1",
            destinationUrls: [
              "https://x.com/lp?utm_source=linkedin&utm_medium=paid&utm_campaign=9",
            ],
          },
        ],
      },
    });

    const reports = await auditCampaigns("linkedin", "u1", "acct1", port);
    expect(reports[0].tagged).toBe(true);
  });

  it("aggregates missing keys and untagged ad ids across a campaign", async () => {
    const { port } = makePort({
      c_partial: {
        name: "Partial Campaign",
        ads: [
          { adId: "full", destinationUrls: [TAGGED] },
          // source only -> missing medium + campaign
          { adId: "half", destinationUrls: ["https://x.com/lp?utm_source=meta"] },
        ],
      },
    });

    const reports = await auditCampaigns("meta", "u1", "acct1", port);
    expect(reports[0].tagged).toBe(false);
    expect(reports[0].untaggedAdIds).toEqual(["half"]);
    expect(reports[0].missingKeys).toEqual(["utm_medium", "utm_campaign"]);
  });

  it("reports every campaign returned by the port", async () => {
    const { port, listAdDestinations, listCampaigns } = makePort({
      c1: { name: "One", ads: [{ adId: "x", destinationUrls: [TAGGED] }] },
      c2: { name: "Two", ads: [{ adId: "y", destinationUrls: ["https://x.com/lp"] }] },
    });

    const reports = await auditCampaigns("meta", "u9", "acctZ", port);
    const map = byId(reports);

    expect(reports).toHaveLength(2);
    expect(map.c1.tagged).toBe(true);
    expect(map.c2.tagged).toBe(false);
    expect(map.c2.untaggedAdIds).toEqual(["y"]);

    expect(listCampaigns).toHaveBeenCalledWith("u9", "acctZ");
    expect(listAdDestinations).toHaveBeenCalledWith("u9", "acctZ", "c1");
    expect(listAdDestinations).toHaveBeenCalledWith("u9", "acctZ", "c2");
  });

  it("is strictly read-only: touches only listCampaigns and listAdDestinations", async () => {
    const { port, accessed } = makePort({
      c: { name: "RO", ads: [{ adId: "a", destinationUrls: ["https://x.com/lp"] }] },
    });

    await auditCampaigns("meta", "u1", "acct1", port);

    const unexpected = [...accessed].filter(
      (p) => p !== "listCampaigns" && p !== "listAdDestinations",
    );
    expect(unexpected).toEqual([]);
  });

  it("throws on an unsupported platform", async () => {
    const { port } = makePort({ c: { name: "x", ads: [] } });
    await expect(
      auditCampaigns("tiktok" as any, "u1", "acct1", port),
    ).rejects.toThrow(/unsupported platform/i);
  });
});
