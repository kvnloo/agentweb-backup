/**
 * TwiML for the hot-lead call (ENG-2271). Hand-built strings so nothing here imports the Twilio
 * SDK (only voiceProvider.ts may, see the vendor metering guard).
 *
 * Copy is fixed text plus the org's announcedName. Visitor-supplied text must never be passed in:
 * it would be read aloud to the team member.
 *
 * Attribute reference (checked 2026-10-19):
 *   https://www.twilio.com/docs/voice/twiml/gather  (a timeout with no input falls through to the next verb)
 *   https://www.twilio.com/docs/voice/twiml/dial    (action receives DialCallStatus; callerId must be an owned number)
 *   https://www.twilio.com/docs/voice/twiml/number  (statusCallbackEvent: initiated ringing answered completed)
 */

export const CONNECTING_COPY = 'Connecting you now.';
export const NO_INPUT_COPY = 'We did not get a response. Goodbye.';
export const LEAD_UNREACHABLE_COPY = 'Sorry, we could not reach them. Goodbye.';
const memberPromptCopy = (announcedName: string): string => `New lead from ${announcedName}. Are you available to take the call now? Press 1.`;

const GATHER_TIMEOUT_SECONDS = 8;
/** Ring time for the lead; Twilio may add a few seconds of buffer. */
const LEAD_DIAL_TIMEOUT_SECONDS = 25;
/** Maximum length of the bridged call, in seconds (Twilio <Dial timeLimit>; its default is 4 hours). */
export const BRIDGED_CALL_TIME_LIMIT_SECONDS = 1800;

const E164 = /^\+[1-9]\d{6,14}$/;
// XML 1.0 forbids most control characters even when escaped; drop them rather than emit a document Twilio rejects.
// eslint-disable-next-line no-control-regex
const XML_FORBIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;

/** Escapes for both text nodes and double-quoted attribute values. */
export function escapeXml(value: string): string {
  return value
    .replace(XML_FORBIDDEN, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const response = (...verbs: string[]): string => `<?xml version="1.0" encoding="UTF-8"?><Response>${verbs.join('')}</Response>`;
const say = (text: string): string => `<Say>${escapeXml(text)}</Say>`;

function requireE164(value: string, what: string): string {
  if (!E164.test(value)) throw new Error(`TwiML ${what} is not E.164`);
  return value;
}

export function hangupTwiml(): string {
  return response('<Hangup/>');
}

export function memberPromptTwiml(p: { announcedName: string; gatherUrl: string }): string {
  return response(
    `<Gather input="dtmf" numDigits="1" timeout="${GATHER_TIMEOUT_SECONDS}" action="${escapeXml(p.gatherUrl)}" method="POST">${say(memberPromptCopy(p.announcedName))}</Gather>`,
    say(NO_INPUT_COPY),
    '<Hangup/>',
  );
}

/** `statusUrl` must already carry leg=lead so the status route knows which leg a callback is for. */
export function connectTwiml(p: { twilioNumber: string; leadE164: string; dialUrl: string; statusUrl: string }): string {
  const number =
    `<Number statusCallback="${escapeXml(p.statusUrl)}" statusCallbackEvent="initiated ringing answered completed" statusCallbackMethod="POST">` +
    `${requireE164(p.leadE164, 'lead number')}</Number>`;
  return response(
    say(CONNECTING_COPY),
    `<Dial callerId="${requireE164(p.twilioNumber, 'caller id')}" timeout="${LEAD_DIAL_TIMEOUT_SECONDS}" timeLimit="${BRIDGED_CALL_TIME_LIMIT_SECONDS}" action="${escapeXml(p.dialUrl)}" method="POST">${number}</Dial>`,
  );
}

export function leadUnreachableTwiml(): string {
  return response(say(LEAD_UNREACHABLE_COPY), '<Hangup/>');
}

/** Destination-verification call: the fixed phrase and the six digits, spaced so text-to-speech reads them one by one. */
export function verificationCodeTwiml(code: string): string {
  if (!/^\d{6}$/.test(code)) throw new Error('verification code must be 6 digits');
  const spoken = code.split('').join(' ');
  return response(`<Pause length="1"/>`, say(`Your Agent Web verification code is ${spoken}. Again, your code is ${spoken}. Goodbye.`));
}
