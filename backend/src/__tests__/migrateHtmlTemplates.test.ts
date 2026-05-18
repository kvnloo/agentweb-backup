const mockScan = jest.fn();
const mockGet  = jest.fn();
const mockPut  = jest.fn();

jest.mock("aws-sdk", () => ({
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      scan: (...a: any[]) => ({ promise: () => mockScan(...a) }),
      get:  (...a: any[]) => ({ promise: () => mockGet(...a) }),
      put:  (...a: any[]) => ({ promise: () => mockPut(...a) }),
    })),
  },
}));

const mockCreateTemplate = jest.fn();
jest.mock("../services/htmlTemplateService", () => ({
  htmlTemplateService: { createTemplate: (...a: any[]) => mockCreateTemplate(...a) },
}));

import { runMigration } from "../scripts/migrate-html-templates";

beforeEach(() => {
  mockScan.mockReset();
  mockGet.mockReset();
  mockPut.mockReset();
  mockCreateTemplate.mockReset();
});

describe("migrate-html-templates", () => {
  it("migrates a private user's templates and a public templates_public row", async () => {
    mockGet.mockResolvedValueOnce({}); // no marker
    mockScan.mockResolvedValueOnce({
      Items: [
        {
          key: "templates_user-1",
          templates: [
            { name: "Welcome", type: ["email"], subject: "Hi", html: "<p>hi</p>" },
            { name: "Promo",   type: ["landing_page"], html: "<div>promo</div>" },
          ],
        },
        {
          key: "templates_public",
          templates: [
            { name: "Newsletter", type: ["email"], html: "<p>news</p>" },
          ],
        },
      ],
    });
    mockCreateTemplate.mockResolvedValue({ templateId: "stub" });
    mockPut.mockResolvedValue({});

    await runMigration();

    expect(mockCreateTemplate).toHaveBeenCalledTimes(3);
    // Private user templates:
    expect(mockCreateTemplate).toHaveBeenCalledWith(expect.objectContaining({ userId: "user-1", name: "Welcome" }));
    expect(mockCreateTemplate).toHaveBeenCalledWith(expect.objectContaining({ userId: "user-1", name: "Promo" }));
    // Public template:
    expect(mockCreateTemplate).toHaveBeenCalledWith(expect.objectContaining({
      userId: "__public__",
      name: "Newsletter",
      isPublic: "true",
    }));
    // Marker written:
    expect(mockPut).toHaveBeenCalledTimes(1);
  });

  it("is idempotent: skips when marker exists", async () => {
    mockGet.mockResolvedValueOnce({ Item: { key: "html_templates_migrated" } });
    await runMigration();
    expect(mockScan).not.toHaveBeenCalled();
    expect(mockCreateTemplate).not.toHaveBeenCalled();
  });

  it("normalizes legacy single-string type to array", async () => {
    mockGet.mockResolvedValueOnce({});
    mockScan.mockResolvedValueOnce({
      Items: [{
        key: "templates_user-2",
        templates: [{ name: "Legacy", type: "email", html: "<p>x</p>" }],
      }],
    });
    mockCreateTemplate.mockResolvedValue({ templateId: "stub" });
    mockPut.mockResolvedValue({});
    await runMigration();
    expect(mockCreateTemplate).toHaveBeenCalledWith(expect.objectContaining({ type: ["email"] }));
  });
});
