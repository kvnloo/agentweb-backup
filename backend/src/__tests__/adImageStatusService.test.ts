import {
  AD_IMAGE_TIMEOUT_MS,
  adImageFailedPatch,
  adImageReadyPatch,
  adImageSnapshot,
  adImageStartPatch,
  logAdImageCompletionMetric,
  sanitizeAdImageResult,
  MAX_AD_IMAGE_VARIANTS,
} from "../services/adImageStatusService";

const variant = (i: number) => ({
  id: `v${i}`,
  imageUrl: `https://example.com/img-${i}.png`,
  prompt: `prompt-${i}`,
});

describe("adImageStatusService", () => {
  const now = new Date("2026-04-24T12:00:00.000Z");

  it("startPatch returns running and resets fields", () => {
    const patch = adImageStartPatch(now);
    expect(patch.adImageStatus).toBe("running");
    expect(patch.adImageResult).toBeUndefined();
  });

  it("readyPatch returns null when not running (FAIL #1)", () => {
    const r = { variants: [variant(1)] };
    expect(adImageReadyPatch({ adImageStatus: "ready" }, r, now)).toBeNull();
    expect(adImageReadyPatch({ adImageStatus: "idle" }, r, now)).toBeNull();
    expect(adImageReadyPatch({}, r, now)).toBeNull();
  });

  it("readyPatch attaches sanitized variants and computes duration", () => {
    const startedAt = new Date("2026-04-24T11:58:00.000Z");
    const patch = adImageReadyPatch(
      { adImageStatus: "running", adImageStartedAt: startedAt.toISOString() },
      { variants: [variant(1), variant(2), variant(3)] },
      now
    );
    expect(patch).not.toBeNull();
    expect(patch!.adImageStatus).toBe("ready");
    expect(patch!.adImageDurationMs).toBe(120_000);
    expect(patch!.adImageResult!.variants).toHaveLength(3);
  });

  it("readyPatch defaults duration to 0 when startedAt is invalid (FAIL #2)", () => {
    const patch = adImageReadyPatch(
      { adImageStatus: "running", adImageStartedAt: "not-a-date" },
      { variants: [variant(1)] },
      now
    );
    expect(patch!.adImageDurationMs).toBe(0);
  });

  it("failedPatch caps error and uses default message", () => {
    const huge = "x".repeat(2000);
    expect(adImageFailedPatch({ adImageStatus: "running" }, huge, now).adImageError!.length).toBe(
      512
    );
    expect(adImageFailedPatch({ adImageStatus: "running" }, "", now).adImageError).toBe(
      "ad image generation failed"
    );
  });

  it("failedPatch allowed from any state", () => {
    expect(adImageFailedPatch({ adImageStatus: "ready" }, "x", now).adImageStatus).toBe("failed");
    expect(adImageFailedPatch({}, "x", now).adImageStatus).toBe("failed");
  });

  it("snapshot flips timedOut after budget", () => {
    const tooOld = new Date(now.getTime() - AD_IMAGE_TIMEOUT_MS - 1);
    const snap = adImageSnapshot(
      { adImageStatus: "running", adImageStartedAt: tooOld.toISOString() },
      now
    );
    expect(snap.timedOut).toBe(true);
  });

  it("sanitizeAdImageResult drops malformed entries and caps array", () => {
    expect(sanitizeAdImageResult(null).variants).toEqual([]);
    expect(sanitizeAdImageResult({ variants: "nope" }).variants).toEqual([]);
    const many = Array.from({ length: 10 }, (_, i) => variant(i));
    const malformed = [...many, { id: "missing fields" }, null];
    const out = sanitizeAdImageResult({ variants: malformed });
    expect(out.variants.length).toBe(MAX_AD_IMAGE_VARIANTS);
    expect(out.variants[0].id).toBe("v0");
  });

  it("sanitizeAdImageResult truncates overlong fields", () => {
    const huge = "x".repeat(5000);
    const out = sanitizeAdImageResult({
      variants: [{ id: huge, imageUrl: huge, prompt: huge }],
    });
    expect(out.variants[0].id.length).toBeLessThanOrEqual(64);
    expect(out.variants[0].imageUrl.length).toBeLessThanOrEqual(1024);
    expect(out.variants[0].prompt.length).toBeLessThanOrEqual(2000);
  });

  it("metric log line is grep-able", () => {
    const captured: unknown[][] = [];
    const spy = jest
      .spyOn(console, "log")
      .mockImplementation((...args) => captured.push(args));
    logAdImageCompletionMetric("user-abc", "ready", 180_000, 3);
    expect(captured[0][0]).toMatch(
      /^\[metrics\] ad_image_complete status=ready duration_ms=180000 variants=3 user=user-abc$/
    );
    spy.mockRestore();
  });
});
