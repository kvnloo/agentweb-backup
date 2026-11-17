/**
 * ENG-3128 — the one directed question Zoma asks right after signup: "How familiar are you
 * with ads?". The answer picks the rest of the journey:
 *
 *   runs_ads        "I already run ads / use the Meta or Google MCP" -> connect ad accounts -> card -> done
 *   new_to_ads      "Interested in ads but never run them"            -> guided ad-account setup, then connect
 *   not_interested  "Not interested, just a friend"                   -> thank-you, no further steps;
 *                                                                        excluded from active-user counts
 *
 * Asked on the device-flow page (routes/zoma.ts) and surfaced to agents through zoma_status
 * and the setup poll's next_step, so an agent can ask it in chat. Stored on the user row as
 * `zomaAdsExperience` (+ `zomaAdsExperienceAt`). Every link here is Meta's or Google's own
 * page — never the Emma app.
 */
export const ZOMA_ADS_EXPERIENCE_VALUES = ['runs_ads', 'new_to_ads', 'not_interested'] as const;
export type ZomaAdsExperience = (typeof ZOMA_ADS_EXPERIENCE_VALUES)[number];

export const ZOMA_ADS_EXPERIENCE_QUESTION = 'How familiar are you with ads?';

export const ZOMA_ADS_EXPERIENCE_OPTIONS: ReadonlyArray<{ value: ZomaAdsExperience; label: string }> = [
  { value: 'runs_ads', label: 'I already run ads / use the Meta or Google MCP' },
  { value: 'new_to_ads', label: "I'm interested in ads but have never run them" },
  { value: 'not_interested', label: 'Not interested, just a friend' },
];

/** Accepts the stored value; anything else (missing, legacy, typo) is "not answered". */
export function parseZomaAdsExperience(raw: unknown): ZomaAdsExperience | null {
  return typeof raw === 'string' && (ZOMA_ADS_EXPERIENCE_VALUES as readonly string[]).includes(raw) ? (raw as ZomaAdsExperience) : null;
}

export const isNotInterested = (raw: unknown) => parseZomaAdsExperience(raw) === 'not_interested';

/** The first words of a newly connected Zoma agent (ENG-3134). */
export const ZOMA_WELCOME = 'Hey, welcome to Zoma.';

/** The whole friend path: exactly this, nothing more (ENG-3134). */
export const ZOMA_NOT_INTERESTED_MESSAGE = 'Thanks for signing up and trying out Zoma.';

/**
 * Internal lead classification (ENG-3134). A "just a friend" answer is a `pal`: listed in the lead
 * list and notifications as a pal and never counted as a potential user. Everyone else is a
 * `prospect` (including users who have not answered yet).
 */
export type ZomaLeadClassification = 'pal' | 'prospect';
export const ZOMA_PAL: ZomaLeadClassification = 'pal';
export const zomaLeadClassification = (raw: unknown): ZomaLeadClassification => (isNotInterested(raw) ? 'pal' : 'prospect');

/**
 * ENG-3135: creating a Google Ads account happens on Google's own site (Zoma cannot and does not
 * create one). Google's default signup pushes toward building a campaign, and currency and time zone are
 * permanent once the account exists (Google's help) — so the guidance is explicit: no campaign, and the
 * user chooses those values themselves.
 */
export const ZOMA_GOOGLE_NEW_ACCOUNT_STEPS: readonly string[] = [
  'Create a Google Ads account yourself, following Google\'s own sign-up guide at https://support.google.com/google-ads/answer/6366720 (sign in with the Google account you want to manage ads with). Zoma never creates the account for you.',
  'If Google pushes you to build a campaign, do not: choose "Create an account without a campaign" (if you only see a Smart campaign setup, look for "Switch to Expert Mode" first). Zoma never creates a campaign or starts spending when you connect.',
  'When Google asks for your billing country, currency and time zone, choose them yourself, because Google does not let anyone change the currency or time zone once the account exists.',
];

/**
 * Which Facebook login Zoma wants (ENG-3136). Zoma binds the Meta connection to the Zoma account that
 * started the link, never by comparing emails, so a different Facebook email is fine — but Meta only
 * shares the ad accounts that Facebook login can see.
 */
export const ZOMA_META_LOGIN_NOTE =
  'The Facebook login you connect does not need to use the same email as your Zoma login: Zoma links whichever Facebook account you sign in with to this Zoma account. It must be a Facebook login that has access to the ad account (the one that created it, or one added to it or to the Business portfolio that owns it); any other Facebook login shows Zoma no ad accounts.';

/** Meta hosts ad-account creation, so a failed Create button is Meta's; Zoma gives a current route and a way back. */
export const ZOMA_AD_ACCOUNT_CREATE_FALLBACK =
  'If Meta\'s "Create ad account" button does nothing or shows an error, that is Meta\'s page, not Zoma — Zoma cannot create the account for you. Reload and retry as an admin of the Business portfolio, or try Ads Manager (https://adsmanager.facebook.com) with the same Facebook login; if it still fails, report it to Meta (https://www.facebook.com/business/help) with the exact message. Once the account exists, get a fresh Meta connect link (links expire after 10 minutes; ask your agent for a new one) and open it.';

/** Ad-account setup for someone who has never run ads, in the order they need it. */
export const ZOMA_NEW_TO_ADS_STEPS: readonly string[] = [
  'Meta: create a Business portfolio at https://business.facebook.com/overview (use the Facebook login you want to manage ads with, and keep using that same login below).',
  'Meta: create a Facebook Page for your business at https://www.facebook.com/pages/create — Meta ads run from a Page.',
  'Meta: in Business settings → Accounts → Ad accounts, create an ad account and set its currency and time zone (https://business.facebook.com/settings/ad-accounts).',
  ZOMA_AD_ACCOUNT_CREATE_FALLBACK,
  ...ZOMA_GOOGLE_NEW_ACCOUNT_STEPS.map((s, i) => (i === 0 ? `Google (optional): ${s}` : s)),
  `Then connect those ad accounts to Zoma. ${ZOMA_META_LOGIN_NOTE}`,
];

/** Agent-facing question block: greet, ask the one question, and how to record each answer. */
export function adsExperienceQuestionText(recordWith: string): string {
  return [
    ZOMA_WELCOME,
    '',
    `Say "${ZOMA_WELCOME}" to the user, then ask this one question: "${ZOMA_ADS_EXPERIENCE_QUESTION}"`,
    ...ZOMA_ADS_EXPERIENCE_OPTIONS.map((o, i) => `  ${i + 1}. ${o.label}  → ${o.value}`),
    `Record their answer with ${recordWith}.`,
  ].join('\n');
}

export function newToAdsGuideText(): string {
  return ['No Meta ad account yet? Set one up, then connect with a fresh Meta link (links expire after 10 minutes):', ...ZOMA_NEW_TO_ADS_STEPS.map((s, i) => `  ${i + 1}. ${s}`)].join('\n');
}

export interface ZomaAdsExperienceStore {
  save(userId: string, answer: ZomaAdsExperience, at: string): Promise<void>;
}

export const defaultAdsExperienceStore: ZomaAdsExperienceStore = {
  async save(userId, answer, at) {
    // Lazy: keeps this module pure for the scoreboard/queue, which only need the parsers.
    const { userDb } = await import('../services/db');
    await userDb.updateUser(userId, { zomaAdsExperience: answer, zomaAdsExperienceAt: at });
  },
};
