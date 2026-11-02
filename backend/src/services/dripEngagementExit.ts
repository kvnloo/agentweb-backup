/**
 * ENG-2548 (ENG-325 slice): decide which stored email event, if any, exits a
 * drip enrollment — gating opens/clicks on dripEngagementClassifier so link
 * scanners and image proxies no longer exit a lead.
 *
 * Pure: takes the already-fetched emailEvents rows, no I/O. Replies are never
 * classified (an inbound email is a human act). When the send time is unknown
 * the classifier cannot judge the event, so we fall back to the pre-ENG-2548
 * behaviour (the event exits) rather than silently keeping a live lead enrolled.
 */
import { classifyEngagementEvent, ClassifyReason, EngagementEvent } from './dripEngagementClassifier';

export type EngagementExitCondition = 'opened' | 'clicked' | 'replied';

export interface SuppressedEngagement {
  event: any;
  reason: ClassifyReason;
}

export interface EngagementExitDecision {
  trigger: any | null;
  suppressed: SuppressedEngagement[];
}

function parseSentAt(e: any): number {
  const raw = e?.data?.created_at;
  if (!raw) return NaN;
  // Resend stores e.g. "2026-10-24 07:59:00.123456+00": swap the space for
  // "T" and widen a bare "+HH"/"-HH" offset to "+HH:00" so Date can parse it.
  const iso = String(raw).trim().replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00');
  return new Date(iso).getTime();
}

function toEngagement(e: any): EngagementEvent | null {
  const type = e?.eventType === 'email.opened' ? 'open' : e?.eventType === 'email.clicked' ? 'click' : null;
  if (!type) return null;
  const detail = e?.data?.click || e?.data?.open || {};
  return {
    type,
    occurredAt: e.createdAt,
    userAgent: detail.userAgent ?? null,
    ip: detail.ipAddress ?? detail.ip ?? null,
    link: detail.link ?? null,
  };
}

export function selectEngagementExitTrigger(
  events: any[],
  enrolledAtMs: number,
  wanted: readonly EngagementExitCondition[],
  opts: { emailEverSent?: boolean } = {},
): EngagementExitDecision {
  const suppressed: SuppressedEngagement[] = [];
  const inWindow = events.filter((e) => {
    const at = e?.createdAt ? new Date(e.createdAt).getTime() : NaN;
    return Number.isFinite(at) && at > enrolledAtMs;
  });
  const engagements = inWindow.map(toEngagement);

  for (let i = 0; i < inWindow.length; i++) {
    const e = inWindow[i];
    if (wanted.includes('replied') && e.eventType === 'email.received') return { trigger: e, suppressed };
    const isOpen = wanted.includes('opened') && e.eventType === 'email.opened';
    const isClick = wanted.includes('clicked') && e.eventType === 'email.clicked';
    if (!isOpen && !isClick) continue;

    // Opens/clicks are only attributable to this sequence if it has sent this lead an
    // email, and the engaged email was sent after enrollment. The events lookup is keyed
    // on domain + lead only, so without this an open of an unrelated email exits the lead.
    if (opts.emailEverSent === false) continue;
    const sentAt = parseSentAt(e);
    if (Number.isFinite(sentAt) && sentAt < enrolledAtMs) continue;

    if (!Number.isFinite(sentAt)) return { trigger: e, suppressed }; // cannot classify: legacy behaviour

    const priorEvents = engagements.filter((x, j): x is EngagementEvent => j !== i && x !== null);
    const result = classifyEngagementEvent({ ...(engagements[i] as EngagementEvent), sentAt, priorEvents });
    if (result.human) return { trigger: e, suppressed };
    suppressed.push({ event: e, reason: result.reason });
  }
  return { trigger: null, suppressed };
}
