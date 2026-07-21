/**
 * Email engagement guard — distinguishes real human opens/clicks from automated
 * machine engagement (corporate link scanners, email-security prefetch) so that a
 * scanner cannot silently trigger a sequence "exit on open/click" and drop a lead
 * out of an outreach sequence without them ever engaging.  (ENG-325)
 *
 * Design constraints (from ENG-325, learned the hard way — do NOT relax these):
 *   1. NEVER ship a "bot-looking user-agent" blocklist.  Gmail's image proxy
 *      (`GoogleImageProxy` / `ggpht.com`) is the dominant open UA and it means a
 *      REAL human open — it must always count as engagement.
 *   2. NEVER use a standalone "engagement under N seconds = bot" numeric threshold.
 *      Sampled prod traffic showed the fastest real click at 18.7s; a bare
 *      time cutoff is calibrated against nothing.
 *
 * We therefore only suppress on POSITIVE, calibration-free evidence of a machine.
 * Anything ambiguous is treated as real engagement (behaviour-preserving default):
 *
 *   - `prefetch`         — the open/click timestamp is at or before the email's own
 *                          send time.  A human cannot open an email before it is
 *                          sent; this is a scanner/prefetch fetching the message at
 *                          delivery.  Pure arithmetic, not a tuned threshold.
 *   - `known-scanner-ua` — the user agent carries a NAMED email-security vendor
 *                          fingerprint (Proofpoint, Mimecast, Barracuda, Microsoft
 *                          Safe Links, Symantec/MessageLabs, Cisco IronPort,
 *                          Forcepoint/Websense, Fortinet).  An allowlist of known
 *                          scanners — never `GoogleImageProxy` or ordinary browsers.
 *   - `sub-second-no-ua` — the issue's exact tripwire ("sub-second gap plus a
 *                          datacenter user agent"), expressed safely: a positive
 *                          gap under one second AND a MISSING user agent.  Every
 *                          real mail client (Gmail, Apple, Outlook) sends a UA, so
 *                          a sub-second engagement with no UA at all is a machine.
 *                          Only fires in combination — never on the gap alone.
 *
 * Note: a `reply` exit condition has no false-positive mode; this guard only
 * governs `opened` / `clicked`.
 */

/**
 * Max send→engagement gap (ms) that, when combined with a MISSING user agent,
 * is treated as machine engagement. Never applied on its own — see module docs.
 */
export const SCANNER_MAX_GAP_MS_WITHOUT_UA = 1000;

/**
 * Named corporate email-security scanner fingerprints. Case-insensitive.
 * These self-identify in the user agent when they fetch/click links to scan them.
 * Deliberately an allowlist of KNOWN vendors, not a heuristic "bot" blocklist —
 * and deliberately excludes Gmail's `GoogleImageProxy`, which means a real open.
 */
export const KNOWN_SCANNER_UA_PATTERNS: RegExp[] = [
  /Proofpoint/i,
  /\bURLDefense\b/i, // Proofpoint URL Defense
  /Mimecast/i,
  /Barracuda/i,
  /Microsoft(?:-| )?(?:ATP|Defender)/i, // Microsoft Defender for Office 365
  /SafeLinks/i,
  /Safe[- ]Links/i,
  /SkypeUriPreview/i, // Microsoft link-scanning agent
  /BingPreview/i,
  /MessageLabs/i, // Symantec / MessageLabs Email Security.cloud
  /Symantec/i,
  /IronPort/i, // Cisco IronPort / Secure Email
  /\bCisco\b/i,
  /Forcepoint/i,
  /Websense/i,
  /FortiMail/i,
  /Fortinet/i,
];

/**
 * True when the user agent matches a KNOWN named email-security scanner.
 * Returns false for Gmail's GoogleImageProxy, Apple Mail, ordinary browsers,
 * empty/missing UAs, and anything else not on the named allowlist.
 */
export function isKnownScannerUserAgent(ua?: string | null): boolean {
  if (!ua || typeof ua !== 'string' || !ua.trim()) return false;
  return KNOWN_SCANNER_UA_PATTERNS.some((re) => re.test(ua));
}

