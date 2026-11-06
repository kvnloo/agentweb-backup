/**
 * ENG-2782 S1 — single source of truth for the "Get started in Slack" wizard.
 *
 * The embeddable widget (packages/slack-start) renders ONLY what this module
 * returns from GET /api/onboarding/slack-start/config: every heading, subline,
 * button label and option. The same option ids validate PATCH answers, so the
 * browser can never persist a value the backend does not know about.
 *
 * Copy for steps 1–6 and "getting ready" is the approved intake mock
 * (ENG-2782 intake.html). The pending/check-email copy is new and honest by
 * construction: with SLACK_CONNECT_ENABLED off nothing is sent, so it never
 * claims an invitation went out.
 *
 * Internal routing (which budgets alert Francisco) lives in HIGH_BUDGET_IDS
 * and is deliberately NOT part of the public config.
 */

export type StepKind = 'start' | 'single' | 'multi';

export interface SlackStartOption {
  id: string;
  label: string;
  /** Optional grouping heading (tools step: "Ad channels", "CRM, email & site"). */
  group?: string;
}

export interface SlackStartStep {
  id: 'start' | AnswerField;
  kind: StepKind;
  heading: string;
  subline: string;
  options?: SlackStartOption[];
  note?: string;
  cta?: string;
  fields?: {
    email: { label: string; placeholder: string };
    website: { label: string; placeholder: string };
  };
}

export interface SlackStartConfig {
  version: number;
  brand: { name: string };
  steps: SlackStartStep[];
  buttons: { continue: string; back: string; retry: string; finish: string; close: string };
  screens: {
    gettingReady: { heading: string; subline: string };
    pending: { heading: string; body: string };
    ready: { heading: string; body: string };
  };
  errors: {
    generic: string;
    saveFailed: string;
    invalidEmail: string;
    personalEmail: string;
    invalidWebsite: string;
    captcha: string;
    rateLimited: string;
    domainInProgress: string;
    accountExists: string;
    selectOne: string;
    selectAtLeastOne: string;
  };
}

export const ANSWER_FIELDS = ['source', 'role', 'sector', 'tools', 'adSpend'] as const;
export type AnswerField = (typeof ANSWER_FIELDS)[number];
export type AnswerValue = string | string[];

const opts = (pairs: Array<[string, string, string?]>): SlackStartOption[] =>
  pairs.map(([id, label, group]) => (group ? { id, label, group } : { id, label }));

const STEPS: SlackStartStep[] = [
  {
    id: 'start',
    kind: 'start',
    heading: "Let's set up your growth team",
    subline: "We'll open a private Slack channel for you with our team and agents.",
    cta: 'Continue',
    fields: {
      email: { label: 'Work email', placeholder: 'you@company.com' },
      website: { label: 'Company website', placeholder: 'company.com' },
    },
  },
  {
    id: 'source',
    kind: 'single',
    heading: 'How did you find AgentWeb?',
    subline: 'Pick the closest match – you can always change this later.',
    options: opts([
      ['linkedin', 'LinkedIn'],
      ['x', 'Twitter / X'],
      ['reddit', 'Reddit'],
      ['google', 'Google'],
      ['ai_assistant', 'ChatGPT / Claude / Perplexity'],
      ['product_hunt', 'Product Hunt'],
      ['referral', 'A friend or colleague'],
      ['event', 'An event'],
      ['slack_marketplace', 'Slack Marketplace'],
      ['newsletter_podcast', 'A newsletter or podcast'],
    ]),
  },
  {
    id: 'role',
    kind: 'single',
    heading: "What's your role?",
    subline: 'This helps our agents tailor suggestions to how you work.',
    options: opts([
      ['founder', 'Founder / CEO'],
      ['head_of_growth', 'Head of Marketing / Growth'],
      ['marketing_ic', 'Marketing manager or specialist'],
      ['agency', 'Agency owner / freelancer'],
      ['sales_revops', 'Sales / RevOps'],
      ['other', 'Something else'],
    ]),
  },
  {
    id: 'sector',
    kind: 'multi',
    heading: 'What does your company sell?',
    subline: 'Select all that apply.',
    options: opts([
      ['agency', 'Agency / freelance – serve multiple clients'],
      ['saas', 'SaaS / technology'],
      ['ecommerce', 'E-commerce / DTC'],
      ['professional_services', 'Professional services – legal, consulting, finance'],
      ['local_services', 'Local & field services – trades, health, real estate'],
      ['media_apps', 'Media, apps & entertainment'],
    ]),
  },
  {
    id: 'tools',
    kind: 'multi',
    heading: 'Which tools does your growth run on?',
    subline: 'This helps our agents speak your language from the first message.',
    note: 'Nothing gets connected here. Our agents ask for each login in Slack, only when a task needs it.',
    options: opts([
      ['meta_ads', 'Meta Ads', 'Ad channels'],
      ['google_ads', 'Google Ads', 'Ad channels'],
      ['linkedin_ads', 'LinkedIn Ads', 'Ad channels'],
      ['hubspot', 'HubSpot', 'CRM, email & site'],
      ['activecampaign', 'ActiveCampaign', 'CRM, email & site'],
      ['shopify', 'Shopify', 'CRM, email & site'],
      ['webflow', 'Webflow', 'CRM, email & site'],
      ['wordpress', 'WordPress', 'CRM, email & site'],
      ['google_analytics', 'Google Analytics', 'CRM, email & site'],
    ]),
  },
  {
    id: 'adSpend',
    kind: 'single',
    heading: 'How much do you spend on ads per month?',
    subline: 'Rough is fine. It sets how hands-on we get.',
    cta: 'Create my Slack channel',
    options: opts([
      ['none', 'Nothing yet'],
      ['under_1k', 'Under $1k'],
      ['1k_5k', '$1k – $5k'],
      ['5k_20k', '$5k – $20k'],
      ['20k_100k', '$20k – $100k'],
      ['100k_plus', '$100k+'],
    ]),
  },
];

