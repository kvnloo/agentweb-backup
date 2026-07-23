/**
 * LLM-backed onboarding outreach invite drafting.
 *
 * The whole point of this service is that the ADMIN-EDITABLE system prompt is
 * what the model is actually composed with (AC #3) — an admin edit must change
 * the drafts, with no deploy. It also owns the hard guardrails the model
 * cannot be trusted to honour: the per-account LinkedIn char limit and the
 * no-emoji rule (AC #2), enforced server-side regardless of the prompt.
 *
 * Char limit is per ACCOUNT, not a constant: LinkedIn allows 300 chars on a
 * Premium account and 200 on a free one. Drafting to 300 for a free account
 * means the note the user reviewed gets silently cut at send time, so the
 * limit is threaded in and defaults to the free (safe) value.
 *
 * The LLM is injected so these tests never hit Bedrock.
 */

const mockGetPrompt = jest.fn();
jest.mock("../services/outreachInvitePromptService", () => ({
  getOutreachInvitePrompt: (...args: any[]) => mockGetPrompt(...args),
}));

import {
  generateInviteDrafts,
  sanitizeInvite,
  DEFAULT_INVITE_CHAR_LIMIT,
} from "../services/outreachInviteDraftService";
import { LinkedInOutreachService } from "../services/linkedInOutreachService";

const PROSPECTS = [
  { id: "p-1", name: "Jane Doe", company: "Acme Schools", title: "Director" },
  { id: "p-2", name: "John Smith", company: "BetaCo Academy" },
];

const CTX = {
  brandName: "Acme Outbound",
  icpName: "program directors",
  specs: "K-5, Bay Area",
};

const ROW = {
  templateId: "onboarding-outreach-invite",
  version: "v3-2026-07-13",
  systemPrompt: "ADMIN EDITED SYSTEM PROMPT",
  withCompanyVariants: ["Hi {firstName} at {company}"],
  withoutCompanyVariants: ["Hi {firstName}"],
  updatedAt: "2026-07-13T00:00:00Z",
  updatedBy: "admin-1",
};

/** An LLM stub that returns a well-formed batch. */
function okLlm(messages: Record<string, string>) {
  return {
    generateJsonRobust: jest.fn().mockResolvedValue({
      drafts: Object.entries(messages).map(([prospectId, message]) => ({
        prospectId,
        message,
      })),
    }),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetPrompt.mockResolvedValue(ROW);
});

describe("char limit defaults", () => {
  it("defaults to the FREE limit so we never over-promise capacity", () => {
    expect(DEFAULT_INVITE_CHAR_LIMIT).toBe(
      LinkedInOutreachService.INVITE_MESSAGE_MAX_CHARS_FREE,
    );
    expect(DEFAULT_INVITE_CHAR_LIMIT).toBe(200);
  });
});

describe("sanitizeInvite (guardrails the prompt cannot override)", () => {
  it("strips emojis an LLM may add despite the prompt", () => {
    expect(sanitizeInvite("Hi Jane 🚀 — great work ✨", 300)).toBe(
      "Hi Jane — great work",
    );
  });

  it("truncates to the limit it is given", () => {
    expect(sanitizeInvite("z".repeat(400), 200).length).toBe(200);
    expect(sanitizeInvite("z".repeat(400), 300).length).toBe(300);
  });

  it("defaults to the free limit when none is supplied", () => {
    expect(sanitizeInvite("z".repeat(400)).length).toBe(200);
  });

  it("cuts on a word boundary, never mid-word", () => {
    // A 200-char hard slice would land inside an "alpha" token.
    const msg = "Hi Jane, " + "alpha ".repeat(40);
    const out = sanitizeInvite(msg, 200);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out.endsWith("alpha")).toBe(true);
    expect(out).not.toMatch(/\s$/);
  });

  it("prefers dropping an incomplete trailing sentence", () => {
    // The first sentence must end past 60% of the budget for the
    // sentence-boundary branch to be honoured (below that we'd throw away too
    // much of the note and fall back to a word cut).
    const first =
      "Hi Jane, I loved what your team shipped at Acme Schools last term and I wanted to reach out directly because it lines up closely with our work.";
    const msg =
      first +
      " This second sentence runs past the limit and should be dropped in full rather than cut mid-way through a word.";
    const out = sanitizeInvite(msg, 200);
    expect(out).toBe(first);
  });

  it("leaves plain typography alone", () => {
    expect(sanitizeInvite("Open to a chat — yes → no", 300)).toBe(
      "Open to a chat — yes → no",
    );
  });
});

