import { toE164 } from '../whatsappService';

// ENG-2783: the visitor's consent to be called by an automated (computer-generated voice) call, recorded at form submission
// and checked by the hot-lead call gate `no_call_consent`. See backend/docs/integrations/hot-lead-call.md "Call consent".

/** Version tag of the approved notice below; sent by the generated form as `callConsent.version`. */
export const CALL_CONSENT_NOTICE_VERSION = 'v1';

/** A bracketed placeholder or the old literal placeholder, in any case or spacing. Text containing one is never accepted as consent. */
const PLACEHOLDER_RE = /\[[^\]]*name[^\]]*\]|registered\s*business\s*name/i;

/**
 * The digits of the E.164 form of a phone, normalised exactly as the hot-lead call normalises a lead's phone
 * (`toE164(raw, 'US')`, as in callableLeadPhone), or '' when it is not a number. Consent is bound to this value.
 */
export const consentPhoneDigits = (raw: unknown): string => {
  const e164 = typeof raw === 'string' ? toE164(raw, 'US') : null;
  return e164 ? e164.replace(/\D/g, '') : '';
};

/** The approved notice shown next to the unchecked box. `businessName` must be the REGISTERED legal name of the business that places the call. */
export const buildCallConsentNotice = (businessName: string): string =>
  `By checking this box and submitting, I agree that ${businessName} may call me at the number above about my enquiry, ` +
  'including automated calls that use a computer-generated voice. Agreeing is not a condition of purchase. ' +
  'I can stop calls at any time by pressing 3 on a call.';

const TEXT_MIN = 40;
const TEXT_MAX = 1000;
const VERSION_RE = /^[A-Za-z0-9._-]{1,32}$/;
const FIELD_CAP = 300;

// A type alias (not an interface) so the record is assignable to Record<string, unknown> where it is written without a cast.
export type CallConsentRecord = {
  granted: true;
  text: string;
  version?: string;
  /** E.164 digits of the number the visitor submitted; the record is consent for THIS number only (see hasCallConsent). */
  phoneDigits?: string;
  /** Server clock, never supplied by the client. */
  capturedAt: string;
  pageUrl?: string;
  ip?: string;
  userAgent?: string;
  source: 'form' | 'operator';
  /** Operator back-fill only: why consent is recorded without a form. */
  note?: string;
};

export type CallConsentParse =
  | { ok: true; text: string; version?: string }
  | { ok: false; reason: 'absent' | 'unchecked' | 'not_object' | 'not_granted' | 'bad_text' | 'text_too_short' | 'text_too_long' | 'text_no_call_word' | 'text_no_automated_word' | 'placeholder_name' | 'bad_version' };

/** Validates the wire field `callConsent`. `absent` is the normal "form had no notice" case; everything else is a malformed one. */
export function parseCallConsent(raw: unknown): CallConsentParse {
  if (raw === undefined || raw === null) return { ok: false, reason: 'absent' };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'not_object' };
  const { granted, text, version } = raw as Record<string, unknown>;
  if (granted === false) return { ok: false, reason: 'unchecked' }; // an unticked box is the normal case, like an absent field
  if (granted !== true) return { ok: false, reason: 'not_granted' };
  if (typeof text !== 'string') return { ok: false, reason: 'bad_text' };
  const trimmed = text.trim();
  if (trimmed.length < TEXT_MIN) return { ok: false, reason: 'text_too_short' };
  if (trimmed.length > TEXT_MAX) return { ok: false, reason: 'text_too_long' };
  if (!/\bcall/i.test(trimmed)) return { ok: false, reason: 'text_no_call_word' };
  if (!/\bautomated\b/i.test(trimmed)) return { ok: false, reason: 'text_no_automated_word' };
  if (PLACEHOLDER_RE.test(trimmed)) return { ok: false, reason: 'placeholder_name' };
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
  ctx: { phone: unknown; pageUrl?: string; ip?: string; userAgent?: string },
  now: Date = new Date(),
): CallConsentRecord {
  return {
    granted: true,
    text: parsed.text,
    ...(parsed.version ? { version: parsed.version } : {}),
    phoneDigits: consentPhoneDigits(ctx.phone),
    capturedAt: now.toISOString(),
    ...(ctx.pageUrl ? { pageUrl: ctx.pageUrl.slice(0, FIELD_CAP) } : {}),
    ...(ctx.ip ? { ip: ctx.ip.slice(0, 64) } : {}),
    ...(ctx.userAgent ? { userAgent: ctx.userAgent.slice(0, FIELD_CAP) } : {}),
    source: 'form',
  };
}

/**
 * The gate's question: does the lead carry a consent record FOR THE NUMBER IT WOULD BE CALLED ON. Stateless. A record without
 * `phoneDigits`, or a lead without a callable phone, is not consent: a changed phone can never inherit an old record.
 */
export function hasCallConsent(lead: { phone?: unknown; system?: Record<string, unknown> | null }): boolean {
  const rec = lead?.system?.callConsent as { granted?: unknown; phoneDigits?: unknown } | undefined;
  if (rec?.granted !== true || typeof rec.phoneDigits !== 'string' || !rec.phoneDigits) return false;
  return rec.phoneDigits === consentPhoneDigits(lead.phone);
}
