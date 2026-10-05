/**
 * Meta Marketing API money normalization (ENG-2046 A1).
 *
 * Meta expresses every money field (daily/lifetime budget, bid, spend_cap) as an integer in
 * the ad account currency's smallest unit, using a per-currency "offset": 100 for most
 * currencies (USD cents), but 1 for zero-decimal currencies (TWD, JPY, KRW, ...). Treating
 * every account as cents turns NT$300/day into NT$30,000/day. Everything here is pure.
 */

/** Currencies Meta bills with offset 1 (no minor unit). */
const META_ZERO_DECIMAL = new Set([
  'CLP', 'COP', 'CRC', 'HUF', 'ISK', 'IDR', 'JPY', 'KRW', 'PYG', 'TWD', 'VND',
]);

const SYMBOLS: Record<string, string> = {
  USD: '$', EUR: '€', GBP: '£', JPY: '¥', TWD: 'NT$', KRW: '₩', INR: '₹',
  AUD: 'A$', CAD: 'C$',
};

export interface MetaCurrencyInfo {
  code: string;
  offset: 1 | 100;
  /** true when the code was missing/unrecognised and we fell back to offset 100. */
  assumed: boolean;
}

export function resolveMetaCurrency(code: string | null | undefined): MetaCurrencyInfo {
  const normalized = String(code ?? '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalized)) return { code: 'UNKNOWN', offset: 100, assumed: true };
  return { code: normalized, offset: META_ZERO_DECIMAL.has(normalized) ? 1 : 100, assumed: false };
}

export function metaCurrencyOffset(code: string | null | undefined): 1 | 100 {
  return resolveMetaCurrency(code).offset;
}

/** Major units (e.g. 300 TWD, 30.5 USD) -> Meta integer minor units. */
export function majorToMinor(amount: number, code: string | null | undefined): number {
  const n = Number(amount);
  if (!Number.isFinite(n)) throw new Error(`Invalid money amount: ${amount}`);
  return Math.round(n * metaCurrencyOffset(code));
}

/** Meta integer minor units -> major units. */
export function minorToMajor(minor: number, code: string | null | undefined): number {
  const n = Number(minor);
  if (!Number.isFinite(n)) throw new Error(`Invalid money amount: ${minor}`);
  return n / metaCurrencyOffset(code);
}

/** "300 (= NT$300.00 TWD)" — raw value plus major-unit meaning, for every confirmation. */
export function describeMetaMoney(minor: number, code: string | null | undefined): string {
  const info = resolveMetaCurrency(code);
  const major = minorToMajor(minor, code).toLocaleString('en-US', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
  if (info.assumed) return `${minor} (= ${major} in the ad account's currency, assuming 2 decimals)`;
  return `${minor} (= ${SYMBOLS[info.code] ?? ''}${major} ${info.code})`;
}