describe("generateInviteDrafts", () => {
  it("composes the model with the ADMIN system prompt, not a hardcoded one", async () => {
    const llm = okLlm({ "p-1": "Hi Jane", "p-2": "Hi John" });

    await generateInviteDrafts(PROSPECTS, CTX, { llm });

    expect(llm.generateJsonRobust).toHaveBeenCalledTimes(1);
    const [systemPrompt] = llm.generateJsonRobust.mock.calls[0];
    expect(systemPrompt).toContain("ADMIN EDITED SYSTEM PROMPT");
  });

  it("tells the model the ACTUAL char limit for this account", async () => {
    const llm = okLlm({ "p-1": "Hi Jane", "p-2": "Hi John" });

    await generateInviteDrafts(PROSPECTS, { ...CTX, charLimit: 200 }, { llm });

    const [systemPrompt] = llm.generateJsonRobust.mock.calls[0];
    expect(systemPrompt).toContain("200");
    expect(systemPrompt).not.toContain("300");
  });

  it("passes brand + ICP + specs + each prospect into the user prompt", async () => {
    const llm = okLlm({ "p-1": "Hi Jane", "p-2": "Hi John" });

    await generateInviteDrafts(PROSPECTS, CTX, { llm });

    const [, userPrompt] = llm.generateJsonRobust.mock.calls[0];
    expect(userPrompt).toContain("Acme Outbound");
    expect(userPrompt).toContain("program directors");
    expect(userPrompt).toContain("K-5, Bay Area");
    expect(userPrompt).toContain("Jane Doe");
    expect(userPrompt).toContain("Acme Schools");
    expect(userPrompt).toContain("John Smith");
    // Ids must be in the prompt so the model can key its response back.
    expect(userPrompt).toContain("p-1");
    expect(userPrompt).toContain("p-2");
  });

  it("returns one sanitized draft per prospect, keyed by prospectId", async () => {
    const llm = okLlm({
      "p-1": "Hi Jane, saw Acme's new campus 🚀",
      "p-2": "Hi John, loved the BetaCo post.",
    });

    const out = await generateInviteDrafts(PROSPECTS, CTX, { llm });

    expect(out.promptVersion).toBe("v3-2026-07-13");
    expect(out.charLimit).toBe(DEFAULT_INVITE_CHAR_LIMIT);
    expect(out.drafts).toEqual([
      { prospectId: "p-1", message: "Hi Jane, saw Acme's new campus" },
      { prospectId: "p-2", message: "Hi John, loved the BetaCo post." },
    ]);
  });

  it("enforces the FREE cap when the model ignores it (the common account)", async () => {
    const llm = okLlm({ "p-1": "z".repeat(500), "p-2": "ok" });

    const out = await generateInviteDrafts(PROSPECTS, CTX, { llm });

    const p1 = out.drafts.find((d) => d.prospectId === "p-1");
    expect(p1!.message.length).toBe(200);
  });

  it("allows the full 300 for a Premium account", async () => {
    const llm = okLlm({ "p-1": "z".repeat(500), "p-2": "ok" });

    const out = await generateInviteDrafts(
      PROSPECTS,
      { ...CTX, charLimit: 300 },
      { llm },
    );

    const p1 = out.drafts.find((d) => d.prospectId === "p-1");
    expect(p1!.message.length).toBe(300);
    expect(out.charLimit).toBe(300);
  });

  it("clamps a nonsense charLimit back to a safe value", async () => {
    const llm = okLlm({ "p-1": "z".repeat(500), "p-2": "ok" });

    const out = await generateInviteDrafts(
      PROSPECTS,
      { ...CTX, charLimit: 99999 },
      { llm },
    );

    // Never exceed LinkedIn's absolute maximum.
    expect(out.charLimit).toBe(300);
    const p1 = out.drafts.find((d) => d.prospectId === "p-1");
    expect(p1!.message.length).toBeLessThanOrEqual(300);
  });

  it("drops drafts for prospects that were never requested (model hallucination)", async () => {
    const llm = okLlm({ "p-1": "Hi Jane", "ghost-9": "Hi Nobody" });

    const out = await generateInviteDrafts(PROSPECTS, CTX, { llm });

    expect(out.drafts.map((d) => d.prospectId)).toEqual(["p-1"]);
  });

  it("omits a prospect whose message came back empty rather than emitting a blank", async () => {
    const llm = okLlm({ "p-1": "   ", "p-2": "Hi John" });

    const out = await generateInviteDrafts(PROSPECTS, CTX, { llm });

    expect(out.drafts.map((d) => d.prospectId)).toEqual(["p-2"]);
  });

  it("returns no drafts (never throws) when the LLM fails — the FE keeps its templates", async () => {
    const llm = {
      generateJsonRobust: jest.fn().mockRejectedValue(new Error("bedrock 503")),
    };

    const out = await generateInviteDrafts(PROSPECTS, CTX, { llm });

    expect(out.drafts).toEqual([]);
  });

  it("returns no drafts when the model returns a malformed shape", async () => {
    const llm = {
      generateJsonRobust: jest.fn().mockResolvedValue({ nope: true }),
    };

    const out = await generateInviteDrafts(PROSPECTS, CTX, { llm });

    expect(out.drafts).toEqual([]);
  });

  it("short-circuits without calling the LLM when there are no prospects", async () => {
    const llm = okLlm({});

    const out = await generateInviteDrafts([], CTX, { llm });

    expect(out.drafts).toEqual([]);
    expect(llm.generateJsonRobust).not.toHaveBeenCalled();
  });

  it("caps oversized context + prospect fields so one caller can't inflate the prompt", async () => {
    const llm = okLlm({ big: "Hi there" });
    const huge = "x".repeat(10000);

    await generateInviteDrafts(
      [{ id: "big", name: huge, company: huge, title: huge }],
      { brandName: huge, icpName: huge, specs: huge },
      { llm },
    );

    // The whole user prompt is bounded (all caps + labels), nowhere near the
    // ~60k chars an uncapped 6-field blow-up would produce.
    const userPrompt: string = (llm.generateJsonRobust as jest.Mock).mock
      .calls[0][1];
    expect(userPrompt.length).toBeLessThan(2000);
    // No single run of the padding survives past its field cap (500 = specs, the
    // largest cap).
    expect(/x{501,}/.test(userPrompt)).toBe(false);
    expect(userPrompt).toContain("x".repeat(120)); // a 120-cap field is present
  });
});
