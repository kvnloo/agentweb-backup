/**
 * WhatsApp Cloud API channel (ENG-273).
 *
 * AgentWeb sends from ONE business number it owns — this is not multi-tenant. Each
 * customer contact is addressed by E.164 phone. See docs/integrations/whatsapp-contract.md.
 *
 * ── Two platform rules this module exists to enforce ─────────────────────────
 *
 * 1. THE 24-HOUR SERVICE WINDOW. Free-form text is only legal within 24h of the
 *    contact's last inbound message. Outside it, the send must use a template Meta
 *    pre-approved. We decide this locally and refuse early, rather than letting Meta
 *    reject with 131047 — a rejected send is a message the customer never gets, and
 *    the failure surfaces far from its cause.
 *
 * 2. US MARKETING TEMPLATES ARE PAUSED. Meta paused marketing-category templates to
 *    +1 numbers on 2025-04-01; still paused, no announced end date. Those sends fail
 *    with 131049. AgentWeb's customer base is US-centric, so this is mapped to a
 *    named error rather than a generic failure. Utility and authentication templates
 *    to US numbers are unaffected, which is why AgentWeb's templates are utility.
 *
 * Cost note, since it drives the routing: messages inside the service window are
 * free. Utility templates outside it are billed per delivery (~$0.004 to US). The
 * window check is therefore also the thing keeping the bill at roughly zero.
 *
 * ── What this module deliberately does NOT do ────────────────────────────────
 * No conversational Emma bridge. Since 2026-01-15 WhatsApp's Business Solution Terms
 * prohibit general-purpose AI assistants where the AI is the primary functionality.
 * Structured notifications, approvals and support automation are explicitly fine;
 * "chat with Emma over WhatsApp" is not. The webhook must never open a chat session.
 */

import { parsePhoneNumberWithError, isValidPhoneNumber, type CountryCode } from 'libphonenumber-js';
import { MessagingChannelError, formatForChannel } from './messagingChannelService';
import { settingsService } from './settingsService';
import { getWhatsAppCredentials } from '../utils/secretsManager';

// ── Errors ─────────────────────────────────────────────────────────────────

export class WhatsAppError extends MessagingChannelError {
  readonly subcode?: number;
  constructor(message: string, subcode?: number) {
    super(message, 'whatsapp');
    this.subcode = subcode;
  }
}

/** 131049 — Meta's US (+1) marketing-template pause, in effect since 2025-04-01. */
export class WhatsAppMarketingPausedError extends WhatsAppError {}
/** 131047 — outside the 24-hour service window; a template is required. */
export class WhatsAppWindowClosedError extends WhatsAppError {}
/** 131026 — recipient is not reachable on WhatsApp. */
export class WhatsAppUndeliverableError extends WhatsAppError {}
/** 130429 / 80007 — throughput or quota limit. */
export class WhatsAppRateLimitError extends WhatsAppError {}
/** The contact sent STOP. Refused locally; never reaches Meta. */
export class WhatsAppOptedOutError extends WhatsAppError {}

// ── Templates ──────────────────────────────────────────────────────────────

export interface WhatsAppTemplate {
  /** Exact name as approved in the WhatsApp Manager. */
  name: string;
  /** BCP-47 locale of the approved template. */
  language: string;
  /**
   * Variable names in POSITIONAL order. Meta binds body parameters by index
   * ({{1}}, {{2}}), not by name — reordering this array silently sends the wrong
   * words into the wrong slots. Names are documentation for the caller only.
   */
  variables: string[];
  /**
   * Meta template category. Kept explicit because it decides both price and
   * legality: 'marketing' cannot be delivered to +1 numbers at all (131049).
   */
  category: 'utility' | 'authentication' | 'marketing';
}

/**
 * The approved template registry.
 *
 * Every entry is deliberately `utility`: utility templates are deliverable to US
 * numbers and are free inside the service window, whereas marketing templates are
 * both billable and currently undeliverable to +1. Adding a `marketing` template
 * here is a product decision with a compliance consequence, not a code change.
 */
