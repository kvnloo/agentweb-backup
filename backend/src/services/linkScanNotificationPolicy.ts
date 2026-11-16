/**
 * ENG-1098 — scheduled-notification suppression for a clean broken-link scan.
 *
 * A recurring broken-link schedule should email only when something is wrong.
 * The decision is derived from the run's ACTUAL executed tool results (the
 * role:'tool' messages toolDispatch persists), never from prompt text or the
 * requested-function list, so a model claiming "no broken links" cannot
 * silence a report.
 *
 * Suppress only when the run's sole executed tool is one scan_website_links result and
 * it parses as a complete, clean scan. Anything else — broken links, failure,
 * truncation, robots-skipped or unverifiable links, several scans, an
 * unparseable/offloaded payload, or no scan at all — returns false so the
 * report is sent exactly as before. Pure: no I/O.
 */
const SCAN_TOOL_NAME = 'scan_website_links';

function parseScanResult(content: unknown): Record<string, unknown> | null {
  if (typeof content !== 'string') return null;
  try {
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isCleanScan(result: Record<string, unknown>): boolean {
  return (
    result.success === true &&
    result.brokenLinkCount === 0 &&
    result.unverifiableLinkCount === 0 &&
    Array.isArray(result.robotsSkipped) &&
    result.robotsSkipped.length === 0 &&
    result.truncated === false &&
    result.deadlineExceeded === false
  );
}

export function shouldSuppressScheduledNotification(
  messages: Array<Record<string, any>> | null | undefined
): boolean {
  if (!Array.isArray(messages)) return false;
  const toolResults = messages.filter((m) => m?.role === 'tool');
  // The scan must be the run's only executed tool: a larger report that merely
  // includes a clean scan still carries other findings and must be sent.
  if (toolResults.length !== 1 || toolResults[0]?.name !== SCAN_TOOL_NAME) return false;
  const scanResults = toolResults;
  const parsed = parseScanResult(scanResults[0].content);
  return parsed !== null && isCleanScan(parsed);
}
