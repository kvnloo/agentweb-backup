import { FakeVoiceProvider } from '../fakeVoiceProvider';
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

  it('can be injected through setVoiceProviderForTests', () => {
    const f = new FakeVoiceProvider();
    setVoiceProviderForTests(f);
    expect(getVoiceProvider()).toBe(f);
  });
});
