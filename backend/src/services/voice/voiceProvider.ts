import twilio from 'twilio';
import { getTwilioCredentials, type TwilioCredentials } from '../../utils/secretsManager';
import { redactPhone } from '../whatsappService';

export interface PlaceCallParams {
  to: string;
  from: string;
  /** TwiML webhook Twilio fetches when the callee answers. */
  url: string;
  statusCallbackUrl: string;
  timeoutSeconds: number;
}

export interface BuyNumberParams {
  /** ISO 3166-1 alpha-2, e.g. 'US'. */
  countryCode: string;
  areaCode?: string;
}

export interface ValidateSignatureParams {
  /** The exact URL Twilio was configured with, query string included. */
  url: string;
  params: Record<string, string>;
  signature: string | undefined;
}

/**
 * Telephony seam for the hot-lead auto-call (ENG-2271). Everything that touches Twilio goes
 * through this interface so the call flow is testable with the recording fake.
 *
 * buyNumber and releaseNumber are non-idempotent account changes. If either fails ambiguously
 * (timeout, 5xx, dropped connection) the purchase or release may have happened anyway: a failed
 * buyNumber can leave an orphan number that is billed but unrecorded, and a failed releaseNumber
 * a number that is still billed. Callers must reconcile against Twilio before retrying.
 */
export interface VoiceProvider {
  /**
   * Loads the current credentials. validateSignature is synchronous (the contract), so it can
   * only use a token that an awaited call has already loaded: webhook handlers MUST await this
   * first. Without it validateSignature returns false (fail closed), never a false accept.
   *
   * Handler contract: wrap `await ensureCredentials()` in try/catch. A VoiceCallError means
   * "cannot verify", so respond 503 (Twilio retries) and process nothing. Then a false
   * validateSignature means 401.
   *
   * A failed call does not discard the last good token: validateSignature keeps verifying with
   * it. Twilio status callbacks are the metering input and must survive a Secrets Manager blip;
   * the token's age is bounded by the credentials cache TTL plus the next successful load.
   */
  ensureCredentials(): Promise<void>;
  placeCall(p: PlaceCallParams): Promise<{ callSid: string }>;
  buyNumber(p: BuyNumberParams): Promise<{ numberSid: string; phoneNumber: string }>;
  releaseNumber(numberSid: string): Promise<void>;
  validateSignature(p: ValidateSignatureParams): boolean;
}

/**
 * Thrown by every VoiceProvider operation that talks to Twilio, and only ever this type: the raw
 * SDK error (an AxiosError carrying the Basic auth header) is never kept, so there is no cause and
 * nothing beyond the scrubbed message and `placed`.
 *
 * `placed` says whether the account-side change (the call, the purchase, the release) may have
 * been made, so the caller knows whether a retry could repeat it:
 *   'no'      Twilio rejected the request (4xx: validation, auth, rate limit); nothing was changed
 *   'unknown' timeout, network error or 5xx; the change may or may not have happened
 */
export class VoiceCallError extends Error {
  constructor(
    message: string,
    readonly placed: 'no' | 'unknown',
  ) {
    super(message);
    this.name = 'VoiceCallError';
  }
}

// Bounds how long any SDK call (call, search, purchase, release) can hang; the SDK's default is 30s.
const REQUEST_TIMEOUT_MS = 15_000;

// Twilio echoes the dialled number in its error text (21211: "The 'To' number +1555... is not a
// valid phone number."). This message is logged and persisted, so any 7+ digit run is removed,
// including non-ASCII decimal digits and the separators people type inside a number (spaces,
// dots, dashes of any width, slashes, brackets). Twilio resource SIDs (two letters + 32 hex,
// e.g. CA... call, PN... number) are matched first and passed through untouched: they are
// identifiers worth keeping and can contain long digit runs. Account SIDs (AC...) are the
// exception: they are half of the API credential, so ACCOUNT_SID redacts them before this runs.
const ACCOUNT_SID = /\bAC[0-9a-f]{32}\b/g;
const RESOURCE_SID = /\b[A-Z]{2}[0-9a-f]{32}\b/;
const PHONE_LIKE = /\+?\p{Nd}(?:[\s().\-\u2010-\u2015\u2212/]*\p{Nd}){6,}/u;
const SCRUB = new RegExp(`(${RESOURCE_SID.source})|${PHONE_LIKE.source}`, 'gu');
// A Basic Authorization value is base64(sid:token); the SDK never puts it in a message, but a
// proxy or HTTP layer could.
const BASIC_AUTH = /\bBasic\s+[A-Za-z0-9+/=_-]{20,}/g;

