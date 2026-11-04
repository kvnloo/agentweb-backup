import { FakeVoiceProvider } from '../../../__tests__/helpers/fakeVoiceProvider';
import { getVoiceProvider, setVoiceProviderForTests, VoiceCallError } from '../voiceProvider';

const p = { to: '+15555550100', from: '+15555550199', url: 'https://x/o', statusCallbackUrl: 'https://x/s', timeoutSeconds: 20 };

describe('FakeVoiceProvider', () => {
  afterEach(() => setVoiceProviderForTests(null));

  it('records calls and hands out deterministic sids', async () => {
    const f = new FakeVoiceProvider();
    await expect(f.placeCall(p)).resolves.toEqual({ callSid: 'CA00000001' });
    await expect(f.placeCall(p)).resolves.toEqual({ callSid: 'CA00000002' });
    expect(f.placedCalls).toEqual([p, p]);
  });

  it('scripts a definite failure then recovers; the attempt is still recorded', async () => {
    const f = new FakeVoiceProvider();
    f.failNextPlaceCall('no');
    await expect(f.placeCall(p)).rejects.toMatchObject({ placed: 'no' });
    await expect(f.placeCall(p)).resolves.toEqual({ callSid: 'CA00000001' });
    expect(f.placedCalls).toHaveLength(2);
  });

  it('scripts an ambiguous failure', async () => {
    const f = new FakeVoiceProvider();
    f.failNextPlaceCall('unknown', 'timeout');
    const err = await f.placeCall(p).catch((e) => e);
    expect(err).toBeInstanceOf(VoiceCallError);
    expect(err.placed).toBe('unknown');
  });

  it('signature check can be toggled and never accepts a missing signature', async () => {
    const f = new FakeVoiceProvider();
    await f.ensureCredentials();
    const args = { url: 'u', params: {}, signature: 'sig' };
    expect(f.validateSignature(args)).toBe(true);
    expect(f.validateSignature({ ...args, signature: undefined })).toBe(false);
    f.signatureValid = false;
    expect(f.validateSignature(args)).toBe(false);
    expect(f.signatureChecks).toHaveLength(3);
  });

  it('does not unlock validateSignature for an un-awaited ensureCredentials(), only after it resolves', async () => {
    const f = new FakeVoiceProvider();
    const args = { url: 'u', params: {}, signature: 'sig' };
    const pending = f.ensureCredentials(); // deliberately not awaited yet
    expect(f.validateSignature(args)).toBe(false);
    await pending;
    expect(f.ensureCredentialsCalls).toBe(1);
    expect(f.validateSignature(args)).toBe(true);
  });

  it('records number purchases and releases', async () => {
    const f = new FakeVoiceProvider();
    await expect(f.buyNumber({ countryCode: 'US' })).resolves.toEqual({ numberSid: 'PN00000001', phoneNumber: '+15555550001' });
    await f.releaseNumber('PN00000001');
    expect(f.releasedNumbers).toEqual(['PN00000001']);
  });

  it('records the voice URL of a purchase and refuses a malformed one before recording', async () => {
    const f = new FakeVoiceProvider();
    await f.buyNumber({ countryCode: 'US', voiceUrl: 'https://api.example.test/api/webhooks/twilio-voice/inbound' });
    expect(f.boughtNumbers).toEqual([{ countryCode: 'US', voiceUrl: 'https://api.example.test/api/webhooks/twilio-voice/inbound' }]);
    await expect(f.buyNumber({ countryCode: 'US', voiceUrl: 'not a url' })).rejects.toThrow(/voiceUrl/);
    expect(f.boughtNumbers).toHaveLength(1);
  });

  it('can be injected through setVoiceProviderForTests', () => {
    const f = new FakeVoiceProvider();
    setVoiceProviderForTests(f);
    expect(getVoiceProvider()).toBe(f);
  });

  it('scripts buyNumber and releaseNumber failures and results, still recording the attempt', async () => {
    const f = new FakeVoiceProvider();
    f.failNextBuyNumber('unknown', 'timeout');
    await expect(f.buyNumber({ countryCode: 'US' })).rejects.toMatchObject({ placed: 'unknown' });
    f.queueBuyNumberResult({ numberSid: 'PNx', phoneNumber: '+14155550123' });
    await expect(f.buyNumber({ countryCode: 'US', areaCode: '415' })).resolves.toEqual({ numberSid: 'PNx', phoneNumber: '+14155550123' });
    expect(f.boughtNumbers).toHaveLength(2);
    f.failNextReleaseNumber('no', 'gone', 404);
    await expect(f.releaseNumber('PNx')).rejects.toMatchObject({ placed: 'no', httpStatus: 404 });
    await expect(f.releaseNumber('PNx')).resolves.toBeUndefined();
    expect(f.releasedNumbers).toEqual(['PNx', 'PNx']);
  });

  it('rejects a placeCall that sets both url and twiml, or neither (the real provider would silently pick one)', async () => {
    const f = new FakeVoiceProvider();
    await expect(f.placeCall({ ...p, twiml: '<Response/>' } as never)).rejects.toThrow('exactly one of url and twiml');
    await expect(f.placeCall({ to: p.to, from: p.from, timeoutSeconds: 20 } as never)).rejects.toThrow('exactly one');
    await expect(f.placeCall({ to: p.to, from: p.from, twiml: '<Response/>', timeoutSeconds: 20 })).resolves.toEqual({ callSid: 'CA00000001' });
    expect(f.placedCalls).toHaveLength(1);
  });
});
