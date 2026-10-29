import { FIRST_PUSH_COHORT, PREVIEW_MAX_LEADS, PreviewError, buildPreview, type PreviewDeps } from "../smartleadPushPreview";
import { verifyPushToken } from "../smartleadPushToken";
import { smartleadMarkerKey } from "../smartleadMarkers";
import { preflightSequence } from "../smartleadPreflight";

const SEQ = [{ seq_number: 1, subject: "Hi {{first_name}}", email_body: "<p>{{first_name}} at {{company_name}}</p>" }];
const lead = (n: number, over: Record<string, any> = {}) => ({
  leadId: `lead_${String(n).padStart(6, "0")}`, email: `p${n}@example.com`, firstName: `N${n}`, company: "Acme", createdAt: "2020-01-01T00:00:00.000Z",
  customFields: { email_validation: { status: "deliverable" } }, ...over,
});

function deps(leads: any[], over: Partial<PreviewDeps> = {}, campaign: any = { id: 77, name: "Q4", status: "DRAFTED", maxLeadsPerDay: 100, addUnsubscribeTag: true }): PreviewDeps {
  return {
    readLeads: async (_l, after, limit) => { const start = after ? leads.findIndex(x => x.leadId === after.leadId) + 1 : 0; return { items: leads.slice(start, start + limit), hasMore: start + limit < leads.length }; },
    getCampaign: async () => campaign,
    getSequences: async () => SEQ,
    getCampaignMailboxes: async () => [{ id: 1, email: "a@x.com", dailyLimit: 30 }, { id: 2, email: "b@x.com", dailyLimit: 30 }],
    now: () => new Date("2026-10-28T10:00:00Z"),
    secret: "test-secret",
    ...over,
  };
}
const req = (over: Record<string, any> = {}) => ({ listId: "L", campaignId: 77, userId: "u1", accountId: "smartlead-u1", ...over });