// Below this length an exact-value redaction would mangle ordinary words in the message
// (a 1-char token would replace every occurrence of that letter); real tokens are 32 chars.
const MIN_REDACTABLE_SECRET = 8;

/**
 * Removes anything credential-like, then phone numbers, from error text. `credentials` is absent
 * when the failure happened before any were loaded.
 */
function scrubErrorText(text: string, credentials?: TwilioCredentials): string {
  // Exact values first: they are what we know for certain must not leak, whatever their shape.
  // The bare base64 of sid:token is what a Basic header carries, with or without its prefix.
  const known = credentials
    ? [credentials.accountSid, credentials.authToken, Buffer.from(`${credentials.accountSid}:${credentials.authToken}`).toString('base64')]
    : [];
  return known
    .filter((v) => v.length >= MIN_REDACTABLE_SECRET)
    .reduce((acc, v) => acc.split(v).join('[redacted]'), text)
    .replace(BASIC_AUTH, 'Basic [redacted]')
    .replace(ACCOUNT_SID, '[redacted]')
    .replace(SCRUB, (m, resourceSid) => (resourceSid ? m : '[number]'));
}

/**
 * Reduces any SDK failure to a VoiceCallError whose message names the operation and, when
 * present, appends the HTTP status and Twilio error code as text, followed by the scrubbed SDK
 * message (see VoiceCallError for why the raw error is dropped).
 */
function sanitizeSdkError(err: unknown, operation: string, credentials?: TwilioCredentials): VoiceCallError {
  const e = err as { status?: unknown; code?: unknown; message?: unknown } | null;
  const status = typeof e?.status === 'number' ? e.status : undefined;
  const twilioCode = typeof e?.code === 'number' ? e.code : undefined;
  const detail = scrubErrorText(typeof e?.message === 'string' ? e.message : 'unknown error', credentials);
  // 408 is a server-side timeout: the request may have been acted on. Every other 4xx is a
  // rejection before anything was changed. Anything without an HTTP status is transport-level.
  const definitelyNotPlaced = status !== undefined && status >= 400 && status < 500 && status !== 408;
  return new VoiceCallError(
    `Twilio ${operation} failed${status ? ` (HTTP ${status}${twilioCode ? `, code ${twilioCode}` : ''})` : ''}: ${detail}`,
    definitelyNotPlaced ? 'no' : 'unknown',
  );
}

type TwilioClient = ReturnType<typeof twilio>;
type Active = TwilioCredentials & { client: TwilioClient };

class TwilioVoiceProvider implements VoiceProvider {
  private active: Active | null = null;

  // getTwilioCredentials caches with a TTL, so calling this per request is cheap and a rotated
  // token is picked up without a restart. The client is rebuilt only when the credentials change.
  private async current(): Promise<Active> {
    const { accountSid, authToken } = await getTwilioCredentials();
    // Blank credentials would only fail later as a 401 (or throw in the SDK); nothing was sent.
    if (!accountSid.trim() || !authToken.trim()) throw new Error('Twilio credentials are blank');
    if (!this.active || this.active.accountSid !== accountSid || this.active.authToken !== authToken) {
      this.active = { accountSid, authToken, client: twilio(accountSid, authToken, { timeout: REQUEST_TIMEOUT_MS, autoRetry: false }) };
    }
    return this.active;
  }

