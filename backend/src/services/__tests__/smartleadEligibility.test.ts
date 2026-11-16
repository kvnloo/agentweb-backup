import { selectSmartleadLeads } from "../smartleadEligibility";
import { campaignStatusDecision, preflightSequence } from "../smartleadPreflight";
import { analyseSequence } from "../smartleadSequence";
import { buildSmartleadMarker, getSmartleadMarker, isMarkedForCampaign, isPushedToSmartlead, smartleadMarkerKey } from "../smartleadMarkers";
import { estimateDaysToSend } from "../smartleadEstimate";
import { realSequencesWithVariants } from "./fixtures/smartleadRealReplies";

const lead = (id: string, over: Record<string, any> = {}) => ({
  leadId: id, email: `${id}@example.com`, firstName: "Ann", company: "Acme", createdAt: "2026-01-01T00:00:00.000Z",
  customFields: { email_validation: { status: "deliverable" } }, ...over,
});
// runStartedAt is required; this default is later than every lead the tests create, so the created-after-start rule stays out of the way.
const ctx = (over: Record<string, any> = {}) => ({ campaignId: 77, tags: ["first_name", "company_name"], mapping: {}, runStartedAt: "2030-01-01T00:00:00Z", ...over });

describe("pushed leads and do-not-contact (ENG-673)", () => {
  it("a lead pushed to Smartlead is NOT do-not-contact: bounce recording and the unsubscribe page rely on isDoNotContact staying as it was", () => {
    const { isDoNotContact } = require("../../utils/leadContactStatus");
    const marker = { state: "pushed", pushedAt: "x", runId: "r", payloadHash: "h" };
    expect(isDoNotContact({ email: "a@b.com", system: { smartlead_77: marker } })).toBe(false);
    expect(isPushedToSmartlead({ system: { smartlead_77: marker } })).toBe(true);
  });
});

