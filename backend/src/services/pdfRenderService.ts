/**
 * pdfRenderService — the single HTML→PDF rendering path.
 *
 * Both the agent tool (`convert_to_pdf` → AgentModeService.convertToPdf) and the
 * HTTP endpoint (`POST /api/files/export-pdf` → filesController.exportHtmlToPdf)
 * funnel through `renderHtmlToPdf` so every quality fix applies in one place.
 *
 * Quality guarantees implemented here (the root causes behind repeated PDF
 * complaints):
 *   1. Section/table overlap — `applyPrintLayoutFixes` relaxes unsatisfiable
 *      `break-inside: avoid` constraints (the 2026-06-01 fix), now orientation-aware.
 *   2. Right-edge clipping of wide/landscape content — orientation is auto-detected
 *      from the rendered content (e.g. a 16:9 deck prints landscape), and any
 *      remaining horizontal overflow is scaled down to fit the printable width.
 *   3. Document intent — `preferCSSPageSize` honors a template's own `@page` size
 *      when it declares one.
 */

import {
  applyPrintLayoutFixes,
  measureContentSize,
  chooseOrientation,
  computePageContentWidthPx,
  computeFitScale,
  readAuthoredPageRule,
  parsePageSize,
  Orientation,
} from "../utils/pdfPrintLayout";

const CHROME_PATH = "/usr/bin/google-chrome";
const CHROME_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
];

const DEFAULT_FORMAT = "A4";
const DEFAULT_MARGIN = { top: "20mm", bottom: "20mm", left: "15mm", right: "15mm" };

export interface RenderHtmlToPdfOptions {
  /** Provide one of these as the content source. */
  url?: string;
  html?: string;
  /** Paper format (A4, Letter, Legal, A3, A5, Tabloid). Defaults to A4. */
  format?: string;
  /**
   * "portrait" | "landscape" forces orientation. "auto" (default) detects it
   * from the rendered content's aspect ratio — wide layouts (slide decks) print
   * landscape, documents stay portrait.
   */
  orientation?: Orientation | "auto";
  /** Page margins. Defaults to 20mm/15mm. */
  margin?: { top?: string; bottom?: string; left?: string; right?: string };
  /** Navigation/content timeout in ms. Defaults to 30000. */
  timeoutMs?: number;
}

export interface RenderHtmlToPdfResult {
  buffer: Buffer;
  /** The orientation actually used (after auto-detection). */
  orientation: Orientation;
  /** The scale applied to fit content to the page width (1 = no scaling). */
  scale: number;
  /**
   * True when the document declared its own `@page { size }` and we rendered at
   * exactly that page size + margin (e.g. a slide deck authored at 11in×8.5in),
   * rather than forcing a paper format. Lets callers/tests assert edge-to-edge.
   */
  honoredAuthoredPageSize: boolean;
}

/**
 * Render HTML (from a URL or an inline string) to a PDF buffer with all
 * print-quality fixes applied. The caller owns what happens to the buffer
 * (upload to S3, stream to client, etc.).
 */
export async function renderHtmlToPdf(
  opts: RenderHtmlToPdfOptions,
  puppeteerModule?: any
): Promise<RenderHtmlToPdfResult> {
  if (!opts.url && typeof opts.html !== "string") {
    throw new Error("renderHtmlToPdf requires either a url or html string");
  }

  const format = opts.format || DEFAULT_FORMAT;
  const margin = { ...DEFAULT_MARGIN, ...(opts.margin || {}) };
  const timeout = opts.timeoutMs ?? 30000;
  const requestedOrientation = opts.orientation ?? "auto";

  const puppeteer = puppeteerModule || (await import("puppeteer-core")).default;

  let browser: any = null;
  try {
    browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      args: CHROME_ARGS,
      headless: true,
    });
    const page = await browser.newPage();

    if (opts.url) {
      await page.goto(opts.url, { waitUntil: "networkidle0", timeout });
    } else {
      await page.setContent(opts.html as string, {
        waitUntil: "networkidle0",
        timeout,
      });
    }

    // ── Path 1: the document declares its own @page size (e.g. a slide deck
    // authored at "11in 8.5in; margin: 0"). Honor it exactly — render at that
    // page size with the CSS margins and no fit-shrink — so the slide prints
    // edge-to-edge. Forcing a paper format here is what left a band at the
    // bottom and clipped the right edge. Only used when the caller did not
    // explicitly override orientation/format.
    const callerOverrodeLayout =
      requestedOrientation !== "auto" || opts.format !== undefined;
    if (!callerOverrodeLayout) {
      const authored = parsePageSize(
        (await readAuthoredPageRule(page))?.size
      );
      if (authored) {
        // The document owns its layout (fixed-size slides paginated with
        // break-after: page). Don't inject the report break-inside relaxation —
        // just render at the authored size with preferCSSPageSize so Chrome uses
        // the @page box and its margin. No fit-shrink: scale stays 1.
        const pdfBuffer = await page.pdf({
          width: `${authored.widthMm}mm`,
          height: `${authored.heightMm}mm`,
          printBackground: true,
          preferCSSPageSize: true,
          scale: 1,
          // Authored @page declares its own margin; do not inject ours.
          margin: { top: "0", bottom: "0", left: "0", right: "0" },
        });
        return {
          buffer: Buffer.from(pdfBuffer),
          orientation: authored.orientation,
          scale: 1,
          honoredAuthoredPageSize: true,
        };
      }
    }

    // ── Path 2 (fallback): no authored @page size. Decide orientation from how
    // well the content's width fits a portrait vs landscape page (width is the
    // right signal — a deck is wide slides stacked tall, so aspect ratio
    // misleads), then scale to fit so the right edge is never clipped.
    const content = await measureContentSize(page);
    const portraitWidthPx = computePageContentWidthPx(
      format,
      margin.left,
      margin.right,
      "portrait"
    );
    const landscapeWidthPx = computePageContentWidthPx(
      format,
      margin.left,
      margin.right,
      "landscape"
    );
    const orientation: Orientation =
      requestedOrientation === "auto"
        ? chooseOrientation(content.width, portraitWidthPx, landscapeWidthPx)
        : requestedOrientation;

    // Relax unsatisfiable break-inside constraints for the chosen orientation
    // (prevents tall sections overflowing and overwriting the next section).
    await applyPrintLayoutFixes(
      page,
      format,
      margin.top,
      margin.bottom,
      orientation
    );

    // Prevent right-edge clipping: if content is still wider than the printable
    // area of the chosen orientation, scale the whole page down to fit.
    const pageWidthPx =
      orientation === "landscape" ? landscapeWidthPx : portraitWidthPx;
    const scale = computeFitScale(content.width, pageWidthPx);

    const pdfBuffer = await page.pdf({
      format,
      landscape: orientation === "landscape",
      printBackground: true,
      preferCSSPageSize: true,
      scale,
      margin,
    });

    return {
      buffer: Buffer.from(pdfBuffer),
      orientation,
      scale,
      honoredAuthoredPageSize: false,
    };
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {
        /* ignore close errors */
      }
    }
  }
}
