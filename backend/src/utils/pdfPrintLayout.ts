/**
 * pdfPrintLayout — helpers that make HTML-to-PDF conversion robust against
 * sections/tables overlapping or overwriting each other.
 *
 * Background
 * ----------
 * Generated report HTML commonly applies `page-break-inside: avoid` to large
 * containers (`.section-block`, cards, etc.) so a section won't be split mid-way.
 * That works when the container fits on a page. But when a container is TALLER
 * than a single printable page, the constraint is unsatisfiable: Chrome's print
 * engine overflows the block past the page boundary and paints the following
 * section on top of it — the reported "sections overwrite each other" bug.
 *
 * The robust fix lives in the conversion pipeline (not in any one template):
 *   1. Inject print-safety CSS that lets big tables break across pages while
 *      keeping rows/headers intact.
 *   2. After layout, find any element whose `break-inside: avoid` cannot be
 *      satisfied (taller than the printable page) and relax it to `auto`, so
 *      Chrome inserts clean page breaks instead of overflowing.
 *
 * The pure helpers here are unit-tested; `applyPrintLayoutFixes` runs the
 * relaxation step inside a Puppeteer page.
 */

const PX_PER_MM = 96 / 25.4; // CSS reference pixel is 1/96in; 1in = 25.4mm

/**
 * Portrait dimensions (width × height, in mm) for supported Puppeteer paper
 * formats. In landscape the two are swapped.
 */
const FORMAT_DIMENSIONS_MM: Record<string, { width: number; height: number }> = {
  a4: { width: 210, height: 297 },
  letter: { width: 215.9, height: 279.4 },
  legal: { width: 215.9, height: 355.6 },
  a3: { width: 297, height: 420 },
  a5: { width: 148, height: 210 },
  tabloid: { width: 279.4, height: 431.8 },
};

function formatDimensions(format: string): { width: number; height: number } {
  return FORMAT_DIMENSIONS_MM[(format || "a4").toLowerCase()] ?? FORMAT_DIMENSIONS_MM.a4;
}

/** Convert a millimeter measurement to CSS pixels at 96dpi. */
export function mmToPx(mm: number): number {
  return mm * PX_PER_MM;
}

/**
 * Parse a CSS-ish margin string (e.g. "20mm", "1in", "72px") into millimeters.
 * Defaults to 0 for missing/unparseable values.
 */
function marginToMm(margin: string | undefined): number {
  if (!margin) return 0;
  const match = /^([\d.]+)\s*(mm|cm|in|px|pt)?$/.exec(margin.trim());
  if (!match) return 0;
  const value = parseFloat(match[1]);
  if (!isFinite(value)) return 0;
  switch (match[2]) {
    case "cm":
      return value * 10;
    case "in":
      return value * 25.4;
    case "px":
      return value / PX_PER_MM;
    case "pt":
      return (value / 72) * 25.4;
    case "mm":
    default:
      return value;
  }
}

export type Orientation = "portrait" | "landscape";

/** Parse a single CSS length token (e.g. "11in", "210mm") into mm, else null. */
function lengthToMm(token: string): number | null {
  const match = /^([\d.]+)(mm|cm|in|px|pt)?$/.exec(token.trim());
  if (!match) return null;
  const value = parseFloat(match[1]);
  if (!isFinite(value)) return null;
  switch (match[2]) {
    case "cm":
      return value * 10;
    case "in":
      return value * 25.4;
    case "px":
      return value / PX_PER_MM;
    case "pt":
      return (value / 72) * 25.4;
    case "mm":
      return value;
    default:
      // A unitless length is invalid for @page size; treat as unresolved.
      return null;
  }
}

/**
 * A page size resolved from a CSS `@page { size: ... }` declaration, in mm.
 * `orientation` is reported for logging/wiring; the width/height are already
 * swapped so width is the page's horizontal extent.
 */
export interface AuthoredPageSize {
  widthMm: number;
  heightMm: number;
  orientation: Orientation;
}

/**
 * Parse a CSS `@page` `size` value into concrete page dimensions.
 *
 * Honoring a document's own `@page` size is what makes a slide deck print
 * edge-to-edge: the deck declares e.g. `size: 11in 8.5in; margin: 0`, and we
 * render at exactly that instead of forcing A4 + margins (which clips the right
 * and leaves a band at the bottom).
 *
 * Supported forms:
 *   - two lengths:  "11in 8.5in"      → 279.4 × 215.9 mm
 *   - one length:   "8.5in"           → square 215.9 × 215.9 mm
 *   - named:        "A4", "Letter"    → format dimensions (portrait)
 *   - named + kw:   "A4 landscape"    → format dimensions, swapped
 *   - keyword only: "landscape"       → null (no concrete size; caller decides)
 *   - "auto"/empty/unparseable        → null
 */