  // A credentials failure happens before any request, so nothing was changed. The message is
  // scrubbed like any other because it comes from a lower layer.
  private async credentials(): Promise<Active> {
    try {
      return await this.current();
    } catch (err) {
      throw new VoiceCallError(`Twilio credentials unavailable: ${scrubErrorText(err instanceof Error ? err.message : 'unknown')}`, 'no');
    }
  }

  async ensureCredentials(): Promise<void> {
    await this.credentials();
  }

  // The one place SDK errors are caught and logged: whatever the SDK throws, only a sanitized
  // VoiceCallError leaves this class (as with ensureCredentials). `target` must already be
  // redacted (it goes to the log line).
  private async run<T>(operation: string, target: string, fn: (client: TwilioClient) => Promise<T>): Promise<T> {
    const fail = (e: VoiceCallError): never => {
      console.error(`[voice] ${operation}${target} failed (placed=${e.placed}): ${e.message}`);
      throw e;
    };
    let active: Active | undefined;
    try {
      active = await this.credentials();
      return await fn(active.client);
    } catch (err) {
      return fail(err instanceof VoiceCallError ? err : sanitizeSdkError(err, operation, active));
    }
  }

  async placeCall(p: PlaceCallParams): Promise<{ callSid: string }> {
    return this.run('placeCall', ` to ${redactPhone(p.to)}`, async (client) => {
      const call = await client.calls.create({
        to: p.to,
        from: p.from,
        url: p.url,
        statusCallback: p.statusCallbackUrl,
        statusCallbackEvent: ['completed'],
        timeout: p.timeoutSeconds,
      });
      // A 2xx without a sid still means Twilio accepted something: a call may exist.
      if (typeof call.sid !== 'string' || !call.sid) {
        throw new VoiceCallError('Twilio placeCall response carried no call sid; a call may exist', 'unknown');
      }
      return { callSid: call.sid };
    });
  }

  async buyNumber(p: BuyNumberParams): Promise<{ numberSid: string; phoneNumber: string }> {
    // Reject before spending anything: Number('') or Number('1e3') would otherwise be searched as a real area code.
    if (p.areaCode !== undefined && !/^\d{3}$/.test(p.areaCode)) {
      throw new VoiceCallError('Invalid area code: expected exactly 3 digits', 'no');
    }
    return this.run('buyNumber', '', async (client) => {
      const [available] = await client.availablePhoneNumbers(p.countryCode).local.list({
        areaCode: p.areaCode === undefined ? undefined : Number(p.areaCode),
        voiceEnabled: true,
        limit: 1,
      });
      if (!available) throw new VoiceCallError(`No voice-enabled number available for ${p.countryCode}${p.areaCode ? `/${p.areaCode}` : ''}`, 'no');
      const bought = await client.incomingPhoneNumbers.create({ phoneNumber: available.phoneNumber });
      // A 2xx without a sid still means the purchase may have happened: an orphan number.
      if (typeof bought.sid !== 'string' || !bought.sid) {
        throw new VoiceCallError('Twilio buyNumber response carried no number sid; a number may have been bought', 'unknown');
      }
      return { numberSid: bought.sid, phoneNumber: bought.phoneNumber };
    });
  }

  async releaseNumber(numberSid: string): Promise<void> {
    await this.run('releaseNumber', '', async (client) => {
      await client.incomingPhoneNumbers(numberSid).remove();
    });
  }

  validateSignature(p: ValidateSignatureParams): boolean {
    if (!p.signature || !this.active) return false;
    try {
      return twilio.validateRequest(this.active.authToken, p.signature, p.url, p.params);
    } catch {
      return false;
    }
  }
}

let provider: VoiceProvider | null = null;

export function getVoiceProvider(): VoiceProvider {
  if (!provider) provider = new TwilioVoiceProvider();
  return provider;
}

/** Tests only. Pass null to restore the real provider. */
export function setVoiceProviderForTests(p: VoiceProvider | null): void {
  provider = p;
}
