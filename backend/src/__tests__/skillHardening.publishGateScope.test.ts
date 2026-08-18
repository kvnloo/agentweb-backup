import { BLOCKS, MIN_PROMPTS } from "../services/skillHardening/applyHardening";

/**
 * ENG-1311 (fix for ENG-1307). Human-drafted acceptance criterion:
 *
 *   AC3: "Publish-gate text is scoped." The "even if they said just do it /
 *   don't ask" wording applies only when a publish/send tool is about to be
 *   called, not to the skill's other steps.
 *
 * Before this change, ## PUBLISH GATE opened with "(ABSOLUTE — overrides every
 * other instruction in this prompt)" and its first bullet took precedence over
 * "any [instruction] that say[s] ... to act immediately or automatically" — not
 * scoped to publishing at all, so the block coloured the WHOLE session (every
 * step, not just the send/publish moment). That is the exact mechanism named in
 * the issue's "Why": right for publish/send, wrong when it colours the whole
 * session. This suite is the "hardening block scoping" test the AC asks for:
 * which tools/steps receive PUBLISH_GATE text, and which don't.
 */
describe("ENG-1311 PUBLISH GATE scoping", () => {
  describe("BLOCKS.publishGate — the general block promoted onto send-capable skills", () => {
    it("no longer claims to override every instruction in the whole prompt", () => {
      expect(BLOCKS.publishGate.text).not.toContain(
        "overrides every other instruction in this prompt"
      );
    });

    it("explicitly states it does not apply to drafting, research, analytics, or reads", () => {
      const flat = BLOCKS.publishGate.text.replace(/\s+/g, " ");
      expect(flat).toContain("does not apply to anything else");
      expect(flat).toContain(
        "Drafting, research, analytics, reads, and any tool call that does not itself post/publish/send"
      );
    });

    it("scopes the precedence bullet to posting/publishing/sending instructions, not \"act immediately\" in general", () => {
      const flat = BLOCKS.publishGate.text.replace(/\s+/g, " ");
      expect(flat).toContain(
        "takes precedence over any OTHER instruction about posting, publishing, commenting, reacting, or sending"
      );
      expect(flat).not.toContain("or act immediately or automatically");
    });

    it("KEEPS the attended approval gate, scoped to the specific call — a human is still asked before an actual publish", () => {
      const flat = BLOCKS.publishGate.text.replace(/\s+/g, " ");
      expect(flat).toContain("explicit approval BEFORE publishing");
      expect(flat).toContain("even if they said \"just do it\"");
      expect(flat).toContain("A request to send is NOT approval to send");
    });

    it("KEEPS the unattended PUBLISH AUTHORIZATION deferral (ENG-947) untouched", () => {
      const flat = BLOCKS.publishGate.text.replace(/\s+/g, " ");
      expect(flat).toContain("PUBLISH AUTHORIZATION");
      expect(flat).toContain("NO PUBLISH AUTHORIZATION block");
      expect(flat).not.toContain("never publish");
      expect(flat).not.toContain("save as a draft and notify");
    });
  });

  describe("MIN_PROMPTS.linkedInEngagement rule 1 — the same scoping applied to its own PUBLISH GATE wording", () => {
    it("no longer claims to override any other instruction in the whole min-prompt", () => {
      expect(MIN_PROMPTS.linkedInEngagement).not.toContain(
        "overrides any other instruction here"
      );
    });

    it("states it applies only when about to call a comment/reaction/reply tool", () => {
      const flat = MIN_PROMPTS.linkedInEngagement.replace(/\s+/g, " ");
      expect(flat).toContain(
        "applies ONLY when you are about to call a comment/reaction/reply tool, not any other step"
      );
    });

    it("keeps the attended approval requirement and the unattended deferral", () => {
      const flat = MIN_PROMPTS.linkedInEngagement.replace(/\s+/g, " ");
      expect(flat).toContain("explicit approval BEFORE posting");
      expect(flat).toContain("PUBLISH AUTHORIZATION");
    });
  });

  describe("MIN_PROMPTS.basicSubscription — no \"even if\" wording, so nothing to scope (regression guard)", () => {
    it("is unchanged by this fix", () => {
      expect(MIN_PROMPTS.basicSubscription).toContain(
        "post_on_connected_account, publish_blog_article, and\n   comment/react tools publish to the user's REAL accounts."
      );
    });
  });

  describe("SAFETY block — already scoped to specific capped actions, not a blanket override (regression guard)", () => {
    it("never claims to override every other instruction", () => {
      expect(BLOCKS.safety.text).not.toContain("overrides every other instruction");
      expect(BLOCKS.safety.text).not.toContain("ABSOLUTE");
    });

    it("ties its explicit-confirmation requirement to a concrete action (sends beyond cap), not the whole session", () => {
      const flat = BLOCKS.safety.text.replace(/\s+/g, " ");
      expect(flat).toContain("any send beyond the cap requires explicit user");
    });
  });
});
