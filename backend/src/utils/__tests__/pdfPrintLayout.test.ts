/**
 * Tests for pdfPrintLayout — pure helpers that make HTML-to-PDF conversion
 * robust against sections/tables overlapping or overwriting each other.
 *
 * Root cause being guarded against: generated report HTML applies
 * `page-break-inside: avoid` to section-block / card containers. When such a
 * container is TALLER than a single printable page, Chrome's print engine
 * cannot satisfy the constraint and overflows the block past the page
 * boundary — the next section then paints on top of it ("sections overwrite
 * each other"). Relaxing the unsatisfiable constraint to `auto` lets Chrome
 * insert clean page breaks instead.
 */

import {
  mmToPx,
  computePageContentHeightPx,
  shouldRelaxBreakInside,
  PRINT_SAFETY_CSS,
} from "../pdfPrintLayout";

describe("mmToPx", () => {
  it("converts millimeters to CSS pixels at 96dpi", () => {
    expect(Math.round(mmToPx(25.4))).toBe(96);
    expect(Math.round(mmToPx(0))).toBe(0);
  });
});

describe("computePageContentHeightPx", () => {
  it("returns A4 printable height minus top/bottom margins", () => {
    // A4 height = 297mm. With 20mm top + 20mm bottom => 257mm content.
    const h = computePageContentHeightPx("A4", "20mm", "20mm");
    expect(Math.round(h)).toBe(Math.round(mmToPx(257)));
  });

  it("falls back to A4 for an unknown format", () => {
    const h = computePageContentHeightPx("Letter-unknown", "0mm", "0mm");
    expect(Math.round(h)).toBe(Math.round(mmToPx(297)));
  });

  it("handles Letter format", () => {
    // Letter height = 279.4mm.
    const h = computePageContentHeightPx("Letter", "0mm", "0mm");
    expect(Math.round(h)).toBe(Math.round(mmToPx(279.4)));
  });

  it("treats missing margins as zero", () => {
    const h = computePageContentHeightPx("A4", undefined, undefined);
    expect(Math.round(h)).toBe(Math.round(mmToPx(297)));
  });
});

describe("shouldRelaxBreakInside", () => {
  const pageHeight = computePageContentHeightPx("A4", "20mm", "20mm"); // ~971px

  it("relaxes an element taller than the printable page", () => {
    expect(shouldRelaxBreakInside(2295, pageHeight)).toBe(true);
  });

  it("keeps an element that fits within a page", () => {
    expect(shouldRelaxBreakInside(336, pageHeight)).toBe(false);
  });

  it("keeps an element exactly at the page height (still satisfiable)", () => {
    expect(shouldRelaxBreakInside(Math.floor(pageHeight), pageHeight)).toBe(
      false
    );
  });

  it("relaxes an element just over the page height", () => {
    expect(shouldRelaxBreakInside(Math.ceil(pageHeight) + 1, pageHeight)).toBe(
      true
    );
  });

  it("ignores zero/invalid heights", () => {
    expect(shouldRelaxBreakInside(0, pageHeight)).toBe(false);
    expect(shouldRelaxBreakInside(-10, pageHeight)).toBe(false);
  });
});

describe("PRINT_SAFETY_CSS", () => {
  it("allows large tables to break across pages instead of overflowing", () => {
    expect(PRINT_SAFETY_CSS).toMatch(/table[\s\S]*break-inside:\s*auto/);
  });

  it("keeps individual table rows intact", () => {
    expect(PRINT_SAFETY_CSS).toMatch(/tr\s*\{[^}]*break-inside:\s*avoid/);
  });

  it("keeps section headers attached to the content that follows them", () => {
    expect(PRINT_SAFETY_CSS).toMatch(/break-after:\s*avoid/);
  });
});