export function parsePageSize(size: string | undefined): AuthoredPageSize | null {
  if (!size) return null;
  const tokens = size.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  if (tokens.length === 1 && (tokens[0] === "auto" || tokens[0] === "")) {
    return null;
  }

  // Explicit length(s): one or two CSS lengths.
  const lengths = tokens.map(lengthToMm);
  if (lengths.every((l) => l !== null)) {
    if (lengths.length === 1) {
      const s = lengths[0] as number;
      return { widthMm: s, heightMm: s, orientation: "portrait" };
    }
    if (lengths.length === 2) {
      const w = lengths[0] as number;
      const h = lengths[1] as number;
      return {
        widthMm: w,
        heightMm: h,
        orientation: w >= h ? "landscape" : "portrait",
      };
    }
    return null;
  }

  // Named format, optionally with a portrait/landscape keyword.
  const orientationKw = tokens.find(
    (t) => t === "portrait" || t === "landscape"
  ) as Orientation | undefined;
  const formatKw = tokens.find((t) => t in FORMAT_DIMENSIONS_MM);
  if (formatKw) {
    const dims = FORMAT_DIMENSIONS_MM[formatKw];
    const orientation = orientationKw ?? "portrait";
    const widthMm = orientation === "landscape" ? dims.height : dims.width;
    const heightMm = orientation === "landscape" ? dims.width : dims.height;
    return { widthMm, heightMm, orientation };
  }

  // Keyword-only (e.g. "landscape") has no concrete size — let the caller decide.
  return null;
}

/**
 * Compute the printable content height (in CSS px) for a paper format and
 * top/bottom margins — i.e. how tall an element can be before it can no longer
 * fit on a single page. In landscape the format's width becomes the height.
 */
export function computePageContentHeightPx(
  format: string,
  marginTop: string | undefined,
  marginBottom: string | undefined,
  orientation: Orientation = "portrait"
): number {
  const dims = formatDimensions(format);
  const heightMm = orientation === "landscape" ? dims.width : dims.height;
  const usableMm = heightMm - marginToMm(marginTop) - marginToMm(marginBottom);
  return mmToPx(usableMm);
}

/**
 * Compute the printable content WIDTH (in CSS px) for a paper format and
 * left/right margins — how wide content can be before it is clipped off the
 * right edge of the page. In landscape the format's height becomes the width.
 */
export function computePageContentWidthPx(
  format: string,
  marginLeft: string | undefined,
  marginRight: string | undefined,
  orientation: Orientation = "portrait"
): number {
  const dims = formatDimensions(format);
  const widthMm = orientation === "landscape" ? dims.height : dims.width;
  const usableMm = widthMm - marginToMm(marginLeft) - marginToMm(marginRight);
  return mmToPx(usableMm);
}

/** Uncapped fit ratio: how much content must shrink to fit a page width (≤ 1). */
function fitRatio(contentWidthPx: number, pageWidthPx: number): number {
  if (!(contentWidthPx > 0) || !(pageWidthPx > 0)) return 1;
  return Math.min(1, pageWidthPx / contentWidthPx);
}

/**
 * Decide a sensible page orientation from the rendered content's WIDTH.
 *
 * Width — not aspect ratio — is the right signal: a slide deck is many 16:9
 * slides stacked vertically, so the document as a whole is tall (portrait-ish
 * by aspect ratio) even though each slide is wide. What actually matters is
 * whether the content is too wide to fit a portrait page without shrinking.
 *
 * Rule: if the content fits a portrait page comfortably (needs little or no
 * downscaling), stay portrait — this keeps ordinary reports portrait. Only when
 * portrait would require meaningful shrinking AND landscape fits better do we
 * switch to landscape.
 */
export function chooseOrientation(
  contentWidthPx: number,
  portraitContentWidthPx: number,
  landscapeContentWidthPx: number,
  portraitFitThreshold = 0.85
): Orientation {
  if (!(contentWidthPx > 0)) return "portrait";
  const portraitFit = fitRatio(contentWidthPx, portraitContentWidthPx);
  if (portraitFit >= portraitFitThreshold) return "portrait";
  const landscapeFit = fitRatio(contentWidthPx, landscapeContentWidthPx);
  return landscapeFit > portraitFit ? "landscape" : "portrait";
}

/**
 * Compute a scale factor (≤ 1) that shrinks content to fit within the printable
 * page width, preventing the right side from being clipped. Returns 1 when the
 * content already fits or when inputs are invalid. Never scales below `minScale`
 * so text stays legible — clipping a little is better than an unreadable page.
 */
export function computeFitScale(
  contentWidthPx: number,
  pageContentWidthPx: number,
  minScale = 0.5
): number {
  if (!(contentWidthPx > 0) || !(pageContentWidthPx > 0)) return 1;
  if (contentWidthPx <= pageContentWidthPx) return 1;
  const scale = pageContentWidthPx / contentWidthPx;
  return Math.max(minScale, scale);
}

/**
 * Decide whether an element's `break-inside: avoid` should be relaxed.
 * True when the element is meaningfully taller than the printable page, which
 * makes the avoid constraint impossible to satisfy.
 */
export function shouldRelaxBreakInside(
  elementHeightPx: number,
  pageContentHeightPx: number
): boolean {
  if (!(elementHeightPx > 0) || !(pageContentHeightPx > 0)) return false;
  return elementHeightPx > pageContentHeightPx;
}

