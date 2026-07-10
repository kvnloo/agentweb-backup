/**
 * Tests for adUtm — the single source of truth for the UTM parameters Emma
 * stamps onto ad destination URLs (ENG-239).
 *
 * Two constraints drive this design:
 *
 * 1. The receiving end is fixed. The lead-capture middleware injected into
 *    generated landing pages (`v0Service.injectLeadCaptureAttribution`) reads
 *    ONLY `utm_source|medium|campaign|content|term`. Any other key we emit is
 *    silently dropped, so the key set here is a contract, not a preference.
 *
 * 2. The ad ID does not exist until after the ad is created, so `utm_content`
 *    carries a platform macro (`{{ad.id}}` on Meta, `{creative}` on Google)
 *    that the platform resolves at click time. Macros must survive un-encoded —
 *    percent-encoding the braces breaks resolution.
 */

import {
  UTM_KEYS,
  UTM_MEDIUM_PAID,
  buildUtmSpec,
  existingUtmKeys,
  mergeUtmIntoUrl,
  utmQueryString,
} from "../adUtm";

describe("UTM_KEYS / UTM_MEDIUM_PAID", () => {
  it("matches exactly the keys the injected landing-page middleware reads", () => {
    // Mirror of v0Service.injectLeadCaptureAttribution's middleware.
    expect([...UTM_KEYS]).toEqual([
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_content",
      "utm_term",
    ]);
  });

  it("pins utm_medium to the value ENG-239's acceptance criteria mandate", () => {
    // NOTE: GA4's default channel grouping keys on `cpc`, not `paid`, so paid
    // clicks land in Unassigned. The AC mandates `paid`; flipping this constant
    // is the entire fix if that ruling changes. Asserted so it cannot drift.
    expect(UTM_MEDIUM_PAID).toBe("paid");
  });
});

describe("buildUtmSpec", () => {
  it("builds a spec for a platform with campaign and content macros", () => {
    const spec = buildUtmSpec("meta", {
      campaign: "{{campaign.id}}",
      content: "{{ad.id}}",
    });
    expect(spec).toEqual({
      source: "meta",
      medium: "paid",
      campaign: "{{campaign.id}}",
      content: "{{ad.id}}",
    });
  });

  it("omits content when the platform cannot resolve an ad ID (LinkedIn)", () => {
    const spec = buildUtmSpec("linkedin", { campaign: "urn:li:sponsoredCampaign:123" });
    expect(spec.content).toBeUndefined();
    expect(spec.source).toBe("linkedin");
  });

  it("rejects an unknown platform", () => {
    // @ts-expect-error — exercising the runtime guard, not the type
    expect(() => buildUtmSpec("tiktok", { campaign: "c1" })).toThrow(/unsupported platform/i);
  });

  it("rejects a platform name inherited from Object.prototype", () => {
    // A plain-object lookup walks the prototype chain: PLATFORM_SOURCE["constructor"]
    // is truthy (it is Object), so a naive `if (!source)` guard lets it through and
    // the function gets stringified into the ad's URL.
    for (const evil of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
      // @ts-expect-error — exercising the runtime guard, not the type
      expect(() => buildUtmSpec(evil, { campaign: "c1" })).toThrow(/unsupported platform/i);
    }
  });

  it("rejects an empty or whitespace-only campaign", () => {
    expect(() => buildUtmSpec("google", { campaign: "" })).toThrow(/campaign/i);
    expect(() => buildUtmSpec("google", { campaign: "   " })).toThrow(/campaign/i);
  });

  it("rejects a missing campaign", () => {
    // @ts-expect-error — exercising the runtime guard against an absent field
    expect(() => buildUtmSpec("google", {})).toThrow(/campaign/i);
  });

  it("drops an explicitly-supplied content on LinkedIn, which resolves no macros", () => {
    const spec = buildUtmSpec("linkedin", { campaign: "c1", content: "{{ad.id}}" });
    expect(spec.content).toBeUndefined();
  });

  it("ignores whitespace-only content and term rather than emitting empty params", () => {
    const spec = buildUtmSpec("meta", { campaign: "c1", content: "  ", term: "  " });
    expect(spec.content).toBeUndefined();
    expect(spec.term).toBeUndefined();
  });

  it("carries utm_term through when supplied", () => {
    const spec = buildUtmSpec("google", { campaign: "c1", term: "running shoes" });
    expect(spec.term).toBe("running shoes");
    expect(utmQueryString(spec)).toContain("utm_term=running%20shoes");
    expect(mergeUtmIntoUrl("https://x.com/lp", spec)).toContain("utm_term=running%20shoes");
  });
});

