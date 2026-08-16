/**
 * Unit tests for outreachProspectPreviewService — pure helpers + the
 * service entry point. The pure helpers (buildProspectQuery,
 * mapUnipileItemToPreview) are exercised directly. The service entry
 * (`searchProspectsPreview`) is exercised with mocks for
 * `linkedInOutreachService` and `connectedAccountsDb`.
 */

jest.mock("../services/linkedInOutreachService", () => ({
  linkedInOutreachService: {
    resolveAccountId: jest.fn(),
    searchPeople: jest.fn(),
  },
}));

jest.mock("../services/connectedAccountsDb", () => ({
  getAccountsByUserId: jest.fn(),
}));

import {
  buildProspectQuery,
  mapUnipileItemToPreview,
  searchProspectsPreview,
  MAX_KEYWORDS_LENGTH,
} from "../services/outreachProspectPreviewService";

const { linkedInOutreachService } = require("../services/linkedInOutreachService");
const { getAccountsByUserId } = require("../services/connectedAccountsDb");

describe("buildProspectQuery", () => {
  it("returns an empty params object when icp + specifications are blank", () => {
    expect(buildProspectQuery({ icp: "", specifications: "" })).toEqual({});
    expect(buildProspectQuery({ icp: null, specifications: null })).toEqual({});
    expect(
      buildProspectQuery({ icp: "   ", specifications: "   " }),
    ).toEqual({});
  });

  it("composes keywords as '<icp> <specifications>' when both are present", () => {
    const params = buildProspectQuery({
      icp: "Educators",
      specifications: "K-5 Bay Area program directors",
    });
    expect(params.keywords).toBe("Educators K-5 Bay Area program directors");
  });

  it("keeps only icp when specifications is empty", () => {
    expect(
      buildProspectQuery({ icp: "B2B SaaS founders", specifications: "" })
        .keywords,
    ).toBe("B2B SaaS founders");
  });

  it("promotes 'directors' role keyword from specifications into title", () => {
    const params = buildProspectQuery({
      icp: "Educators",
      specifications: "K-5 Bay Area program directors",
    });
    expect(params.title).toBe("directors");
  });

  it("longest-match wins when multiple role keywords appear ('head of marketing' beats 'marketing')", () => {
    const params = buildProspectQuery({
      icp: "B2B SaaS",
      specifications:
        "I want the head of marketing at companies under 50 people",
    });
    expect(params.title).toBe("head of marketing");
  });

  it("uses explicit title when provided and skips role inference", () => {
    const params = buildProspectQuery({
      icp: "B2B SaaS",
      specifications: "directors and managers please",
      title: "VP of Sales",
    });
    expect(params.title).toBe("VP of Sales");
  });

  it("does not promote a title when no role keyword is present", () => {
    const params = buildProspectQuery({
      icp: "Designers",
      specifications: "people who care about brand",
    });
    expect(params.title).toBeUndefined();
  });

  it("truncates keywords to MAX_KEYWORDS_LENGTH and trims trailing whitespace", () => {
    const long = "x".repeat(300);
    const params = buildProspectQuery({
      icp: "Founders",
      specifications: long,
    });
    expect(params.keywords?.length).toBeLessThanOrEqual(MAX_KEYWORDS_LENGTH);
    expect(params.keywords?.endsWith(" ")).toBe(false);
  });

  it("includes company filter only when explicitly supplied", () => {
    expect(
      buildProspectQuery({ icp: "Founders", specifications: "" }).company,
    ).toBeUndefined();
    expect(
      buildProspectQuery({
        icp: "Founders",
        specifications: "",
        company: "Acme",
      }).company,
    ).toBe("Acme");
  });
});

