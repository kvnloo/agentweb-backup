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

  // Real deliveries captured from Smartlead on 2026-10-29 (trimmed; identifiers are test data). Note: `from_email` is the SENDING MAILBOX.
  const REAL_REPLY = {
    campaign_status: "COMPLETED", stats_id: "e3d94c2b-a220-472f-b077-9eb5c3a64f19", reply_source: "CAMPAIGN", sl_email_lead_id: "4843221306", sl_email_lead_map_id: 3930296647,
    sl_lead_email: "ann@example.com", sl_senders_mailbox: "sender@example.org", from_email: "sender@example.org", cc_emails: [],
    subject: "AgentWeb event test for Ann", to_email: "ann@example.com", to_name: "Ann Test", time_replied: "2026-10-29T14:57:20+00:00", event_timestamp: "2026-10-29T14:57:20+00:00",
    reply_message: { message_id: "<CAAv@mail.gmail.com>", text: "I am replying to this mail for testing.\n" }, reply_body: "<html>PRIVATE REPLY</html>", message_id: "<CAAv@mail.gmail.com>",
    campaign_name: "AW-TEST events slice3 (delete me)", campaign_id: 4270665, sequence_number: 1, secret_key: "S3CRET", webhook_url: "http://host/api/webhooks/smartlead/a/b/TOKEN",
    leadCorrespondence: { targetLeadEmail: "ann@example.com", replyReceivedFrom: "ann@example.com", repliedCompanyDomain: "SameCompany" }, event_type: "EMAIL_REPLY", event_id: "4ac42b51-84a7-4d7a-9a10-f356e65241e7",
  };
  const REAL_UNSUB = {
    campaign_status: "COMPLETED", event_timestamp: "2026-10-29T14:57:29.266Z", lead_id: 4843221306, lead_email: "ann@example.com", to_email: "ann@example.com",
    from_email: "sender@example.org", lead_name: "Ann Test", sequence_number: 1, campaign_name: "AW-TEST events slice3 (delete me)", campaign_id: 4270665,
    unsubscribed_client_id_map: { "0": "2026-10-29T14:57:28.687636+00:00" }, secret_key: "S3CRET", description: "Lead - ann@example.com unsubscribed from the campaign - AW-TEST events slice3 (delete me)",
    event_type: "LEAD_UNSUBSCRIBED", event_id: "ad65b227-b71c-4256-a3d9-455623d720c2", sl_email_lead_map_id: "3930296647",
  };

  it("reads the REAL reply payload: the contact is found (never the sending mailbox), the subject and time are kept, the reply text and secrets are not", () => {
    const e = ok(REAL_REPLY);
    expect(e).toMatchObject({ kind: "reply", campaignId: 4270665, subject: "AgentWeb event test for Ann", from: "ann@example.com", to: "sender@example.org", occurredAt: "2026-10-29T14:57:20.000Z", soft: false });
    expect(e.candidateEmails[0]).toBe("ann@example.com");
    expect(e.candidateEmails[e.candidateEmails.length - 1]).toBe("sender@example.org"); // the mailbox is only a last resort
    const all = JSON.stringify(e);
    for (const secret of ["PRIVATE REPLY", "I am replying", "S3CRET", "TOKEN"]) expect(all).not.toContain(secret);
  });

  const REAL_BOUNCE = {
    sl_email_lead_id: "4843221319", campaign_status: "COMPLETED", stats_id: "f1d7bbc8-d080-40dc-9c30-66ca96a17b0f", from_email: "sender@example.org", to_email: "nosuchuser@example.com",
    to_name: "Bounce Test", time_sent: "2026-10-29T14:40:14.551+00:00", event_timestamp: "2026-10-29T14:40:14.551+00:00", campaign_name: "AW-TEST events slice3 (delete me)", campaign_id: 4270665,
    sequence_number: 1, custom_subject: "AgentWeb event test", sent_message_body: "<p>Hi Bounce</p>", subject: "AgentWeb event test", is_bounced: true, is_sender_originated_bounce: false,
    bounce_reply_message_id: "<2812cd5f@PN5PR01MB025717.INDPRD01.PROD.OUTLOOK.COM>", bounce_reply_email: "<html>HTML OF THE NOTICE</html>",
    bounce_reply_email_preview: "Your message to nosuchuser@example.com couldn't be delivered.\nnosuchuser wasn't found at example.com.\nsender    Office 365      nosuchuser\nAction Required",
    bounce_message: { message_id: "<2812cd5f@PN5PR01MB025717.INDPRD01.PROD.OUTLOOK.COM>", html: "<html>HTML OF THE NOTICE</html>", text: "Your message to nosuchuser@example.com couldn't be delivered.\nnosuchuser wasn't found at example.com.\nsender    Office 365      nosuchuser\nAction Required", time: "2026-10-29T14:40:15.000Z" },
    secret_key: "S3CRET", webhook_url: "http://host/api/webhooks/smartlead/a/b/TOKEN", event_type: "EMAIL_BOUNCE", event_id: "4a549622-3b9d-4251-940a-151b57d1702e", sl_email_lead_map_id: 3930296648,
  };

  it("reads the REAL bounce payload: the contact is to_email, the reason comes from the receiving server's notice, a missing mailbox is a hard bounce", () => {
    const e = ok(REAL_BOUNCE);
    expect(e).toMatchObject({ kind: "bounce", campaignId: 4270665, soft: false });
    expect(e.candidateEmails[0]).toBe("nosuchuser@example.com");
    expect(e.reason).toContain("wasn't found at example.com");
    expect(e.reason!.length).toBeLessThanOrEqual(160);
    const all = JSON.stringify(e);
    for (const never of ["HTML OF THE NOTICE", "S3CRET", "TOKEN"]) expect(all).not.toContain(never);
  });

  it("a bounce that came from OUR side, or that is not a bounce at all, never blocks the contact", () => {
    expect(ok({ ...REAL_BOUNCE, is_sender_originated_bounce: true }).soft).toBe(true);
    expect(ok({ ...REAL_BOUNCE, is_bounced: false }).soft).toBe(true);
    expect(ok({ ...REAL_BOUNCE, is_sender_originated_bounce: true, bounce_type: "hard" }).soft).toBe(true); // a hard label does not make our own mailbox problem the contact's
  });

  it("reads the REAL unsubscribe payload", () => {
    const e = ok(REAL_UNSUB);
    expect(e).toMatchObject({ kind: "unsubscribe", campaignId: 4270665, occurredAt: "2026-10-29T14:57:29.266Z" });
    expect(e.candidateEmails[0]).toBe("ann@example.com");
    expect(JSON.stringify(e)).not.toContain("S3CRET");
  });

  it("keys an event by its event_id alone: a retry with a different timestamp still has the same key, a different event has another", () => {
    expect(ok(REAL_REPLY).eventKey).toBe(ok({ ...REAL_REPLY, event_timestamp: "2026-10-29T15:30:00+00:00", time_replied: "2026-10-29T15:30:00+00:00" }).eventKey);
    expect(ok(REAL_REPLY).eventKey).not.toBe(ok({ ...REAL_REPLY, event_id: "00000000-0000-0000-0000-000000000000" }).eventKey);
    expect(ok(REAL_REPLY).eventKey).not.toBe(ok({ ...REAL_UNSUB, event_id: REAL_REPLY.event_id }).eventKey); // the kind is part of it
  });

  it("reads a reply: the contact is the sender, the subject and time are kept", () => {
    const e = ok({ event_type: "EMAIL_REPLY", campaign_id: 4269250, sl_lead_email: "Ann <ANN@example.com>", from_email: "sender@ours.com", to_email: "ann@example.com", subject: "Re: Hi", time_replied: "2026-10-29T13:00:00Z", reply_body: "SECRET TEXT" });
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
    // contact-shaped fields always come before the two mailbox-shaped ones, whatever the event kind
    const r = ok({ event_type: "EMAIL_REPLY", campaign_id: 5, sl_lead_email: "lead@example.com", to_email: "lead@example.com", from_email: "mailbox@ours.com" });
    expect(r.candidateEmails).toEqual(["lead@example.com", "mailbox@ours.com"]);
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
