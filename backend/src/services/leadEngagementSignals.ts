/**
 * Classifies a lead's stored engagement events into genuine-interest signals,
 * and derives the CRM Inbox heat score (Warm >= 5, Hot >= 8) from them.
 *
 * Why: the previous score was min(#engagements, 5) + recency of the latest
 * engagement of ANY type, falling back to lead.createdAt. That made outbound
 * sends, status changes, out-of-office auto-replies and a fresh import all read
 * as "Warm" (Nu|Erraa: 158 of 159 Warm contacts had no genuine reply).
 *
 * Rules:
 *  - Only inbound replies, meetings and (weakly) clicks score.
 *  - Outbound activity (sent/delivered/invite), opens, status changes, intent
 *    notes and lead creation never score.
 *  - Auto-replies, out-of-office notices and bounces are detected with the same
 *    classifier drip exit-on-reply uses (headers > subject/body patterns).
 *  - A reply explicitly marked negative (sentiment / outcome / unsubscribe)
 *    does not score: Warm/Hot means interest, not just a response.
 *  - Recency only boosts a contact that already has a reply or meeting.
 *  - Clicks alone are capped below Warm (link scanners click too).
 */
import { classifyInboundReply } from './dripInboundReplyClassifier';

export type EngagementSignal =
  | 'reply'
  | 'meeting'
  | 'click'
  | 'auto_reply'
  | 'negative_reply'
  | 'none';

export const WARM_THRESHOLD = 5;
export const HOT_THRESHOLD = 8;

const OUTBOUND_OR_NEUTRAL = /(sent|delivered|opened|invite|status\.changed|bounced|unsubscribed|complain|intent_signal|note|enrich|created|imported|draft|scheduled|queued|failed)/i;
const REPLY_TYPE = /(^email\.received$|^linkedin\.message\.received$|repl(y|ied)|response_received|message_received|\.received$)/i;
const MEETING_TYPE = /(meeting|call_completed|booked|calendly|demo)/i;
const CLICK_TYPE = /(^email\.clicked$|clicked)/i;
const NEGATIVE_MARKERS = /\b(not interested|no thanks|no, thanks|unsubscribe|remove me|stop emailing|do not contact|not a fit|wrong person|(pretty|all|we'?re|we are) set (with|on|for)|not (a priority|looking|the right time|at this time)|no need|will pass|going to pass|have to pass|not in a position)\b/i;

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function isNegative(data: any): boolean {
  const sentiment = str(data?.sentiment).toLowerCase();
  if (sentiment === 'negative') return true;
  const outcome = str(data?.outcome).toLowerCase();
  if (/not_interested|not interested|unsubscribe|declined|negative/.test(outcome)) return true;
  if (sentiment === 'positive') return false;
  return NEGATIVE_MARKERS.test(`${str(data?.notes)} ${str(data?.text)} ${str(data?.body)}`);
}

/** True when an inbound reply is machine-generated (auto-reply, OOO, bounce). */
export function isAutomatedReply(data: any): boolean {
  const d = data && typeof data === 'object' ? data : {};
  const bodyText = [d.text, d.body, d.bodyText, d.snippet, d.content, d.notes, d.message]
    .map(str)
    .filter(Boolean)
    .join('\n');
  const c = classifyInboundReply({
    headers: d.headers && typeof d.headers === 'object' ? d.headers : null,
    from: str(d.from) || str(d.sender),
    subject: str(d.subject),
    bodyText,
  });
  return c.kind === 'auto_reply' || c.kind === 'out_of_office' || c.kind === 'bounce';
}

export function classifyEngagementSignal(event: any): EngagementSignal {
  const type = str(event?.eventType);
  if (!type) return 'none';
  const data = event?.eventData ?? event?.data ?? {};
  if (MEETING_TYPE.test(type) && !/(sent|invite|scheduled_by_us)/i.test(type)) return 'meeting';
  if (REPLY_TYPE.test(type) && !/sent/i.test(type)) {
    if (isAutomatedReply(data)) return 'auto_reply';
    if (isNegative(data)) return 'negative_reply';
    return 'reply';
  }
  if (CLICK_TYPE.test(type)) return 'click';
  if (OUTBOUND_OR_NEUTRAL.test(type)) return 'none';
  return 'none';
}

export interface HeatBreakdown {
  score: number;
  replies: number;
  meetings: number;
  clicks: number;
  autoReplies: number;
  lastGenuineAt?: string;
}

function messageKey(e: any): string | null {
  const d = e?.eventData ?? e?.data ?? {};
  const id = str(d.messageId) || str(d.message_id) || str(d.providerMessageId);
  if (id) return `id:${id}`;
  const body = (str(d.body) || str(d.text) || str(d.bodyText) || str(d.snippet)).replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!body) return null;
  return `body:${str(d.from).toLowerCase()}|${str(d.subject).toLowerCase()}|${body.toLowerCase()}`;
}

function ageDays(iso: string, now: number): number {
  return (now - new Date(iso).getTime()) / 86_400_000;
}

export function computeHeatBreakdown(lead: any, now: number = Date.now()): HeatBreakdown {
  const engs: any[] = Array.isArray(lead?.engagements) ? lead.engagements : [];
  let replies = 0;
  let meetings = 0;
  let clicks = 0;
  let autoReplies = 0;
  let lastGenuineAt: string | undefined;
  // The same inbound message is sometimes logged more than once (re-syncs);
  // count each distinct message once, at its earliest timestamp.
  const seen = new Set<string>();
  const sorted = [...engs].sort(
    (a, b) => new Date(a?.createdAt ?? 0).getTime() - new Date(b?.createdAt ?? 0).getTime(),
  );
  for (const e of sorted) {
    const s = classifyEngagementSignal(e);
    if (s === 'reply' || s === 'auto_reply' || s === 'negative_reply') {
      const key = messageKey(e);
      if (key) {
        if (seen.has(key)) continue;
        seen.add(key);
      }
    }
    if (s === 'auto_reply') autoReplies++;
    if (s !== 'reply' && s !== 'meeting' && s !== 'click') continue;
    if (s === 'reply') replies++;
    else if (s === 'meeting') meetings++;
    else clicks++;
    if (s !== 'click' && e?.createdAt && !Number.isNaN(new Date(e.createdAt).getTime())) {
      if (!lastGenuineAt || new Date(e.createdAt).getTime() > new Date(lastGenuineAt).getTime()) {
        lastGenuineAt = e.createdAt;
      }
    }
  }

  let score = 0;
  if (meetings > 0) score += 6;
  if (replies > 0) score += 5 + Math.min(replies - 1, 2);
  score += Math.min(clicks, 2);
  if (lastGenuineAt) {
    const a = ageDays(lastGenuineAt, now);
    if (a < 7) score += 3;
    else if (a < 14) score += 2;
    else if (a < 30) score += 1;
  }
  // Clicks alone never reach Warm.
  if (replies === 0 && meetings === 0) score = Math.min(score, WARM_THRESHOLD - 1);
  return { score: Math.min(10, Math.max(0, score)), replies, meetings, clicks, autoReplies, lastGenuineAt };
}

export function computeGenuineHeatScore(lead: any, now: number = Date.now()): number {
  return computeHeatBreakdown(lead, now).score;
}

/** Event counts as engagement for the isEngaged flag. */
export function isGenuineEngagementEvent(event: any): boolean {
  const s = classifyEngagementSignal(event);
  return s === 'reply' || s === 'meeting' || s === 'click';
}
