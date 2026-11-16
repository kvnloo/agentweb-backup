/**
 * ENG-2538 (ENG-2167 slice, addresses ENG-325): pure human/bot classifier for
 * drip-sequence engagement events. Link scanners and image proxies fire
 * opens/clicks that must not exit a lead from a sequence.
 *
 * Pure: no persistence, no Resend calls, no webhook wiring.
 */

export type EngagementType = 'open' | 'click';

export interface EngagementEvent {
  type: EngagementType;
  occurredAt: string | number | Date;
  userAgent?: string | null;
  ip?: string | null;
  /** Clicked URL (clicks only); used by the burst rule. */
  link?: string | null;
}

export interface ClassifyInput extends EngagementEvent {
  sentAt: string | number | Date;
  priorEvents?: EngagementEvent[];
}

export type ClassifyReason =
  | 'too_fast'
  | 'proxy_open'
  | 'scanner_user_agent'
  | 'click_burst'
  | 'invalid_timestamp'
  | 'human';

export interface ClassifyResult {
  human: boolean;
  reason: ClassifyReason;
}

export interface ClassifyOptions {
  /** Events within this many ms after send are non-human. Default 10_000. */
  tooFastWindowMs?: number;
  /** Distinct-link clicks needed to count as a burst. Default 3. */
  burstMinClicks?: number;
  /** Burst window in ms. Default 2_000. */
  burstWindowMs?: number;
}

/**
 * Image proxies that prefetch opens regardless of a human (Apple MPP). Opens
 * from these never count as human.
 *
 * ENG-325: Gmail's GoogleImageProxy (ggpht.com) is deliberately NOT listed.
 * Gmail fetches images through its proxy only when the recipient opens the
 * message, so it is the dominant UA for real human opens. Machine opens via
 * Gmail are still caught by the too-fast gap rule.
 */
export const IMAGE_PROXY_USER_AGENT_PATTERNS: readonly RegExp[] = [
  /Apple\s?Mail\s?Privacy/i,
  /AppleMailProxy/i,
];

/** Link scanners / security gateways / preview fetchers. */
/**
 * ENG-325: Gmail's image proxy is human for opens, but a *click* carrying the
 * image-proxy UA is an automated fetch, never a recipient's click.
 */
export const CLICK_ONLY_SCANNER_USER_AGENT_PATTERNS: readonly RegExp[] = [/GoogleImageProxy/i, /ggpht\.com/i];

export const SCANNER_USER_AGENT_PATTERNS: readonly RegExp[] = [
  ...IMAGE_PROXY_USER_AGENT_PATTERNS,
  /SafeLinks/i,
  /Microsoft Office Protocol Discovery/i,
  /ms-office/i,
  /Outlook-iOS-Android\/.*preview/i,
  /OutlookPreview/i,
  /Barracuda/i,
  /Proofpoint/i,
  /Mimecast/i,
  /YahooMailProxy/i,
];

const DEFAULTS: Required<ClassifyOptions> = {
  tooFastWindowMs: 10_000,
  burstMinClicks: 3,
  burstWindowMs: 2_000,
};

function toMs(t: string | number | Date): number {
  return t instanceof Date ? t.getTime() : typeof t === 'number' ? t : Date.parse(t);
}

function matchesAny(ua: string | null | undefined, patterns: readonly RegExp[]): boolean {
  if (!ua) return false;
  return patterns.some((p) => p.test(ua));
}

export function classifyEngagementEvent(
  input: ClassifyInput,
  options: ClassifyOptions = {},
): ClassifyResult {
  const opts = { ...DEFAULTS, ...options };
  const at = toMs(input.occurredAt);
  const sent = toMs(input.sentAt);

  if (!Number.isFinite(at) || !Number.isFinite(sent)) {
    return { human: false, reason: 'invalid_timestamp' };
  }
  if (input.type === 'open' && matchesAny(input.userAgent, IMAGE_PROXY_USER_AGENT_PATTERNS)) {
    return { human: false, reason: 'proxy_open' };
  }
  if (
    matchesAny(input.userAgent, SCANNER_USER_AGENT_PATTERNS) ||
    (input.type === 'click' && matchesAny(input.userAgent, CLICK_ONLY_SCANNER_USER_AGENT_PATTERNS))
  ) {
    return { human: false, reason: 'scanner_user_agent' };
  }
  if (at - sent < opts.tooFastWindowMs) {
    return { human: false, reason: 'too_fast' };
  }
  if (input.type === 'click') {
    const links = new Set<string>();
    const all: EngagementEvent[] = [...(input.priorEvents ?? []), input];
    for (const e of all) {
      if (e.type !== 'click' || !e.link) continue;
      if (
        e !== input &&
        (matchesAny(e.userAgent, SCANNER_USER_AGENT_PATTERNS) ||
          matchesAny(e.userAgent, CLICK_ONLY_SCANNER_USER_AGENT_PATTERNS))
      )
        continue;
      const t = toMs(e.occurredAt);
      if (Number.isFinite(t) && Math.abs(at - t) <= opts.burstWindowMs) links.add(e.link);
    }
    if (links.size >= opts.burstMinClicks) return { human: false, reason: 'click_burst' };
  }
  return { human: true, reason: 'human' };
}

export interface StopConditions {
  exitOnOpen?: boolean;
  exitOnClick?: boolean;
}

/**
 * True when any human-classified event matches an enabled stop condition.
 * Each event is classified against every other event in the list (before and
 * after): a scanner fans out across all links at once, so the first click of a
 * burst must not count as human just because it arrived first.
 */
export function shouldExitSequence(
  events: EngagementEvent[],
  sentAt: string | number | Date,
  stopConditions: StopConditions,
  options: ClassifyOptions = {},
): boolean {
  const sorted = [...events].sort((a, b) => toMs(a.occurredAt) - toMs(b.occurredAt));
  return sorted.some((e, i) => {
    const enabled = e.type === 'open' ? stopConditions.exitOnOpen : stopConditions.exitOnClick;
    if (!enabled) return false;
    return classifyEngagementEvent(
      { ...e, sentAt, priorEvents: sorted.filter((_, j) => j !== i) },
      options,
    ).human;
  });
}
