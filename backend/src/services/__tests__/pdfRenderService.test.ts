/**
 * Tests for pdfRenderService — the single HTML→PDF rendering path shared by the
 * convert_to_pdf tool and the /export-pdf endpoint.
 *
 * These use a fake puppeteer so they run without Chrome and deterministically
 * assert the print options that cause real client-visible bugs:
 *   - landscape is enabled for wide (16:9) content so the right side is not clipped
 *   - a portrait document stays portrait
 *   - overflowing content is scaled down to fit the printable width
 *   - preferCSSPageSize/printBackground are always on
 */

import { renderHtmlToPdf } from "../pdfRenderService";
import { computePageContentWidthPx } from "../../utils/pdfPrintLayout";

/**
 * Build a fake puppeteer whose page reports a fixed natural content size.
 * Captures the options passed to page.pdf() for assertions.
 */
function makeFakePuppeteer(contentWidth: number, contentHeight: number) {
  const captured: { pdfOpts?: any } = {};
  let closed = false;
  const page = {
    goto: async () => {},
    setContent: async () => {},
    addStyleTag: async () => {},
    emulateMediaType: async () => {},
    // measureContentSize and applyPrintLayoutFixes both call evaluate; the first
    // returns the content size object, the relax pass returns a number.
    evaluate: async (fn: (...a: any[]) => any) => {
      const src = fn.toString();
      if (src.includes("scrollWidth")) {
        return { width: contentWidth, height: contentHeight };
      }
      return 0;
    },
    pdf: async (opts: any) => {
      captured.pdfOpts = opts;
      return Buffer.from("%PDF-fake");
    },
  };
  const browser = {
    newPage: async () => page,
    close: async () => {
      closed = true;
    },
  };
  const puppeteer = {
    launch: async () => browser,
  };
  return { puppeteer, captured, wasClosed: () => closed };
}

const PORTRAIT_W = computePageContentWidthPx("A4", "15mm", "15mm"); // ~680px
const LANDSCAPE_W = computePageContentWidthPx("A4", "15mm", "15mm", "landscape"); // ~1008px

describe("renderHtmlToPdf", () => {
  it("auto-detects landscape for a wide slide deck (tall but wide content)", async () => {
    // A 16:9 deck = wide slides stacked tall. Width (1280) >> portrait width,
    // so even though the document is tall it must render landscape.
    const { puppeteer, captured } = makeFakePuppeteer(1280, 5000);

    const result = await renderHtmlToPdf(
      { html: "<html><body>deck</body></html>" },
      puppeteer
    );

    expect(result.orientation).toBe("landscape");
    expect(captured.pdfOpts.landscape).toBe(true);
    expect(captured.pdfOpts.preferCSSPageSize).toBe(true);
    expect(captured.pdfOpts.printBackground).toBe(true);
  });

  it("auto-detects portrait for a normal-width document", async () => {
    // Content fits the portrait printable width comfortably.
    const { puppeteer, captured } = makeFakePuppeteer(600, 2200);

    const result = await renderHtmlToPdf(
      { html: "<html><body>report</body></html>" },
      puppeteer
    );

    expect(result.orientation).toBe("portrait");
    expect(captured.pdfOpts.landscape).toBe(false);
  });

  it("honors an explicit landscape override even for narrow content", async () => {
    const { puppeteer, captured } = makeFakePuppeteer(600, 2200);

    const result = await renderHtmlToPdf(
      { html: "<x/>", orientation: "landscape" },
      puppeteer
    );

    expect(result.orientation).toBe("landscape");
    expect(captured.pdfOpts.landscape).toBe(true);
  });

  it("honors an explicit portrait override for wide content", async () => {
    const { puppeteer, captured } = makeFakePuppeteer(1280, 720);

    const result = await renderHtmlToPdf(
      { html: "<x/>", orientation: "portrait" },
      puppeteer
    );

    expect(result.orientation).toBe("portrait");
    expect(captured.pdfOpts.landscape).toBe(false);
    // Still protected from clipping via scaling.
    expect(captured.pdfOpts.scale).toBeLessThan(1);
  });

  it("scales landscape content down to fit when it overflows the landscape width", async () => {
    // 2x the landscape printable width => ~0.5 scale, still landscape.
    const { puppeteer, captured } = makeFakePuppeteer(LANDSCAPE_W * 2, 5000);

    const result = await renderHtmlToPdf({ html: "<x/>" }, puppeteer);

    expect(result.orientation).toBe("landscape");
    expect(result.scale).toBeCloseTo(0.5, 2);
    expect(captured.pdfOpts.scale).toBeCloseTo(0.5, 2);
  });

  it("uses scale 1 when content fits the page", async () => {
    const { puppeteer, captured } = makeFakePuppeteer(400, 1200);
    const result = await renderHtmlToPdf({ html: "<x/>" }, puppeteer);
    expect(result.orientation).toBe("portrait");
    expect(result.scale).toBe(1);
    expect(captured.pdfOpts.scale).toBe(1);
  });

  it("closes the browser even when rendering throws", async () => {
    const { puppeteer } = makeFakePuppeteer(800, 600);
    const fake = await puppeteer.launch();
    const closeSpy = jest.spyOn(fake, "close");
    const throwingPuppeteer = {
      launch: async () => {
        const page = await fake.newPage();
        (page as any).pdf = async () => {
          throw new Error("boom");
        };
        return fake;
      },
    };

    await expect(
      renderHtmlToPdf({ html: "<x/>" }, throwingPuppeteer)
    ).rejects.toThrow("boom");
    expect(closeSpy).toHaveBeenCalled();
  });

  it("rejects when neither url nor html is provided", async () => {
    const { puppeteer } = makeFakePuppeteer(800, 600);
    await expect(renderHtmlToPdf({}, puppeteer)).rejects.toThrow(
      /requires either a url or html/
    );
  });

  it("navigates via goto for a url source", async () => {
    const { puppeteer, captured } = makeFakePuppeteer(1280, 720);
    const result = await renderHtmlToPdf(
      { url: "https://example.com/deck.html" },
      puppeteer
    );
    expect(result.orientation).toBe("landscape");
    expect(captured.pdfOpts).toBeDefined();
  });
});
