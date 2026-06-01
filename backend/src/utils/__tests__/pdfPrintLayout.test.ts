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
  applyPrintLayoutFixes,
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

  it("defaults to A4 when format is an empty string", () => {
    const h = computePageContentHeightPx("", "0mm", "0mm");
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

  it("parses margins expressed in cm", () => {
    // 297mm - 1cm - 1cm = 277mm
    const h = computePageContentHeightPx("A4", "1cm", "1cm");
    expect(Math.round(h)).toBe(Math.round(mmToPx(277)));
  });

  it("parses margins expressed in inches", () => {
    // 297mm - 1in(25.4mm) - 0 = 271.6mm
    const h = computePageContentHeightPx("A4", "1in", "0mm");
    expect(Math.round(h)).toBe(Math.round(mmToPx(271.6)));
  });

  it("parses margins expressed in px", () => {
    // 96px == 25.4mm => 297 - 25.4 = 271.6mm
    const h = computePageContentHeightPx("A4", "96px", "0mm");
    expect(Math.round(h)).toBe(Math.round(mmToPx(271.6)));
  });

  it("parses margins expressed in pt", () => {
    // 72pt == 1in == 25.4mm => 297 - 25.4 = 271.6mm
    const h = computePageContentHeightPx("A4", "72pt", "0mm");
    expect(Math.round(h)).toBe(Math.round(mmToPx(271.6)));
  });

  it("ignores unparseable margin strings", () => {
    const h = computePageContentHeightPx("A4", "auto", "");
    expect(Math.round(h)).toBe(Math.round(mmToPx(297)));
  });

  it("ignores non-finite margin values", () => {
    // "." matches the numeric pattern but parseFloat(".") is NaN.
    const h = computePageContentHeightPx("A4", ".mm", "0mm");
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

describe("applyPrintLayoutFixes", () => {
  it("injects print CSS, switches to print media, and returns the relaxed count", async () => {
    const calls: { styleContent?: string; media?: string; maxHeight?: number } =
      {};
    const page = {
      addStyleTag: async (opts: { content: string }) => {
        calls.styleContent = opts.content;
      },
      emulateMediaType: async (type: string) => {
        calls.media = type;
      },
      // Simulate the in-browser pass returning 3 relaxed elements.
      evaluate: async (_fn: (...a: any[]) => any, maxHeight: number) => {
        calls.maxHeight = maxHeight;
        return 3;
      },
    };

    const relaxed = await applyPrintLayoutFixes(page, "A4", "20mm", "20mm");

    expect(relaxed).toBe(3);
    expect(calls.styleContent).toBe(PRINT_SAFETY_CSS);
    expect(calls.media).toBe("print");
    // The page-content height passed to the browser pass must match A4 minus margins.
    expect(Math.round(calls.maxHeight!)).toBe(
      Math.round(computePageContentHeightPx("A4", "20mm", "20mm"))
    );
  });

  it("works when the page has no emulateMediaType (still injects CSS and evaluates)", async () => {
    let styled = false;
    let evaluated = false;
    const page = {
      addStyleTag: async () => {
        styled = true;
      },
      evaluate: async () => {
        evaluated = true;
        return 0;
      },
    };

    const relaxed = await applyPrintLayoutFixes(page, "A4", "20mm", "20mm");

    expect(relaxed).toBe(0);
    expect(styled).toBe(true);
    expect(evaluated).toBe(true);
  });

  describe("in-browser relaxation pass", () => {
    // Exercise the function body passed to page.evaluate by emulating the DOM
    // APIs it relies on, so the relaxation logic itself is covered.
    function runEvaluatePass(
      elements: Array<{
        breakInside?: string;
        pageBreakInside?: string;
        height: number;
      }>,
      maxHeight: number
    ) {
      const setCalls: Array<{ prop: string; value: string }> = [];
      // Build the element objects once so the same references flow through
      // querySelectorAll, getComputedStyle, and getBoundingClientRect.
      const nodes = elements.map((e) => ({
        getBoundingClientRect: () => ({ height: e.height }),
        _computed: {
          breakInside: e.breakInside ?? "auto",
          pageBreakInside: e.pageBreakInside ?? "auto",
        },
        style: {
          setProperty: (prop: string, value: string) => {
            setCalls.push({ prop, value });
          },
        },
      }));
      const fakeDoc = {
        querySelectorAll: () => nodes,
      };
      const fakeWin = {
        getComputedStyle: (el: any) => el._computed,
      };

      let captured: any;
      const page = {
        addStyleTag: async () => {},
        evaluate: async (fn: (...a: any[]) => any, max: number) => {
          (global as any).document = fakeDoc;
          (global as any).window = fakeWin;
          try {
            captured = fn(max);
          } finally {
            delete (global as any).document;
            delete (global as any).window;
          }
          return captured;
        },
      };
      return { page, setCalls };
    }

    it("relaxes only avoid-elements taller than the page", async () => {
      const { page, setCalls } = runEvaluatePass(
        [
          { breakInside: "avoid", height: 2000 }, // tall + avoid -> relax
          { breakInside: "avoid", height: 300 }, // short + avoid -> keep
          { pageBreakInside: "avoid", height: 2000 }, // tall via legacy prop -> relax
          { height: 2000 }, // tall but no avoid -> keep
        ],
        971
      );

      const relaxed = await applyPrintLayoutFixes(
        page,
        "A4",
        "20mm",
        "20mm"
      );

      expect(relaxed).toBe(2);
      // Each relaxed element sets both modern and legacy properties to auto.
      expect(setCalls).toEqual([
        { prop: "break-inside", value: "auto" },
        { prop: "page-break-inside", value: "auto" },
        { prop: "break-inside", value: "auto" },
        { prop: "page-break-inside", value: "auto" },
      ]);
    });

    it("relaxes nothing when no element needs it", async () => {
      const { page, setCalls } = runEvaluatePass(
        [{ breakInside: "avoid", height: 100 }, { height: 5000 }],
        971
      );

      const relaxed = await applyPrintLayoutFixes(page, "A4", "20mm", "20mm");

      expect(relaxed).toBe(0);
      expect(setCalls).toEqual([]);
    });
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
