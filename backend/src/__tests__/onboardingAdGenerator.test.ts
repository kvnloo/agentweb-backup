import {
  extractBrandContext,
  extractOnboardingContext,
  generateAdVariants,
} from "../services/onboardingAdGenerator";

// Lightweight stand-in for LLMService that satisfies the shape generateAdVariants
// expects. We only need generateJSONContent.
class FakeLlm {
  public lastSystemPrompt = "";
  public lastUserPrompt = "";
  public lastFormat = "";

  constructor(
    private readonly response: unknown,
    private readonly throwError?: Error,
  ) {}

  async generateJSONContent<T = unknown>(
    system: string,
    user: string,
    format: "json" | "xml" = "json",
  ): Promise<T> {
    this.lastSystemPrompt = system;
    this.lastUserPrompt = user;
    this.lastFormat = format;
    if (this.throwError) throw this.throwError;
    return this.response as T;
  }
}

describe("onboardingAdGenerator", () => {
  describe("extractOnboardingContext", () => {
    it("returns empty object when events array is undefined", () => {
      expect(extractOnboardingContext(undefined)).toEqual({});
    });

    it("returns empty object when events array is empty", () => {
      expect(extractOnboardingContext([])).toEqual({});
    });

    it("picks channel + adGoal from the most recent channel_selected event", () => {
      const events = [
        { event: "channel_selected", ts: "2026-04-24T10:00:00Z", data: { channel: "meta", adGoal: "page_views" } },
        { event: "channel_selected", ts: "2026-04-24T10:05:00Z", data: { channel: "linkedin", adGoal: "demo" } },
      ];
      expect(extractOnboardingContext(events)).toEqual({
        channel: "linkedin",
        adGoal: "demo",
        icp: undefined,
        valuePropOverride: undefined,
      });
    });

    it("picks value_prop_edited override and icp_selected when present", () => {
      const events = [
        { event: "channel_selected", ts: "2026-04-24T10:00:00Z", data: { channel: "meta", adGoal: "demo" } },
        { event: "icp_selected", ts: "2026-04-24T10:01:00Z", data: { icp: "VP of Eng at 50-500 person SaaS" } },
        { event: "value_prop_edited", ts: "2026-04-24T10:02:00Z", data: { value: "Ship 5x faster with zero meetings" } },
      ];
      expect(extractOnboardingContext(events)).toEqual({
        channel: "meta",
        adGoal: "demo",
        icp: "VP of Eng at 50-500 person SaaS",
        valuePropOverride: "Ship 5x faster with zero meetings",
      });
    });
  });

  describe("extractBrandContext", () => {
    it("reads fields from brandGuidelines.brandData when present", () => {
      const user = {
        brandGuidelines: {
          brandData: {
            brandName: "Linear",
            domain: "linear.app",
            tagline: "Linear is the issue tracking tool you'll enjoy using",
            toneOfVoice: "Confident, direct, no jargon",
            valueProposition: "Fast, minimal issue tracking",
            targetAudience: "Software teams",
          },
        },
      };
      expect(extractBrandContext(user)).toEqual({
        companyName: "Linear",
        companyUrl: "linear.app",
        tagline: "Linear is the issue tracking tool you'll enjoy using",
        toneOfVoice: "Confident, direct, no jargon",
        valueProposition: "Fast, minimal issue tracking",
        targetAudience: "Software teams",
      });
    });

    it("falls back to companyName + productDomain when brandGuidelines absent", () => {
      const user = { companyName: "Acme", productDomain: "acme.io" };
      const ctx = extractBrandContext(user);
      expect(ctx.companyName).toBe("Acme");
      expect(ctx.companyUrl).toBe("acme.io");
      expect(ctx.tagline).toBeUndefined();
    });
  });

  describe("generateAdVariants", () => {
    it("returns 3 variants parsed from LLM response", async () => {
      const llm = new FakeLlm({
        variants: [
          { id: "v1", headline: "Hook 1", primaryText: "Body 1", cta: "Book a demo" },
          { id: "v2", headline: "Hook 2", primaryText: "Body 2", cta: "Book a demo" },
          { id: "v3", headline: "Hook 3", primaryText: "Body 3", cta: "Book a demo" },
        ],
      });
      const result = await generateAdVariants(
        { companyName: "Linear" },
        { channel: "linkedin", adGoal: "demo" },
        { llm: llm as any },
      );
      expect(result).toHaveLength(3);
      expect(result[0].id).toBe("v1");
      expect(result[0].headline).toBe("Hook 1");
      expect(result[2].cta).toBe("Book a demo");
    });

    it("caps at MAX_AD_VARIANTS (3) if the LLM returns more", async () => {
      const tooMany = Array.from({ length: 7 }, (_, i) => ({
        id: `v${i + 1}`,
        headline: `h${i}`,
        primaryText: `p${i}`,
        cta: "Learn more",
      }));
      const llm = new FakeLlm({ variants: tooMany });
      const result = await generateAdVariants(
        { companyName: "Acme" },
        { channel: "meta" },
        { llm: llm as any },
      );
      expect(result).toHaveLength(3);
    });

    it("throws when LLM returns malformed response (no variants key)", async () => {
      const llm = new FakeLlm({ something: "else" });
      await expect(
        generateAdVariants({ companyName: "Acme" }, {}, { llm: llm as any }),
      ).rejects.toThrow(/variants/i);
    });

    it("includes channel-specific guidance for LinkedIn in the user prompt", async () => {
      const llm = new FakeLlm({
        variants: [{ id: "v1", headline: "a", primaryText: "b", cta: "Learn more" }],
      });
      await generateAdVariants(
        { companyName: "Acme" },
        { channel: "linkedin", adGoal: "demo" },
        { llm: llm as any },
      );
      expect(llm.lastUserPrompt).toMatch(/LinkedIn/i);
      expect(llm.lastUserPrompt).toMatch(/Book a demo/i);
    });

    it("defaults missing variant ids to v1/v2/v3", async () => {
      const llm = new FakeLlm({
        variants: [
          { headline: "a", primaryText: "b", cta: "Learn more" },
          { headline: "c", primaryText: "d", cta: "Learn more" },
        ],
      });
      const result = await generateAdVariants({}, {}, { llm: llm as any });
      expect(result[0].id).toBe("v1");
      expect(result[1].id).toBe("v2");
    });

    it("propagates LLM errors to the caller", async () => {
      const llm = new FakeLlm(null, new Error("bedrock timeout"));
      await expect(
        generateAdVariants({ companyName: "Acme" }, {}, { llm: llm as any }),
      ).rejects.toThrow(/bedrock timeout/);
    });
  });
});