export const TEMPLATES = {
  SHIP_NOTIFY: {
    name: 'agentweb_ship_notify',
    language: 'en_US',
    variables: ['item_title', 'item_url'],
    category: 'utility',
  },
  LEAD_ALERT: {
    name: 'agentweb_lead_alert',
    language: 'en_US',
    variables: ['lead_name', 'lead_detail'],
    category: 'utility',
  },
  APPROVAL_REQUEST: {
    name: 'agentweb_approval_request',
    language: 'en_US',
    variables: ['asset_type', 'asset_name', 'review_url'],
    category: 'utility',
  },
} as const satisfies Record<string, WhatsAppTemplate>;

// ── Destination normalization ──────────────────────────────────────────────

/**
 * Strict E.164 normalization for a messaging destination.
 *
 * Deliberately stricter than `utils/phoneValidation.sanitizePhone`, whose digit-count
 * fallback exists so enrichment does not DISCARD an ambiguous local-format number.
 * Storing an ambiguous number is harmless; messaging one sends a customer's
 * notification to a stranger. Returns null rather than guessing.
 */
export function toE164(raw: string, defaultCountry?: CountryCode): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    if (!isValidPhoneNumber(trimmed, defaultCountry)) return null;
    return parsePhoneNumberWithError(trimmed, defaultCountry).number;
  } catch {
    return null;
  }
}

// ── Service window ─────────────────────────────────────────────────────────

const WINDOW_MS = 24 * 60 * 60 * 1000;
const windowKey = (phone: string) => `whatsapp:window:${phone}`;
const optOutKey = (phone: string) => `whatsapp:optout:${phone}`;

/**
 * Record an inbound message, opening (or extending) the 24-hour service window.
 *
 * The row carries a DynamoDB TTL so an expired window is reaped without a sweeper —
 * but `isServiceWindowOpen` still decides from the stored timestamp, because TTL
 * deletion is asynchronous and Dynamo guarantees no promptness.
 */
export async function recordInboundMessage(phone: string): Promise<void> {
  const now = new Date();
  await settingsService.setSetting(
    windowKey(phone),
    now.toISOString(),
    'WhatsApp 24h service window opened by an inbound message',
    'system',
    Math.floor((now.getTime() + WINDOW_MS) / 1000),
  );
}

export async function isServiceWindowOpen(phone: string): Promise<boolean> {
  const row = await settingsService.getSetting(windowKey(phone));
  if (!row?.settingValue) return false;
  const openedAt = Date.parse(row.settingValue);
  if (Number.isNaN(openedAt)) return false;
  return Date.now() - openedAt < WINDOW_MS;
}

// ── Consent ────────────────────────────────────────────────────────────────

/**
 * Opt-out is keyed on the phone number, not on a user or lead record.
 *
 * STOP is a platform obligation that must take effect immediately, including for a
 * number that maps to no known contact. It is also deliberately NOT the email
 * `unsubscribedFromGroupEmail` / `contactStatus` fields: those mean consent for a
 * different channel, and conflating them would let an email unsubscribe silently
 * revoke WhatsApp consent (or worse, the reverse).
 */
export async function recordOptOut(phone: string): Promise<void> {
  await settingsService.setSetting(
    optOutKey(phone),
    new Date().toISOString(),
    'WhatsApp opt-out (STOP)',
    'system',
  );
}

export async function recordOptIn(phone: string, source: string): Promise<void> {
  // Clearing the blocklist row IS the opt-in for messaging purposes; the durable
  // consent record with its source lives on the user's messagingChannels entry.
  console.log(`[whatsapp] opt-in for ${redactPhone(phone)} via ${source}`);
  await settingsService.deleteSetting(optOutKey(phone));
}

export async function isOptedOut(phone: string): Promise<boolean> {
  const row = await settingsService.getSetting(optOutKey(phone));
  return !!row?.settingValue;
}

