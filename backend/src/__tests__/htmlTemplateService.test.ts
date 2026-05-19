/**
 * Unit tests for htmlTemplateService (settings-based AW-Settings storage).
 *
 * All operations are stored as JSON arrays in AW-Settings rows keyed
 * templates_<userId> or templates_public. No AW-HtmlTemplates table.
 */

// ── Mocks (must come before import) ─────────────────────────────────────────
const mockGetSetting = jest.fn();
const mockSetSetting = jest.fn();

jest.mock("../services/settingsService", () => ({
  settingsService: {
    getSetting: mockGetSetting,
    setSetting:  mockSetSetting,
  },
}));

// uuid is mocked to return predictable IDs
const mockUUID = jest.fn();
jest.mock("uuid", () => ({ v4: () => mockUUID() }));

import { htmlTemplateService, HtmlTemplate } from "../services/htmlTemplateService";

// ── Helpers ──────────────────────────────────────────────────────────────────
function makeSetting(templates: any[]) {
  return { settingName: "templates_u1", settingValue: JSON.stringify(templates) };
}

const BASE_TPL: HtmlTemplate = {
  template_id: "tpl-001",
  template_name: "My Template",
  type: ["email"],
  subject: "Hello",
  html_content: "<p>Hi {{name}}</p>",
  variables: ["name"],
  arrayVariables: [],
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

beforeEach(() => {
  jest.clearAllMocks();
  mockSetSetting.mockResolvedValue({});
});

// ── getTemplatesByOwner ───────────────────────────────────────────────────────
describe("getTemplatesByOwner", () => {
  it("returns empty array when no row exists", async () => {
    mockGetSetting.mockResolvedValue(null);
    const result = await htmlTemplateService.getTemplatesByOwner("u1");
    expect(result).toEqual([]);
  });

  it("returns parsed templates from the row", async () => {
    mockGetSetting.mockResolvedValue(makeSetting([BASE_TPL]));
    const result = await htmlTemplateService.getTemplatesByOwner("u1");
    expect(result).toHaveLength(1);
    expect(result[0].template_id).toBe("tpl-001");
  });

  it("returns empty array on malformed JSON", async () => {
    mockGetSetting.mockResolvedValue({
      settingName: "templates_u1",
      settingValue: "not-json!",
    });
    const result = await htmlTemplateService.getTemplatesByOwner("u1");
    expect(result).toEqual([]);
  });

  it("returns empty array when settingValue is an object, not an array", async () => {
    mockGetSetting.mockResolvedValue({
      settingName: "templates_u1",
      settingValue: JSON.stringify({ template_id: "x" }),
    });
    const result = await htmlTemplateService.getTemplatesByOwner("u1");
    expect(result).toEqual([]);
  });
});

// ── normalize: legacy type field ─────────────────────────────────────────────
describe("normalize (legacy type field)", () => {
  it("wraps a string type into an array", async () => {
    const legacy = { ...BASE_TPL, type: "email" as any };
    mockGetSetting.mockResolvedValue(makeSetting([legacy]));
    const [tpl] = await htmlTemplateService.getTemplatesByOwner("u1");
    expect(Array.isArray(tpl.type)).toBe(true);
    expect(tpl.type).toEqual(["email"]);
  });

  it("defaults to ['email'] when type is absent", async () => {
    const legacy = { ...BASE_TPL };
    delete (legacy as any).type;
    mockGetSetting.mockResolvedValue(makeSetting([legacy]));
    const [tpl] = await htmlTemplateService.getTemplatesByOwner("u1");
    expect(tpl.type).toEqual(["email"]);
  });

  it("assigns a uuid when template_id is missing", async () => {
    mockUUID.mockReturnValue("auto-uuid-1");
    const legacy = { ...BASE_TPL };
    delete (legacy as any).template_id;
    mockGetSetting.mockResolvedValue(makeSetting([legacy]));
    const [tpl] = await htmlTemplateService.getTemplatesByOwner("u1");
    expect(tpl.template_id).toBe("auto-uuid-1");
  });
});

// ── getTemplate ───────────────────────────────────────────────────────────────
describe("getTemplate", () => {
  it("returns the matching template", async () => {
    mockGetSetting.mockResolvedValue(makeSetting([BASE_TPL]));
    const tpl = await htmlTemplateService.getTemplate("tpl-001", "u1");
    expect(tpl?.template_id).toBe("tpl-001");
  });

  it("returns null when template is not found", async () => {
    mockGetSetting.mockResolvedValue(makeSetting([BASE_TPL]));
    const tpl = await htmlTemplateService.getTemplate("no-such-id", "u1");
    expect(tpl).toBeNull();
  });
});

// ── createTemplate ────────────────────────────────────────────────────────────
describe("createTemplate", () => {
  it("appends a new template to an empty row and writes back", async () => {
    mockUUID.mockReturnValue("new-id-1");
    mockGetSetting.mockResolvedValue(null);

    const input = {
      template_name: "New",
      type: ["email"] as ("email" | "landing_page")[],
      html_content: "<p>x</p>",
      subject: "Hi",
      variables: [],
      arrayVariables: [],
    };

    const tpl = await htmlTemplateService.createTemplate("u1", input, "user@example.com");

    expect(tpl.template_id).toBe("new-id-1");
    expect(tpl.template_name).toBe("New");
    expect(mockSetSetting).toHaveBeenCalledWith(
      "templates_u1",
      expect.stringContaining("new-id-1"),
      "User templates",
      "user@example.com",
    );
  });

  it("appends to an existing list", async () => {
    mockUUID.mockReturnValue("new-id-2");
    mockGetSetting.mockResolvedValue(makeSetting([BASE_TPL]));

    const input = {
      template_name: "Another",
      type: ["landing_page"] as ("email" | "landing_page")[],
      html_content: "<div></div>",
    };

    await htmlTemplateService.createTemplate("u1", input, "user@example.com");

    const writtenValue = JSON.parse(mockSetSetting.mock.calls[0][1]);
    expect(writtenValue).toHaveLength(2);
    expect(writtenValue[1].template_id).toBe("new-id-2");
  });
});

// ── updateTemplate ────────────────────────────────────────────────────────────
describe("updateTemplate", () => {
  it("updates the matching template fields and returns the updated record", async () => {
    mockGetSetting.mockResolvedValue(makeSetting([BASE_TPL]));

    const updated = await htmlTemplateService.updateTemplate(
      "tpl-001",
      "u1",
      { template_name: "Renamed", subject: "New Subject" },
      "editor@example.com",
    );

    expect(updated?.template_name).toBe("Renamed");
    expect(updated?.subject).toBe("New Subject");
    expect(updated?.html_content).toBe(BASE_TPL.html_content); // unchanged
    expect(mockSetSetting).toHaveBeenCalledTimes(1);
  });

  it("returns null when the template is not found", async () => {
    mockGetSetting.mockResolvedValue(makeSetting([BASE_TPL]));
    const result = await htmlTemplateService.updateTemplate(
      "no-such-id",
      "u1",
      { template_name: "x" },
      "editor@example.com",
    );
    expect(result).toBeNull();
    expect(mockSetSetting).not.toHaveBeenCalled();
  });
});

// ── deleteTemplate ────────────────────────────────────────────────────────────
describe("deleteTemplate", () => {
  it("removes the template and returns true", async () => {
    mockGetSetting.mockResolvedValue(makeSetting([BASE_TPL]));
    const ok = await htmlTemplateService.deleteTemplate("tpl-001", "u1", "admin@example.com");
    expect(ok).toBe(true);
    const written = JSON.parse(mockSetSetting.mock.calls[0][1]);
    expect(written).toHaveLength(0);
  });

  it("returns false when the template is not found (no write)", async () => {
    mockGetSetting.mockResolvedValue(makeSetting([BASE_TPL]));
    const ok = await htmlTemplateService.deleteTemplate("nope", "u1", "admin@example.com");
    expect(ok).toBe(false);
    expect(mockSetSetting).not.toHaveBeenCalled();
  });
});

// ── transferAllTemplates ──────────────────────────────────────────────────────
describe("transferAllTemplates", () => {
  it("moves all templates from source to destination and clears the source", async () => {
    const tplA = { ...BASE_TPL, template_id: "a" };
    const tplB = { ...BASE_TPL, template_id: "b" };
    const destTpl = { ...BASE_TPL, template_id: "dest-1" };

    mockGetSetting
      .mockResolvedValueOnce(makeSetting([tplA, tplB]))   // from row
      .mockResolvedValueOnce(makeSetting([destTpl]));       // to row

    const count = await htmlTemplateService.transferAllTemplates("from-u", "to-u", "admin@x.com");

    expect(count).toBe(2);
    // First write: to row now has all 3 templates
    const toWrite = JSON.parse(mockSetSetting.mock.calls[0][1]);
    expect(toWrite).toHaveLength(3);
    expect(toWrite.map((t: any) => t.template_id)).toContain("dest-1");
    // Second write: from row is emptied
    const fromWrite = JSON.parse(mockSetSetting.mock.calls[1][1]);
    expect(fromWrite).toHaveLength(0);
  });

  it("returns 0 and does not write when source is empty", async () => {
    mockGetSetting.mockResolvedValue(null); // empty source
    const count = await htmlTemplateService.transferAllTemplates("from-u", "to-u", "admin@x.com");
    expect(count).toBe(0);
    expect(mockSetSetting).not.toHaveBeenCalled();
  });
});

// ── deleteAllTemplates ────────────────────────────────────────────────────────
describe("deleteAllTemplates", () => {
  it("empties the user's template row and returns the count", async () => {
    const tpls = [
      { ...BASE_TPL, template_id: "x1" },
      { ...BASE_TPL, template_id: "x2" },
    ];
    mockGetSetting.mockResolvedValue(makeSetting(tpls));

    const count = await htmlTemplateService.deleteAllTemplates("u1", "admin@x.com");

    expect(count).toBe(2);
    const written = JSON.parse(mockSetSetting.mock.calls[0][1]);
    expect(written).toHaveLength(0);
  });

  it("returns 0 and does not write when row is already empty", async () => {
    mockGetSetting.mockResolvedValue(null);
    const count = await htmlTemplateService.deleteAllTemplates("u1", "admin@x.com");
    expect(count).toBe(0);
    expect(mockSetSetting).not.toHaveBeenCalled();
  });
});

// ── getPublicTemplates ────────────────────────────────────────────────────────
describe("getPublicTemplates", () => {
  it("reads from templates_public key", async () => {
    const pubTpl = { ...BASE_TPL, template_id: "pub-1" };
    mockGetSetting.mockResolvedValue({
      settingName: "templates_public",
      settingValue: JSON.stringify([pubTpl]),
    });

    const result = await htmlTemplateService.getPublicTemplates();

    expect(result).toHaveLength(1);
    expect(result[0].template_id).toBe("pub-1");
    expect(mockGetSetting).toHaveBeenCalledWith("templates_public");
  });
});
