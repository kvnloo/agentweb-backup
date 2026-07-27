/**
 * Seed defaults for the admin-editable onboarding outreach invite prompt.
 *
 * These constants are the *initial* content written into the
 * `onboarding-outreach-invite` row of the AW-PromptTemplates table the
 * first time it is read (see outreachInvitePromptService). After that,
 * admins edit the row from the partner-portal "Prompt Templates" tab and
 * the values here only matter as a fresh-install seed / worst-case
 * fallback.
 *
 * The invite drafts themselves are still assembled deterministically on
 * the frontend (see `useOutreachDrafts.buildTemplateDraft`) — these
 * templates are the *variant pool* it interpolates. Keeping the pool in a
 * DB row is what makes the copy editable without a code deploy (AC #3).
 *
 * Placeholder contract (the frontend fills these, empty values cause the
 * whole variant to be skipped so we never emit a half-filled sentence):
 *   {firstName} — prospect's first name (always present; defaults to "there")
 *   {company}   — prospect's company (may be empty)
 *   {icp}       — the ideal-customer-profile cohort name (may be empty)
 *   {specs}     — extra targeting specifics the user typed (may be empty)
 *   {brand}     — the sender's brand / company name (may be empty)
 *
 * Every variant MUST start with "Hi {firstName}" and stay well under the
 * 300-char LinkedIn invite cap once interpolated.
 */

/**
 * Guidance text. Not interpolated into the draft today — it documents the
 * intent for admins and is the system prompt a future Claude-backed
 * generator would use. Kept in the row so it, too, is editable.
 */
export const DEFAULT_OUTREACH_INVITE_SYSTEM_PROMPT = [
  "You are drafting a short LinkedIn connection request on behalf of the",
  "sender's brand. Write like one human to another: warm, specific, and",
  "direct. Reference the recipient's company or the audience you both care",
  "about. No corporate speak, no buzzwords, no emojis. Keep every message",
  "under 300 characters and end with a light, low-pressure question.",
].join(" ");

/**
 * Variants used when the prospect HAS a company on record. Ordered
 * most-personal first. Brand-referencing variants come first so a
 * configured brand gets used; they are skipped automatically when no
 * brand is available.
 */
export const DEFAULT_OUTREACH_INVITE_WITH_COMPANY: string[] = [
  "Hi {firstName}, I'm with {brand} — saw your work at {company}. We help {icp} run lighter outbound. Open to a quick chat?",
  "Hi {firstName}, saw your work at {company} — we help {icp} run lighter outbound. Open to a quick chat?",
  "Hi {firstName}, came across {company} while looking at {specs}. Curious how you're approaching outbound?",
  "Hi {firstName}, came across {company} and was impressed. Curious how you're handling outbound right now — open to a quick chat?",
  "Hi {firstName}, saw what {company} is doing — would love to compare notes on outbound. Open to a quick chat?",
  "Hi {firstName}, would love to connect re: {company}.",
];

/**
 * Variants used when the prospect has NO company on record. We personalise
 * on brand / ICP / specs / name instead so a missing company never leaves
 * a visible hole.
 */
export const DEFAULT_OUTREACH_INVITE_WITHOUT_COMPANY: string[] = [
  "Hi {firstName}, I'm with {brand} — we help {icp} run lighter outbound. Curious how you're approaching it, open to a quick chat?",
  "Hi {firstName}, we help {icp} run lighter outbound. Curious how you're approaching it — open to a quick chat?",
  "Hi {firstName}, came across your work in {specs}. Curious how you're approaching outbound?",
  "Hi {firstName}, came across your profile and was impressed. Curious how you're handling outbound right now — open to a quick chat?",
  "Hi {firstName}, would love to compare notes on outbound. Open to a quick chat?",
  "Hi {firstName}, would love to connect.",
];
