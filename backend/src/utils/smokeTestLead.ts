import * as crypto from "crypto";

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
  // String(): these helpers are called with `any` from raw DynamoDB rows and from
  // webhooks' untyped body, so a numeric email must not throw — the sweep swallows
  // errors, and a throw there would silently abandon the rest of the page.
  return PATTERN.test(String(email).trim().toLowerCase());
}

/**
 * Digits of a phone, with a NANP country code removed.
 *
 * A lander using a libphonenumber-style phone component emits E.164 (`+14155550142`), and
 * the platform stores whatever the lander posts — nothing normalises it. Comparing raw
 * digits therefore failed for exactly those landers, which defeats suppression, the
 * per-run cleanup AND the stranded-lead sweep at the same time.
 *
 * Widening is safe: country code 1 IS the NANP, so `1` + `4155550142` can only be the
 * reserved fictional number. A non-NANP number keeps all its digits and still cannot match.
 */
export function phoneDigits(phone: unknown): string {
  const digits = String(phone ?? "").replace(/\D/g, "");
  return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
}

/**
 * The fewest digits that can identify a person.
 *
 * Seven, because that is a local subscriber number without an area code — the shortest
 * thing a human can meaningfully be reached on. The portal mirrors this constant; if the
 * two disagree, one surface merges rows the other splits.
 */
export const MIN_DEDUPABLE_PHONE_DIGITS = 7;

/**
 * Is this phone specific enough to MERGE two rows on?
 *
 * Merging is destructive in a way splitting is not: a split row is a cosmetic annoyance,
 * but two different people collapsed into one means the second disappears from the Inbox
 * and its list memberships are grafted onto the first. So the bar is "could this plausibly
 * be one person's number", not "is this non-empty".
 *
 * Without the floor, `+1` and `1` both reduce to `1`, and EVERY lead across an account
 * that carried only a country code collapsed into a single row. A visitor who tabs through
 * a phone field after typing the prefix produces exactly that.
 */
export function isDedupablePhone(phone: unknown): boolean {
  return phoneDigits(phone).length >= MIN_DEDUPABLE_PHONE_DIGITS;
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
  // Random, not Date.now() % 100. The reserved block gives 100 numbers either way, but a
  // clock-derived tail collides with itself on a 100 ms cycle, and a collision here is not
  // harmless: the colliding row already exists, so the conditional create loses, the adopt
  // path returns no new row, and `createdAt >= submittedAtIso` can never hold — a permanent
  // false `ok: false` for that list.
  const tail = String(Math.floor(Math.random() * 100)).padStart(2, "0");
  return `${PHONE_AREA}${PHONE_EXCHANGE}${PHONE_BLOCK}${tail}`;
}

/**
 * The deterministic lead id a phone-only capture is written under.
 *
 * Lives here, beside phoneDigits, for the same reason phoneDigits does: webhooks.ts MINTS
 * this id and landingPageSmokeTest.ts must READ it back, and if the two ever derive it
 * differently the smoke test silently stops finding the row it just created. Returns "" when
 * the phone carries no digits, which is the caller's signal that there is no deterministic
 * id to use.
 */
export function phoneLeadId(phone: unknown): string {
  const digits = phoneDigits(phone);
  if (!digits) return "";
  return `lead_ph_${crypto.createHash("sha256").update(digits).digest("hex").slice(0, 24)}`;
}

export function isSmokeTestPhone(phone: string | undefined | null): boolean {
  if (!phone) return false;
  return PHONE_PATTERN.test(phoneDigits(phone));
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
