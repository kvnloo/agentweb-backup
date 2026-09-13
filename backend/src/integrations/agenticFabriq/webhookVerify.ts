/**
 * Agentic Fabriq webhook signature verification — one verifier for both
 * connection.* and trigger events, per the vendor's own spec:
 *
 *   expected = hex HMAC-SHA256(signing_secret, `${timestamp}.${raw_body}`)
 *
 * Compared with timingSafeEqual against the RAW bytes — any JSON.parse/
 * stringify round-trip before this check breaks the MAC, so this module
 * takes a Buffer, never a parsed object, as its body input. This mirrors the
 * existing `timingSafeEqual` webhook-verification convention already used by
 * calendlyWebhook.ts / unipileWebhook.ts / apolloWebhook.ts elsewhere in this
 * repo, rather than inventing a new pattern.
 */

import crypto from 'crypto';
import { AgenticFabriqWebhookVerificationError } from './errors';

const MAX_TIMESTAMP_AGE_SECONDS = 300;

export interface VerifyAgenticFabriqWebhookInput {
  signatureHeader: string | undefined;
  timestampHeader: string | undefined;
  rawBody: Buffer;
  signingSecret: string;
  nowMs?: number;
}

/**
 * Throws AgenticFabriqWebhookVerificationError on any failure (missing
 * headers, bad hex, signature mismatch, stale timestamp). Returns void on
 * success — dedupe on event_id is the caller's job (via the existing
 * asyncJobQueue conditional-write pattern), since it needs the parsed body.
 */
export function verifyAgenticFabriqWebhookSignature(input: VerifyAgenticFabriqWebhookInput): void {
  const { signatureHeader, timestampHeader, rawBody, signingSecret } = input;
  const nowMs = input.nowMs ?? Date.now();

  if (!signatureHeader || !timestampHeader) {
    throw new AgenticFabriqWebhookVerificationError('Missing X-AF-Signature or X-AF-Timestamp header.');
  }

  const timestampSeconds = Number(timestampHeader);
  if (!Number.isFinite(timestampSeconds)) {
    throw new AgenticFabriqWebhookVerificationError(`X-AF-Timestamp header is not a valid number: "${timestampHeader}".`);
  }
  const ageSeconds = Math.abs(nowMs / 1000 - timestampSeconds);
  if (ageSeconds > MAX_TIMESTAMP_AGE_SECONDS) {
    throw new AgenticFabriqWebhookVerificationError(
      `Webhook timestamp is ${Math.round(ageSeconds)}s old, exceeding the ${MAX_TIMESTAMP_AGE_SECONDS}s freshness window.`,
    );
  }

  const signingInput = Buffer.concat([Buffer.from(`${timestampHeader}.`, 'utf8'), rawBody]);
  const expectedHex = crypto.createHmac('sha256', signingSecret).update(signingInput).digest('hex');

  let expectedBuf: Buffer;
  let providedBuf: Buffer;
  try {
    expectedBuf = Buffer.from(expectedHex, 'hex');
    providedBuf = Buffer.from(signatureHeader, 'hex');
  } catch {
    throw new AgenticFabriqWebhookVerificationError('X-AF-Signature header is not valid hex.');
  }

  if (
    expectedBuf.length !== providedBuf.length ||
    !crypto.timingSafeEqual(expectedBuf, providedBuf)
  ) {
    throw new AgenticFabriqWebhookVerificationError('Webhook signature does not match.');
  }
}