describe("mapUnipileItemToPreview", () => {
  it("maps a typical Unipile search-result item with public_identifier", () => {
    const item = {
      name: "Jane Doe",
      public_identifier: "janedoe",
      headline: "Director of Growth at Acme",
      location: "San Francisco Bay Area",
    };
    const out = mapUnipileItemToPreview(item);
    expect(out.name).toBe("Jane Doe");
    expect(out.linkedin_url).toBe("https://www.linkedin.com/in/janedoe");
    expect(out.public_identifier).toBe("janedoe");
    expect(out.headline).toBe("Director of Growth at Acme");
    expect(out.location).toBe("San Francisco Bay Area");
    expect(out.id).toBe("janedoe");
  });

  it("falls back to stripped profile_url when no public_identifier", () => {
    const item = {
      name: "John Smith",
      profile_url:
        "https://www.linkedin.com/in/john-smith?miniProfileUrn=urn%3Ali%3Afsd_profile",
    };
    const out = mapUnipileItemToPreview(item);
    expect(out.linkedin_url).toBe("https://www.linkedin.com/in/john-smith");
  });

  it("composes name from first_name/last_name when only those are present", () => {
    const out = mapUnipileItemToPreview({
      first_name: "Ada",
      last_name: "Lovelace",
      public_identifier: "ada",
    });
    expect(out.name).toBe("Ada Lovelace");
  });

  it("uses 'Unknown' when no name is resolvable", () => {
    const out = mapUnipileItemToPreview({ public_identifier: "x" });
    expect(out.name).toBe("Unknown");
  });

  it("extracts company + headline from work_experience.current when missing top-level", () => {
    const out = mapUnipileItemToPreview({
      name: "Sam Lee",
      public_identifier: "sam-lee",
      work_experience: [
        { company: "Acme Inc.", position: "VP of Growth", current: true },
      ],
    });
    expect(out.company).toBe("Acme Inc.");
    expect(out.headline).toBe("VP of Growth");
  });

  it("guards against null/undefined item without crashing", () => {
    const out = mapUnipileItemToPreview(null);
    expect(out.name).toBe("Unknown");
    expect(out.linkedin_url).toBe("");
    expect(out.id.length).toBeGreaterThan(0); // synthesized fallback id
  });
});

