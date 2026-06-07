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

export type PdfOrientation = "portrait" | "landscape";

/** Page dimensions in millimeters for supported Puppeteer paper formats. */
const FORMAT_SIZE_MM: Record<string, { width: number; height: number }> = {
  a4: { width: 210, height: 297 },
  letter: { width: 215.9, height: 279.4 },
  legal: { width: 215.9, height: 355.6 },
  a3: { width: 297, height: 420 },
  a5: { width: 148, height: 210 },
  tabloid: { width: 279.4, height: 431.8 },
};

/** Convert a millimeter measurement to CSS pixels at 96dpi. */
export function mmToPx(mm: number): number {
  return mm * PX_PER_MM;
}

export function normalizePdfOrientation(
  orientation: unknown
): PdfOrientation {
  return orientation === "landscape" ? "landscape" : "portrait";
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

/**
 * Compute the printable content height (in CSS px) for a paper format and
 * top/bottom margins — i.e. how tall an element can be before it can no longer
 * fit on a single page.
 */
export function computePageContentHeightPx(
  format: string,
  marginTop: string | undefined,
  marginBottom: string | undefined,
  orientation: PdfOrientation = "portrait"
): number {
  const size = FORMAT_SIZE_MM[(format || "a4").toLowerCase()] ?? FORMAT_SIZE_MM.a4;
  const heightMm = normalizePdfOrientation(orientation) === "landscape"
    ? size.width
    : size.height;
  const usableMm = heightMm - marginToMm(marginTop) - marginToMm(marginBottom);
  return mmToPx(usableMm);
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
  orientation: PdfOrientation = "portrait"
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
