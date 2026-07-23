/**
 * Onboarding outreach invite prompt store (AC #3).
 *
 * Mocks the aws-sdk DocumentClient to drive get/put outcomes and assert
 * seed-from-constants, existing-row read, degrade-on-throw, cache TTL,
 * malformed-row normalisation, and version bump + per-field merge on save.
 */

const mockGet = jest.fn();
const mockPut = jest.fn();

jest.mock("aws-sdk", () => ({
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      get: (...args: any[]) => ({ promise: () => mockGet(...args) }),
      put: (...args: any[]) => ({ promise: () => mockPut(...args) }),
    })),
  },
}));

import {
  getOutreachInvitePrompt,
  saveOutreachInvitePrompt,
  OUTREACH_INVITE_TEMPLATE_ID,
  _clearCacheForTests,
} from "../services/outreachInvitePromptService";
import {
  DEFAULT_OUTREACH_INVITE_SYSTEM_PROMPT,
  DEFAULT_OUTREACH_INVITE_WITH_COMPANY,
  DEFAULT_OUTREACH_INVITE_WITHOUT_COMPANY,
} from "../services/outreachInvitePromptDefaults";

beforeEach(() => {
  jest.clearAllMocks();
  _clearCacheForTests();
  mockGet.mockResolvedValue({});
  mockPut.mockResolvedValue({});
});

