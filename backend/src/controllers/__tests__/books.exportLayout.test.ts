import { getPdfExportLayoutOptions } from "../books";

describe("getPdfExportLayoutOptions", () => {
  it("forces whitepaper exports to disable TOC and section title pages", () => {
    const book = { type: "whitepaper" } as any;
    const exportConfig = { includeTableOfContents: true, showSectionTitlePage: true };

    const result = getPdfExportLayoutOptions(book, exportConfig);

    expect(result.includeTableOfContents).toBe(false);
    expect(result.showSectionTitlePage).toBe(false);
  });

  it("honors includeTableOfContents for books by defaulting to true", () => {
    const book = { type: "book" } as any;
    const exportConfig = {};

    const result = getPdfExportLayoutOptions(book, exportConfig);

    expect(result.includeTableOfContents).toBe(true);
  });

  it("honors includeTableOfContents and showSectionTitlePage when explicitly disabled", () => {
    const book = { type: "book" } as any;
    const exportConfig = { includeTableOfContents: false, showSectionTitlePage: false };

    const result = getPdfExportLayoutOptions(book, exportConfig);

    expect(result.includeTableOfContents).toBe(false);
    expect(result.showSectionTitlePage).toBe(false);
  });
});
