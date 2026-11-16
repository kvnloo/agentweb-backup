const mockCreate = jest.fn();
const mockLocalList = jest.fn();
const mockIncomingCreate = jest.fn();
const mockRemove = jest.fn();
const mockGetCreds = jest.fn();

jest.mock('twilio', () => {
  const actual = jest.requireActual('twilio');
  const factory = jest.fn(() => {
    const incoming = jest.fn(() => ({ remove: mockRemove }));
    Object.assign(incoming, { create: mockIncomingCreate });
    return {
      calls: { create: mockCreate },
      availablePhoneNumbers: jest.fn(() => ({ local: { list: mockLocalList } })),
      incomingPhoneNumbers: incoming,
    };
  });
  // Keep the real signature functions so validateSignature is checked against Twilio's own algorithm.
  Object.assign(factory, { validateRequest: actual.validateRequest, getExpectedTwilioSignature: actual.getExpectedTwilioSignature });
  return { __esModule: true, default: factory, getExpectedTwilioSignature: actual.getExpectedTwilioSignature };
});
jest.mock('../../../utils/secretsManager', () => ({ getTwilioCredentials: (...a: unknown[]) => mockGetCreds(...a) }));
jest.mock('../../whatsappService', () => ({ redactPhone: (p: string) => `***${p.slice(-4)}` }));

import { inspect } from 'util';
import twilio, { getExpectedTwilioSignature } from 'twilio';
import { getVoiceProvider, setVoiceProviderForTests, VoiceCallError } from '../voiceProvider';

const CREDS = { accountSid: 'ACfake0123456789abcdef0123456789ab', authToken: 'fake-auth-token' };
const B64 = Buffer.from(`${CREDS.accountSid}:${CREDS.authToken}`).toString('base64');
const BASIC = `Basic ${B64}`;
const CALL_SID = 'CA0123456789abcdef0123456789abcdef'; // contains a 10-digit run
const NUMBER_SID = 'PN0123456789abcdef0123456789abcdef';
const URL_ = 'https://api.example.com/api/webhooks/twilio-voice/status?listId=l1&leadId=ld1&jobKey=j1';
const PARAMS = { CallSid: 'CA00000001', CallStatus: 'completed' };
const callParams = { to: '+15555550100', from: '+15555550199', url: 'https://x/owner', statusCallbackUrl: 'https://x/status', timeoutSeconds: 20 };

const longestDigitRun = (text: string) =>
  Math.max(0, ...(text.match(/\p{Nd}(?:[\s().\-\u2010-\u2015\u2212/]*\p{Nd})*/gu) ?? []).map((m) => m.replace(/[^\p{Nd}]/gu, '').length));

// Every operation that talks to Twilio, with a way to make its SDK call fail.
interface Operation {
  name: string;
  call: () => Promise<unknown>;
  arrange: (sdkError: unknown) => void;
}
const OPERATIONS: Operation[] = [
  { name: 'placeCall', call: () => getVoiceProvider().placeCall(callParams), arrange: (e) => mockCreate.mockRejectedValue(e) },
  { name: 'buyNumber (search)', call: () => getVoiceProvider().buyNumber({ countryCode: 'US' }), arrange: (e) => mockLocalList.mockRejectedValue(e) },
  {
    name: 'buyNumber (purchase)',
    call: () => getVoiceProvider().buyNumber({ countryCode: 'US' }),
    arrange: (e) => {
      mockLocalList.mockResolvedValue([{ phoneNumber: '+15555550123' }]);
      mockIncomingCreate.mockRejectedValue(e);
    },
  },
  { name: 'releaseNumber', call: () => getVoiceProvider().releaseNumber('PN1'), arrange: (e) => mockRemove.mockRejectedValue(e) },
];
const [PLACE_CALL] = OPERATIONS;

/** Makes the operation's SDK call fail with `sdkError` and returns what the provider threw. */
async function failWith(op: Operation, sdkError: unknown): Promise<VoiceCallError> {
  op.arrange(sdkError);
  const thrown: unknown = await op.call().then(() => undefined, (e: unknown) => e);
  if (!(thrown instanceof VoiceCallError)) throw new Error(`${op.name} did not throw a VoiceCallError: ${String(thrown)}`);
  return thrown;
}

