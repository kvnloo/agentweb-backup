import {
  LAUNCH_CHANNELS,
  buildTrackedLink,
  classifyAcquisitionSource,
  summarizeFunnel,
} from "../services/zomaChannelAttribution";

describe("ENG-2886 Zoma channel attribution", () => {
  it("a test visit through each channel's tracked link is attributed to that channel", () => {
    const links = new Set<string>();
    for (const channel of LAUNCH_CHANNELS) {
      const link = buildTrackedLink("https://zoma.ai/?x=1", channel);
      links.add(link);
      const params = new URL(link).searchParams;
      expect(params.get("x")).toBe("1");
      expect(
        classifyAcquisitionSource({
          utm_source: params.get("utm_source"),
          utm_medium: params.get("utm_medium"),
        }),
      ).toBe(channel);
    }
    expect(links.size).toBe(LAUNCH_CHANNELS.length);
  });

  it("utm_content makes per-founder links unique without changing the channel", () => {
    const a = buildTrackedLink("https://zoma.ai", "founder_referral", { content: "Matt S" });
    const b = buildTrackedLink("https://zoma.ai", "founder_referral", { content: "Fangfang" });
    expect(a).not.toBe(b);
    expect(new URL(a).searchParams.get("utm_content")).toBe("matt-s");
  });

  it("rejects unknown channels", () => {
    expect(() => buildTrackedLink("https://zoma.ai", "tiktok" as never)).toThrow();
  });

  it("explicit tags beat referrer, aliases normalize, falls back to referrer/direct", () => {
    expect(classifyAcquisitionSource({ utm_source: "email", referrer: "https://t.co/abc" })).toBe("email");
    expect(classifyAcquisitionSource({ utm_source: "Twitter" })).toBe("x");
    expect(classifyAcquisitionSource({ ref: "producthunt" })).toBe("product_hunt");
    expect(classifyAcquisitionSource({ referrer: "https://www.linkedin.com/feed" })).toBe("linkedin");
    expect(classifyAcquisitionSource({ referrer: "https://news.ycombinator.com" })).toBe("other");
    expect(classifyAcquisitionSource({ utm_source: "billboard" })).toBe("other");
    expect(classifyAcquisitionSource({ referrer: "not a url" })).toBe("other");
    expect(classifyAcquisitionSource({})).toBe("direct");
  });

  it("funnel counts each account once (first touch) with no double counting", () => {
    const summary = summarizeFunnel([
      { accountId: "a", channel: "linkedin", signedUp: false, firstAdLaunched: false },
      { accountId: "a", channel: "x", signedUp: true, firstAdLaunched: true },
      { accountId: "b", channel: "x", signedUp: true, firstAdLaunched: false },
      { accountId: "c", channel: "x", signedUp: false, firstAdLaunched: true },
    ]);
    expect(summary.linkedin).toEqual({ visitors: 1, signups: 1, firstAds: 1 });
    expect(summary.x).toEqual({ visitors: 2, signups: 1, firstAds: 0 });
    const total = Object.values(summary).reduce((n, f) => n + f.visitors, 0);
    expect(total).toBe(3);
  });
});