describe("searchProspectsPreview", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns no_filters error when icp + specifications + title + company are all blank", async () => {
    const r = await searchProspectsPreview("user-1", {
      icp: "",
      specifications: "",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("no_filters");
    expect(linkedInOutreachService.resolveAccountId).not.toHaveBeenCalled();
  });

  it("returns no_linkedin_account when resolveAccountId returns null", async () => {
    linkedInOutreachService.resolveAccountId.mockResolvedValue(null);
    const r = await searchProspectsPreview("user-1", {
      icp: "Founders",
      specifications: "B2B SaaS",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("no_linkedin_account");
  });

  it("returns unipile_error when searchPeople returns an error envelope", async () => {
    linkedInOutreachService.resolveAccountId.mockResolvedValue("acct-1");
    getAccountsByUserId.mockResolvedValue([]);
    linkedInOutreachService.searchPeople.mockResolvedValue({
      error: "Unipile rate limited",
    });
    const r = await searchProspectsPreview("user-1", {
      icp: "Founders",
      specifications: "B2B SaaS",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe("unipile_error");
      expect(r.message).toContain("rate limited");
    }
  });

  it("returns mapped items + linkedinConnected=true when user has unipile account", async () => {
    linkedInOutreachService.resolveAccountId.mockResolvedValue("acct-1");
    getAccountsByUserId.mockResolvedValue([
      { platform: "unipile", account_id: "acct-1" },
    ]);
    linkedInOutreachService.searchPeople.mockResolvedValue({
      items: [
        {
          name: "Jane Doe",
          public_identifier: "janedoe",
          headline: "Director of Growth",
          location: "Bay Area",
        },
        {
          name: "John Smith",
          public_identifier: "johnsmith",
          headline: "Head of Marketing",
        },
      ],
      cursor: "cursor-xyz",
    });
    const r = await searchProspectsPreview("user-1", {
      icp: "Educators",
      specifications: "K-5 Bay Area program directors",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.items).toHaveLength(2);
      expect(r.items[0].linkedin_url).toBe(
        "https://www.linkedin.com/in/janedoe",
      );
      expect(r.linkedinConnected).toBe(true);
      expect(r.cursor).toBe("cursor-xyz");
    }
  });

  it("sets linkedinConnected=false when user has no unipile account (platform fallback)", async () => {
    linkedInOutreachService.resolveAccountId.mockResolvedValue(
      "platform-acct",
    );
    getAccountsByUserId.mockResolvedValue([]); // no user-owned LI
    linkedInOutreachService.searchPeople.mockResolvedValue({ items: [] });
    const r = await searchProspectsPreview("user-1", {
      icp: "Founders",
      specifications: "B2B SaaS",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.linkedinConnected).toBe(false);
      expect(r.items).toEqual([]);
    }
  });

  it("caps results to 10 even when Unipile returns more", async () => {
    linkedInOutreachService.resolveAccountId.mockResolvedValue("acct-1");
    getAccountsByUserId.mockResolvedValue([]);
    const items = Array.from({ length: 25 }, (_, i) => ({
      name: `Person ${i}`,
      public_identifier: `p${i}`,
    }));
    linkedInOutreachService.searchPeople.mockResolvedValue({ items });
    const r = await searchProspectsPreview("user-1", {
      icp: "Founders",
      specifications: "B2B SaaS",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.items).toHaveLength(10);
  });

  // ENG-1002: these cards are posted straight back to
  // POST /api/onboarding/outreach/save, which persists them via
  // batchCreateLeads — an unfiltered placeholder becomes a nameless,
  // un-dedupable CRM lead.
  it("drops LinkedIn's anonymized out-of-network hits from the prospect cards", async () => {
    linkedInOutreachService.resolveAccountId.mockResolvedValue("acct-1");
    getAccountsByUserId.mockResolvedValue([]);
    linkedInOutreachService.searchPeople.mockResolvedValue({
      items: [
        { name: "LinkedIn Member", headline: "Regional Property Manager" },
        { name: "Amy Foley", public_identifier: "amy-foley" },
        { name: "Miembro de LinkedIn", headline: "Gerente" },
      ],
    });
    const r = await searchProspectsPreview("user-1", {
      icp: "Founders",
      specifications: "B2B SaaS",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.items).toHaveLength(1);
      expect(r.items[0].name).toBe("Amy Foley");
    }
  });

  // Filtering has to happen BEFORE the slice, or placeholders silently eat
  // card slots and the user gets fewer real prospects than they asked for.
  it("still returns a full page of real prospects when the page is padded with placeholders", async () => {
    linkedInOutreachService.resolveAccountId.mockResolvedValue("acct-1");
    getAccountsByUserId.mockResolvedValue([]);
    const items = [
      ...Array.from({ length: 6 }, () => ({ name: "LinkedIn Member" })),
      ...Array.from({ length: 5 }, (_, i) => ({
        name: `Person ${i}`,
        public_identifier: `p${i}`,
      })),
    ];
    linkedInOutreachService.searchPeople.mockResolvedValue({ items });
    const r = await searchProspectsPreview("user-1", {
      icp: "Founders",
      specifications: "B2B SaaS",
      limit: 5,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.items).toHaveLength(5);
      expect(r.items.every((p) => p.name !== "LinkedIn Member")).toBe(true);
    }
  });

  it("respects the limit param when smaller than 10", async () => {
    linkedInOutreachService.resolveAccountId.mockResolvedValue("acct-1");
    getAccountsByUserId.mockResolvedValue([]);
    linkedInOutreachService.searchPeople.mockResolvedValue({
      items: Array.from({ length: 8 }, (_, i) => ({
        name: `P${i}`,
        public_identifier: `p${i}`,
      })),
    });
    const r = await searchProspectsPreview("user-1", {
      icp: "Founders",
      specifications: "B2B SaaS",
      limit: 5,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.items).toHaveLength(5);
  });

  it("returns ok with empty items when Unipile returns no results", async () => {
    linkedInOutreachService.resolveAccountId.mockResolvedValue("acct-1");
    getAccountsByUserId.mockResolvedValue([]);
    linkedInOutreachService.searchPeople.mockResolvedValue({ items: [] });
    const r = await searchProspectsPreview("user-1", {
      icp: "Niche",
      specifications: "very specific",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.items).toEqual([]);
  });
});