describe("getOutreachInvitePrompt", () => {
  it("seeds from the constants when the row is missing", async () => {
    mockGet.mockResolvedValueOnce({}); // no Item
    const row = await getOutreachInvitePrompt();
    expect(row.templateId).toBe(OUTREACH_INVITE_TEMPLATE_ID);
    expect(row.version).toBe("v1-seed");
    expect(row.systemPrompt).toBe(DEFAULT_OUTREACH_INVITE_SYSTEM_PROMPT);
    expect(row.withCompanyVariants).toEqual(
      DEFAULT_OUTREACH_INVITE_WITH_COMPANY,
    );
    expect(row.withoutCompanyVariants).toEqual(
      DEFAULT_OUTREACH_INVITE_WITHOUT_COMPANY,
    );
    // Seed write attempted with a not-exists guard.
    expect(mockPut).toHaveBeenCalledTimes(1);
    expect(mockPut.mock.calls[0][0].ConditionExpression).toMatch(
      /attribute_not_exists/,
    );
  });

  it("returns the persisted row when present", async () => {
    mockGet.mockResolvedValueOnce({
      Item: {
        templateId: OUTREACH_INVITE_TEMPLATE_ID,
        version: "v3-2026-06-14",
        systemPrompt: "EDITED PROMPT",
        withCompanyVariants: ["Hi {firstName} at {company}"],
        withoutCompanyVariants: ["Hi {firstName}"],
        updatedAt: "2026-06-14T00:00:00Z",
        updatedBy: "admin-1",
      },
    });
    const row = await getOutreachInvitePrompt();
    expect(row.systemPrompt).toBe("EDITED PROMPT");
    expect(row.version).toBe("v3-2026-06-14");
    expect(row.withCompanyVariants).toEqual(["Hi {firstName} at {company}"]);
    expect(mockPut).not.toHaveBeenCalled(); // no seed needed
  });

  it("normalises a malformed persisted row back to seed defaults", async () => {
    mockGet.mockResolvedValueOnce({
      Item: {
        templateId: OUTREACH_INVITE_TEMPLATE_ID,
        version: "v2-2026-06-14",
        systemPrompt: "",
        withCompanyVariants: "not-an-array",
        withoutCompanyVariants: [123, "  ", ""], // no usable strings
        updatedAt: "2026-06-14T00:00:00Z",
        updatedBy: "admin-1",
      },
    });
    const row = await getOutreachInvitePrompt();
    // Falls back to seeds for the broken fields, keeps the good version.
    expect(row.version).toBe("v2-2026-06-14");
    expect(row.systemPrompt).toBe(DEFAULT_OUTREACH_INVITE_SYSTEM_PROMPT);
    expect(row.withCompanyVariants).toEqual(
      DEFAULT_OUTREACH_INVITE_WITH_COMPANY,
    );
    expect(row.withoutCompanyVariants).toEqual(
      DEFAULT_OUTREACH_INVITE_WITHOUT_COMPANY,
    );
  });

  it("degrades to the constants when Dynamo throws (never rejects)", async () => {
    mockGet.mockRejectedValueOnce(new Error("ddb unreachable"));
    mockPut.mockRejectedValueOnce(new Error("ddb unreachable"));
    const row = await getOutreachInvitePrompt();
    expect(row.systemPrompt).toBe(DEFAULT_OUTREACH_INVITE_SYSTEM_PROMPT);
    expect(row.withCompanyVariants.length).toBeGreaterThan(0);
  });

  it("re-reads the winning row when it loses the seed race", async () => {
    // Two instances boot at once: our conditional seed write is rejected, so
    // we must return the row the other instance wrote, not our seed.
    mockGet.mockResolvedValueOnce({}); // no Item -> seed path
    const conflict: any = new Error("exists");
    conflict.code = "ConditionalCheckFailedException";
    mockPut.mockRejectedValueOnce(conflict);
    mockGet.mockResolvedValueOnce({
      Item: {
        templateId: OUTREACH_INVITE_TEMPLATE_ID,
        version: "v9-2026-07-13",
        systemPrompt: "WINNER",
        withCompanyVariants: ["W"],
        withoutCompanyVariants: ["X"],
        updatedAt: "2026-07-13T00:00:00Z",
        updatedBy: "other-instance",
      },
    });

    const row = await getOutreachInvitePrompt();
    expect(row.systemPrompt).toBe("WINNER");
    expect(row.version).toBe("v9-2026-07-13");
  });

  it("keeps the seed when the post-race re-read also fails", async () => {
    mockGet.mockResolvedValueOnce({}); // no Item -> seed path
    mockPut.mockRejectedValueOnce(new Error("write blew up"));
    mockGet.mockRejectedValueOnce(new Error("re-read blew up"));

    const row = await getOutreachInvitePrompt();
    expect(row.systemPrompt).toBe(DEFAULT_OUTREACH_INVITE_SYSTEM_PROMPT);
  });

  it("backfills missing metadata on a partially-written row", async () => {
    mockGet.mockResolvedValueOnce({
      Item: {
        templateId: OUTREACH_INVITE_TEMPLATE_ID,
        // version / updatedAt / updatedBy all absent
        systemPrompt: "KEEP ME",
        withCompanyVariants: ["A"],
        withoutCompanyVariants: ["B"],
      },
    });
    const row = await getOutreachInvitePrompt();
    expect(row.systemPrompt).toBe("KEEP ME");
    expect(row.version).toBe("v1-seed");
    expect(row.updatedBy).toBe("system");
    expect(typeof row.updatedAt).toBe("string");
  });

  it("degrades when Dynamo rejects with a non-Error value", async () => {
    mockGet.mockRejectedValueOnce("string failure"); // not an Error instance
    mockPut.mockRejectedValueOnce({ message: undefined }); // no .message
    mockGet.mockRejectedValueOnce("string failure again");
    const row = await getOutreachInvitePrompt();
    expect(row.systemPrompt).toBe(DEFAULT_OUTREACH_INVITE_SYSTEM_PROMPT);
  });

  it("replaces a blank version string with the seed version", async () => {
    mockGet.mockResolvedValueOnce({
      Item: {
        templateId: OUTREACH_INVITE_TEMPLATE_ID,
        version: "",
        systemPrompt: "KEEP",
        withCompanyVariants: ["A"],
        withoutCompanyVariants: ["B"],
        updatedAt: 12345, // wrong type
        updatedBy: 67890, // wrong type
      },
    });
    const row = await getOutreachInvitePrompt();
    expect(row.version).toBe("v1-seed");
    expect(row.updatedBy).toBe("system");
    expect(typeof row.updatedAt).toBe("string");
  });

  it("caches within the TTL — a second read does not hit Dynamo", async () => {
    await getOutreachInvitePrompt();
    const callsAfterFirst = mockGet.mock.calls.length;
    await getOutreachInvitePrompt();
    expect(mockGet.mock.calls.length).toBe(callsAfterFirst);
  });
});

