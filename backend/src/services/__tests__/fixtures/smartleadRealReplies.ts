/**
 * Replies recorded from a LIVE Smartlead account on 2026-10-27 (ENG-673), with every value replaced by an invented one
 * (example.com addresses, made-up ids and names). The SHAPES are real: field names, nesting, bare arrays versus wrappers.
 * Smartlead's own docs contradict these in places (add-leads reply, campaign mailbox list, per-day limit field name), so
 * these fixtures, not the docs, are the contract. Re-record them if Smartlead changes.
 */

export const realEmailAccounts = [
  {
    id: 1001, from_email: "box1@example-outreach.test", from_name: "Box One", type: "OUTLOOK", message_per_day: 15,
    username: "box1@example-outreach.test", password: "REDACTED", imap_password: "REDACTED", is_smtp_success: true, is_imap_success: true,
    daily_sent_count: 0, campaign_count: 1, is_connected_to_campaign: true, minTimeToWaitInMins: 5,
    warmup_details: { status: "ACTIVE", warmup_reputation: "100%" }, tags: [],
  },
  { id: 1002, from_email: "box2@example-outreach.test", from_name: "Box Two", type: "OUTLOOK", message_per_day: 30, password: "REDACTED", imap_password: null, warmup_details: { status: "INACTIVE" }, tags: [] },
];

/** A bare array, with status values ACTIVE, DRAFTED, STOPPED, COMPLETED, ARCHIVED as seen live (DRAFTED, not DRAFT). */
export const realCampaignsList = [
  { id: 2001, name: "Q4 outreach", status: "ACTIVE", max_leads_per_day: 200, stop_lead_settings: "REPLY_TO_AN_EMAIL", user_id: 1, client_id: null },
  { id: 2002, name: "Test draft", status: "DRAFTED", max_leads_per_day: 100, stop_lead_settings: "REPLY_TO_AN_EMAIL", user_id: 1, client_id: null },
  { id: 2003, name: "Old", status: "ARCHIVED", user_id: 1, client_id: null },
];

/** A bare array (not the documented {ok, data}), and it DOES carry the per-day limit and the SMTP password. */
export const realCampaignMailboxes = [
  { id: 1001, from_email: "box1@example-outreach.test", from_name: "Box One", type: "OUTLOOK", message_per_day: 15, password: "REDACTED", warmup_details: { status: "ACTIVE" }, tags: [] },
];

/**
 * A bare array of steps. With A/B variants the step's own subject and body are EMPTY and the content is in
 * `sequence_variants`; without variants the content is on the step.
 */
export const realSequencesWithVariants = [
  {
    id: 3001, seq_number: 1, subject: "", email_body: "", follow_up_subject: "", seq_delay_details: { delayInDays: 1 },
    sequence_variants: [
      { id: 4001, variant_label: "A", subject: "How AI reads {{company_name}}", email_body: "<p>Hi {{first_name}},</p>", optional_email_body_1: "", is_deleted: false },
      { id: 4002, variant_label: "B", subject: "Your pipeline", email_body: "<p>Hi {{first_name}}</p>", optional_email_body_1: "", is_deleted: false },
    ],
  },
  {
    id: 3002, seq_number: 2, subject: "Quick follow-up", email_body: "<p>Hi {{first_name}}</p>", follow_up_subject: "", seq_delay_details: { delayInDays: 4 },
    sequence_variants: [],
  },
];

const zeroTallies = {
  skipped_in_other_campaign_count: 0, block_count: 0, duplicate_count: 0, invalid_email_count: 0, invalid_emails: [],
  already_added_to_campaign: 0, unsubscribed_leads: [], is_lead_limit_exhausted: false, lead_import_stopped_count: 0, bounce_count: 0,
};

/** 3 rows sent (2 valid, 1 invalid). `upload_count` is 3, the number SUBMITTED; `total_leads` is 2, the number ADDED. */
export const realAddLeadsFirstImport = {
  ok: true, upload_count: 3, total_leads: 2, ...zeroTallies, invalid_email_count: 1, invalid_emails: ["bad-email"],
  emailToLeadIdMap: { newlyAddedLeads: { "a@example.com": "9001", "b@example.com": "9002" }, existingLeads: {}, existingLeadsInOtherCampaigns: {} },
};

/** The same 3 rows again: nothing added, two already in this campaign. */
export const realAddLeadsResend = {
  ok: true, upload_count: 3, total_leads: 0, ...zeroTallies, invalid_email_count: 1, invalid_emails: ["bad-email"], already_added_to_campaign: 2,
  emailToLeadIdMap: { newlyAddedLeads: {}, existingLeads: { "a@example.com": "9001", "b@example.com": "9002" }, existingLeadsInOtherCampaigns: {} },
};

/** Two emails that already exist in ANOTHER (draft) campaign were still added here, and are listed separately. */
export const realAddLeadsExistingInOtherCampaign = {
  ok: true, upload_count: 2, total_leads: 2, ...zeroTallies,
  emailToLeadIdMap: { newlyAddedLeads: {}, existingLeads: {}, existingLeadsInOtherCampaigns: { "a@example.com": "9001", "b@example.com": "9002" } },
};

/** Without `return_lead_ids` the map is absent. */
export const realAddLeadsNoMap = { ok: true, upload_count: 1, total_leads: 1, ...zeroTallies };