/**
 * Parse a Resend timestamp into epoch milliseconds.
 *
 * Resend's `data.created_at` (email send time) is NOT ISO-with-T — it looks like
 * `2026-07-14 14:51:51.523456+00` (space-separated, microseconds, bare `+00`
 * offset). Engagement timestamps (`data.open.timestamp` / `data.click.timestamp`)
 * and the webhook `created_at` are ISO. This tolerates both.
 *
 * Returns null when the value is missing or unparseable (callers fail open).
 */
export function parseResendTimestamp(raw?: string | null): number | null {
  if (!raw || typeof raw !== 'string') return null;
  let s = raw.trim();
  if (!s) return null;

  // Space-separated date/time → ISO 'T' (replace only the first space).
  s = s.replace(' ', 'T');
  // JS Date only handles millisecond precision — truncate any extra fractional digits.
  s = s.replace(/(\.\d{3})\d+/, '$1');
  // Normalize timezone offset: `+00`/`-05` → `+00:00`, `+0000` → `+00:00`.
  s = s.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  s = s.replace(/([+-]\d{2})$/, '$1:00');

  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : ms;
}

/** Minimal shape of a stored `AW-EmailEvents` record this guard reads. */
export interface EngagementEventLike {
  eventType?: string;
  createdAt?: string;
  data?: {
    created_at?: string;
    open?: { userAgent?: string; timestamp?: string; ipAddress?: string };
    click?: { userAgent?: string; timestamp?: string; ipAddress?: string };
    [key: string]: any;
  };
}

export interface EngagementSignals {
  /** engagement-time minus send-time, in ms; null when either is unknown. */
  gapMs: number | null;
  userAgent: string | null;
}

/**
 * Pull the send→engagement gap and user agent out of a stored email event.
 * Engagement time prefers the precise `open`/`click` sub-object timestamp and
 * falls back to the webhook `createdAt`. Send time is `data.created_at`.
 */
export function extractEngagementSignals(event: EngagementEventLike): EngagementSignals {
  const detail =
    event.eventType === 'email.clicked' ? event.data?.click : event.data?.open;

  const userAgent = detail?.userAgent ?? null;

  const engagementMs =
    parseResendTimestamp(detail?.timestamp) ?? parseResendTimestamp(event.createdAt);
  const sendMs = parseResendTimestamp(event.data?.created_at);

  const gapMs =
    engagementMs !== null && sendMs !== null ? engagementMs - sendMs : null;

  return { gapMs, userAgent };
}

export type ScannerReason = 'prefetch' | 'known-scanner-ua' | 'sub-second-no-ua';

export interface ScannerClassification {
  /** True → machine engagement; the caller must NOT fire an exit on this event. */
  isScanner: boolean;
  reason: ScannerReason | null;
  gapMs: number | null;
  userAgent: string | null;
}

/**
 * Classify a single open/click event as human vs. machine engagement.
 * Only returns isScanner=true on positive machine evidence; everything else
 * (including all ambiguous / unparseable cases) is treated as a real human.
 */
export function classifyEngagementEvent(event: EngagementEventLike): ScannerClassification {
  const { gapMs, userAgent } = extractEngagementSignals(event);

  // 1. Named email-security scanner user agent (never GoogleImageProxy).
  if (isKnownScannerUserAgent(userAgent)) {
    return { isScanner: true, reason: 'known-scanner-ua', gapMs, userAgent };
  }

  // 2. Prefetch / impossible timing — opened at or before the email was sent.
  if (gapMs !== null && gapMs <= 0) {
    return { isScanner: true, reason: 'prefetch', gapMs, userAgent };
  }

  // 3. Sub-second gap AND no user agent at all (the issue's combined tripwire).
  if (
    gapMs !== null &&
    gapMs < SCANNER_MAX_GAP_MS_WITHOUT_UA &&
    (!userAgent || !userAgent.trim())
  ) {
    return { isScanner: true, reason: 'sub-second-no-ua', gapMs, userAgent };
  }

  return { isScanner: false, reason: null, gapMs, userAgent };
}
