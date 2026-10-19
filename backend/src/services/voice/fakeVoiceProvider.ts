import { VoiceCallError, type BuyNumberParams, type PlaceCallParams, type ValidateSignatureParams, type VoiceProvider } from './voiceProvider';

/**
 * Recording VoiceProvider for tests: no network, deterministic sids (CA00000001, ...), and
 * scriptable failures. `failNextPlaceCall` queues one failure per placeCall, in order.
 */
export class FakeVoiceProvider implements VoiceProvider {
  readonly placedCalls: PlaceCallParams[] = [];
  readonly boughtNumbers: BuyNumberParams[] = [];
  readonly releasedNumbers: string[] = [];
  readonly signatureChecks: ValidateSignatureParams[] = [];
  /** Result once credentials are ensured; flip to false to simulate a forged request. */
  signatureValid = true;
  ensureCredentialsCalls = 0;

  private callSeq = 0;
  private numberSeq = 0;
  private placeCallFailures: VoiceCallError[] = [];
  private buyNumberFailures: VoiceCallError[] = [];
  private releaseNumberFailures: VoiceCallError[] = [];
  private buyNumberResults: { numberSid: string; phoneNumber: string }[] = [];

  /** 'no' = Twilio rejected it; 'unknown' = ambiguous timeout (the fake still records the attempt). */
  failNextPlaceCall(placed: 'no' | 'unknown', message = 'scripted failure'): void {
    this.placeCallFailures.push(new VoiceCallError(message, placed));
  }

  /** Queued like failNextPlaceCall; for buyNumber the attempt is recorded and, for 'unknown', nothing is returned though a number may exist. */
  failNextBuyNumber(placed: 'no' | 'unknown', message = 'scripted failure', httpStatus?: number): void {
    this.buyNumberFailures.push(new VoiceCallError(message, placed, httpStatus));
  }

  failNextReleaseNumber(placed: 'no' | 'unknown', message = 'scripted failure', httpStatus?: number): void {
    this.releaseNumberFailures.push(new VoiceCallError(message, placed, httpStatus));
  }

  /** The next buyNumber returns this instead of a generated number (e.g. one that passes the production validators). */
  queueBuyNumberResult(result: { numberSid: string; phoneNumber: string }): void {
    this.buyNumberResults.push(result);
  }

  async ensureCredentials(): Promise<void> {
    // Counted only once the promise resolves: an un-awaited `void provider.ensureCredentials()` must not unlock validateSignature.
    await Promise.resolve();
    this.ensureCredentialsCalls++;
  }

  async placeCall(p: PlaceCallParams): Promise<{ callSid: string }> {
    // The real provider sends whichever is set; both (or neither) would be a caller bug the fake must not hide.
    if ((p.url === undefined) === (p.twiml === undefined)) throw new Error('FakeVoiceProvider: placeCall needs exactly one of url and twiml');
    this.placedCalls.push(p);
    const failure = this.placeCallFailures.shift();
    if (failure) throw failure;
    return { callSid: `CA${String(++this.callSeq).padStart(8, '0')}` };
  }

  async buyNumber(p: BuyNumberParams): Promise<{ numberSid: string; phoneNumber: string }> {
    this.boughtNumbers.push(p);
    const failure = this.buyNumberFailures.shift();
    if (failure) throw failure;
    const queued = this.buyNumberResults.shift();
    if (queued) return queued;
    const n = ++this.numberSeq;
    return { numberSid: `PN${String(n).padStart(8, '0')}`, phoneNumber: `+1555555${String(n).padStart(4, '0')}` };
  }

  async releaseNumber(numberSid: string): Promise<void> {
    this.releasedNumbers.push(numberSid);
    const failure = this.releaseNumberFailures.shift();
    if (failure) throw failure;
  }

  validateSignature(p: ValidateSignatureParams): boolean {
    this.signatureChecks.push(p);
    // Like the real provider: false until ensureCredentials() was awaited, so a handler that
    // forgets the await fails its test instead of passing against the fake and failing in prod.
    return this.ensureCredentialsCalls > 0 && this.signatureValid && !!p.signature;
  }
}
