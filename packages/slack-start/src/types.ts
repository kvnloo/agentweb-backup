/** Shape of GET /api/onboarding/slack-start/config (backend services/slackStart/slackStartConfig.ts). */
export interface SlackStartOption {
  id: string;
  label: string;
  group?: string;
}

export interface SlackStartStep {
  id: 'start' | 'source' | 'role' | 'sector' | 'tools' | 'adSpend';
  kind: 'start' | 'single' | 'multi';
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
  errors: Record<
    | 'generic'
    | 'saveFailed'
    | 'invalidEmail'
    | 'personalEmail'
    | 'invalidWebsite'
    | 'captcha'
    | 'rateLimited'
    | 'domainInProgress'
    | 'accountExists'
    | 'selectOne'
    | 'selectAtLeastOne',
    string
  >;
  captcha: { provider: 'turnstile'; siteKey: string } | null;
}

export type Answers = Partial<Record<Exclude<SlackStartStep['id'], 'start'>, string | string[]>>;

export interface SlackStartOptions {
  /** Backend origin, e.g. https://api.agentweb.pro (no trailing slash needed). */
  apiBase: string;
  /** Injected fetch (tests, custom transports). Defaults to window.fetch. */
  fetch?: typeof fetch;
  /** URL query parameter that mirrors the current step (browser back + analytics). */
  stepParam?: string;
  /** CSP nonce applied to the injected <style> and the Turnstile <script> (strict-CSP hosts). */
  nonce?: string;
}
