import { kindOf, parseSmartleadEvent } from "../smartleadEvents";

const ok = (body: unknown) => {
  const r = parseSmartleadEvent(body);
  if (!r.ok) throw new Error(`expected an event, got ${r.reason}`);
  return r.event;
};

describe("parsing a Smartlead event (ENG-673)", () => {
  it("accepts every documented spelling of the three event names, and ignores the rest", () => {
    for (const n of ["EMAIL_REPLY", "EMAIL_REPLIED", "LEAD_REPLIED", "email_reply"]) expect(kindOf(n)).toBe("reply");
    for (const n of ["EMAIL_BOUNCE", "LEAD_BOUNCED", "email.bounce"]) expect(kindOf(n)).toBe("bounce");
    for (const n of ["LEAD_UNSUBSCRIBED", "EMAIL_UNSUBSCRIBED", "lead unsubscribed"]) expect(kindOf(n)).toBe("unsubscribe");
    for (const n of ["EMAIL_SENT", "LEAD_CATEGORY_UPDATED", "CAMPAIGN_STATUS_CHANGED", "", undefined, 5, null]) expect(kindOf(n)).toBeUndefined();
    // a longer name that merely CONTAINS a word is a different event
    for (const n of ["EMAIL_REPLY_CATEGORY_UPDATED", "LEAD_UNSUBSCRIBED_FROM_LIST_CHANGED", "BOUNCE_RATE_ALERT", "constructor", "__proto__", "toString"]) expect(kindOf(n)).toBeUndefined();
  });

  it("reads a reply: the contact is the sender, the subject and time are kept", () => {
    const e = ok({ event_type: "EMAIL_REPLY", campaign_id: 4269250, from_email: "Ann <ANN@example.com>", to_email: "sender@ours.com", subject: "Re: Hi", time_replied: "2026-10-29T13:00:00Z", reply_body: "SECRET TEXT" });
    expect(e).toMatchObject({ kind: "reply", campaignId: 4269250, subject: "Re: Hi", from: "ann@example.com", to: "sender@ours.com", occurredAt: "2026-10-29T13:00:00.000Z", soft: false });
    expect(e.candidateEmails[0]).toBe("ann@example.com");
    expect(JSON.stringify(e)).not.toContain("SECRET TEXT"); // the reply's body is never carried
  });

  it("reads an unsubscribe with the documented lead_email field, and a campaign id given as text", () => {
    const e = ok({ event_type: "LEAD_UNSUBSCRIBED", campaign_id: "77", lead_email: "Bo@Example.com", unsubscribed_client_id_map: {} });
    expect(e).toMatchObject({ kind: "unsubscribe", campaignId: 77, candidateEmails: ["bo@example.com"] });
  });

  it("offers every address the payload might use, contact-shaped fields first, without duplicates", () => {
    const e = ok({ event: "EMAIL_BOUNCE", campaign_id: 5, to_email: "lead@example.com", from_email: "mailbox@ours.com", lead: { email: "Lead@example.com" } });
    expect(e.candidateEmails).toEqual(["lead@example.com", "mailbox@ours.com"]);
    const r = ok({ event_type: "EMAIL_REPLY", campaign_id: 5, to_email: "mailbox@ours.com", from_email: "lead@example.com" });
    expect(r.candidateEmails[0]).toBe("lead@example.com"); // for a reply the sender is the contact
  });

  it("tells a hard bounce from a temporary one, and says why", () => {
    expect(ok({ event_type: "EMAIL_BOUNCE", campaign_id: 5, lead_email: "a@b.co", bounce_type: "hard" }).soft).toBe(false);
    expect(ok({ event_type: "EMAIL_BOUNCE", campaign_id: 5, lead_email: "a@b.co", bounce_type: "soft" }).soft).toBe(true);
    expect(ok({ event_type: "EMAIL_BOUNCE", campaign_id: 5, lead_email: "a@b.co", reason: "Mailbox full, try again later" }).soft).toBe(true);
    expect(ok({ event_type: "EMAIL_BOUNCE", campaign_id: 5, lead_email: "a@b.co", reason: "550 5.1.1 user unknown" }).soft).toBe(false);
    expect(ok({ event_type: "EMAIL_BOUNCE", campaign_id: 5, lead_email: "a@b.co", bounce_type: "hard", reason: "Mailbox full" }).soft).toBe(false); // an explicit hard wins
    expect(ok({ event_type: "EMAIL_BOUNCE", campaign_id: 5, lead_email: "a@b.co" }).soft).toBe(false); // unknown: treated as hard, the safe side for an opt-out
    expect(ok({ event_type: "EMAIL_BOUNCE", campaign_id: 5, lead_email: "a@b.co", reason: "550 user unknown" }).reason).toBe("550 user unknown");
  });

  it("never calls a permanent failure temporary, even when its text has a 4xx-looking number or the words 'try again'", () => {
    const soft = (reason: string) => ok({ event_type: "EMAIL_BOUNCE", campaign_id: 5, lead_email: "a@b.co", reason }).soft;
    expect(soft("450 4.2.2 mailbox busy, try again later")).toBe(true);
    expect(soft("452 4.2.2 over quota")).toBe(true);
    expect(soft("Mailbox full")).toBe(true);
    expect(soft("554 5.7.1 message size 450 bytes rejected")).toBe(false);
    expect(soft("Permanent failure, do not try again")).toBe(false);
    expect(soft("550 5.1.1 user unknown, try again later")).toBe(false);
    expect(soft("The recipient mailbox does not exist")).toBe(false);
    expect(soft("Delivery has failed")).toBe(false); // no clear sign of a temporary problem: treated as permanent
  });

  it("a payload with no time or id still gets a key that tells two different replies apart and survives a retry", () => {
    const a = { event_type: "EMAIL_REPLY", campaign_id: 5, from_email: "a@b.co", subject: "first" };
    const b = { event_type: "EMAIL_REPLY", campaign_id: 5, from_email: "a@b.co", subject: "second" };
    expect(ok(a).eventKey).toBe(ok({ ...a }).eventKey);
    expect(ok(a).eventKey).toBe(ok({ subject: "first", from_email: "a@b.co", campaign_id: 5, event_type: "EMAIL_REPLY" }).eventKey); // field order does not matter
    expect(ok(a).eventKey).not.toBe(ok(b).eventKey);
  });

  it("only a bounce can be soft", () => {
    expect(ok({ event_type: "LEAD_UNSUBSCRIBED", campaign_id: 5, lead_email: "a@b.co", reason: "try again later" }).soft).toBe(false);
  });

  it("gives the same event the same key, and a different event a different one", () => {
    const base = { event_type: "EMAIL_REPLY", campaign_id: 5, from_email: "a@b.co", time_replied: "2026-10-29T13:00:00Z", sequence_number: 1 };
    expect(ok(base).eventKey).toBe(ok({ ...base }).eventKey);
    expect(ok(base).eventKey).not.toBe(ok({ ...base, time_replied: "2026-10-29T14:00:00Z" }).eventKey);
    expect(ok(base).eventKey).not.toBe(ok({ ...base, event_type: "EMAIL_BOUNCE" }).eventKey);
    expect(ok(base).eventKey).not.toBe(ok({ ...base, from_email: "c@d.co" }).eventKey);
    expect(ok(base).eventKey).toMatch(/^[0-9a-f]{32}$/);
  });

  it("refuses what it cannot act on, with a reason", () => {
    expect(parseSmartleadEvent(null)).toEqual({ ok: false, reason: "not_an_object" });
    expect(parseSmartleadEvent([1])).toEqual({ ok: false, reason: "not_an_object" });
    expect(parseSmartleadEvent("x")).toEqual({ ok: false, reason: "not_an_object" });
    expect(parseSmartleadEvent({ event_type: "EMAIL_SENT", campaign_id: 5 })).toEqual({ ok: false, reason: "unhandled_event" });
    expect(parseSmartleadEvent({ event_type: "EMAIL_REPLY" })).toEqual({ ok: false, reason: "no_campaign" });
    for (const c of [0, -1, "abc", 1.5, "1e3", null]) expect(parseSmartleadEvent({ event_type: "EMAIL_REPLY", campaign_id: c, from_email: "a@b.co" })).toEqual({ ok: false, reason: "no_campaign" });
    expect(parseSmartleadEvent({ event_type: "EMAIL_REPLY", campaign_id: 5 })).toEqual({ ok: false, reason: "no_contact_address" });
    expect(parseSmartleadEvent({ event_type: "EMAIL_REPLY", campaign_id: 5, from_email: "not-an-address" })).toEqual({ ok: false, reason: "no_contact_address" });
  });

  it("keeps text short and clean, and never trusts a field's size", () => {
    const e = ok({ event_type: "EMAIL_REPLY", campaign_id: 5, from_email: "a@b.co", subject: `Hi\u0000 there\n${"x".repeat(5000)}` });
    expect(e.subject!.length).toBeLessThanOrEqual(200);
    expect(e.subject).not.toMatch(/[\u0000-\u001f]/);
    expect(parseSmartleadEvent({ event_type: "EMAIL_REPLY", campaign_id: 5, from_email: `${"a".repeat(300)}@b.co` })).toEqual({ ok: false, reason: "no_contact_address" });
    const many = ok({ event_type: "EMAIL_REPLY", campaign_id: 5, from_email: "a@b.co", lead_email: "c@d.co", email: "e@f.co", to_email: "g@h.co", lead: { email: "i@j.co", lead_email: "k@l.co" } });
    expect(many.candidateEmails.length).toBeLessThanOrEqual(6);
  });
});
