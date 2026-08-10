/**
 * Unit tests for the outreach onboarding CRM-save service.
 *
 * The service reuses the SAME crmDb lead-import path that Emma's
 * `import_leads_from_search` tool uses: `crmDb.createLeadList` to make the
 * list, then `crmDb.batchCreateLeads` to add the prospects (so dedup, lead
 * counting, and field-name merging behave identically). These tests mock
 * crmDb and lock down the validation + mapping rules.
 */

jest.mock("../services/db", () => ({
  crmDb: {
    createLeadList: jest.fn(),
    batchCreateLeads: jest.fn(),
  },
}));

import {
  saveOutreachProspects,
  mapProspectToLead,
} from "../services/outreachOnboardingSaveService";
const { crmDb } = require("../services/db");

const prospect = (over: Record<string, any> = {}) => ({
  id: "janedoe",
  name: "Jane Doe",
  linkedin_url: "https://www.linkedin.com/in/janedoe",
  headline: "Director of Growth",
  company: "Acme",
  ...over,
});

describe("mapProspectToLead", () => {
  it("splits name into first/last, carries linkedin + company, and attaches the draft as a note", () => {
    const lead = mapProspectToLead(
      prospect(),
      "Hi Jane, loved your work at Acme.",
      "icp-1",
    );
    expect(lead.firstName).toBe("Jane");
    expect(lead.lastName).toBe("Doe");
    expect(lead.linkedin).toBe("https://www.linkedin.com/in/janedoe");
    expect(lead.company).toBe("Acme");
    expect(lead.title).toBe("Director of Growth");
    expect(lead.notes).toBe("Hi Jane, loved your work at Acme.");
    // ICP attribution lives in the sidecar `system` map, not customFields.
    expect(lead.system?.icpSource).toBe("icp-1");
  });

  it("renders a renderable lead even when only a name is present", () => {
    const lead = mapProspectToLead(
      { id: "x", name: "Cher", linkedin_url: "" },
      undefined,
      "icp-1",
    );
    expect(lead.firstName).toBe("Cher");
    expect(lead.lastName).toBe("");
    expect(lead.notes).toBeUndefined();
  });
});

describe("saveOutreachProspects", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    crmDb.createLeadList.mockResolvedValue({ listId: "list_123" });
    crmDb.batchCreateLeads.mockResolvedValue({
      successCount: 1,
      newCount: 1,
      mergedCount: 0,
      errorCount: 0,
      errors: [],
      created: [{ leadId: "lead_1" }],
    });
  });

  it("rejects empty prospects with no_prospects (no CRM writes)", async () => {
    const res = await saveOutreachProspects("user-1", {
      icpId: "icp-1",
      prospects: [],
      drafts: {},
    });
    expect(res).toEqual({ ok: false, error: "no_prospects" });
    expect(crmDb.createLeadList).not.toHaveBeenCalled();
    expect(crmDb.batchCreateLeads).not.toHaveBeenCalled();
  });

  it("creates a lead list named after the ICP and returns its id on success", async () => {
    const res = await saveOutreachProspects("user-1", {
      icpId: "icp-1",
      icpLabel: "K-5 program directors",
      prospects: [prospect()],
      drafts: { janedoe: "Hi Jane" },
    });
    expect(res).toEqual({ ok: true, leadListId: "list_123" });
    expect(crmDb.createLeadList).toHaveBeenCalledWith(
      "user-1",
      expect.stringContaining("K-5 program directors"),
      expect.any(String),
    );
    // Reuses the SAME batchCreateLeads path Emma's import tool uses.
    expect(crmDb.batchCreateLeads).toHaveBeenCalledTimes(1);
    const [listIdArg, leadsArg] = crmDb.batchCreateLeads.mock.calls[0];
    expect(listIdArg).toBe("list_123");
    expect(leadsArg).toHaveLength(1);
    expect(leadsArg[0].notes).toBe("Hi Jane");
  });

  // ENG-1002: the preview already filters these out, but this write is driven
  // by whatever the client posts back — a stale bundle must not be able to
  // create nameless, un-dedupable placeholder leads.
  it("never persists LinkedIn's anonymized placeholder prospects", async () => {
    const res = await saveOutreachProspects("user-1", {
      icpId: "icp-1",
      icpLabel: "K-5 program directors",
      prospects: [
        prospect({ id: "anon1", name: "LinkedIn Member", linkedin_url: "" }),
        prospect(),
        prospect({ id: "anon2", name: "Miembro de LinkedIn", linkedin_url: "" }),
      ],
    });
    expect(res).toEqual({ ok: true, leadListId: "list_123" });
    const [, leadsArg] = crmDb.batchCreateLeads.mock.calls[0];
    expect(leadsArg).toHaveLength(1);
    expect(leadsArg[0].firstName).toBe("Jane");
  });

  it("falls back to icpId for the list name when no label is given", async () => {
    await saveOutreachProspects("user-1", {
      icpId: "icp-77",
      prospects: [prospect()],
      drafts: {},
    });
    expect(crmDb.createLeadList).toHaveBeenCalledWith(
      "user-1",
      expect.stringContaining("icp-77"),
      expect.any(String),
    );
  });

  it("surfaces a crm_error envelope when createLeadList throws", async () => {
    crmDb.createLeadList.mockRejectedValue(new Error("DynamoDB unavailable"));
    const res = await saveOutreachProspects("user-1", {
      icpId: "icp-1",
      prospects: [prospect()],
      drafts: {},
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe("crm_error");
      expect(res.message).toContain("DynamoDB");
    }
  });

  it("surfaces a crm_error envelope when batchCreateLeads throws", async () => {
    crmDb.batchCreateLeads.mockRejectedValue(new Error("batch boom"));
    const res = await saveOutreachProspects("user-1", {
      icpId: "icp-1",
      prospects: [prospect()],
      drafts: {},
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe("crm_error");
    }
  });
});