/**
 * Print-safety CSS injected before PDF generation. Applies in the print
 * media context so it never affects on-screen rendering.
 *
 * - Tables and their wrappers may break across pages (prevents tall tables
 *   from overflowing a page and overwriting the next section).
 * - Individual rows and images stay intact.
 * - Headers stay attached to the content that follows them.
 */
export const PRINT_SAFETY_CSS = `
@media print {
  html, body { height: auto !important; }
  table, .table-wrapper, tbody, thead {
    break-inside: auto !important;
    page-break-inside: auto !important;
  }
  tr {
    break-inside: avoid;
    page-break-inside: avoid;
  }
  img { break-inside: avoid; page-break-inside: avoid; max-width: 100%; }
  h1, h2, h3, h4, h5, h6,
  .section-header, .subsection-header, .section-number-badge {
    break-after: avoid;
    page-break-after: avoid;
  }
}
`;

/**
 * Run inside a Puppeteer page (after setContent/goto, before page.pdf()).
 * Injects PRINT_SAFETY_CSS, switches to print media, then relaxes
 * `break-inside: avoid` on any element taller than the printable page so it
 * can break cleanly across pages instead of overlapping the next section.
 *
 * Returns the number of elements relaxed (useful for logging/tests).
 */
export async function applyPrintLayoutFixes(
  page: {
    addStyleTag: (opts: { content: string }) => Promise<unknown>;
    emulateMediaType?: (type: string) => Promise<unknown>;
    evaluate: (fn: (...args: any[]) => any, ...args: any[]) => Promise<any>;
  },
  format: string,
  marginTop: string | undefined,
  marginBottom: string | undefined,
  orientation: Orientation = "portrait"
): Promise<number> {
  const pageContentHeightPx = computePageContentHeightPx(
    format,
    marginTop,
    marginBottom,
    orientation
  );

  await page.addStyleTag({ content: PRINT_SAFETY_CSS });
  if (page.emulateMediaType) {
    await page.emulateMediaType("print");
  }

  // In-browser pass: relax unsatisfiable avoid constraints.
  return (await page.evaluate((maxHeight: number) => {
    let relaxed = 0;
    const els = document.querySelectorAll<HTMLElement>("*");
    els.forEach((el) => {
      const cs = window.getComputedStyle(el);
      const avoids =
        cs.breakInside === "avoid" || cs.pageBreakInside === "avoid";
      if (!avoids) return;
      if (el.getBoundingClientRect().height > maxHeight) {
        el.style.setProperty("break-inside", "auto", "important");
        el.style.setProperty("page-break-inside", "auto", "important");
        relaxed += 1;
      }
    });
    return relaxed;
  }, pageContentHeightPx)) as number;
}

/**
 * Measure the rendered content's natural size (CSS px) inside a Puppeteer page.
 * Used to auto-detect orientation and to decide whether content overflows the
 * page width and must be scaled to avoid right-edge clipping.
 *
 * `width` is the widest of scroll/offset/client width so absolutely-positioned
 * or overflowing children (a wide slide canvas, a fixed-width deck) are counted.
 */
export async function measureContentSize(page: {
  evaluate: (fn: (...args: any[]) => any, ...args: any[]) => Promise<any>;
}): Promise<{ width: number; height: number }> {
  return (await page.evaluate(() => {
    const b = document.body;
    const e = document.documentElement;
    const width = Math.max(
      b ? b.scrollWidth : 0,
      b ? b.offsetWidth : 0,
      e ? e.scrollWidth : 0,
      e ? e.offsetWidth : 0,
      e ? e.clientWidth : 0
    );
    const height = Math.max(
      b ? b.scrollHeight : 0,
      b ? b.offsetHeight : 0,
      e ? e.scrollHeight : 0,
      e ? e.offsetHeight : 0,
      e ? e.clientHeight : 0
    );
    return { width, height };
  })) as { width: number; height: number };
}

/** Raw `size`/`margin` strings read from a document's first `@page` rule. */
export interface AuthoredPageRule {
  size?: string;
  margin?: string;
}

/**
 * Read the first `@page` rule's `size`/`margin` from the document's stylesheets
 * inside a Puppeteer page. Returns null when no `@page` rule is declared.
 *
 * Cross-origin stylesheets throw on `.cssRules` access; those are skipped so a
 * remote font/CSS import can't break detection.
 */
export async function readAuthoredPageRule(page: {
  evaluate: (fn: (...args: any[]) => any, ...args: any[]) => Promise<any>;
}): Promise<AuthoredPageRule | null> {
  return (await page.evaluate(() => {
    for (const sheet of Array.from(document.styleSheets)) {
      let rules: any;
      try {
        rules = (sheet as CSSStyleSheet).cssRules;
      } catch {
        continue; // cross-origin sheet — not readable
      }
      for (const rule of Array.from(rules || [])) {
        if (rule && rule.constructor && rule.constructor.name === "CSSPageRule") {
          const style = (rule as any).style || {};
          const size = style.size || undefined;
          const margin = style.margin || undefined;
          if (size || margin) return { size, margin };
        }
      }
    }
    return null;
  })) as AuthoredPageRule | null;
}
