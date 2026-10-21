/**
 * The Twilio side of the hot-lead call end-to-end test (ENG-2271): a VoiceProvider whose signature check is
 * Twilio's own algorithm, and a caller that behaves like Twilio's webhook client. It only ever follows the URLs
 * the app handed out (the placeCall URLs, then the action/statusCallback URLs inside the TwiML it was answered
 * with), so a URL the app got wrong cannot be papered over by the test knowing the right one.
 */
import express from 'express';
import request from 'supertest';
import { getExpectedTwilioSignature, validateRequest } from 'twilio';
import { FakeVoiceProvider } from './fakeVoiceProvider';
import type { ValidateSignatureParams } from '../../services/voice/voiceProvider';
import twilioVoiceWebhookRoutes, { twilioVoiceBodyParser } from '../../routes/twilioVoiceWebhook';

const TEST_AUTH_TOKEN = 'test-auth-token-0123456789abcdef0123';
export const MOUNT = '/api/webhooks/twilio-voice';

/** The strict fake, with the signature check swapped for Twilio's real HMAC over the URL and form params. */
export class SignedFakeVoiceProvider extends FakeVoiceProvider {
  override validateSignature(p: ValidateSignatureParams): boolean {
    // super() keeps the "ensureCredentials() must have been awaited" strictness and records the check.
    return super.validateSignature(p) && !!p.signature && validateRequest(TEST_AUTH_TOKEN, p.signature, p.url, p.params);
  }
}

/** Same stack order as app.ts: the route's narrow body parser first, then the global wide ones. */
function buildWebhookApp(): express.Express {
  const app = express();
  app.use(MOUNT, twilioVoiceBodyParser);
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ limit: '50mb', extended: true }));
  app.use(MOUNT, twilioVoiceWebhookRoutes);
  return app;
}

const unescapeXml = (s: string): string =>
  s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** The value of the first `name="..."` attribute in a TwiML document, XML-unescaped. */
export function attrOf(xml: string, name: string): string {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(xml);
  if (!m) throw new Error(`TwiML has no ${name} attribute: ${xml}`);
  return unescapeXml(m[1]);
}

export const sayText = (xml: string): string => unescapeXml(/<Say>([^<]*)<\/Say>/.exec(xml)?.[1] ?? '');

interface TwilioReply { status: number; body: string }

/**
 * Posts like Twilio: the fragment of a webhook URL is never sent and never signed; the signature covers the
 * absolute URL (query included) plus the form parameters, computed with the account auth token.
 */
export class TwilioCaller {
  private readonly app = buildWebhookApp();

  async post(
    absoluteUrl: string,
    params: Record<string, string>,
    opts: { signWith?: string | null; signedUrl?: string } = {},
  ): Promise<TwilioReply> {
    const sent = new URL(absoluteUrl);
    sent.hash = '';
    const signedUrl = opts.signedUrl ?? sent.toString();
    const req = request(this.app).post(`${sent.pathname}${sent.search}`).type('form');
    if (opts.signWith !== null) req.set('X-Twilio-Signature', getExpectedTwilioSignature(opts.signWith ?? TEST_AUTH_TOKEN, signedUrl, params));
    const res = await req.send(params);
    return { status: res.status, body: res.text };
  }
}
