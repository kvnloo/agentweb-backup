/**
 * WS4: stop negative-cache poisoning in the enrichment cache.
 *
 * Before: an EMPTY enrichment result (no web results, no LinkedIn data) was
 * cached with the field group's full TTL (90–180 days). A lead that couldn't
 * be enriched once was locked out of re-enrichment for months, even after the
 * data became findable — a big driver of "enrichment is bad".
 *
 * After: empty payloads get a short negative TTL so a re-run the next day can
 * pick up newly-available data, while still avoiding hammering providers on
 * every request. Positive hits keep their full TTL (behavior-preserving).
 */

const putItem = jest.fn();
jest.mock("../services/db", () => ({
  crmDb: {
    putEnrichmentCacheItem: (...args: any[]) => putItem(...args),
    getEnrichmentCacheItem: jest.fn(),
  },
}));

import {
  isEmptyRawData,
  resolveCacheTtlDays,
  NEGATIVE_CACHE_TTL_DAYS,
  writeRawDataToCache,
} from "../services/enrichmentCacheService";

const empty = { webResults: [], linkedinCompanyResults: null, linkedinData: null };
const withWeb = { webResults: [{ url: "x" } as any], linkedinCompanyResults: null, linkedinData: null };
const withLi = {
  webResults: [],
  linkedinCompanyResults: null,
  linkedinData: { profileId: "p", publicIdentifier: "u", rawProfile: {}, fetchedAt: "t" },
};
const withLiCompany = { webResults: [], linkedinCompanyResults: [{ url: "y" } as any], linkedinData: null };

describe("isEmptyRawData", () => {
  it("is true only when there is no usable signal", () => {
    expect(isEmptyRawData(empty as any)).toBe(true);
    expect(isEmptyRawData(null as any)).toBe(true);
    expect(isEmptyRawData({} as any)).toBe(true);
  });
  it("is false when any source has data", () => {
    expect(isEmptyRawData(withWeb as any)).toBe(false);
    expect(isEmptyRawData(withLi as any)).toBe(false);
    expect(isEmptyRawData(withLiCompany as any)).toBe(false);
  });
});

describe("resolveCacheTtlDays", () => {
  it("uses a short negative TTL for empty payloads", () => {
    expect(resolveCacheTtlDays(empty as any, 180)).toBe(NEGATIVE_CACHE_TTL_DAYS);
    expect(resolveCacheTtlDays(empty as any, 180)).toBeLessThan(180);
  });
  it("never exceeds the base TTL (if base is tiny, clamp to base)", () => {
    expect(resolveCacheTtlDays(empty as any, 0)).toBe(0);
  });
  it("keeps the full TTL for non-empty payloads", () => {
    expect(resolveCacheTtlDays(withWeb as any, 180)).toBe(180);
  });
});

describe("writeRawDataToCache — applies the negative TTL", () => {
  const lead = { website: "acme.com" } as any;
  const group = "company_firmographic";

  beforeEach(() => putItem.mockReset());

  it("writes an empty result with a ~1-day expiry and a negative flag", async () => {
    await writeRawDataToCache(lead, group, empty as any, "q", ["web"]);
    expect(putItem).toHaveBeenCalledTimes(1);
    const item = putItem.mock.calls[0][0];
    const nowSec = Math.floor(Date.now() / 1000);
    expect(item.expiresAt - nowSec).toBeLessThanOrEqual(NEGATIVE_CACHE_TTL_DAYS * 86400 + 5);
    expect(item.expiresAt - nowSec).toBeGreaterThan(0);
    expect(item.negative).toBe(true);
  });

  it("writes a non-empty result with the full (long) expiry", async () => {
    await writeRawDataToCache(lead, group, withWeb as any, "q", ["web"]);
    const item = putItem.mock.calls[0][0];
    const nowSec = Math.floor(Date.now() / 1000);
    // company_firmographic TTL is well over a week; assert it's far longer
    // than the negative TTL.
    expect(item.expiresAt - nowSec).toBeGreaterThan(NEGATIVE_CACHE_TTL_DAYS * 86400 * 5);
    expect(item.negative).toBe(false);
  });
});