/**
 * A phone number safe to put in a log line.
 *
 * A WhatsApp destination is someone's personal number — cleartext PII in application
 * logs (CWE-532) — so only the last 4 digits survive, which is enough to correlate a
 * log line with a support ticket without exposing the number itself.
 */
export function redactPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return digits.length <= 4 ? '*'.repeat(digits.length) : `${'*'.repeat(digits.length - 4)}${digits.slice(-4)}`;
}

// ── Graph transport ────────────────────────────────────────────────────────

const GRAPH_VERSION = process.env.WHATSAPP_GRAPH_VERSION || 'v23.0';

/** Meta error subcodes worth naming. Anything else surfaces with its raw code. */
const ERROR_MAP: Record<number, { cls: typeof WhatsAppError; message: string }> = {
  131049: {
    cls: WhatsAppMarketingPausedError,
    message:
      'Meta has paused marketing-template delivery to US (+1) numbers since 2025-04-01. ' +
      'Use a utility template, or reach this contact inside the 24-hour service window.',
  },
  131047: {
    cls: WhatsAppWindowClosedError,
    message:
      'Outside the 24-hour service window — a pre-approved template is required for this send.',
  },
  131026: {
    cls: WhatsAppUndeliverableError,
    message: 'Recipient is not reachable on WhatsApp (no account, or the number cannot receive).',
  },
  130429: { cls: WhatsAppRateLimitError, message: 'WhatsApp throughput limit reached.' },
  80007: { cls: WhatsAppRateLimitError, message: 'WhatsApp rate limit reached.' },
};

async function postToGraph(body: Record<string, unknown>): Promise<{ messageId: string | null }> {
  const creds = await getWhatsAppCredentials();
  const response = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/${creds.phoneNumberId}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${creds.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      // Without this, a Graph request that stops responding can hang for as long as the
      // process's global fetch dispatcher allows — up to 15 minutes on this codebase's
      // MCP HTTP client. shipNotifyService releases the failed channel's claim once this
      // eventually rejects, but every later send queues up behind it until then.
      signal: AbortSignal.timeout(10_000),
    },
  );

  if (!response.ok) {
    // A gateway/proxy failure returns HTML, not Meta's JSON envelope — parsing it
    // must not turn a 502 into an unrelated SyntaxError.
    let payload: any = null;
    try {
      payload = await response.json();
    } catch {
      /* fall through to the status-only error below */
    }

    const subcode: number | undefined =
      payload?.error?.error_subcode ?? payload?.error?.code ?? undefined;
    const mapped = subcode !== undefined ? ERROR_MAP[subcode] : undefined;
    if (mapped) throw new mapped.cls(mapped.message, subcode);

    if (response.status === 429) {
      throw new WhatsAppRateLimitError('WhatsApp rate limit reached.', subcode);
    }
    // Never interpolate credentials into an error — these get logged and surfaced.
    const detail = payload?.error?.message || `HTTP ${response.status}`;
    throw new WhatsAppError(
      `WhatsApp send failed (${subcode ?? 'no subcode'}): ${detail}`,
      subcode,
    );
  }

  const json: any = await response.json();
  return { messageId: json?.messages?.[0]?.id ?? null };
}

// ── Display number ─────────────────────────────────────────────────────────

let displayNumberCache: { phoneNumberId: string; digits: string } | null = null;

/** Test hook: forget the cached display number. */
export function __resetDisplayPhoneNumberCache(): void {
  displayNumberCache = null;
}

/**
 * The business number people message, as bare digits (no '+') for a wa.me link.
 *
 * Asked of Meta rather than configured: credentials carry the phone number ID, which
 * is not the number, and a hand-copied display number that drifts from the ID would
 * send customers' verification messages to somebody else's WhatsApp. Cached for the
 * process lifetime, keyed on the ID so a credential change is picked up.
 */
