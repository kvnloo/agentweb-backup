import {
  AD_COPY_TIMEOUT_MS,
  adCopyFailedPatch,
  adCopyReadyPatch,
  adCopySnapshot,
  adCopyStartPatch,
  adCopyUpdateVariantPatch,
  logAdCopyCompletionMetric,
  sanitizeAdCopyResult,
  MAX_AD_COPY_VARIANTS,
} from "../services/adCopyStatusService";

const variant = (i: number) => ({
  id: `v${i}`,
  headline: `Headline ${i}`,
  primaryText: `Body text ${i}`,
  cta: "Learn more",
  variety: `variety-${i}`,
});

describe("adCopyStatusService", () => {
  const now = new Date("2026-04-24T12:00:00.000Z");

  it("startPatch returns running and resets fields", () => {
    const patch = adCopyStartPatch(now);
    expect(patch.adCopyStatus).toBe("running");
    expect(patch.adCopyResult).toBeUndefined();
  });

  it("readyPatch returns null when not running (FAIL #1)", () => {
    const r = { variants: [variant(1)] };
    expect(adCopyReadyPatch({ adCopyStatus: "ready" }, r, now)).toBeNull();
    expect(adCopyReadyPatch({ adCopyStatus: "failed" }, r, now)).toBeNull();
    expect(adCopyReadyPatch({}, r, now)).toBeNull();
  });

  it("readyPatch attaches sanitized variants and computes duration", () => {
    const startedAt = new Date("2026-04-24T11:59:30.000Z");
    const patch = adCopyReadyPatch(
      { adCopyStatus: "running", adCopyStartedAt: startedAt.toISOString() },
      { variants: [variant(1), variant(2), variant(3)] },
      now
    );
    expect(patch).not.toBeNull();
    expect(patch!.adCopyStatus).toBe("ready");
    expect(patch!.adCopyDurationMs).toBe(30_000);
    expect(patch!.adCopyResult!.variants).toHaveLength(3);
    expect(patch!.adCopyResult!.variants[0].variety).toBe("variety-1");
  });

  it("readyPatch coerces negative skew to 0 (FAIL #2)", () => {
    const future = new Date("2026-04-24T12:01:00.000Z");
    const patch = adCopyReadyPatch(
      { adCopyStatus: "running", adCopyStartedAt: future.toISOString() },
      { variants: [variant(1)] },
      now
    );
    expect(patch!.adCopyDurationMs).toBe(0);
  });

  it("failedPatch caps error and defaults message", () => {
    const huge = "x".repeat(2000);
    expect(adCopyFailedPatch({ adCopyStatus: "running" }, huge, now).adCopyError!.length).toBe(
      512
    );
    expect(adCopyFailedPatch({ adCopyStatus: "running" }, "", now).adCopyError).toBe(
      "ad copy generation failed"
    );
  });

  it("snapshot flips timedOut after budget", () => {
    const tooOld = new Date(now.getTime() - AD_COPY_TIMEOUT_MS - 1);
    const snap = adCopySnapshot(
      { adCopyStatus: "running", adCopyStartedAt: tooOld.toISOString() },
      now
    );
    expect(snap.timedOut).toBe(true);
  });

  it("sanitizeAdCopyResult drops malformed entries", () => {
    expect(sanitizeAdCopyResult(null).variants).toEqual([]);
    const out = sanitizeAdCopyResult({
      variants: [
        variant(1),
        { id: "v2", headline: "h" }, // missing fields
        null,
        variant(3),
      ],
    });
    expect(out.variants.length).toBe(2);
    expect(out.variants.map((v) => v.id)).toEqual(["v1", "v3"]);
  });

  it("sanitizeAdCopyResult caps array at MAX_AD_COPY_VARIANTS", () => {
    const many = Array.from({ length: 10 }, (_, i) => variant(i));
    const out = sanitizeAdCopyResult({ variants: many });
    expect(out.variants.length).toBe(MAX_AD_COPY_VARIANTS);
    expect(MAX_AD_COPY_VARIANTS).toBe(3);
  });

  it("sanitizeAdCopyResult truncates overlong fields", () => {
    const huge = "x".repeat(5000);
    const out = sanitizeAdCopyResult({
      variants: [
        { id: huge, headline: huge, primaryText: huge, cta: huge, variety: huge },
      ],
    });
    expect(out.variants[0].id.length).toBeLessThanOrEqual(64);
    expect(out.variants[0].headline.length).toBeLessThanOrEqual(200);
    expect(out.variants[0].primaryText.length).toBeLessThanOrEqual(1000);
    expect(out.variants[0].cta.length).toBeLessThanOrEqual(40);
    expect(out.variants[0].variety.length).toBeLessThanOrEqual(100);
  });

  it("metric log line is grep-able", () => {
    const captured: unknown[][] = [];
    const spy = jest
      .spyOn(console, "log")
      .mockImplementation((...args) => captured.push(args));
    logAdCopyCompletionMetric("user-1234", "ready", 45_000, 3);
    expect(captured[0][0]).toMatch(
      /^\[metrics\] ad_copy_complete status=ready duration_ms=45000 variants=3 user=user-123$/
    );
    spy.mockRestore();
  });

  describe("adCopyUpdateVariantPatch", () => {
    const baseFields = {
      adCopyStatus: "ready" as const,
      adCopyResult: {
        variants: [variant(1), variant(2), variant(3)],
      },
    };

    it("returns null when no result is present (state not ready)", () => {
      const patch = adCopyUpdateVariantPatch(
        {},
        { variantId: "v1", headline: "x" }
      );
      expect(patch).toBeNull();
    });

    it("returns null when variant id is not found", () => {
      const patch = adCopyUpdateVariantPatch(baseFields, {
        variantId: "missing",
        headline: "x",
      });
      expect(patch).toBeNull();
    });

    it("returns null when no editable fields are supplied", () => {
      const patch = adCopyUpdateVariantPatch(baseFields, {
        variantId: "v1",
      });
      expect(patch).toBeNull();
    });

    it("updates only the headline when only headline supplied", () => {
      const patch = adCopyUpdateVariantPatch(baseFields, {
        variantId: "v2",
        headline: "Brand new headline",
      });
      expect(patch).not.toBeNull();
      const variants = patch!.adCopyResult!.variants;
      expect(variants[0]).toEqual(variant(1));
      expect(variants[1].headline).toBe("Brand new headline");
      expect(variants[1].primaryText).toBe("Body text 2");
      expect(variants[1].cta).toBe("Learn more");
      expect(variants[1].variety).toBe("variety-2");
      expect(variants[2]).toEqual(variant(3));
    });

    it("supports updating headline + primaryText + cta together", () => {
      const patch = adCopyUpdateVariantPatch(baseFields, {
        variantId: "v3",
        headline: "H",
        primaryText: "P",
        cta: "Sign up",
      });
      expect(patch).not.toBeNull();
      const v = patch!.adCopyResult!.variants[2];
      expect(v.id).toBe("v3");
      expect(v.headline).toBe("H");
      expect(v.primaryText).toBe("P");
      expect(v.cta).toBe("Sign up");
      expect(v.variety).toBe("variety-3");
    });

    it("clamps oversized fields to the canonical max lengths", () => {
      const longHeadline = "x".repeat(500);
      const longPrimary = "y".repeat(2000);
      const longCta = "z".repeat(100);
      const patch = adCopyUpdateVariantPatch(baseFields, {
        variantId: "v1",
        headline: longHeadline,
        primaryText: longPrimary,
        cta: longCta,
      });
      const v = patch!.adCopyResult!.variants[0];
      expect(v.headline.length).toBeLessThanOrEqual(200);
      expect(v.primaryText.length).toBeLessThanOrEqual(1000);
      expect(v.cta.length).toBeLessThanOrEqual(40);
    });

    it("preserves variety on edit (not user-editable)", () => {
      const patch = adCopyUpdateVariantPatch(baseFields, {
        variantId: "v1",
        headline: "edited",
      });
      expect(patch!.adCopyResult!.variants[0].variety).toBe("variety-1");
    });

    it("returns a fresh array — does not mutate input", () => {
      const before = JSON.parse(JSON.stringify(baseFields));
      adCopyUpdateVariantPatch(baseFields, {
        variantId: "v1",
        headline: "edited",
      });
      expect(baseFields).toEqual(before);
    });
  });
});
