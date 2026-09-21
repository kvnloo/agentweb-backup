/**
 * ENG-449 gap #3: the automated post-deploy smoke test (landingPageSmokeTest.ts) submits a
 * REAL lead through a customer's REAL lead-capture form to verify the pipeline actually
 * works. That lead creation is not side-effect-free: webhooks.ts's forward-lead handler
 * fires HubSpot/Attio sync, drip-sequence auto-enrollment, auto-draft/auto-send emails, an
 * owner notification, and a server-side Meta CAPI conversion event for every new lead.
 * "Verify then delete" only cleans up the DB row — it does nothing to undo an
 * already-dispatched sequence enrollment or a real outbound email, since those fire
 * fire-and-forget the instant the lead is created, before the smoke test ever deletes it.
 *
 * This shared, strict marker lets webhooks.ts recognize and skip those specific side
 * effects for a synthetic smoke-test lead, while still creating (and returning) a real lead
 * row — the smoke test's CRM-landing verification still needs a real row to check for.
 *
 * Single source of truth: landingPageSmokeTest.ts builds the values with
 * buildSmokeTestEmail/buildSmokeTestPhone, webhooks.ts recognizes them with
 * isSmokeTestLead — both must agree on the exact formats.
 *
 * The email alone is not enough. A lander with no email field cannot carry our address, so
 * it substitutes its own placeholder (observed live on campaign.waterheater.app:
 * `noemail+<timestamp>@waterheater.app`). The lead is just as synthetic, but nothing in it
 * matched the marker — so every side effect above fired on it, and the row was never
 * recognised for cleanup either. The synthetic PHONE is the marker that survives that case.
 */

const DOMAIN = "agentweb.pro";
const PREFIX = "smoke-test+";
// PREFIX's "+" is a literal character in the email, not a regex quantifier — must be escaped
// or it silently changes meaning (matches "one or more t" instead of a literal "+"), which
// would make isSmokeTestEmail never actually match a real smoke-test email. Caught by a test.
const PATTERN = new RegExp(`^${PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\d+@${DOMAIN.replace(".", "\\.")}$`);

export function buildSmokeTestEmail(): string {
  return `${PREFIX}${Date.now()}@${DOMAIN}`;
}

export function isSmokeTestEmail(email: string | undefined | null): boolean {
  if (!email) return false;
  return PATTERN.test(email.trim().toLowerCase());
}

// 415-555-0100..0199 — the NANP's reserved fictional range inside a real area code. Valid
// enough for a lander's own phone validation to accept, and provably unroutable, so no real
// visitor can hold one. That is what makes it safe to key suppression off.
const PHONE_AREA = "415";
const PHONE_EXCHANGE = "555";
const PHONE_BLOCK = "01";
const PHONE_PATTERN = new RegExp(`^${PHONE_AREA}${PHONE_EXCHANGE}${PHONE_BLOCK}\\d{2}$`);

/** Builds the synthetic phone. Only the low two digits vary — the CRM key is never the phone. */
export function buildSmokeTestPhone(): string {
  const tail = String(Date.now() % 100).padStart(2, "0");
  return `${PHONE_AREA}${PHONE_EXCHANGE}${PHONE_BLOCK}${tail}`;
}

export function isSmokeTestPhone(phone: string | undefined | null): boolean {
  if (!phone) return false;
  return PHONE_PATTERN.test(String(phone).replace(/\D/g, ""));
}

/**
 * Recognises a synthetic smoke-test lead by EITHER marker.
 *
 * Use this — not isSmokeTestEmail — at every suppression site. Deleting the lead row
 * afterwards does not unsend an email or un-fire a conversion, so a lead that slips past
 * this check has already caused the damage by the time cleanup runs.
 */
export function isSmokeTestLead(
  lead: { email?: string | null; phone?: string | null } | null | undefined
): boolean {
  if (!lead) return false;
  return isSmokeTestEmail(lead.email) || isSmokeTestPhone(lead.phone);
}