export async function getDisplayPhoneNumber(): Promise<string> {
  const creds = await getWhatsAppCredentials();
  if (displayNumberCache?.phoneNumberId === creds.phoneNumberId) return displayNumberCache.digits;

  const response = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/${creds.phoneNumberId}?fields=display_phone_number`,
    {
      headers: { Authorization: `Bearer ${creds.accessToken}` },
      signal: AbortSignal.timeout(8000),
    },
  );
  if (!response.ok) {
    // Never interpolate credentials into an error — these get logged and surfaced.
    throw new WhatsAppError(`Could not read the WhatsApp display number (HTTP ${response.status}).`);
  }
  const json: any = await response.json();
  const digits = String(json?.display_phone_number ?? '').replace(/\D/g, '');
  if (digits.length < 7) {
    throw new WhatsAppError('WhatsApp did not return a usable display number for this phone number ID.');
  }
  displayNumberCache = { phoneNumberId: creds.phoneNumberId, digits };
  return digits;
}

// ── Sending ────────────────────────────────────────────────────────────────

async function assertSendable(destination: string): Promise<string> {
  const phone = toE164(destination);
  if (!phone) {
    // Redacted even though this is the raw, not-yet-validated input: it is very
    // likely a real attempted phone number, and this error's .message ends up in
    // application logs at every catch site up the call chain — see redactPhone.
    throw new WhatsAppError(
      `"${redactPhone(destination)}" is not a valid phone number in E.164 form — refusing to send.`,
    );
  }
  if (await isOptedOut(phone)) {
    throw new WhatsAppOptedOutError(`${redactPhone(phone)} has opted out of WhatsApp messages (STOP).`);
  }
  return phone;
}

/** Meta's ceiling for one body parameter. */
const TEMPLATE_PARAM_MAX = 1024;
/**
 * Stand-in for a value that is empty once cleaned. Callers pass '' for an absent
 * optional value (e.g. no URL) precisely so the positional count stays right — but
 * Meta rejects an empty body parameter outright.
 */
const EMPTY_PARAM_PLACEHOLDER = '-';

/**
 * Make one value safe to bind into a template body parameter.
 *
 * Meta rejects, with a 400 that reads nothing like the cause: an empty parameter, a
 * newline or tab inside one, and a run of 4+ consecutive spaces (error 132018). The
 * values come from user-authored text — public post titles, lead names — so this is
 * enforced here, once, for every caller rather than left to each call site to remember.
 *
 * Also strips zero-width and bidi-override characters, which the free-form path
 * already strips via formatForChannel, so a template body is no easier to spoof.
 */
export function toTemplateParam(value: string): string {
  const cleaned = formatForChannel(value ?? '', 'whatsapp')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
  if (!cleaned) return EMPTY_PARAM_PLACEHOLDER;
  // Spread by code point so truncation cannot split a surrogate pair (emoji).
  const points = [...cleaned];
  return points.length > TEMPLATE_PARAM_MAX
    ? `${points.slice(0, TEMPLATE_PARAM_MAX - 1).join('')}…`
    : cleaned;
}

/** Send a pre-approved template. Legal inside and outside the service window. */
export async function sendTemplate(
  destination: string,
  template: WhatsAppTemplate,
  variables: string[],
): Promise<{ messageId: string | null }> {
  const phone = await assertSendable(destination);

  // Meta binds body parameters positionally, so a count mismatch does not error at
  // their end — it renders the wrong text, or an empty placeholder, to the customer.
  if (variables.length !== template.variables.length) {
    throw new WhatsAppError(
      `Template "${template.name}" expects ${template.variables.length} variables ` +
        `(${template.variables.join(', ')}) but got ${variables.length}.`,
    );
  }

  return postToGraph({
    messaging_product: 'whatsapp',
    to: phone,
    type: 'template',
    template: {
      name: template.name,
      language: { code: template.language },
      components: [
        {
          type: 'body',
          parameters: variables.map((text) => ({ type: 'text', text: toTemplateParam(text) })),
        },
      ],
    },
  });
}

/** Send free-form text. Only legal inside the 24-hour service window. */
export async function sendText(
  destination: string,
  text: string,
): Promise<{ messageId: string | null }> {
  const phone = await assertSendable(destination);
  // Enforced HERE, not only by sendMessage's caller-side check before it calls this —
  // sendText is exported, and a direct caller that skips sendMessage would otherwise
  // discover the window is shut as Meta's 131047, far from the call site, instead of a
  // clear local refusal. sendMessage already checked this immediately before calling
  // in; the extra read here is a settings-table lookup, not a network call to Meta.
  if (!(await isServiceWindowOpen(phone))) {
    throw new WhatsAppWindowClosedError(
      `${redactPhone(phone)} is outside the 24-hour service window.`,
    );
  }
  return postToGraph({
    messaging_product: 'whatsapp',
    to: phone,
    type: 'text',
    text: { body: text },
  });
}

export const OPT_OUT_CONFIRMATION =
  "You're opted out. AgentWeb won't send any more WhatsApp notifications to this number. " +
  'Reply UNSTOP to turn them back on.';

export const OPT_IN_CONFIRMATION =
  "You're opted back in. AgentWeb will send notifications to this WhatsApp number again. " +
  'Reply STOP at any time to opt out.';

/**
 * The one message an opted-out number is allowed to receive: confirmation that the
 * opt-out landed (ENG-273).
 *
 * Every other send goes through `assertSendable`, which refuses an opted-out number
 * outright. That is right for notifications and wrong for this: a STOP that is answered
 * with silence is indistinguishable, to the person who sent it, from a STOP that was
 * dropped. Acknowledging it once is what people expect from SMS, and the webhook records
 * the opt-out BEFORE calling this, so a failure here can never leave someone still
 * subscribed.
 *
 * Deliberately a separate narrow export rather than a `force`/`ignoreOptOut` flag on
 * sendText: a bypass any caller can pass is a bypass that eventually gets passed by
 * accident. This one takes no text and no template, so it cannot be repurposed into a
 * way to message someone who opted out — and it still honours the service window, which
 * the inbound STOP itself just opened.
 */
export async function sendOptOutConfirmation(
  destination: string,
): Promise<{ messageId: string | null }> {
  const phone = toE164(destination);
  if (!phone) {
    throw new WhatsAppError(
      `"${redactPhone(destination)}" is not a valid phone number in E.164 form — refusing to send.`,
    );
  }
  if (!(await isServiceWindowOpen(phone))) {
    throw new WhatsAppWindowClosedError(
      `${redactPhone(phone)} is outside the 24-hour service window.`,
    );
  }
  return postToGraph({
    messaging_product: 'whatsapp',
    to: phone,
    type: 'text',
    text: { body: OPT_OUT_CONFIRMATION },
  });
}


export interface WhatsAppSendParams {
  destination: string;
  text: string;
  /** Required to reach a contact outside the service window. */
  template?: { name: string; variables: string[] };
}

/**
 * Window-aware send: free text when the window is open, the supplied template when
 * it is not.
 *
 * Refuses locally when the window is shut and no template was given, rather than
 * letting Meta reject with 131047 — the caller learns at the call site that this
 * send needs a template, instead of discovering it as a delivery failure later.
 */
export async function sendMessage(
  params: WhatsAppSendParams,
): Promise<{ messageId: string | null }> {
  const phone = await assertSendable(params.destination);

  if (await isServiceWindowOpen(phone)) {
    return sendText(phone, params.text);
  }

  if (!params.template) {
    throw new WhatsAppWindowClosedError(
      `${redactPhone(phone)} is outside the 24-hour service window and no template was supplied. ` +
        'Free-form text cannot be delivered — pass a pre-approved template.',
    );
  }

  const template = Object.values(TEMPLATES).find((t) => t.name === params.template!.name);
  if (!template) {
    throw new WhatsAppError(
      `Unknown template "${params.template.name}". Approved templates: ` +
        Object.values(TEMPLATES)
          .map((t) => t.name)
          .join(', '),
    );
  }
  return sendTemplate(phone, template, params.template.variables);
}
