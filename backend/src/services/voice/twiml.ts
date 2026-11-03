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
 *   https://www.twilio.com/docs/voice/twiml/number  (statusCallbackEvent: initiated ringing answered completed;
 *     `url` runs on the called party's leg after they answer and before the parties are bridged: only
 *     Gather/Say/Hangup-style verbs, never Dial; a hangup there ends the parent Dial with
 *     DialCallStatus=completed and DialBridged=false; answerOnBridge="true" on the Dial is required for it)
 */

export const CONNECTING_COPY = 'Calling the lead now, please hold.';
export const LEAD_PHONE_CHANGED_COPY = 'We could not reach the lead. Their details are in your lead alert.';
export const LEAD_DECLINED_COPY = 'The lead did not confirm. Their details are in your lead alert.';
export const SCREEN_NO_INPUT_COPY = 'We did not get your answer. Goodbye.';
const screenPromptCopy = (announcedName: string): string => `${announcedName} would like to talk to you about your enquiry. Press 1 to be connected now.`;
export const NO_INPUT_COPY = 'We did not get a response. Goodbye.';
export const LEAD_UNREACHABLE_COPY = 'Sorry, we could not reach them. Goodbye.';
const memberPromptCopy = (announcedName: string): string => `New lead from ${announcedName}. Are you available to take the call now? Press 1.`;

const inboundMemberPromptCopy = (announcedName: string): string => `${announcedName}: a lead is calling back. Are you available to take the call? Press 1.`;
/** The caller is told this when the number cannot be served at all (unknown, switched off, not entitled, misconfigured). */
export const INBOUND_UNAVAILABLE_COPY = 'Sorry, we are unable to take your call right now. Goodbye.';
/** The caller is told this when the number is live but no member accepted or none was available. */
export const INBOUND_NOBODY_COPY = 'Sorry, nobody is available to take your call right now. Please try again later. Goodbye.';

const GATHER_TIMEOUT_SECONDS = 8;
/** Ring time for the lead or, on a callback, for each member; Twilio may add a few seconds of buffer. */
const LEAD_DIAL_TIMEOUT_SECONDS = 25;
/** Maximum length of the bridged call, in seconds (Twilio <Dial timeLimit>; its default is 4 hours). */
const BRIDGED_CALL_TIME_LIMIT_SECONDS = 1800;

const E164 = /^\+[1-9]\d{6,14}$/;
// XML 1.0 forbids most control characters even when escaped; drop them rather than emit a document Twilio rejects.
// eslint-disable-next-line no-control-regex -- the control characters are exactly what this pattern removes
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

const pressOneGather = (prompt: string, actionUrl: string): string =>
  `<Gather input="dtmf" numDigits="1" timeout="${GATHER_TIMEOUT_SECONDS}" action="${escapeXml(actionUrl)}" method="POST">${say(prompt)}</Gather>`;

export function memberPromptTwiml(p: { announcedName: string; gatherUrl: string }): string {
  return response(
    pressOneGather(memberPromptCopy(p.announcedName), p.gatherUrl),
    say(NO_INPUT_COPY),
    '<Hangup/>',
  );
}

/**
 * `statusUrl` must already carry leg=lead so the status route knows which leg a callback is for. `screenUrl`
 * is fetched on the lead's leg once the lead answers: the lead must press 1 there before the two are bridged.
 */
export function connectTwiml(p: { twilioNumber: string; leadE164: string; dialUrl: string; statusUrl: string; screenUrl: string }): string {
  const number =
    `<Number url="${escapeXml(p.screenUrl)}" method="POST" statusCallback="${escapeXml(p.statusUrl)}" statusCallbackEvent="initiated ringing answered completed" statusCallbackMethod="POST">` +
    `${requireE164(p.leadE164, 'lead number')}</Number>`;
  return response(
    say(CONNECTING_COPY),
    `<Dial answerOnBridge="true" callerId="${requireE164(p.twilioNumber, 'caller id')}" timeout="${LEAD_DIAL_TIMEOUT_SECONDS}" timeLimit="${BRIDGED_CALL_TIME_LIMIT_SECONDS}" action="${escapeXml(p.dialUrl)}" method="POST">${number}</Dial>`,
  );
}

export function leadUnreachableTwiml(): string {
  return response(say(LEAD_UNREACHABLE_COPY), '<Hangup/>');
}

export function leadPhoneChangedTwiml(): string {
  return response(say(LEAD_PHONE_CHANGED_COPY), '<Hangup/>');
}

export function leadDeclinedTwiml(): string {
  return response(say(LEAD_DECLINED_COPY), '<Hangup/>');
}

/** What the lead hears on answering: press 1 or nothing is connected. No input falls through to the goodbye and hangup. */
export function leadScreenTwiml(p: { announcedName: string; resultUrl: string }): string {
  return response(
    pressOneGather(screenPromptCopy(p.announcedName), p.resultUrl),
    say(SCREEN_NO_INPUT_COPY),
    '<Hangup/>',
  );
}

/** An empty response ends the screening leg normally, which lets Twilio bridge the two calls. */
export function bridgeTwiml(): string {
  return '<?xml version="1.0" encoding="UTF-8"?><Response/>';
}

/** Team-member verification call: the fixed phrase and the six digits, spaced so text-to-speech reads them one by one. */
export function verificationCodeTwiml(code: string): string {
  if (!/^\d{6}$/.test(code)) throw new Error('verification code must be 6 digits');
  const spoken = code.split('').join(' ');
  return response(`<Pause length="1"/>`, say(`Your Agent Web verification code is ${spoken}. Again, your code is ${spoken}. Goodbye.`));
}

// ── inbound callbacks: a lead dials the org's number back ──────────────────────────────────────────────

/** Said to the caller, then hung up on. Nothing is recorded and there is no voicemail. */
export function inboundUnavailableTwiml(): string {
  return response(say(INBOUND_UNAVAILABLE_COPY), '<Hangup/>');
}

export function inboundNobodyTwiml(): string {
  return response(say(INBOUND_NOBODY_COPY), '<Hangup/>');
}

/**
 * Rings one team member on the caller's call. `screenUrl` runs on the member's leg once they answer (they must
 * press 1 before the two are bridged, exactly like the lead screening on an outbound call), `dialUrl` reports how
 * the attempt ended, and `statusUrl` receives the member leg's final progress callback (the only metered leg).
 * The caller ID is the org's own number, which Twilio always accepts for a number the account owns.
 */
export function inboundRingTwiml(p: { memberE164: string; callerId: string; screenUrl: string; dialUrl: string; statusUrl: string }): string {
  const number =
    `<Number url="${escapeXml(p.screenUrl)}" method="POST" statusCallback="${escapeXml(p.statusUrl)}" statusCallbackEvent="completed" statusCallbackMethod="POST">` +
    `${requireE164(p.memberE164, 'member number')}</Number>`;
  return response(
    `<Dial answerOnBridge="true" callerId="${requireE164(p.callerId, 'caller id')}" timeout="${LEAD_DIAL_TIMEOUT_SECONDS}" timeLimit="${BRIDGED_CALL_TIME_LIMIT_SECONDS}" action="${escapeXml(p.dialUrl)}" method="POST">${number}</Dial>`,
  );
}

/** What the member hears on answering a callback: press 1 or the caller is not connected. No input falls through to the goodbye. */
export function inboundMemberScreenTwiml(p: { announcedName: string; resultUrl: string }): string {
  return response(pressOneGather(inboundMemberPromptCopy(p.announcedName), p.resultUrl), say(NO_INPUT_COPY), '<Hangup/>');
}
