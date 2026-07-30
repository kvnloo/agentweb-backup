import {
  hasEmptyPrompt,
  powerToolsOf,
  needsSafetyBlock,
  isSendName,
  isPublishName,
} from "../utils/hardeningGaps";
import { EXTERNAL_SEND_TOOLS, EXTERNAL_PUBLISH_TOOLS } from "../services/agentToolGatewayService";

describe("hardeningGaps", () => {
  it("hasEmptyPrompt flags empty and whitespace-only prompts", () => {
    expect(hasEmptyPrompt({ systemPrompt: "" })).toBe(true);
    expect(hasEmptyPrompt({ systemPrompt: "   \n" })).toBe(true);
    expect(hasEmptyPrompt({ systemPrompt: undefined })).toBe(true);
    expect(hasEmptyPrompt({ systemPrompt: "You are Emma." })).toBe(false);
  });

  it("powerToolsOf returns only the high-power tools a skill holds", () => {
    expect(
      powerToolsOf({ toolNames: ["read_brand_guidelines", "linkedin_outreach", "send_email_to_lead"] }),
    ).toEqual(["linkedin_outreach", "send_email_to_lead"]);
    expect(powerToolsOf({ toolNames: ["read_brand_guidelines"] })).toEqual([]);
  });

  it("needsSafetyBlock: power tool present but no SAFETY block -> true", () => {
    expect(
      needsSafetyBlock({ toolNames: ["linkedin_outreach"], systemPrompt: "do outreach" }),
    ).toBe(true);
  });

  it("needsSafetyBlock: SAFETY block already present -> false", () => {
    expect(
      needsSafetyBlock({
        toolNames: ["linkedin_outreach"],
        systemPrompt: "do outreach\n\n## SAFETY & VOLUME LIMITS\n- caps...",
      }),
    ).toBe(false);
  });

  it("needsSafetyBlock: a PUBLISH GATE also covers the gap -> false", () => {
    expect(
      needsSafetyBlock({
        toolNames: ["post_on_connected_account"],
        systemPrompt: "post stuff\n\n## PUBLISH GATE\n- approval before publishing",
      }),
    ).toBe(false);
  });

  it("needsSafetyBlock: the post_on_account MCP alias is treated as a publisher", () => {
    // No gate at all -> gap.
    expect(needsSafetyBlock({ toolNames: ["post_on_account"], systemPrompt: "post" })).toBe(true);
    // A publish gate covers it (publish-power, not send-volume).
    expect(
      needsSafetyBlock({
        toolNames: ["post_on_account"],
        systemPrompt: "post\n\n## PUBLISH GATE\napprove first",
      }),
    ).toBe(false);
  });

  it("needsSafetyBlock: a SEND tool is NOT covered by a bare PUBLISH GATE -> true", () => {
    // send_email_to_lead carries volume risk the publish gate does not govern.
    expect(
      needsSafetyBlock({
        toolNames: ["send_email_to_lead"],
        systemPrompt: "email leads\n\n## PUBLISH GATE\n- approval before publishing",
      }),
    ).toBe(true);
  });

  it("needsSafetyBlock: a SEND tool WITH the SAFETY block -> false", () => {
    expect(
      needsSafetyBlock({
        toolNames: ["send_email_to_lead"],
        systemPrompt: "email leads\n\n## SAFETY & VOLUME LIMITS\n- 25 emails max",
      }),
    ).toBe(false);
  });

  it("needsSafetyBlock: no power tool -> false regardless of prompt", () => {
    expect(needsSafetyBlock({ toolNames: ["read_brand_guidelines"], systemPrompt: "" })).toBe(false);
  });

  it("recognizes every canonical external send/publish tool (drift guard)", () => {
    // Keeps the detector a superset of agentToolGatewayService's authoritative
    // classification — if a tool is added there, this fails until we cover it.
    for (const t of EXTERNAL_SEND_TOOLS) {
      expect({ tool: t, recognized: isSendName(t) || isPublishName(t) }).toEqual({ tool: t, recognized: true });
    }
    for (const t of EXTERNAL_PUBLISH_TOOLS) {
      expect({ tool: t, recognized: isPublishName(t) || isSendName(t) }).toEqual({ tool: t, recognized: true });
    }
  });

  it("recognizes send_email and publish_landing_page_changes (Greptile-flagged)", () => {
    expect(needsSafetyBlock({ toolNames: ["send_email"], systemPrompt: "email people" })).toBe(true);
    expect(needsSafetyBlock({ toolNames: ["publish_landing_page_changes"], systemPrompt: "ship it" })).toBe(true);
    // publish_landing_page_changes is publish-power, so a publish gate covers it.
    expect(
      needsSafetyBlock({ toolNames: ["publish_landing_page_changes"], systemPrompt: "## PUBLISH GATE" }),
    ).toBe(false);
    // send_email is send-power, so a bare publish gate does NOT cover it.
    expect(needsSafetyBlock({ toolNames: ["send_email"], systemPrompt: "## PUBLISH GATE" })).toBe(true);
  });

  it("prefix families catch future send/publish tools", () => {
    expect(isPublishName("publish_something_new")).toBe(true);
    expect(isPublishName("post_on_mastodon")).toBe(true);
    expect(isSendName("send_email_blast")).toBe(true);
    expect(isSendName("reddit_outreach")).toBe(true);
    // benign internal look-alikes are excluded
    expect(isSendName("send_for_review")).toBe(false);
  });

  it("needsSafetyBlock: high-power tools that previously escaped detection are caught", () => {
    // Each of these carries publish/send/destructive effect and needs the SAFETY block.
    for (const tool of [
      "twitter_manage_post",   // posts threads + deletes at volume
      "twitter_outreach",      // X DMs / outreach
      "send_email_from_sender",
      "delete_leads",
      "delete_lead_list",
    ]) {
      expect(needsSafetyBlock({ toolNames: [tool], systemPrompt: "do stuff" })).toBe(true);
      // ...and a bare PUBLISH GATE does NOT cover their volume/destructive risk.
      expect(
        needsSafetyBlock({ toolNames: [tool], systemPrompt: "## PUBLISH GATE\napprove first" }),
      ).toBe(true);
    }
  });
});
