/**
 * POST /api/loop-events — anonymous ingestion for closed-loop instances.
 *
 * Public route (no auth). The closed-loop framework's `eventTableEventSource`
 * sensor reads from `Dev-AW-LoopEvents`; this route is the writer.
 *
 * Body shape (matches NormalizedEvent from loops/core/types.ts):
 *   {
 *     loopId: string                   — must be a registered loop
 *     eventType: string                — must be in manifest.allowedEventTypes
 *     subjectId: string                — sessionId, userId, or anonymous id
 *     ts?: string                      — ISO timestamp; defaults to now
 *     variantId?: string
 *     dimensions?: Record<string, string|number|boolean|null>
 *   }
 *
 * Validation
 *   - Rejects unknown loopIds (400)
 *   - Rejects eventTypes not in the loop's allowedEventTypes (400)
 *   - Rejects payloads > 4KB
 *   - Per-IP rate limit: 60 events/minute (in-process token bucket; for
 *     production-grade abuse protection we'd front this with API Gateway
 *     throttling or a CloudFront WAF rule)
 *
 * NEVER trusts: caller's loopId / eventType claims — both checked against
 * the registered manifest.
 */

import express, { Request, Response } from 'express';
import AWS from 'aws-sdk';
import { getLoopManifest, getRegisteredLoopIds } from '../loops';
import { asLoopId, asSubjectId, asVariantId } from '../loops/core/types';
import type { NormalizedEvent } from '../loops/core/types';
import { LOOP_EVENTS_TABLE, eventToItem } from '../loops/core/sensors/eventTableEventSource';

const router = express.Router();

const dynamodb = new AWS.DynamoDB.DocumentClient({
  region: process.env.AWS_REGION || 'us-west-2',
});

const MAX_PAYLOAD_BYTES = 4096;
const RATE_LIMIT_PER_MIN = 60;

// Simple in-memory token bucket per IP. Sufficient for a single-process
// deployment; replace with Redis-backed counter or API Gateway throttling
// when this route sees > 1 instance of the backend.
interface BucketEntry {
  tokens: number;
  resetAt: number;
}
const buckets = new Map<string, BucketEntry>();

function rateCheck(ip: string): boolean {
  const now = Date.now();
  const e = buckets.get(ip);
  if (!e || e.resetAt < now) {
    buckets.set(ip, { tokens: RATE_LIMIT_PER_MIN - 1, resetAt: now + 60_000 });
    return true;
  }
  if (e.tokens <= 0) return false;
  e.tokens--;
  return true;
}

router.post('/', async (req: Request, res: Response) => {
  try {
    const ip = (req.headers['x-forwarded-for']?.toString().split(',')[0] ?? req.ip ?? 'unknown').trim();
    if (!rateCheck(ip)) {
      return res.status(429).json({ error: 'rate_limited' });
    }

    if (req.headers['content-length'] && Number(req.headers['content-length']) > MAX_PAYLOAD_BYTES) {
      return res.status(413).json({ error: 'payload_too_large' });
    }

    const body = req.body ?? {};
    const { loopId, eventType, subjectId, ts, variantId, dimensions } = body;

    if (typeof loopId !== 'string' || !loopId) {
      return res.status(400).json({ error: 'loopId required' });
    }
    if (typeof eventType !== 'string' || !eventType) {
      return res.status(400).json({ error: 'eventType required' });
    }
    if (typeof subjectId !== 'string' || !subjectId) {
      return res.status(400).json({ error: 'subjectId required' });
    }

    // Validate loop is registered.
    const registered = getRegisteredLoopIds() as readonly string[];
    if (!registered.includes(loopId)) {
      return res.status(400).json({ error: 'unknown_loopId', loopId });
    }
    const manifest = getLoopManifest(asLoopId(loopId));
    if (!manifest.allowedEventTypes.includes(eventType)) {
      return res.status(400).json({ error: 'event_type_not_allowed', eventType });
    }
    if (manifest.paused) {
      // Don't reject — just acknowledge. The frontend keeps firing; the
      // loop's policy layer ignores everything when paused.
      return res.status(200).json({ ok: true, loopPaused: true });
    }

    // Build the NormalizedEvent.
    const event: NormalizedEvent = {
      subjectId: asSubjectId(subjectId),
      eventType,
      ts: ts ? new Date(ts) : new Date(),
      ...(variantId ? { variantId: asVariantId(variantId) } : {}),
      ...(dimensions && typeof dimensions === 'object' ? { dimensions: sanitizeDimensions(dimensions) } : {}),
    };

    const item = eventToItem(asLoopId(loopId), event);
    await dynamodb.put({ TableName: LOOP_EVENTS_TABLE, Item: item }).promise();

    return res.status(201).json({ ok: true });
  } catch (err) {
    console.error('[loopEvents] ingestion error:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

function sanitizeDimensions(raw: Record<string, unknown>): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null) {
      out[k] = v;
    } else {
      // Coerce nested/complex values to JSON string so we don't lose them.
      try {
        out[k] = JSON.stringify(v).slice(0, 500);
      } catch {
        // Skip unserializable values.
      }
    }
  }
  return out;
}

export default router;