describe('real voice provider', () => {
  let errSpy: jest.SpyInstance;
  beforeEach(() => {
    jest.clearAllMocks();
    setVoiceProviderForTests(null);
    mockGetCreds.mockResolvedValue(CREDS);
    errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  describe('validateSignature', () => {
    const sig = () => getExpectedTwilioSignature(CREDS.authToken, URL_, PARAMS);
    const ready = async () => { const p = getVoiceProvider(); await p.ensureCredentials(); return p; };

    it('accepts a signature computed by the twilio package', async () => {
      expect((await ready()).validateSignature({ url: URL_, params: PARAMS, signature: sig() })).toBe(true);
    });
    it('rejects when the URL changes', async () => {
      expect((await ready()).validateSignature({ url: URL_ + '&x=1', params: PARAMS, signature: sig() })).toBe(false);
    });
    it('rejects when a param changes', async () => {
      expect((await ready()).validateSignature({ url: URL_, params: { ...PARAMS, CallStatus: 'failed' }, signature: sig() })).toBe(false);
    });
    it('rejects when the auth token differs', async () => {
      const p = await ready();
      const other = getExpectedTwilioSignature('other-token', URL_, PARAMS);
      expect(p.validateSignature({ url: URL_, params: PARAMS, signature: other })).toBe(false);
    });
    it('rejects a missing or empty signature', async () => {
      const p = await ready();
      expect(p.validateSignature({ url: URL_, params: PARAMS, signature: undefined })).toBe(false);
      expect(p.validateSignature({ url: URL_, params: PARAMS, signature: '' })).toBe(false);
    });
    it('only accepts a correctly signed request once ensureCredentials() has resolved', async () => {
      let release!: (v: typeof CREDS) => void;
      mockGetCreds.mockReturnValue(new Promise((r) => { release = r; }));
      const p = getVoiceProvider();
      const args = { url: URL_, params: PARAMS, signature: sig() };

      const pending = p.ensureCredentials();
      expect(p.validateSignature(args)).toBe(false); // correctly signed, but the token is not loaded yet
      release(CREDS);
      await pending;
      expect(p.validateSignature(args)).toBe(true);
    });
    it('keeps verifying with the last good token after a later ensureCredentials() fails', async () => {
      // Twilio status callbacks are the metering input and must survive a Secrets Manager blip;
      // the token's age is bounded by the credentials cache TTL plus the next successful load.
      const p = await ready();
      mockGetCreds.mockRejectedValue(new Error('Failed to fetch Twilio credentials'));
      await expect(p.ensureCredentials()).rejects.toBeInstanceOf(VoiceCallError);
      expect(p.validateSignature({ url: URL_, params: PARAMS, signature: sig() })).toBe(true);
    });
    it('fails closed (false) when credentials were never loaded', () => {
      expect(getVoiceProvider().validateSignature({ url: URL_, params: PARAMS, signature: sig() })).toBe(false);
    });
    it('fails closed when verification throws', async () => {
      const p = await ready();
      jest.spyOn(twilio, 'validateRequest').mockImplementation(() => { throw new Error('boom'); });
      expect(p.validateSignature({ url: URL_, params: PARAMS, signature: sig() })).toBe(false);
    });
    it('picks up a rotated token on the next ensureCredentials', async () => {
      const p = await ready();
      mockGetCreds.mockResolvedValue({ ...CREDS, authToken: 'rotated' });
      await p.ensureCredentials();
      expect(p.validateSignature({ url: URL_, params: PARAMS, signature: sig() })).toBe(false);
      expect(p.validateSignature({ url: URL_, params: PARAMS, signature: getExpectedTwilioSignature('rotated', URL_, PARAMS) })).toBe(true);
    });
  });

  describe('placeCall', () => {
    it('returns the call sid and maps params to the Twilio request', async () => {
      mockCreate.mockResolvedValue({ sid: 'CA123' });
      await expect(getVoiceProvider().placeCall(callParams)).resolves.toEqual({ callSid: 'CA123' });
      expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
        statusCallbackEvent: ['completed'],
        to: callParams.to, from: callParams.from, url: callParams.url, statusCallback: callParams.statusCallbackUrl, timeout: 20,
      }));
    });

    it('sends inline twiml without url or status callback when given twiml', async () => {
      mockCreate.mockResolvedValue({ sid: 'CA124' });
      const twiml = '<Response><Say>hi</Say></Response>';
      await getVoiceProvider().placeCall({ to: callParams.to, from: callParams.from, twiml, timeoutSeconds: 30 });
      const sent = mockCreate.mock.calls[0][0];
      expect(sent).toEqual({ to: callParams.to, from: callParams.from, twiml, timeout: 30 });
      expect(sent).not.toHaveProperty('url');
      expect(sent).not.toHaveProperty('statusCallback');
    });

    it('records the HTTP status on a rejection so callers can tell 404 (already gone) from 401/429', async () => {
      mockRemove.mockRejectedValue(Object.assign(new Error('not found'), { status: 404, code: 20404 }));
      await expect(getVoiceProvider().releaseNumber('PN1')).rejects.toMatchObject({ placed: 'no', httpStatus: 404 });
      mockRemove.mockRejectedValue(new Error('socket hang up'));
      const err = await getVoiceProvider().releaseNumber('PN1').catch((e) => e);
      expect(err.placed).toBe('unknown');
      expect(err.httpStatus).toBeUndefined();
    });

    it('creates the SDK client with auto-retry off and a bounded timeout', async () => {
      mockCreate.mockResolvedValue({ sid: 'CA1' });
      await getVoiceProvider().placeCall(callParams);
      expect(twilio).toHaveBeenCalledWith(CREDS.accountSid, CREDS.authToken, { timeout: 15000, autoRetry: false });
    });

    it('does not retry: one failed request means exactly one attempt', async () => {
      mockCreate.mockRejectedValue(Object.assign(new Error('Service Unavailable'), { status: 503 }));
      await expect(getVoiceProvider().placeCall(callParams)).rejects.toMatchObject({ placed: 'unknown' });
      expect(mockCreate).toHaveBeenCalledTimes(1);
    });

    it('reports placed=no when credentials cannot be loaded (no request was made)', async () => {
      mockGetCreds.mockRejectedValue(new Error('Failed to fetch Twilio credentials'));
      await expect(getVoiceProvider().placeCall(callParams)).rejects.toMatchObject({ placed: 'no' });
      expect(mockCreate).not.toHaveBeenCalled();
      // The failure is logged too, with the operation and the redacted target.
      expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/^\[hotLeadCall\] placeCall to \*\*\*0100 failed \(placed=no\): Twilio credentials unavailable/));
    });
  });

  describe('phone numbers in Twilio error text', () => {
    // The real 21211 text, which echoes the dialled number.
    const TWILIO_21211 = "The 'To' number +15555550100 is not a valid phone number.";

    it('keeps the number and the auth token out of the log line and VoiceCallError.message, but keeps status and code', async () => {
      const err = await failWith(PLACE_CALL, Object.assign(new Error(TWILIO_21211), { status: 400, code: 21211 }));
      const logged = errSpy.mock.calls.flat().map(String).join(' ');

      expect(longestDigitRun(err.message)).toBeLessThan(7);
      expect(longestDigitRun(logged)).toBeLessThan(7);
      expect(err.message).toContain('HTTP 400');
      expect(err.message).toContain('code 21211');
      expect(err.placed).toBe('no');
      // The log still identifies the call by the last 4 digits.
      expect(logged).toContain('0100');
      expect(logged).not.toContain('+15555550100');
      expect(logged).not.toContain(CREDS.authToken);
    });

    it.each(['+1 (555) 555-0100', '555.555.0100', '5555550100', '+44 20 7946 0958'])('scrubs %s', async (num) => {
      const e = await failWith(PLACE_CALL, { status: 400, message: `bad number ${num} here` });
      expect(longestDigitRun(e.message)).toBeLessThan(7);
    });
  });

  describe('SIDs and exotic digits in error text', () => {
    const msg = async (text: string) => (await failWith(PLACE_CALL, { status: 400, message: text })).message;

    it('passes a Twilio SID through unmangled', async () => {
      expect(await msg(`number ${NUMBER_SID} not found`)).toContain(NUMBER_SID);
      expect(await msg(`call CA00000000000000000000000000000001 gone`)).toContain('CA00000000000000000000000000000001');
    });
    it('still scrubs a phone number sitting next to a SID', async () => {
      const m = await msg(`${NUMBER_SID} / +15555550100`);
      expect(m).toContain(NUMBER_SID);
      expect(m).not.toContain('5555550100');
    });
    it.each([
      ['Arabic-Indic digits', '\u0665\u0665\u0665\u0665\u0665\u0665\u0665\u0661\u0660\u0660'],
      ['fullwidth digits', '\uFF15\uFF15\uFF15\uFF15\uFF15\uFF15\uFF15\uFF11\uFF10\uFF10'],
      ['non-breaking hyphen', '555\u2011555\u20110100'],
      ['en dash', '555\u2013555\u20130100'],
      ['minus sign', '555\u2212555\u22120100'],
      ['non-breaking space', '555\u00a0555\u00a00100'],
      ['slashes', '555/555/0100'],
    ])('scrubs %s', async (_label, num) => {
      const m = await msg(`bad ${num} here`);
      expect(longestDigitRun(m)).toBeLessThan(7);
      expect(m).toContain('[redacted]');
    });
    it('keeps runs shorter than 7 digits', async () => {
      expect(await msg('code 21211 and 123456')).toContain('123456');
    });
  });

  describe('credentials in SDK error text', () => {
    const ACCOUNT_SID_HEX = 'ACabcdefabcdefabcdefabcdefabcdefab'; // no digit run, so only the AC rule can remove it

    it('redacts Basic auth values, account SIDs and the exact loaded credentials', async () => {
      const hostile = `proxy said ${BASIC} for ${ACCOUNT_SID_HEX}; loaded ${CREDS.accountSid} with ${CREDS.authToken}`;
      const m = (await failWith(PLACE_CALL, { status: 502, message: hostile })).message;
      expect(m).not.toContain(B64);
      expect(m).toContain('Basic [redacted]');
      expect(m).not.toContain(ACCOUNT_SID_HEX);
      expect(m).not.toContain(CREDS.accountSid);
      expect(m).not.toContain(CREDS.authToken);
    });

    it('redacts the bare base64 of sid:token, with no Basic prefix', async () => {
      const m = (await failWith(PLACE_CALL, { status: 502, message: `upstream echoed ${B64} verbatim` })).message;
      expect(m).not.toContain(B64);
    });

    it('leaves a pathologically short token alone but still redacts a normal one', async () => {
      mockGetCreds.mockResolvedValue({ ...CREDS, authToken: 'e' });
      const short = (await failWith(PLACE_CALL, { status: 502, message: 'service temporarily unavailable' })).message;
      expect(short).toContain('service temporarily unavailable');

      mockGetCreds.mockResolvedValue({ ...CREDS, authToken: '0123456789abcdef0123456789abcdef' });
      const normal = (await failWith(PLACE_CALL, { status: 502, message: 'token 0123456789abcdef0123456789abcdef leaked' })).message;
      expect(normal).not.toContain('0123456789abcdef0123456789abcdef');
    });

    it('redacts only ACCOUNT sids: call (CA) and phone-number (PN) sids stay readable', async () => {
      const m = (await failWith(PLACE_CALL, { status: 400, message: `${CALL_SID} ${NUMBER_SID} ${ACCOUNT_SID_HEX}` })).message;
      expect(m).toContain(CALL_SID);
      expect(m).toContain(NUMBER_SID);
      expect(m).not.toContain(ACCOUNT_SID_HEX);
    });

    it('applies to every operation, not just placeCall', async () => {
      for (const op of OPERATIONS) {
        jest.clearAllMocks();
        const m = (await failWith(op, { status: 400, message: `bad token ${CREDS.authToken} ${BASIC}` })).message;
        expect(m).not.toContain(CREDS.authToken);
        expect(m).not.toContain(B64);
      }
    });
  });

  describe('credentials that cannot be used', () => {
    it.each([['empty', { accountSid: '', authToken: '' }], ['whitespace', { accountSid: '  ', authToken: '\n' }]])(
      'classifies %s credentials as placed=no without sending a request',
      async (_l, creds) => {
        mockGetCreds.mockResolvedValue(creds);
        for (const op of OPERATIONS) {
          const err: unknown = await op.call().then(() => undefined, (e: unknown) => e);
          expect(err).toBeInstanceOf(VoiceCallError);
          expect(err).toMatchObject({ placed: 'no' });
        }
        expect(mockCreate).not.toHaveBeenCalled();
        expect(mockRemove).not.toHaveBeenCalled();
      },
    );

    it('ensureCredentials rejects with a sanitized VoiceCallError, and validateSignature stays false', async () => {
      mockGetCreds.mockRejectedValue(new Error(`Failed to fetch Twilio credentials for +15555550100`));
      const p = getVoiceProvider();
      const err = await p.ensureCredentials().catch((e) => e);
      expect(err).toBeInstanceOf(VoiceCallError);
      expect(err.placed).toBe('no');
      expect(longestDigitRun(err.message)).toBeLessThan(7);
      expect(p.validateSignature({ url: URL_, params: PARAMS, signature: getExpectedTwilioSignature(CREDS.authToken, URL_, PARAMS) })).toBe(false);
    });

    it('scrubs the credentials-unavailable message like any other error text', async () => {
      mockGetCreds.mockRejectedValue(new Error(`lookup failed: ${BASIC}`));
      const err = await getVoiceProvider().placeCall(callParams).catch((e) => e);
      expect(err.message).not.toContain(B64);
    });
  });

  describe('placeCall response without a sid', () => {
    it.each([[{}], [{ sid: 123 }], [{ sid: '' }], [undefined]])('throws placed=unknown for %j', async (resp) => {
      mockCreate.mockResolvedValue(resp);
      await expect(getVoiceProvider().placeCall(callParams)).rejects.toMatchObject({ name: 'VoiceCallError', placed: 'unknown' });
    });
  });

  describe('credential-bearing SDK errors never escape', () => {
    const axiosLike = (extra: Record<string, unknown>) => {
      const headers = { Authorization: BASIC, 'User-Agent': 'twilio-node' };
      const err = Object.assign(new Error(extra.message as string), {
        isAxiosError: true,
        config: { headers, auth: { username: CREDS.accountSid, password: CREDS.authToken } },
        request: { _header: `GET / HTTP/1.1\r\nAuthorization: ${BASIC}` },
        ...extra,
      });
      (err as { cause?: unknown }).cause = { config: { headers } };
      return err;
    };
    const scenarios: Array<[string, () => Error]> = [
      ['a socket reset', () => axiosLike({ message: 'socket hang up', code: 'ECONNRESET' })],
      ['a 401 response', () => axiosLike({ message: 'Authenticate', status: 401, code: 20003, response: { status: 401, config: { headers: { Authorization: BASIC } } } })],
    ];
    describe.each(OPERATIONS)('$name', (op) => {
      it.each(scenarios)('throws a sanitized VoiceCallError for %s', async (_label, make) => {
        mockGetCreds.mockResolvedValue(CREDS);
        const err = await failWith(op, make());

        expect(err).toBeInstanceOf(VoiceCallError);
        expect('cause' in err).toBe(false);
        for (const dump of [JSON.stringify(err), inspect(err, { depth: 6 }), String(err.stack)]) {
          expect(dump).not.toContain(B64);
          expect(dump).not.toContain(CREDS.authToken);
          expect(dump).not.toContain(CREDS.accountSid);
          expect(dump).not.toMatch(/Authorization/i);
        }
        // Only these own enumerable props exist, so nothing else (config, request, response) can ride along.
        expect(Object.keys(err).sort()).toEqual(['httpStatus', 'name', 'placed']);
        const logged = errSpy.mock.calls.flat().map(String).join(' ');
        expect(logged).not.toContain(B64);
        expect(logged).not.toContain(CREDS.authToken);
      });
    });
  });

  describe('classifying SDK failures', () => {
    describe.each(OPERATIONS)('$name', (op) => {
      const fail = (e: unknown) => failWith(op, e);

      it.each([400, 401, 403, 404, 409, 429])('HTTP %i is definitely not done', async (status) => {
        const e = await fail({ status, code: 20404, message: 'x' });
        expect(e).toBeInstanceOf(VoiceCallError);
        expect(e.placed).toBe('no');
        expect(e.message).toContain(`HTTP ${status}, code 20404`);
      });
      it.each([408, 500, 502, 503, 504])('HTTP %i is ambiguous', async (status) => {
        expect((await fail({ status, message: 'x' })).placed).toBe('unknown');
      });
      it('a transport error without a status (timeout, reset) is ambiguous and a string code is not a Twilio code', async () => {
        const e = await fail(Object.assign(new Error('timeout of 15000ms exceeded'), { code: 'ECONNABORTED' }));
        expect(e.placed).toBe('unknown');
        expect(e.message).not.toContain('ECONNABORTED');
        expect(e.message).not.toContain('code');
      });
      it.each([['a string', 'weird'], ['null', null]])('a non-Error throw (%s) is ambiguous', async (_l, thrown) => {
        expect((await fail(thrown)).placed).toBe('unknown');
      });
    });
  });

  describe('numbers', () => {
    it('buys the first available voice-enabled number', async () => {
      mockLocalList.mockResolvedValue([{ phoneNumber: '+15555550123' }]);
      mockIncomingCreate.mockResolvedValue({ sid: 'PN1', phoneNumber: '+15555550123' });
      await expect(getVoiceProvider().buyNumber({ countryCode: 'US', areaCode: '555' })).resolves.toEqual({ numberSid: 'PN1', phoneNumber: '+15555550123' });
      expect(mockLocalList).toHaveBeenCalledWith(expect.objectContaining({ areaCode: 555, voiceEnabled: true, limit: 1 }));
    });
    it('points the new number at the given voice URL (POST), and sets no voice URL when none is given', async () => {
      mockLocalList.mockResolvedValue([{ phoneNumber: '+15555550123' }]);
      mockIncomingCreate.mockResolvedValue({ sid: 'PN1', phoneNumber: '+15555550123' });
      await getVoiceProvider().buyNumber({ countryCode: 'US', voiceUrl: 'https://api.example.test/api/webhooks/twilio-voice/inbound' });
      expect(mockIncomingCreate).toHaveBeenLastCalledWith({ phoneNumber: '+15555550123', voiceUrl: 'https://api.example.test/api/webhooks/twilio-voice/inbound', voiceMethod: 'POST' });
      await getVoiceProvider().buyNumber({ countryCode: 'US' });
      expect(mockIncomingCreate).toHaveBeenLastCalledWith({ phoneNumber: '+15555550123' });
    });
    it.each([[{}], [{ sid: 7 }], [{ sid: '' }], [undefined]])('throws placed=unknown when the purchase response has no sid (%j)', async (resp) => {
      mockLocalList.mockResolvedValue([{ phoneNumber: '+15555550123' }]);
      mockIncomingCreate.mockResolvedValue(resp);
      await expect(getVoiceProvider().buyNumber({ countryCode: 'US' })).rejects.toMatchObject({ name: 'VoiceCallError', placed: 'unknown' });
    });
    it('throws when nothing is available, without buying', async () => {
      mockLocalList.mockResolvedValue([]);
      await expect(getVoiceProvider().buyNumber({ countryCode: 'US' })).rejects.toThrow(/No voice-enabled number/);
      expect(mockIncomingCreate).not.toHaveBeenCalled();
    });
    it.each(['', '55', '5555', '5a5', '1e3', ' 555'])('rejects area code %j with placed=no before touching Twilio', async (areaCode) => {
      const err = await getVoiceProvider().buyNumber({ countryCode: 'US', areaCode }).catch((e) => e);
      expect(err).toBeInstanceOf(VoiceCallError);
      expect(err.placed).toBe('no');
      expect(mockLocalList).not.toHaveBeenCalled();
      expect(mockIncomingCreate).not.toHaveBeenCalled();
    });
    it('releases a number by sid', async () => {
      mockRemove.mockResolvedValue(true);
      await getVoiceProvider().releaseNumber('PN1');
      expect(mockRemove).toHaveBeenCalledTimes(1);
    });
  });
});
