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
 * Single source of truth: landingPageSmokeTest.ts builds the email with buildSmokeTestEmail,
 * webhooks.ts recognizes it with isSmokeTestEmail — both must agree on the exact format.
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
