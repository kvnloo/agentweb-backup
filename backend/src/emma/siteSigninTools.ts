/**
 * ENG-795: open_site_signin — open a site's sign-in page with the credentials
 * that make it automatable, without ever putting those credentials in the
 * model's context.
 *
 * RankAI's sign-in is walled by an invisible reCAPTCHA v2 that 2captcha cannot
 * solve (ERROR_CAPTCHA_UNSOLVABLE), which is what stalled the weekly SEO/GEO
 * report every run: no captcha token → POST /api/auth/magic-link 400s → no code
 * is ever emailed → zero output. RankAI gave us a first-party bypass key that
 * suppresses the widget when passed as a query param; the key lives in Secrets
 * Manager and is read here at runtime.
 *
 * The tool NAVIGATES rather than handing the key back, and redacts the key from
 * everything it returns. That is deliberate: this Emma session drafts a Slack
 * message at the end of the same run, and anything in her context can be
 * paraphrased into it. The key is a bypass credential for another company's bot
 * protection — it does not belong in a chat transcript.
 *
 * The registry is an allowlist, not a generic "read me a secret" tool: adding a
 * site is one entry here plus its own Secrets Manager getter.
 */

import { emmaToolRegistry } from './registry';

interface SiteSigninProfile {
  /** Domain the session is being established for (used in logs and messages). */
  domain: string;
  /** Human-readable secret location, minus the env prefix. */
  secretLabel: string;
  /** Fields the secret must contain for the flow to work at all. */
  requiredFields: string[];
  /** Query params injected into the signin URL: param name → secret field. */
  secretQueryParams: Record<string, string>;
  /** Secret field holding the sign-in URL. */
  signinUrlField: string;
  /** Secret field holding the account email to sign in as, if any. */
  loginEmailField?: string;
  /** Secret field holding a dashboard/workspace id worth surfacing, if any. */
  dashboardIdField?: string;
  loadCredentials: () => Promise<Record<string, any>>;
  nextSteps: (credentials: Record<string, any>) => string;
}

const SITE_SIGNIN_PROFILES: Record<string, SiteSigninProfile> = {
  rankai: {
    domain: 'rankai.ai',
    secretLabel: 'AgentWeb/RankAI',
    requiredFields: ['captchaBypassKey', 'signinUrl'],
    secretQueryParams: { captchaKey: 'captchaBypassKey' },
    signinUrlField: 'signinUrl',
    loginEmailField: 'reportAccountEmail',
    dashboardIdField: 'dashboardId',
    loadCredentials: async () => {
      const { getRankAICredentials } = await import('../utils/secretsManager');
      return getRankAICredentials();
    },
    nextSteps: (credentials) =>
      `The page is open and NO captcha will be shown — the bypass key is already applied. ` +
      `Type ${credentials.reportAccountEmail || 'the report account email'} into the email field, click "Send Verification Code", ` +
      'then call read_verification_code(subject_contains: "RankAI Login Code") to read the 6-digit code from the connected mailbox. ' +
      'Type the code in and click "Verify Code". ' +
      'If any step fails, stop and report the failure — never fabricate report data.',
  },
};

function supportedSites(): string {
  return Object.keys(SITE_SIGNIN_PROFILES).join(', ');
}

function envSecretName(secretLabel: string): string {
  const environment = process.env.NODE_ENV || 'development';
  return `${environment === 'production' ? 'prod' : 'dev'}/${secretLabel}`;
}

/** Playwright MCP tool names may be server-prefixed (playwright_browser_navigate). */
function findPlaywrightTool(service: any, suffix: string): string | null {
  const allTools = service?.toolRegistry?.getAllTools?.() || [];
  for (const tool of allTools) {
    if (tool.name === suffix || tool.name.endsWith(`_${suffix}`)) return tool.name;
  }
  return null;
}