describe("existingUtmKeys", () => {
  it("returns the UTM keys already present on the URL", () => {
    const keys = existingUtmKeys("https://x.com/p?utm_source=newsletter&foo=1&utm_term=shoes");
    expect([...keys].sort()).toEqual(["utm_source", "utm_term"]);
  });

  it("returns an empty set for a URL with no query string", () => {
    expect(existingUtmKeys("https://x.com/p").size).toBe(0);
  });

  it("detects user-supplied keys case-insensitively so we never add a duplicate", () => {
    const keys = existingUtmKeys("https://x.com/p?UTM_Source=news");
    expect(keys.has("utm_source")).toBe(true);
  });

  it("throws on a URL it cannot parse", () => {
    expect(() => existingUtmKeys("not a url")).toThrow(/invalid url/i);
    expect(() => existingUtmKeys("/relative/path")).toThrow(/invalid url/i);
  });
});

describe("mergeUtmIntoUrl", () => {
  const spec = buildUtmSpec("google", { campaign: "{campaignid}", content: "{creative}" });

  it("appends all missing UTM params to a bare URL", () => {
    expect(mergeUtmIntoUrl("https://x.com/lp", spec)).toBe(
      "https://x.com/lp?utm_source=google&utm_medium=paid&utm_campaign={campaignid}&utm_content={creative}",
    );
  });

  it("uses & when the URL already has a query string, and preserves it", () => {
    const out = mergeUtmIntoUrl("https://x.com/lp?ref=abc", spec);
    expect(out.startsWith("https://x.com/lp?ref=abc&utm_source=google")).toBe(true);
  });

  it("AC4: never overwrites a UTM key the user set, but fills in the ones they did not", () => {
    const out = mergeUtmIntoUrl("https://x.com/lp?utm_source=newsletter", spec);
    expect(out).toContain("utm_source=newsletter");
    expect(out).not.toContain("utm_source=google");
    expect(out).toContain("utm_medium=paid");
    expect(out).toContain("utm_campaign={campaignid}");
  });

  it("AC4: returns the URL untouched when every UTM key is already present", () => {
    const url =
      "https://x.com/lp?utm_source=a&utm_medium=b&utm_campaign=c&utm_content=d&utm_term=e";
    expect(mergeUtmIntoUrl(url, spec)).toBe(url);
  });

  it("leaves platform macros un-encoded but percent-encodes real values", () => {
    const literal = buildUtmSpec("meta", { campaign: "spring sale/2026", content: "{{ad.id}}" });
    const out = mergeUtmIntoUrl("https://x.com/lp", literal);
    expect(out).toContain("utm_campaign=spring%20sale%2F2026");
    expect(out).toContain("utm_content={{ad.id}}");
  });

  it("preserves a fragment, appending params before it", () => {
    const out = mergeUtmIntoUrl("https://x.com/lp#pricing", spec);
    expect(out.endsWith("#pricing")).toBe(true);
    expect(out).toContain("?utm_source=google");
  });

  it("does not emit a stray & when the URL ends in a bare '?'", () => {
    // `https://x.com/lp?` is a valid URL with an empty query. Naively choosing the
    // separator on `includes("?")` yields `?&utm_source=...`, which strict URL
    // validators on the ad platforms reject.
    expect(mergeUtmIntoUrl("https://x.com/lp?", spec)).toBe(
      "https://x.com/lp?utm_source=google&utm_medium=paid&utm_campaign={campaignid}&utm_content={creative}",
    );
    expect(mergeUtmIntoUrl("https://x.com/lp?#top", spec)).toBe(
      "https://x.com/lp?utm_source=google&utm_medium=paid&utm_campaign={campaignid}&utm_content={creative}#top",
    );
  });

  it("throws on a URL it cannot parse", () => {
    expect(() => mergeUtmIntoUrl("not a url", spec)).toThrow(/invalid url/i);
  });
});

describe("utmQueryString", () => {
  it("renders the spec as a query string for Meta url_tags / Google finalUrlSuffix", () => {
    const spec = buildUtmSpec("meta", { campaign: "{{campaign.id}}", content: "{{ad.id}}" });
    expect(utmQueryString(spec)).toBe(
      "utm_source=meta&utm_medium=paid&utm_campaign={{campaign.id}}&utm_content={{ad.id}}",
    );
  });

  it("omits the keys the caller says are already on the destination URL", () => {
    const spec = buildUtmSpec("meta", { campaign: "c1", content: "{{ad.id}}" });
    const out = utmQueryString(spec, new Set(["utm_source", "utm_content"]));
    expect(out).toBe("utm_medium=paid&utm_campaign=c1");
  });

  it("returns an empty string when every key is omitted, so callers can skip the write", () => {
    const spec = buildUtmSpec("meta", { campaign: "c1" });
    expect(utmQueryString(spec, new Set(UTM_KEYS))).toBe("");
  });
});
