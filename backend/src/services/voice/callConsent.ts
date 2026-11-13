// ENG-2783: the visitor's consent to be called by an automated (computer-generated voice) call, recorded at form submission
// and checked by the hot-lead call gate `no_call_consent`. See backend/docs/integrations/hot-lead-call.md "Call consent".

/** Version tag of the approved notice below; sent by the generated form as `callConsent.version`. */
export const CALL_CONSENT_NOTICE_VERSION = 'v1';

/** Stands in for the registered legal name until the owner supplies one. Text that still contains it is never accepted as consent. */
export const CALL_CONSENT_NAME_PLACEHOLDER = '[REGISTERED BUSINESS NAME]';

/** The approved notice shown next to the unchecked box. `businessName` must be the REGISTERED legal name of the business that places the call. */
export const buildCallConsentNotice = (businessName: string): string =>
  `By checking this box and submitting, I agree that ${businessName} may call me at the number above about my enquiry, ` +
  'including automated calls that use a computer-generated voice. Agreeing is not a condition of purchase. ' +
  'I can stop calls at any time by pressing 3 on a call.';

const TEXT_MIN = 40;
const TEXT_MAX = 1000;
const VERSION_RE = /^[A-Za-z0-9._-]{1,32}$/;
const FIELD_CAP = 300;

export interface CallConsentRecord {
  granted: true;
  text: string;
  version?: string;
  /** Server clock, never supplied by the client. */
  capturedAt: string;
  pageUrl?: string;
  ip?: string;
  userAgent?: string;
  source: 'form' | 'operator';
  /** Operator back-fill only: why consent is recorded without a form. */
  note?: string;
}

export type CallConsentParse =
  | { ok: true; text: string; version?: string }
  | { ok: false; reason: 'absent' | 'not_object' | 'not_granted' | 'bad_text' | 'text_too_short' | 'text_too_long' | 'text_no_call_word' | 'placeholder_name' | 'bad_version' };

/** Validates the wire field `callConsent`. `absent` is the normal "form had no notice" case; everything else is a malformed one. */
export function parseCallConsent(raw: unknown): CallConsentParse {
  if (raw === undefined || raw === null) return { ok: false, reason: 'absent' };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'not_object' };
  const { granted, text, version } = raw as Record<string, unknown>;
  if (granted !== true) return { ok: false, reason: 'not_granted' };
  if (typeof text !== 'string') return { ok: false, reason: 'bad_text' };
  const trimmed = text.trim();
  if (trimmed.length < TEXT_MIN) return { ok: false, reason: 'text_too_short' };
  if (trimmed.length > TEXT_MAX) return { ok: false, reason: 'text_too_long' };
  if (!/\bcall/i.test(trimmed)) return { ok: false, reason: 'text_no_call_word' };
  if (trimmed.includes(CALL_CONSENT_NAME_PLACEHOLDER)) return { ok: false, reason: 'placeholder_name' };
  if (version !== undefined && (typeof version !== 'string' || !VERSION_RE.test(version))) return { ok: false, reason: 'bad_version' };
  return { ok: true, text: trimmed, ...(version !== undefined ? { version: version as string } : {}) };
}

/** `https://host/path` from a Referer/Origin value: no query string, no fragment, no credentials, capped. */
export function pageUrlOf(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined;
    return `${u.protocol}//${u.host}${u.pathname}`.slice(0, FIELD_CAP);
  } catch {
    return undefined;
  }
}

/** The stored record. `capturedAt` is the server's own clock. Optional facts are omitted rather than written empty. */
export function buildCallConsentRecord(
  parsed: { text: string; version?: string },
  ctx: { pageUrl?: string; ip?: string; userAgent?: string },
  now: Date = new Date(),
): CallConsentRecord {
  return {
    granted: true,
    text: parsed.text,
    ...(parsed.version ? { version: parsed.version } : {}),
    capturedAt: now.toISOString(),
    ...(ctx.pageUrl ? { pageUrl: ctx.pageUrl.slice(0, FIELD_CAP) } : {}),
    ...(ctx.ip ? { ip: ctx.ip.slice(0, 64) } : {}),
    ...(ctx.userAgent ? { userAgent: ctx.userAgent.slice(0, FIELD_CAP) } : {}),
    source: 'form',
  };
}

/** The gate's question: does the lead carry a consent record. Stateless. */
export const hasCallConsent = (lead: { system?: Record<string, unknown> | null }): boolean =>
  (lead?.system?.callConsent as { granted?: unknown } | undefined)?.granted === true;