describe("selectSmartleadLeads (ENG-673)", () => {
  it("keeps a good lead and builds its payload", () => {
    const r = selectSmartleadLeads([lead("a")], ctx());
    expect(r.eligible).toHaveLength(1);
    expect(r.eligible[0].input).toMatchObject({ email: "a@example.com", first_name: "Ann", company_name: "Acme" });
    expect(r.eligible[0].payloadHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    ["do_not_contact", { contactStatus: "do-not-contact" }],
    ["do_not_contact", { contactStatus: "unsubscribed" }],
    ["do_not_contact", { unsubscribedFromGroupEmail: true }],
    ["undeliverable", { customFields: { email_validation: { status: "undeliverable" } } }],
    ["unverified", { customFields: { email_validation: { status: "risky" } } }],
    ["unverified", { customFields: { email_validation: { status: "unknown" } } }],
    ["unverified", { customFields: {} }],
    ["already_pushed", { system: { smartlead_77: { state: "pushed", pushedAt: "x", runId: "r", payloadHash: "h" } } }],
    ["already_pushed", { system: { smartlead_77: { state: "withdrawn", pushedAt: "x", runId: "r", payloadHash: "h" } } }],
    ["created_after_start", { createdAt: "2026-12-01T00:00:00.000Z" }],
    ["missing_tag", { firstName: "" }],
    ["template_syntax", { company: "{{x}}" }],
    ["no_email", { email: "" }],
  ])("skips a lead as %s", (reason, over) => {
    const r = selectSmartleadLeads([lead("a", over as any)], ctx({ runStartedAt: "2026-06-01T00:00:00.000Z" }));
    expect(r.eligible).toHaveLength(0);
    expect(r.skipped[0].reason).toBe(reason);
    expect(r.counts[reason as keyof typeof r.counts]).toBe(1);
  });

  it("names the tag when a value is missing", () => {
    expect(selectSmartleadLeads([lead("a", { company: "" })], ctx()).skipped[0]).toMatchObject({ reason: "missing_tag", tag: "company_name" });
  });

  it("does not count a lead pushed to ANOTHER campaign, or a released marker, as already pushed", () => {
    const other = lead("a", { system: { smartlead_99: { state: "pushed", pushedAt: "x", runId: "r", payloadHash: "h" } } });
    const released = lead("b", { system: { smartlead_77: { state: "released", pushedAt: "x", runId: "r", payloadHash: "h" } } });
    expect(selectSmartleadLeads([other, released], ctx()).eligible).toHaveLength(2);
  });

  it("leaves out risky, unknown and never-validated leads unless asked", () => {
    const risky = lead("a", { customFields: { email_validation: { status: "risky" } } });
    expect(selectSmartleadLeads([risky], ctx({ includeUnverified: true })).eligible).toHaveLength(1);
    // asking for unverified never lets an undeliverable one through
    const bad = lead("b", { customFields: { email_validation: { status: "undeliverable" } } });
    expect(selectSmartleadLeads([bad], ctx({ includeUnverified: true })).eligible).toHaveLength(0);
  });

  it("catches a duplicate email case-insensitively, keeps the first, and lets a duplicate of a REJECTED lead through", () => {
    const first = lead("a", { email: "Dup@Example.com" });
    const second = lead("b", { email: "dup@example.com" });
    const r = selectSmartleadLeads([first, second], ctx());
    expect(r.eligible.map(e => e.lead.leadId)).toEqual(["a"]);
    expect(r.skipped).toEqual([{ leadId: "b", email: "dup@example.com", reason: "duplicate_in_run" }]);
    const rejected = lead("c", { email: "same@example.com", firstName: "" });
    const later = lead("d", { email: "same@example.com" });
    expect(selectSmartleadLeads([rejected, later], ctx()).eligible.map(e => e.lead.leadId)).toEqual(["d"]);
  });

  it("catches duplicates across batches through a shared set, and keeps the input order", () => {
    const seen = new Set<string>();
    const one = selectSmartleadLeads([lead("c"), lead("a")], ctx({ seenEmails: seen }));
    const two = selectSmartleadLeads([lead("a", { leadId: "z" }), lead("b")], ctx({ seenEmails: seen }));
    expect(one.eligible.map(e => e.lead.leadId)).toEqual(["c", "a"]);
    expect(two.eligible.map(e => e.lead.leadId)).toEqual(["b"]);
    expect(two.counts.duplicate_in_run).toBe(1);
  });

  it("needs no lead value for a tag that is neither standard nor mapped (decided once for the run by the preflight)", () => {
    expect(selectSmartleadLeads([lead("a")], ctx({ tags: ["sender_name"] })).eligible).toHaveLength(1);
  });

  it("reads createdAt as a time, not text: other formats, offsets, numbers and Dates compare correctly", () => {
    const started = "2026-06-01T00:00:00Z";
    const check = (createdAt: unknown) => selectSmartleadLeads([lead("a", { createdAt })], ctx({ runStartedAt: started })).skipped[0]?.reason;
    expect(check("2026-06-01T00:00:00.000Z")).toBeUndefined(); // the same instant, written differently
    expect(check("2026-06-01T05:30:00+05:30")).toBeUndefined(); // 00:00:00Z
    expect(check("2026-06-01T05:29:59+05:30")).toBeUndefined(); // one second before
    expect(check("2026-06-01T05:30:01+05:30")).toBe("created_after_start"); // one second after
  });

  it("skips a lead created after the run started, whatever the type of its createdAt", () => {
    const started = "2026-06-01T00:00:00Z";
    const later = Date.parse("2026-06-02T00:00:00Z");
    for (const createdAt of ["2026-06-02T00:00:00.000Z", "2026-06-02T05:30:00+05:30", later, new Date(later)]) {
      expect(selectSmartleadLeads([lead("a", { createdAt })], ctx({ runStartedAt: started })).skipped[0]?.reason).toBe("created_after_start");
    }
    expect(selectSmartleadLeads([lead("a", { createdAt: Date.parse("2026-05-01T00:00:00Z") })], ctx({ runStartedAt: started })).eligible).toHaveLength(1);
  });

  it("reads a time with no zone as UTC, not as the server's local time", () => {
    const started = "2026-06-01T10:00:00Z";
    const reason = (createdAt: string) => selectSmartleadLeads([lead("a", { createdAt })], ctx({ runStartedAt: started })).skipped[0]?.reason;
    expect(reason("2026-06-01T09:59:59")).toBeUndefined();
    expect(reason("2026-06-01T10:00:01")).toBe("created_after_start");
    expect(reason("2026-05-31")).toBeUndefined();
  });

  it("reads a numeric createdAt in seconds as seconds, and refuses text that is not an ISO date instead of guessing", () => {
    const started = "2026-06-01T00:00:00Z";
    const sec = (iso: string) => Date.parse(iso) / 1000;
    const reason = (createdAt: unknown) => selectSmartleadLeads([lead("a", { createdAt })], ctx({ runStartedAt: started })).skipped[0]?.reason;
    expect(reason(sec("2026-05-01T00:00:00Z"))).toBeUndefined(); // seconds, before the start: an old lead
    expect(reason(sec("2026-07-01T00:00:00Z"))).toBe("created_after_start"); // seconds, after the start
    for (const odd of ["June 2, 2026", "06/02/2026", "tomorrow", "2026"]) expect(reason(odd)).toBe("unknown_creation_time");
  });

  it("allows a lead with no createdAt (an old lead), but fails closed on one whose createdAt cannot be read", () => {
    const base = ctx({ runStartedAt: "2026-06-01T00:00:00Z" });
    expect(selectSmartleadLeads([lead("a", { createdAt: undefined })], base).eligible).toHaveLength(1);
    for (const createdAt of ["not a date", {}, NaN]) {
      expect(selectSmartleadLeads([lead("a", { createdAt })], base).skipped[0]?.reason).toBe("unknown_creation_time");
    }
  });

  it("an opted-out address stops every record with that address, before or after it in the batch and in later batches", () => {
    const optedOut = lead("a", { email: "same@example.com", contactStatus: "do-not-contact" });
    const before = lead("b", { email: "SAME@example.com" });
    const r = selectSmartleadLeads([before, optedOut], ctx());
    expect(r.eligible).toHaveLength(0);
    expect(r.counts.do_not_contact).toBe(2);
    const suppressed = new Set<string>();
    selectSmartleadLeads([optedOut], ctx({ suppressedEmails: suppressed }));
    expect(selectSmartleadLeads([lead("c", { email: "same@example.com" })], ctx({ suppressedEmails: suppressed })).skipped[0].reason).toBe("do_not_contact");
  });

  it("reports markup and over-long values with their own reason", () => {
    expect(selectSmartleadLeads([lead("a", { company: "<b>x</b>" })], ctx()).skipped[0]).toMatchObject({ reason: "unsafe_text", tag: "company_name" });
  });
});

describe("the unsubscribe-link warning (verified with received emails, 2026-10-28)", () => {
  const seq = (body: string) => analyseSequence([{ seq_number: 1, subject: "Hi {{first_name}}", email_body: body }]);
  const warned = (body: string, opts: Record<string, unknown>) => preflightSequence(seq(body), { status: "DRAFTED", mapping: {}, ...opts }).warnings.some(w => w.code === "no_unsubscribe");

  it("warns when the setting is on but the footer text is empty: Smartlead then adds no link", () => {
    expect(warned("<p>Hi</p>", { addUnsubscribeTag: true, unsubscribeText: null })).toBe(true);
    expect(warned("<p>Hi</p>", { addUnsubscribeTag: true, unsubscribeText: "   " })).toBe(true);
  });

  it("does not warn when the setting is on and the footer text is set", () => {
    expect(warned("<p>Hi</p>", { addUnsubscribeTag: true, unsubscribeText: "Unsubscribe here" })).toBe(false);
  });

  it("still warns when the setting is off, and does not guess when Smartlead did not say", () => {
    expect(warned("<p>Hi</p>", { addUnsubscribeTag: false })).toBe(true);
    expect(warned("<p>Hi</p>", { addUnsubscribeTag: true })).toBe(false); // text unknown: no claim either way
    expect(warned("<p>Hi</p>", {})).toBe(false);
  });

  it("an unsubscribe-like tag silences the 'setting off' warning, but NOT the 'empty footer text' one (that it renders a link is unverified)", () => {
    expect(warned("<p>Hi {{unsubscribe_link}}</p>", { addUnsubscribeTag: false })).toBe(false);
    expect(warned("<p>Hi {{unsubscribe_link}}</p>", { addUnsubscribeTag: true, unsubscribeText: null })).toBe(true);
  });
});

describe("campaignStatusDecision and preflightSequence", () => {
  const real = analyseSequence(realSequencesWithVariants);

  it("allows DRAFTED and PAUSED, asks for confirmation on ACTIVE, refuses the rest and anything unknown", () => {
    expect(["DRAFTED", "drafted", " paused "].map(campaignStatusDecision)).toEqual(["allowed", "allowed", "allowed"]);
    expect(campaignStatusDecision("ACTIVE")).toBe("needs_confirmation");
    for (const s of ["STOPPED", "ARCHIVED", "COMPLETED", "DRAFT", "", "WAT", undefined, null, 5, {}]) expect(campaignStatusDecision(s)).toBe("refused");
  });

  it("does not throw on a missing status and applies the stricter (ACTIVE) rules to it", () => {
    const empty = analyseSequence([]);
    expect(() => preflightSequence(empty, { status: undefined, mapping: {} })).not.toThrow();
    expect(preflightSequence(empty, { status: undefined, mapping: {} }).blocks[0].code).toBe("empty");
  });

  it("passes a real A/B-variant sequence that uses only standard tags", () => {
    for (const status of ["DRAFTED", "ACTIVE"]) {
      const r = preflightSequence(real, { status, mapping: {} });
      expect(r.blocks).toEqual([]);
      expect(r.warnings).toEqual([]);
    }
  });

  it("blocks an unreadable sequence only for an ACTIVE campaign, unless acknowledged, and records the acknowledgement", () => {
    const bad = analyseSequence({ message: "?" });
    expect(preflightSequence(bad, { status: "ACTIVE", mapping: {} }).blocks[0].code).toBe("unreadable");
    expect(preflightSequence(bad, { status: "DRAFTED", mapping: {} })).toMatchObject({ blocks: [], warnings: [{ code: "unreadable" }] });
    expect(preflightSequence(bad, { status: "ACTIVE", mapping: {}, acknowledgeUnreadable: true })).toMatchObject({ blocks: [], warnings: [{ code: "unreadable" }] });
  });

  it("blocks an empty sequence only for an ACTIVE campaign", () => {
    const empty = analyseSequence([]);
    expect(preflightSequence(empty, { status: "ACTIVE", mapping: {} }).blocks[0].code).toBe("empty");
    expect(preflightSequence(empty, { status: "DRAFTED", mapping: {} }).warnings[0].code).toBe("empty");
  });

  it("blocks near-miss and unknown tags for EVERY status and lists the ones to map", () => {
    const seq = analyseSequence([{ seq_number: 1, subject: "Hi {{First_Name}}", email_body: "{{industry}} {{signature}}", sequence_variants: [] }]);
    const r = preflightSequence(seq, { status: "DRAFTED", mapping: { industry: "customFields.industry" } });
    expect(r.blocks.map(b => [b.code, b.tag])).toEqual([["near_miss_tag", "First_Name"], ["unknown_tag", "signature"]]);
    expect(r.tagsToMap).toEqual(["signature"]);
    expect(preflightSequence(seq, { status: "DRAFTED", mapping: { industry: "customFields.industry" }, acknowledgedTags: ["signature"] }).blocks.map(b => b.code)).toEqual(["near_miss_tag"]);
  });

  it("warns about spintax and about a campaign with no unsubscribe tag", () => {
    const seq = analyseSequence([{ seq_number: 1, subject: "{Hi|Hello} {{first_name}}", email_body: "x", sequence_variants: [] }]);
    const codes = preflightSequence(seq, { status: "PAUSED", mapping: {}, addUnsubscribeTag: false }).warnings.map(w => w.code);
    expect(codes).toEqual(["spintax", "no_unsubscribe"]);
    expect(preflightSequence(seq, { status: "PAUSED", mapping: {}, addUnsubscribeTag: true }).warnings.map(w => w.code)).toEqual(["spintax"]);
  });
});

describe("markers", () => {
  it("uses one flat key per campaign", () => {
    expect(smartleadMarkerKey(4251616)).toBe("smartlead_4251616");
  });

  it("reads a marker, treats a released one as not marked, and ignores other system keys", () => {
    const m = buildSmartleadMarker({ runId: "r1", payloadHash: "h", smartleadLeadId: "9001", now: new Date("2026-10-27T00:00:00Z") });
    expect(m).toEqual({ pushedAt: "2026-10-27T00:00:00.000Z", runId: "r1", smartleadLeadId: "9001", payloadHash: "h", state: "pushed" });
    const l = { system: { smartlead_5: m, findReason: "x", smartlead_6: { state: "released" } } };
    expect(getSmartleadMarker(l, 5)).toEqual(m);
    expect(isMarkedForCampaign(l, 5)).toBe(true);
    expect(isMarkedForCampaign(l, 6)).toBe(false);
    expect(isMarkedForCampaign(l, 7)).toBe(false);
    expect(isMarkedForCampaign(null, 5)).toBe(false);
  });

  it("isPushedToSmartlead is true for any live marker and false for none, released only, or other keys", () => {
    expect(isPushedToSmartlead({ system: { smartlead_5: { state: "pushed" } } })).toBe(true);
    expect(isPushedToSmartlead({ system: { smartlead_5: { state: "withdrawn" } } })).toBe(true);
    expect(isPushedToSmartlead({ system: { smartlead_5: { state: "released" } } })).toBe(false);
    expect(isPushedToSmartlead({ system: { findReason: "x", smartlead_note: "text" } })).toBe(false);
    expect(isPushedToSmartlead({})).toBe(false);
    expect(isPushedToSmartlead(undefined)).toBe(false);
  });
});

describe("estimateDaysToSend", () => {
  it("adds the mailbox limits, caps by the campaign's daily maximum, and rounds days up", () => {
    expect(estimateDaysToSend({ leads: 8000, mailboxLimits: Array(10).fill(30) })).toEqual({ perDay: 300, days: 27 });
    expect(estimateDaysToSend({ leads: 8000, mailboxLimits: Array(10).fill(30), campaignMaxLeadsPerDay: 100 })).toEqual({ perDay: 100, days: 80 });
  });
  it("says nothing when no mailbox limit is known or there is nothing to send", () => {
    expect(estimateDaysToSend({ leads: 100, mailboxLimits: [undefined] })).toBeUndefined();
    expect(estimateDaysToSend({ leads: 0, mailboxLimits: [30] })).toBeUndefined();
  });
});