describe("buildPreview (ENG-673)", () => {
  it("evaluates the whole list, counts every skip reason, and shows what would be sent for three real leads", async () => {
    const leads = [lead(1), lead(2, { email: "" }), lead(3, { contactStatus: "do-not-contact" }), lead(4, { customFields: {} }), lead(5), lead(6), lead(7), lead(8, { system: { [smartleadMarkerKey(77)]: { state: "pushed" } } })];
    const p = await buildPreview(deps(leads), req());
    expect(p.list).toMatchObject({ total: 8, eligible: 4, alreadyPushed: 1, skipped: { no_email: 1, do_not_contact: 1, unverified: 1, already_pushed: 1 } });
    expect(p.samples).toHaveLength(3);
    expect(p.samples[0]).toEqual({ email: "p1@example.com", sends: expect.objectContaining({ email: "p1@example.com", first_name: "N1", company_name: "Acme" }) });
    expect(p.campaign).toEqual({ id: 77, name: "Q4", status: "DRAFTED" });
    expect(p.sequence.tags).toEqual(["first_name", "company_name"]);
    expect(p.canStart).toBe(true);
    expect(p.requiresActiveConfirmation).toBe(false);
  });

  it("defaults the first push into a campaign to a 50-lead test cohort and offers all of it", async () => {
    const leads = Array.from({ length: 120 }, (_, i) => lead(i + 1));
    const p = await buildPreview(deps(leads), req());
    expect(p.cohort).toEqual({ chosen: FIRST_PUSH_COHORT, suggested: FIRST_PUSH_COHORT, max: 120 });
    const all = await buildPreview(deps(leads), req({ cohort: 120 }));
    expect(all.cohort.chosen).toBe(120);
    expect(verifyPushToken("test-secret", all.token, Date.parse("2026-10-28T10:00:00Z"))!.eligible).toBe(120);
    expect(verifyPushToken("test-secret", p.token, Date.parse("2026-10-28T10:00:00Z"))!.eligible).toBe(50);
  });

  it("fingerprints WHICH contacts go to WHICH connection: the same counts with different contacts, another connection or another cohort differ", async () => {
    const a = Array.from({ length: 5 }, (_, i) => lead(i + 1));
    const base = await buildPreview(deps(a), req());
    expect(base.fingerprint).toMatch(/^[0-9a-f]{32}$/);
    expect((await buildPreview(deps(a), req())).fingerprint).toBe(base.fingerprint); // stable
    const swapped = [lead(1), lead(2), lead(3), lead(4), lead(6)]; // same count, one different contact
    expect((await buildPreview(deps(swapped), req())).fingerprint).not.toBe(base.fingerprint);
    expect((await buildPreview(deps(a), req({ accountId: "smartlead-u2" }))).fingerprint).not.toBe(base.fingerprint);
    expect((await buildPreview(deps(a), req({ cohort: 3 }))).fingerprint).not.toBe(base.fingerprint);
    // contacts beyond the cohort do not matter: the cohort is the first N eligible ones
    const grown = [...a, lead(9)];
    expect((await buildPreview(deps(grown), req({ cohort: 5 }))).fingerprint).toBe(base.fingerprint);
  });

  it("never offers more than is eligible, and defaults to everything once leads are already in the campaign", async () => {
    const leads = [...Array.from({ length: 80 }, (_, i) => lead(i + 1)), lead(500, { system: { [smartleadMarkerKey(77)]: { state: "pushed" } } })];
    expect((await buildPreview(deps(leads), req({ cohort: 9999 }))).cohort.chosen).toBe(80);
    expect((await buildPreview(deps(leads), req())).cohort.chosen).toBe(80); // not a first push
  });

  it("estimates days to send from the smaller of the mailbox limits and the campaign's own cap, and survives a failed mailbox read", async () => {
    const leads = Array.from({ length: 10 }, (_, i) => lead(i + 1));
    expect((await buildPreview(deps(leads), req())).estimate).toBeDefined();
    const p = await buildPreview(deps(leads, { getCampaignMailboxes: async () => { throw new Error("boom"); } }), req());
    expect(p.estimate).toBeUndefined();
    expect(p.canStart).toBe(true);
  });

  it("blocks starting while a tag would render blank for every lead, and says which to map", async () => {
    const p = await buildPreview(deps([lead(1)], { getSequences: async () => [{ seq_number: 1, subject: "Hi", email_body: "<p>About {{industry}}</p>" }] }), req());
    expect(p.canStart).toBe(false);
    expect(p.preflight.tagsToMap).toEqual(["industry"]);
    const mapped = await buildPreview(deps([lead(1, { customFields: { industry: "SaaS", email_validation: { status: "deliverable" } } })], { getSequences: async () => [{ seq_number: 1, subject: "Hi", email_body: "<p>About {{industry}}</p>" }] }), req({ mapping: { industry: "customFields.industry" } }));
    expect(mapped.canStart).toBe(true);
    expect(mapped.samples[0].sends).toMatchObject({ custom_fields: { industry: "SaaS" } });
  });

  it("warns that no unsubscribe link will be added when the campaign's footer text is empty, and not when it is set", async () => {
    const base = { id: 77, name: "Q4", status: "DRAFTED", maxLeadsPerDay: 100, addUnsubscribeTag: true };
    const empty = await buildPreview(deps([lead(1)], {}, { ...base, unsubscribeText: null }), req());
    expect(empty.preflight.warnings.map(w => w.code)).toContain("no_unsubscribe");
    const set = await buildPreview(deps([lead(1)], {}, { ...base, unsubscribeText: "Unsubscribe here" }), req());
    expect(set.preflight.warnings.map(w => w.code)).not.toContain("no_unsubscribe");
  });

  it("asks for the unsubscribe acknowledgement only when the campaign is already sending and its emails have no unsubscribe link", async () => {
    const noLink = (status: string, over: any = {}) => deps([lead(1)], {}, { id: 77, name: "Q", status, maxLeadsPerDay: 100, addUnsubscribeTag: false, ...over });
    expect((await buildPreview(noLink("ACTIVE"), req())).requiresUnsubscribeAcknowledgement).toBe(true);
    expect((await buildPreview(noLink("ACTIVE", { addUnsubscribeTag: true, unsubscribeText: "" }), req())).requiresUnsubscribeAcknowledgement).toBe(true); // on, but no footer text
    expect((await buildPreview(noLink("ACTIVE", { addUnsubscribeTag: true, unsubscribeText: "   " }), req())).requiresUnsubscribeAcknowledgement).toBe(true); // whitespace is no text
    expect((await buildPreview(noLink("ACTIVE", { addUnsubscribeTag: true, unsubscribeText: null }), req())).requiresUnsubscribeAcknowledgement).toBe(true); // null: Smartlead has none
    expect((await buildPreview(noLink("ACTIVE", { addUnsubscribeTag: true, unsubscribeText: undefined }), req())).requiresUnsubscribeAcknowledgement).toBe(false); // unknown is not "missing"
    expect((await buildPreview(noLink("DRAFTED"), req())).requiresUnsubscribeAcknowledgement).toBe(false);
    expect((await buildPreview(noLink("PAUSED"), req())).requiresUnsubscribeAcknowledgement).toBe(false);
    expect((await buildPreview(noLink("ACTIVE", { addUnsubscribeTag: true }), req())).requiresUnsubscribeAcknowledgement).toBe(false);
  });

  it("flags a missing unsubscribe link even when the sequence could not be read (the setting is a campaign setting)", () => {
    const unreadable = { readable: false, hasContent: false, tags: [], usesSpintax: false, stepCount: 0, hash: "h" } as any;
    expect(preflightSequence(unreadable, { status: "ACTIVE", mapping: {}, acknowledgeUnreadable: true, addUnsubscribeTag: false }).missingUnsubscribe).toBe(true);
    expect(preflightSequence(unreadable, { status: "ACTIVE", mapping: {}, acknowledgeUnreadable: true, addUnsubscribeTag: true, unsubscribeText: "Unsubscribe" }).missingUnsubscribe).toBe(false);
  });

  it("cannot start with nothing to send", async () => {
    expect((await buildPreview(deps([lead(1, { email: "" })]), req())).canStart).toBe(false);
  });

  it("asks for a separate confirmation when the campaign is already ACTIVE, and refuses archived, stopped and missing campaigns", async () => {
    expect((await buildPreview(deps([lead(1)], {}, { id: 77, name: "Q", status: "ACTIVE" }), req())).requiresActiveConfirmation).toBe(true);
    for (const status of ["ARCHIVED", "STOPPED", "COMPLETED", ""]) {
      await expect(buildPreview(deps([lead(1)], {}, { id: 77, name: "Q", status }), req())).rejects.toMatchObject({ code: "campaign_not_pushable" });
    }
    await expect(buildPreview(deps([lead(1)], { getCampaign: async () => null }), req())).rejects.toMatchObject({ code: "campaign_not_found" });
  });

  it("signs the campaign status, the sequence hash and the warnings into the token", async () => {
    const p = await buildPreview(deps([lead(1)]), req({ mapping: { z: "customFields.z" } }));
    const t = verifyPushToken("test-secret", p.token, Date.parse("2026-10-28T10:00:00Z"))!;
    expect(t).toMatchObject({ userId: "u1", listId: "L", campaignId: 77, startStatus: "DRAFTED", sequenceHash: p.sequence.hash, mapping: { z: "customFields.z" } });
    expect(p.expiresAt).toBe("2026-10-28T10:30:00.000Z");
  });

  it("gives every approval its own id and binds the connection and the unreadable-sequence acknowledgement into it", async () => {
    const now = Date.parse("2026-10-28T10:00:00Z");
    const a = verifyPushToken("test-secret", (await buildPreview(deps([lead(1)]), req({ acknowledgeUnreadable: true }))).token, now)!;
    const b = verifyPushToken("test-secret", (await buildPreview(deps([lead(1)]), req())).token, now)!;
    expect(a.jti).toBeTruthy();
    expect(a.jti).not.toBe(b.jti);
    expect(a).toMatchObject({ accountId: "smartlead-u1", acknowledgeUnreadable: true });
    expect(b.acknowledgeUnreadable).toBe(false);
  });

  it("refuses bad input before reading anything", async () => {
    let reads = 0;
    const d = deps([lead(1)], { getCampaign: async () => { reads++; return null; } });
    for (const bad of [{ campaignId: 0 }, { listId: "" }, { cohort: 0 }, { cohort: 1.5 }, { mapping: { a: 5 } }, { mapping: { ["x".repeat(101)]: "y" } }, { acknowledgedTags: [1] }]) {
      await expect(buildPreview(d, req(bad))).rejects.toBeInstanceOf(PreviewError);
    }
    expect(reads).toBe(0);
  });

  it("refuses a list too big to evaluate instead of half evaluating it", async () => {
    const big = { readLeads: async (_l: string, after: any) => ({ items: Array.from({ length: 200 }, (_, i) => lead((after ? 1 : 0) * 1000 + i)), hasMore: true }) };
    await expect(buildPreview(deps([], big as any), req())).rejects.toMatchObject({ code: "list_too_large" });
    expect(PREVIEW_MAX_LEADS).toBe(50_000);
  });
});