// MCP tool calls have no transport-level timeout (mcpClientService.ts) — reading
// page.url() is instant, so bound it explicitly rather than let a hung call
// stall the sign-in.
const CURRENT_URL_PROBE_TIMEOUT_MS = 8000;
const CURRENT_URL_PROBE_ATTEMPTS = 2;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

/** Pull the value out of an MCP result ("### Result\n\"…\"" markdown wrapper). */
function extractMcpText(result: any): string {
  if (typeof result === 'string') return result;
  const contentArray = Array.isArray(result?.raw?.content) ? result.raw.content : null;
  const text = contentArray
    ? contentArray.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n')
    : String(result?.content ?? result ?? '');
  const match = text.match(/^###\s+Result\s*\n([\s\S]*?)(?:\n###\s|$)/i);
  const raw = match ? match[1].trim() : text.trim();
  if (raw.startsWith('"') && raw.endsWith('"')) {
    try { return JSON.parse(raw); } catch { /* use as-is */ }
  }
  return raw;
}

/** True when `host` is the domain itself or a subdomain of it — never a lookalike. */
function hostBelongsTo(host: string, domain: string): boolean {
  const h = host.toLowerCase();
  const d = domain.toLowerCase();
  return h === d || h.endsWith(`.${d}`);
}

type PageCheck = { ok: true } | { ok: false; currentHost: string };

/**
 * Refuse to navigate a browser that is in the middle of something else.
 *
 * This is a foundation tool, so it is offered in every session — including ones
 * driving the browser on an unrelated site. Yanking that browser to a sign-in
 * page would be visibly wrong. The legitimate case always has the browser
 * already ON the site (you got redirected to its /signin), so requiring that is
 * precise rather than restrictive.
 *
 * Fails OPEN — if the page cannot be read (no run_code tool, blank page, probe
 * error or timeout) the sign-in proceeds. The asymmetry is deliberate: wrongly
 * refusing breaks the scheduled report this tool exists to fix, while wrongly
 * allowing navigates a page. There is nothing to disrupt on a blank page anyway.
 */
async function checkBrowserIsOnSite(context: any, userId: string, domain: string): Promise<PageCheck> {
  const runCodeTool = findPlaywrightTool(context?.service, 'browser_run_code');
  if (!runCodeTool) return { ok: true };

  // Probed twice: a transient MCP hiccup on the first call is the main way this
  // guard would have been skipped, and one retry turns most of those into a
  // definite answer. Only a probe that fails BOTH times falls open.
  let currentUrl = '';
  let probeError: any = null;
  for (let attempt = 1; attempt <= CURRENT_URL_PROBE_ATTEMPTS; attempt++) {
    try {
      const result = await withTimeout(
        context.service.executeTool(
          context.llmModel,
          runCodeTool,
          { code: 'async (page) => page.url()' },
          userId,
          context.sessionId
        ),
        CURRENT_URL_PROBE_TIMEOUT_MS,
        'Current-page probe'
      );
      currentUrl = extractMcpText(result);
      probeError = null;
      break;
    } catch (error: any) {
      probeError = error;
    }
  }
  if (probeError) {
    console.warn(`[open_site_signin] Could not read the current page (${probeError?.message || probeError}) — proceeding.`);
    return { ok: true };
  }

  if (!currentUrl || !/^https?:\/\//i.test(currentUrl)) return { ok: true }; // about:blank / no page

  let host: string;
  try {
    host = new URL(currentUrl).hostname;
  } catch {
    return { ok: true };
  }

  return hostBelongsTo(host, domain) ? { ok: true } : { ok: false, currentHost: host };
}

/** Remove every occurrence of a secret value from a string. */
function redact(value: string, secrets: string[]): string {
  return secrets.reduce(
    (acc, secret) => (secret ? acc.split(secret).join('[redacted]') : acc),
    value
  );
}

emmaToolRegistry.register({
  name: 'open_site_signin',
  definition: {
    name: 'open_site_signin',
    description:
      'Open the sign-in page of a site AgentWeb holds automation credentials for, with those credentials applied. ' +
      'Use this when a saved browser session has died — i.e. after load_browser_cookies the site still redirects you to its /signin page. ' +
      'Currently supports: rankai.ai (captcha-bypass sign-in; no CAPTCHA solving is needed or possible there). ' +
      'The tool navigates the browser for you and never reveals the credential. ' +
      'After it returns, follow next_steps to finish the email-code login, then continue with the task.',
    inputSchema: {
      type: 'object',
      properties: {
        site: {
          type: 'string',
          enum: ['rankai'],
          description: 'Which site to sign in to. "rankai" → rankai.ai.',
        },
      },
      required: ['site'],
    },
  },
  internal: true,
  execute: async (args: any, context: any) => {
    const userId = context?.userId || context?.agentUserId;
    if (!userId) throw new Error('Authentication required');

    const site = String(args?.site ?? '').toLowerCase().trim();
    const profile = SITE_SIGNIN_PROFILES[site];
    if (!profile) {
      return {
        success: false,
        error: `Unknown site "${site}". Supported sites: ${supportedSites()}. ` +
          'For any other site, log in with the normal browser flow.',
      };
    }

    const secretName = envSecretName(profile.secretLabel);

    let credentials: Record<string, any>;
    try {
      credentials = (await profile.loadCredentials()) || {};
    } catch (error: any) {
      return {
        success: false,
        error:
          `Could not read the ${secretName} credentials: ${error?.message || String(error)}. ` +
          `${profile.domain} cannot be signed into without them — report this failure rather than continuing.`,
      };
    }

    const missing = profile.requiredFields.filter((field) => !credentials[field]);
    if (missing.length > 0) {
      return {
        success: false,
        error:
          `The ${secretName} secret is missing required field(s): ${missing.join(', ')}. ` +
          `${profile.domain} cannot be signed into until they are added — report this failure rather than continuing.`,
      };
    }

    const navigateTool = findPlaywrightTool(context?.service, 'browser_navigate');
    if (!navigateTool) {
      return {
        success: false,
        error: 'Playwright browser tools are not available — no active browser session to open the sign-in page in.',
      };
    }

    const pageCheck = await checkBrowserIsOnSite(context, userId, profile.domain);
    if (!pageCheck.ok) {
      return {
        success: false,
        reason: 'browser_on_other_site',
        error:
          `The browser is currently on ${pageCheck.currentHost}, not ${profile.domain}. ` +
          `This tool only opens the ${profile.domain} sign-in page when the browser is already there — ` +
          `it will not navigate away from work in progress. If you do mean to sign in to ${profile.domain}, ` +
          'navigate there first and call this again.',
      };
    }

    const url = new URL(String(credentials[profile.signinUrlField]));
    const secretValues: string[] = [];
    for (const [param, field] of Object.entries(profile.secretQueryParams)) {
      url.searchParams.set(param, String(credentials[field]));
      secretValues.push(String(credentials[field]));
    }

    // Surfaced as a warning, not a debug line: reaching this tool means the
    // persisted cookie jar for this domain no longer authenticates. One line per
    // scheduled run is expected; every run means the session is not surviving.
    console.warn(
      `[open_site_signin] Persisted ${profile.domain} session is not usable — re-authenticating via the ` +
        'credentialed sign-in flow. If this happens on every run, the saved cookies are not surviving between runs.'
    );

    try {
      await context.service.executeTool(context.llmModel, navigateTool, { url: url.toString() }, userId, context.sessionId);
    } catch (error: any) {
      return {
        success: false,
        error: `Could not open the ${profile.domain} sign-in page: ${error?.message || String(error)}.`,
      };
    }

    return {
      success: true,
      site,
      domain: profile.domain,
      signin_url: redact(url.toString(), secretValues),
      login_email: profile.loginEmailField ? credentials[profile.loginEmailField] : undefined,
      dashboard_id: profile.dashboardIdField ? credentials[profile.dashboardIdField] : undefined,
      session_recovery: true,
      next_steps: redact(profile.nextSteps(credentials), secretValues),
    };
  },
});
