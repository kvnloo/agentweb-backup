/** The six-digit verification code that a placed verification call reads out (spaced digits in its TwiML). */
export function spokenCode(placedCall: unknown): string {
  const twiml = (placedCall as { twiml: string }).twiml;
  return /code is ((?:\d ){5}\d)\./.exec(twiml)![1].replace(/ /g, '');
}