const CONFIG: SlackStartConfig = {
  version: 1,
  brand: { name: 'AgentWeb' },
  steps: STEPS,
  buttons: { continue: 'Continue', back: 'Back', retry: 'Try again', finish: 'Create my Slack channel', close: 'Close' },
  screens: {
    gettingReady: {
      heading: 'Your team is getting ready',
      subline: 'Setting up your private Slack channel with our team and agents.',
    },
    pending: {
      heading: "You're on the list",
      body: "We're setting up your private Slack channel. Keep an eye on your inbox — we'll email you as soon as it's ready.",
    },
    ready: {
      heading: 'Check Slack',
      body: 'Your private channel is ready. Look for the Slack invitation in Slack or your email.',
    },
  },
  errors: {
    generic: 'Something went wrong. Please try again.',
    saveFailed: "We couldn't save that. Check your connection and try again.",
    invalidEmail: 'Enter a valid email address.',
    personalEmail: 'Please use your work email.',
    invalidWebsite: 'Enter your public company website, like company.com.',
    captcha: "We couldn't verify you're human. Please try again.",
    rateLimited: 'Too many attempts. Please wait a few minutes and try again.',
    domainInProgress:
      'Someone from your company already started setting up AgentWeb. Check your inbox or ask your teammate to add you.',
    accountExists: 'You already have an AgentWeb account. Sign in at app.agentweb.pro.',
    selectOne: 'Pick one option to continue.',
    selectAtLeastOne: 'Pick at least one option to continue.',
  },
};

/** Monthly ad-spend answers that qualify for the Francisco managed-service alert (S6). */
const HIGH_BUDGET_IDS = new Set(['5k_20k', '20k_100k', '100k_plus']);

export function getSlackStartConfig(): SlackStartConfig {
  return CONFIG;
}

export function isHighBudget(adSpend: unknown): boolean {
  return typeof adSpend === 'string' && HIGH_BUDGET_IDS.has(adSpend);
}

export type AnswerValidation = { ok: true; value: AnswerValue } | { ok: false; error: string };

export function validateAnswer(field: AnswerField, raw: unknown): AnswerValidation {
  const step = STEPS.find((s) => s.id === field);
  if (!step?.options) return { ok: false, error: `unknown field ${field}` };
  const allowed = new Set(step.options.map((o) => o.id));
  if (step.kind === 'single') {
    if (typeof raw !== 'string' || !allowed.has(raw)) return { ok: false, error: `invalid ${field}` };
    return { ok: true, value: raw };
  }
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > allowed.size) {
    return { ok: false, error: `invalid ${field}` };
  }
  const unique: string[] = [];
  for (const v of raw) {
    if (typeof v !== 'string' || !allowed.has(v)) return { ok: false, error: `invalid ${field}` };
    if (!unique.includes(v)) unique.push(v);
  }
  return { ok: true, value: unique };
}

export function isAnswerField(value: unknown): value is AnswerField {
  return typeof value === 'string' && (ANSWER_FIELDS as readonly string[]).includes(value);
}