describe("saveOutreachInvitePrompt", () => {
  it("merges provided fields, bumps version, stamps updatedBy", async () => {
    mockGet.mockResolvedValueOnce({
      Item: {
        templateId: OUTREACH_INVITE_TEMPLATE_ID,
        version: "v1-seed",
        systemPrompt: "OLD PROMPT",
        withCompanyVariants: ["OLD A"],
        withoutCompanyVariants: ["OLD B"],
        updatedAt: "2026-06-14T00:00:00Z",
        updatedBy: "system",
      },
    });
    const row = await saveOutreachInvitePrompt({
      withCompanyVariants: ["Hi {firstName} at {company}!", "  ", ""],
      updatedBy: "admin-9",
    });
    // Provided list cleaned (blank entries dropped) and applied.
    expect(row.withCompanyVariants).toEqual(["Hi {firstName} at {company}!"]);
    // Untouched fields preserved.
    expect(row.systemPrompt).toBe("OLD PROMPT");
    expect(row.withoutCompanyVariants).toEqual(["OLD B"]);
    expect(row.updatedBy).toBe("admin-9");
    expect(row.version).not.toBe("v1-seed"); // bumped
    expect(mockPut).toHaveBeenCalled();
    const written = mockPut.mock.calls[mockPut.mock.calls.length - 1][0].Item;
    expect(written.templateId).toBe(OUTREACH_INVITE_TEMPLATE_ID);
  });

  it("increments the version when saving twice on the same day", async () => {
    const today = new Date().toISOString().slice(0, 10);
    mockGet.mockResolvedValueOnce({
      Item: {
        templateId: OUTREACH_INVITE_TEMPLATE_ID,
        version: `v1-${today}`,
        systemPrompt: "P",
        withCompanyVariants: ["A"],
        withoutCompanyVariants: ["B"],
        updatedAt: "2026-07-13T00:00:00Z",
        updatedBy: "admin-1",
      },
    });
    const row = await saveOutreachInvitePrompt({
      systemPrompt: "P2",
      updatedBy: "admin-9",
    });
    expect(row.version).toBe(`v2-${today}`);
  });

  it("falls back to existing values when a provided list is all-blank", async () => {
    mockGet.mockResolvedValueOnce({
      Item: {
        templateId: OUTREACH_INVITE_TEMPLATE_ID,
        version: "v1-seed",
        systemPrompt: "OLD PROMPT",
        withCompanyVariants: ["KEEP A"],
        withoutCompanyVariants: ["KEEP B"],
        updatedAt: "2026-06-14T00:00:00Z",
        updatedBy: "system",
      },
    });
    const row = await saveOutreachInvitePrompt({
      withCompanyVariants: ["", "   "],
      updatedBy: "admin-9",
    });
    expect(row.withCompanyVariants).toEqual(["KEEP A"]);
  });

  it("applies a provided withoutCompanyVariants list and a blank systemPrompt falls back", async () => {
    mockGet.mockResolvedValueOnce({
      Item: {
        templateId: OUTREACH_INVITE_TEMPLATE_ID,
        version: "v1-seed",
        systemPrompt: "OLD PROMPT",
        withCompanyVariants: ["KEEP A"],
        withoutCompanyVariants: ["OLD B"],
        updatedAt: "2026-07-13T00:00:00Z",
        updatedBy: "system",
      },
    });
    const row = await saveOutreachInvitePrompt({
      systemPrompt: "   ", // blank -> keep existing
      withoutCompanyVariants: ["Hi {firstName}!"],
      updatedBy: "admin-9",
    });
    expect(row.withoutCompanyVariants).toEqual(["Hi {firstName}!"]);
    expect(row.withCompanyVariants).toEqual(["KEEP A"]);
    expect(row.systemPrompt).toBe("OLD PROMPT");
  });
});
