/**
 * ENG-2103 (F2) — shared, stateless PDF text renderer.
 *
 * Extracted verbatim from a module-level (non-class) function in
 * agentModeService.ts. Used by three unrelated consumers: `readGoogleDriveFileContent`
 * (emma/impl/shared/googleDriveAccess.ts, extracted for the Google Drive
 * cluster), and two callers that stay in the class for now —
 * `readSingleKnowledgeBaseFile` and `readFileContent`. Promoted here rather than
 * duplicated so all three keep sharing one implementation.
 */

/**
 * pdf-parse's `pagerender` hook. Overrides the library's default text
 * extraction, which concatenates a PDF page's text items in the order the PDF
 * itself lists them — for tabular PDFs that is often column-major, not reading
 * order, so numbers from different table cells run together or land out of
 * order. This renderer:
 * 1. Sorts all text items by Y (descending = top-to-bottom) then X (ascending = left-to-right)
 * 2. Groups items into rows using a Y-tolerance to handle slight vertical misalignments
 * 3. Separates items on the same row with a space so numbers don't concatenate
 */
export function pdfPageRender(pageData: any): Promise<string> {
  return pageData.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false })
    .then((textContent: any) => {
      const Y_TOLERANCE = 3; // points — items within this vertical distance are on the same row

      // Sort: top-to-bottom (higher Y first in PDF coords), left-to-right
      const items: Array<{ str: string; x: number; y: number }> = textContent.items
        .filter((item: any) => item.str && item.str.trim() !== '')
        .map((item: any) => ({ str: item.str, x: item.transform[4], y: item.transform[5] }))
        .sort((a: any, b: any) => {
          if (Math.abs(a.y - b.y) > Y_TOLERANCE) return b.y - a.y; // top first
          return a.x - b.x; // left first within same row
        });

      if (items.length === 0) return '';

      // Group items into rows
      const rows: string[][] = [];
      let currentRow: string[] = [];
      let rowY = items[0].y;

      for (const item of items) {
        if (Math.abs(item.y - rowY) <= Y_TOLERANCE) {
          currentRow.push(item.str);
        } else {
          rows.push(currentRow);
          currentRow = [item.str];
          rowY = item.y;
        }
      }
      if (currentRow.length > 0) rows.push(currentRow);

      return rows.map(row => row.join(' ')).join('\n');
    });
}
