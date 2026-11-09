/**
 * ENG-2113: log hygiene for values a (possibly compromised) worker can influence. A log line must never carry worker-chosen text of unbounded length, newlines
 * (a forged "[...] ALARM" line) or control characters. Fixed vocabularies are logged as themselves, anything else as `other`; free text is stripped and cut.
 */
export function safeToken(value: unknown, allowed: readonly string[]): string {
  return typeof value === "string" && allowed.includes(value) ? value : value === undefined ? "none" : "other";
}

const CONTROL = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]", "g");
export function safeText(value: unknown, max = 200): string {
  const text = typeof value === "string" ? value : value instanceof Error ? value.message : String(value);
  const clean = text.slice(0, max + 1).replace(CONTROL, " ");
  return clean.length > max ? `${clean.slice(0, max)}...` : clean;
}
