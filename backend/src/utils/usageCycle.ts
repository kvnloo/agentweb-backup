/**
 * The billing cycle, in one place.
 *
 * Included allowance is reckoned per CALENDAR month in UTC — `getCurrentUsageMonth`
 * returns `YYYY-MM`, the credit ledger is keyed by it, and `getLlmUsageCreditAdjustment`
 * returns a zero adjustment the moment the stored month stops matching. So "when am I
 * unblocked" is always the 1st of the following month, and it is derivable from the
 * `month` every usage payload already carries — no extra read.
 *
 * ENG-1344: the customer who escalated the usage block could not decode the word
 * "reset" (xCures, 2026-08-18: "a block that I can't use Emma until I reset or add
 * new usage. What does that mean?"). Every customer-visible block message said
 * "reset" without ever saying WHEN, so the one fact that would have answered him
 * was the one fact we never sent. These helpers exist so no surface has to
 * re-derive it, and so none of them can quietly disagree about the date.
 */

/** UTC calendar day, `YYYY-MM-DD`. */
export function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * `YYYY-MM-DD` → the cycle it falls in. `Date.UTC(year, month, 1)` is already the
 * FOLLOWING month because the constructor's month is 0-based while `month` here is
 * 1-based; December needs no special case, since index 12 normalizes to January of
 * the next year.
 */
export function resolveCycle(today: string): { cycleStartDate: string; cycleResetDate: string } {
  const [year, month] = today.split("-").map(Number);
  return {
    cycleStartDate: `${year}-${String(month).padStart(2, "0")}-01`,
    cycleResetDate: utcDay(new Date(Date.UTC(year, month, 1))),
  };
}

/** `YYYY-MM` → `YYYY-MM-DD` of the next reset, or null when unparseable. */
export function resetDateFromMonth(month: string | null | undefined): string | null {
  if (!month) return null;
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return null;
  const year = Number(m[1]);
  const monthNum = Number(m[2]);
  if (monthNum < 1 || monthNum > 12) return null;
  return utcDay(new Date(Date.UTC(year, monthNum, 1)));
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

/**
 * `YYYY-MM-DD` → "October 1, 2026".
 *
 * Formatted by string surgery, NOT by `new Date(...).toLocaleDateString(...)`.
 * A date-only ISO string parses as UTC midnight, so a host west of the line
 * renders the PREVIOUS day — telling a customer their usage returns on
 * September 30 when the cycle actually turns on October 1. Pinning
 * `timeZone: "UTC"` fixes that, but it fixes it invisibly: the bug only
 * reproduces on a host whose offset is negative, so on this fleet (IST, UTC+5:30)
 * a test asserting the pin passes whether or not the pin is there. Rather than
 * ship a guard that cannot fail where it runs, there is no Date here at all and
 * nothing to drift. `en-US` month names match the hardcoded locale the usage
 * emails already use.
 */
export function formatResetDateLong(isoDate: string | null | undefined): string | null {
  if (!isoDate) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) return null;
  const year = Number(m[1]);
  const monthNum = Number(m[2]);
  const day = Number(m[3]);
  if (monthNum < 1 || monthNum > 12 || day < 1 || day > 31) return null;
  // A shape check is not a calendar check: `day <= 31` still admits 2026-02-31.
  // Round-trip it through UTC purely to VALIDATE — every getter here is a UTC
  // getter, so this stays host-timezone independent, and the returned string is
  // still built from the parsed components rather than from the Date. Without
  // this the backend would render "February 31, 2026"; the portal's sibling
  // `formatDay` had the worse version of the same gap, where Date's silent
  // normalization turned it into a plausible but WRONG day (CodeRabbit, #1134).
  const probe = new Date(Date.UTC(year, monthNum - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== monthNum - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }
  return `${MONTH_NAMES[monthNum - 1]} ${day}, ${m[1]}`;
}

/**
 * The customer-facing sentence, or null when the date cannot be derived — in
 * which case the caller must fall back to wording that promises no date rather
 * than invent one.
 */
export function resetSentence(month: string | null | undefined): string | null {
  const label = formatResetDateLong(resetDateFromMonth(month));
  return label ? `Your included usage resets on ${label}.` : null;
}

/**
 * The interactive block message.
 *
 * ENG-1344 AC6: this is a thin re-export of `buildUsageBlockCopy(...).message`
 * so the 429 string and the portal's rendered sentences cannot come from two
 * different places. Kept as a named function because the call sites read better
 * than `buildUsageBlockCopy({ month }).message` inline.
 */
export function usagePausedMessage(month: string | null | undefined): string {
  // Imported lazily to keep `usageCycle` free of a cycle: usageBlockCopy imports
  // the date helpers from here.
  const { buildUsageBlockCopy } = require("./usageBlockCopy") as typeof import("./usageBlockCopy");
  return buildUsageBlockCopy({ month }).message;
}
