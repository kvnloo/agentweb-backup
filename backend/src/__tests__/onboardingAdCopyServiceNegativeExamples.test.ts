/**
 * Unit tests for the negative-examples block builder used in regen prompts.
 *
 * Pure-string output — no LLM, no DB. The function reads the user's
 * `adVariantsRated` log + the previous `adCopyResult.variants`, picks the
 * latest 5 rejects, and emits a prompt section the LLM can read as
 * "don't repeat these directions".
 */

import { buildNegativeExamplesBlock } from "../services/onboardingAdCopyService";

describe("buildNegativeExamplesBlock", () => {
  it("returns empty string when there are no ratings", () => {
    expect(
      buildNegativeExamplesBlock({}, [
        { id: "v1", headline: "h", primaryText: "p", variety: "Pain" },
      ])
    ).toBe("");
  });

  it("returns empty string when no rejects (only likes)", () => {
    expect(
      buildNegativeExamplesBlock(
        {
          adVariantsRated: [
            {
              variantId: "v1",
              rating: "like",
              ratedAt: "2026-04-24T00:00:00Z",
            },
          ],
        },
        [{ id: "v1", headline: "h", primaryText: "p" }]
      )
    ).toBe("");
  });

  it("includes rejected variants with headline + primaryText + variety", () => {
    const block = buildNegativeExamplesBlock(
      {
        adVariantsRated: [
          {
            variantId: "v1",
            rating: "reject",
            ratedAt: "2026-04-24T00:00:00Z",
          },
        ],
      },
      [
        {
          id: "v1",
          headline: "Generic SaaS headline",
          primaryText: "Some boring corporate tone",
          variety: "Social Proof Led",
        },
      ]
    );
    expect(block).toContain("Generic SaaS headline");
    expect(block).toContain("Some boring corporate tone");
    expect(block).toContain("[Social Proof Led]");
    expect(block).toMatch(/REJECTED/i);
  });

  it("drops rejects whose variantId is no longer in previousVariants", () => {
    const block = buildNegativeExamplesBlock(
      {
        adVariantsRated: [
          {
            variantId: "missing",
            rating: "reject",
            ratedAt: "2026-04-24T00:00:00Z",
          },
        ],
      },
      [{ id: "v1", headline: "h", primaryText: "p" }]
    );
    expect(block).toBe("");
  });

  it("limits to the 5 most recent rejects", () => {
    const ratings = Array.from({ length: 8 }).map((_, i) => ({
      variantId: `v${i}`,
      rating: "reject" as const,
      ratedAt: `2026-04-24T00:00:0${i}Z`,
    }));
    const previous = ratings.map((r) => ({
      id: r.variantId,
      headline: `H-${r.variantId}`,
      primaryText: `P-${r.variantId}`,
    }));
    const block = buildNegativeExamplesBlock(
      { adVariantsRated: ratings },
      previous,
      5
    );
    // Latest five (v3..v7) should appear; oldest two (v0, v1) should not.
    expect(block).toContain("H-v7");
    expect(block).toContain("H-v3");
    expect(block).not.toContain("H-v0");
    expect(block).not.toContain("H-v1");
  });

  it("truncates very long primaryText / headline so prompt stays bounded", () => {
    const longHeadline = "A".repeat(500);
    const longBody = "B".repeat(2000);
    const block = buildNegativeExamplesBlock(
      {
        adVariantsRated: [
          {
            variantId: "v1",
            rating: "reject",
            ratedAt: "2026-04-24T00:00:00Z",
          },
        ],
      },
      [{ id: "v1", headline: longHeadline, primaryText: longBody }]
    );
    // Headline truncated to 100, body to 200.
    expect(block).toContain("A".repeat(100));
    expect(block).not.toContain("A".repeat(101));
    expect(block).toContain("B".repeat(200));
    expect(block).not.toContain("B".repeat(201));
  });
});
