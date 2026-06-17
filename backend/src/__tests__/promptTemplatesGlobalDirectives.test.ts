/**
 * WS1a: managed global image directives row in promptTemplatesService.
 *
 * Mocks the aws-sdk DocumentClient so we can drive get/put outcomes and
 * assert seed-from-constants, existing-row read, version bump on save, and
 * per-field merge.
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
  getGlobalImageDirectives,
  saveGlobalImageDirectives,
  GLOBAL_IMAGE_DIRECTIVES_ID,
  _clearCacheForTests,
} from "../services/promptTemplatesService";
import {
  DEFAULT_IMAGE_STYLE_SPEC,
  DEFAULT_IMAGE_HARD_CONSTRAINTS,
} from "../services/imagePromptDefaults";

beforeEach(() => {
  jest.clearAllMocks();
  _clearCacheForTests();
  mockGet.mockResolvedValue({});
  mockPut.mockResolvedValue({});
});

describe("getGlobalImageDirectives", () => {
  it("seeds from the DEFAULT_IMAGE_* constants when the row is missing", async () => {
    mockGet.mockResolvedValueOnce({}); // no Item
    const row = await getGlobalImageDirectives();
    expect(row.templateId).toBe(GLOBAL_IMAGE_DIRECTIVES_ID);
    expect(row.version).toBe("v1-seed");
    expect(row.styleSpec).toBe(DEFAULT_IMAGE_STYLE_SPEC);
    expect(row.hardConstraints).toBe(DEFAULT_IMAGE_HARD_CONSTRAINTS);
    // Seed write attempted with a not-exists guard.
    expect(mockPut).toHaveBeenCalledTimes(1);
    expect(mockPut.mock.calls[0][0].ConditionExpression).toMatch(/attribute_not_exists/);
  });

  it("returns the persisted row when present", async () => {
    mockGet.mockResolvedValueOnce({
      Item: {
        templateId: GLOBAL_IMAGE_DIRECTIVES_ID,
        version: "v3-2026-06-14",
        styleSpec: "EDITED STYLE",
        hardConstraints: "- EDITED CONSTRAINT",
        updatedAt: "2026-06-14T00:00:00Z",
        updatedBy: "admin-1",
      },
    });
    const row = await getGlobalImageDirectives();
    expect(row.styleSpec).toBe("EDITED STYLE");
    expect(row.version).toBe("v3-2026-06-14");
    expect(mockPut).not.toHaveBeenCalled(); // no seed needed
  });

  it("degrades to the constants when Dynamo throws (never rejects)", async () => {
    mockGet.mockRejectedValueOnce(new Error("ddb unreachable"));
    mockPut.mockRejectedValueOnce(new Error("ddb unreachable"));
    const row = await getGlobalImageDirectives();
    expect(row.styleSpec).toBe(DEFAULT_IMAGE_STYLE_SPEC);
  });

  it("caches within the TTL — a second read does not hit Dynamo", async () => {
    await getGlobalImageDirectives();
    const callsAfterFirst = mockGet.mock.calls.length;
    await getGlobalImageDirectives();
    expect(mockGet.mock.calls.length).toBe(callsAfterFirst); // no new get
  });
});

describe("saveGlobalImageDirectives", () => {
  it("merges provided fields, bumps version, stamps updatedBy", async () => {
    mockGet.mockResolvedValueOnce({
      Item: {
        templateId: GLOBAL_IMAGE_DIRECTIVES_ID,
        version: "v1-seed",
        styleSpec: "OLD STYLE",
        hardConstraints: "- OLD",
        updatedAt: "2026-06-14T00:00:00Z",
        updatedBy: "system",
      },
    });
    const row = await saveGlobalImageDirectives({
      styleSpec: "NEW STYLE",
      updatedBy: "admin-9",
    });
    expect(row.styleSpec).toBe("NEW STYLE");
    expect(row.hardConstraints).toBe("- OLD"); // untouched field preserved
    expect(row.updatedBy).toBe("admin-9");
    expect(row.version).not.toBe("v1-seed"); // bumped
    expect(mockPut).toHaveBeenCalled();
    const written = mockPut.mock.calls[mockPut.mock.calls.length - 1][0].Item;
    expect(written.templateId).toBe(GLOBAL_IMAGE_DIRECTIVES_ID);
  });
});
