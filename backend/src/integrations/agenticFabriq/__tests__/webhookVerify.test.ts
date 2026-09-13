/**
 * Protects a critical security invariant: webhook signature/timestamp
 * verification. Uses the RAW-bytes body per the vendor's documented HMAC
 * formula — the whole point of this test is proving a JSON.parse/stringify
 * round-trip would break the MAC, so the module (correctly) never does one.
 */
import crypto from 'crypto';
import { verifyAgenticFabriqWebhookSignature } from '../webhookVerify';
import { AgenticFabriqWebhookVerificationError } from '../errors';

const SIGNING_SECRET = 'test-signing-secret';

function sign(timestamp: string, rawBody: Buffer): string {
  return crypto
    .createHmac('sha256', SIGNING_SECRET)
    .update(Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), rawBody]))
    .digest('hex');
}

describe('verifyAgenticFabriqWebhookSignature', () => {
  const rawBody = Buffer.from(JSON.stringify({ event_id: 'evt_1', payload: { foo: 'bar' } }));
  const nowMs = 1_700_000_000_000;
  const timestamp = String(Math.floor(nowMs / 1000));

  it('accepts a validly signed, fresh delivery', () => {
    const signature = sign(timestamp, rawBody);
    expect(() =>
      verifyAgenticFabriqWebhookSignature({
        signatureHeader: signature,
        timestampHeader: timestamp,
        rawBody,
        signingSecret: SIGNING_SECRET,
        nowMs,
      }),
    ).not.toThrow();
  });

  it('rejects a tampered body', () => {
    const signature = sign(timestamp, rawBody);
    const tamperedBody = Buffer.from(JSON.stringify({ event_id: 'evt_1', payload: { foo: 'TAMPERED' } }));
    expect(() =>
      verifyAgenticFabriqWebhookSignature({
        signatureHeader: signature,
        timestampHeader: timestamp,
        rawBody: tamperedBody,
        signingSecret: SIGNING_SECRET,
        nowMs,
      }),
    ).toThrow(AgenticFabriqWebhookVerificationError);
  });

  it('rejects a stale timestamp (> 300s old)', () => {
    const staleTimestamp = String(Math.floor(nowMs / 1000) - 301);
    const signature = sign(staleTimestamp, rawBody);
    expect(() =>
      verifyAgenticFabriqWebhookSignature({
        signatureHeader: signature,
        timestampHeader: staleTimestamp,
        rawBody,
        signingSecret: SIGNING_SECRET,
        nowMs,
      }),
    ).toThrow(AgenticFabriqWebhookVerificationError);
  });

  it('accepts a timestamp exactly at the 300s boundary', () => {
    const boundaryTimestamp = String(Math.floor(nowMs / 1000) - 300);
    const signature = sign(boundaryTimestamp, rawBody);
    expect(() =>
      verifyAgenticFabriqWebhookSignature({
        signatureHeader: signature,
        timestampHeader: boundaryTimestamp,
        rawBody,
        signingSecret: SIGNING_SECRET,
        nowMs,
      }),
    ).not.toThrow();
  });

  it('rejects a missing signature header', () => {
    expect(() =>
      verifyAgenticFabriqWebhookSignature({
        signatureHeader: undefined,
        timestampHeader: timestamp,
        rawBody,
        signingSecret: SIGNING_SECRET,
        nowMs,
      }),
    ).toThrow(AgenticFabriqWebhookVerificationError);
  });

  it('rejects a signature signed with the WRONG secret', () => {
    const wrongSecretSignature = crypto
      .createHmac('sha256', 'wrong-secret')
      .update(Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), rawBody]))
      .digest('hex');
    expect(() =>
      verifyAgenticFabriqWebhookSignature({
        signatureHeader: wrongSecretSignature,
        timestampHeader: timestamp,
        rawBody,
        signingSecret: SIGNING_SECRET,
        nowMs,
      }),
    ).toThrow(AgenticFabriqWebhookVerificationError);
  });

  it('rejects non-hex garbage in the signature header without throwing an unrelated error', () => {
    expect(() =>
      verifyAgenticFabriqWebhookSignature({
        signatureHeader: 'not-hex-!!!',
        timestampHeader: timestamp,
        rawBody,
        signingSecret: SIGNING_SECRET,
        nowMs,
      }),
    ).toThrow(AgenticFabriqWebhookVerificationError);
  });
});
