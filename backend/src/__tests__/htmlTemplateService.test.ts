/**
 * Tests for htmlTemplateService.
 * Covers: createTemplate, getTemplate, getTemplatesByOwner,
 *         getPublicTemplates, updateTemplate, deleteTemplate.
 */

// ---- mock aws-sdk before any imports ----
const mockPutPromise = jest.fn();
const mockGetPromise = jest.fn();
const mockQueryPromise = jest.fn();
const mockDeletePromise = jest.fn();

const mockPut = jest.fn(() => ({ promise: mockPutPromise }));
const mockGet = jest.fn(() => ({ promise: mockGetPromise }));
const mockQuery = jest.fn(() => ({ promise: mockQueryPromise }));
const mockDelete = jest.fn(() => ({ promise: mockDeletePromise }));

jest.mock("aws-sdk", () => ({
  config: { update: jest.fn() },
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      put: mockPut,
      get: mockGet,
      query: mockQuery,
      delete: mockDelete,
    })),
  },
}));

import { htmlTemplateService, HtmlTemplate } from "../services/htmlTemplateService";

// helper to extract the first call argument (avoids TS tuple-length errors)
function firstCallArg(mockFn: jest.Mock): any {
  return (mockFn.mock.calls as any[])[0][0];
}

// ---- helpers ----
const BASE_TPL: HtmlTemplate = {
  templateId: "tpl-1",
  userId: "user-1",
  type: ["email"],
  name: "Welcome Email",
  html: "<h1>Hello</h1>",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("htmlTemplateService.createTemplate", () => {
  beforeEach(() => jest.clearAllMocks());

  it("writes to DynamoDB via put and returns a template with generated templateId", async () => {
    mockPutPromise.mockResolvedValue({});

    const input = {
      userId: "user-1",
      type: ["email"] as ("email" | "landing_page")[],
      name: "My Template",
      html: "<p>body</p>",
    };

    const result = await htmlTemplateService.createTemplate(input);

    // put was called once
    expect(mockPut).toHaveBeenCalledTimes(1);
    const putArg = firstCallArg(mockPut);
    expect(putArg.TableName).toMatch(/AW-HtmlTemplates/);
    expect(putArg.Item.userId).toBe("user-1");

    // templateId is auto-generated (uuid format)
    expect(result.templateId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );

    // createdAt and updatedAt are set
    expect(result.createdAt).toBeDefined();
    expect(result.updatedAt).toBeDefined();
  });
});

describe("htmlTemplateService.getTemplate", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns the template when the item exists in DynamoDB", async () => {
    mockGetPromise.mockResolvedValue({ Item: BASE_TPL });

    const result = await htmlTemplateService.getTemplate("tpl-1");

    expect(mockGet).toHaveBeenCalledTimes(1);
    const getArg = firstCallArg(mockGet);
    expect(getArg.Key).toEqual({ templateId: "tpl-1" });
    expect(result).toEqual(BASE_TPL);
  });

  it("returns null when the item is not found", async () => {
    mockGetPromise.mockResolvedValue({ Item: undefined });

    const result = await htmlTemplateService.getTemplate("nonexistent");

    expect(result).toBeNull();
  });
});

describe("htmlTemplateService.getTemplatesByOwner", () => {
  beforeEach(() => jest.clearAllMocks());

  it("queries UserIdIndex with the correct userId key", async () => {
    mockQueryPromise.mockResolvedValue({ Items: [BASE_TPL] });

    const results = await htmlTemplateService.getTemplatesByOwner("user-1");

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const queryArg = firstCallArg(mockQuery);
    expect(queryArg.IndexName).toBe("UserIdIndex");
    expect(queryArg.ExpressionAttributeValues[":u"]).toBe("user-1");
    expect(results).toHaveLength(1);
    expect(results[0].templateId).toBe("tpl-1");
  });

  it("returns an empty array when no templates are found", async () => {
    mockQueryPromise.mockResolvedValue({ Items: [] });

    const results = await htmlTemplateService.getTemplatesByOwner("user-999");

    expect(results).toEqual([]);
  });
});

describe("htmlTemplateService.getPublicTemplates", () => {
  beforeEach(() => jest.clearAllMocks());

  it('queries IsPublicIndex with isPublic = "true"', async () => {
    const publicTpl = { ...BASE_TPL, isPublic: "true" as const };
    mockQueryPromise.mockResolvedValue({ Items: [publicTpl] });

    const results = await htmlTemplateService.getPublicTemplates();

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const queryArg = firstCallArg(mockQuery);
    expect(queryArg.IndexName).toBe("IsPublicIndex");
    expect(queryArg.ExpressionAttributeValues[":v"]).toBe("true");
    expect(results).toHaveLength(1);
    expect(results[0].isPublic).toBe("true");
  });
});

describe("htmlTemplateService.updateTemplate", () => {
  beforeEach(() => jest.clearAllMocks());

  it("reads the existing item, merges fields, and writes back via put", async () => {
    mockGetPromise.mockResolvedValue({ Item: BASE_TPL });
    mockPutPromise.mockResolvedValue({});

    const result = await htmlTemplateService.updateTemplate("tpl-1", { name: "Renamed" });

    // get called to fetch existing
    expect(mockGet).toHaveBeenCalledTimes(1);
    // put called to persist merged result
    expect(mockPut).toHaveBeenCalledTimes(1);
    const putItem = firstCallArg(mockPut).Item;
    expect(putItem.name).toBe("Renamed");
    expect(putItem.userId).toBe("user-1"); // original field preserved
    expect(result).not.toBeNull();
    expect(result!.name).toBe("Renamed");
    // updatedAt should be refreshed
    expect(result!.updatedAt).toBeDefined();
  });

  it("returns null when the template does not exist", async () => {
    mockGetPromise.mockResolvedValue({ Item: undefined });

    const result = await htmlTemplateService.updateTemplate("ghost", { name: "X" });

    expect(result).toBeNull();
    expect(mockPut).not.toHaveBeenCalled();
  });
});

describe("htmlTemplateService.deleteTemplate", () => {
  beforeEach(() => jest.clearAllMocks());

  it("calls DynamoDB delete with the correct templateId key", async () => {
    mockDeletePromise.mockResolvedValue({});

    await htmlTemplateService.deleteTemplate("tpl-1");

    expect(mockDelete).toHaveBeenCalledTimes(1);
    const deleteArg = firstCallArg(mockDelete);
    expect(deleteArg.Key).toEqual({ templateId: "tpl-1" });
    expect(deleteArg.TableName).toMatch(/AW-HtmlTemplates/);
  });
});
