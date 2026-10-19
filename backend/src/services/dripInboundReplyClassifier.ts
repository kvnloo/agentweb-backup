/**
 * ENG-2539 (ENG-2167 slice): pure inbound-reply classifier for drip-sequence
 * exit-on-reply. Only a genuine human reply should stop a sequence; auto
 * replies, out-of-office notices and bounces must not.
 *
 * Pure: no persistence, no Resend/IMAP calls. Bounce handling itself is owned
 * by ENG-2517/2518; here a bounce is only recognised so it does not exit.
 *
 * Precedence (first match wins): bounce > auto-reply headers > OOO
 * subject/body patterns > body content. Headers beat body text.
 */

export type InboundReplyKind =
  | 'human_reply'
  | 'auto_reply'
  | 'out_of_office'
  | 'bounce'
  | 'unknown';

export interface InboundMessage {
  /** Header names are matched case-insensitively. */
  headers?: Record<string, string | string[] | null | undefined> | null;
  from?: string | null;
  subject?: string | null;
  bodyText?: string | null;
}

export interface InboundReplyClassification {
  kind: InboundReplyKind;
  shouldExitSequence: boolean;
  reasons: string[];
}

const BOUNCE_SENDER = /(^|[<\s"])(mailer-daemon|postmaster)@/i;

const AUTO_PRECEDENCE = /^(bulk|junk|list|auto_reply)$/i;

/**
 * Strong auto-reply markers: safe to match in the subject AND the (unquoted)
 * body, because a human rarely writes these phrases in a genuine reply.
 */
export const STRONG_OOO_PATTERNS: RegExp[] = [
  /\bautomatic reply\b/i,
  /\bauto[- ]?reply\b/i,
  /\bautoreply\b/i,
  /\bauto[- ]?response\b/i,
  /\bi am (currently )?out of (the )?office\b/i,
  /\bi'?m (currently )?out of (the )?office\b/i,
  /\babwesenheitsnotiz\b/i, // de
  /\bautomatische antwort\b/i, // de
  /\bréponse automatique\b/i, // fr
  /\brespuesta automática\b/i, // es
  /\brisposta automatica\b/i, // it
  /\bresposta automática\b/i, // pt
  /\bautomatisch antwoord\b/i, // nl
  /自动回复/, // zh
  /自動回覆/, // zh-TW
  /自動返信/, // ja
  /不在通知/, // ja
];

/**
 * Ambiguous absence phrases ("on vacation", "out of office"): a human reply
 * can say "I was on vacation, yes let's talk", so these match the SUBJECT only.
 */
export const SUBJECT_ONLY_OOO_PATTERNS: RegExp[] = [
  /\bout of (the )?office\b/i,
  /\bon (annual )?(leave|vacation|holiday)\b/i,
  /\bnicht im büro\b/i, // de
  /\babsence du bureau\b/i, // fr
  /\bhors du bureau\b/i, // fr
  /\bfuera de la oficina\b/i, // es
  /\bfuori sede\b/i, // it
  /\bfora do escritório\b/i, // pt
  /\bafwezig\b/i, // nl
  /不在办公室|不在公司|外出中|休假中|休暇中/, // zh/ja workplace absence
];

/** All subject markers (back-compat export). */
export const OUT_OF_OFFICE_PATTERNS: RegExp[] = [...STRONG_OOO_PATTERNS, ...SUBJECT_ONLY_OOO_PATTERNS];

function headerMap(headers: InboundMessage['headers']): Map<string, string> {
  const map = new Map<string, string>();
  if (!headers) return map;
  for (const [k, v] of Object.entries(headers)) {
    if (v === null || v === undefined) continue;
    const value = Array.isArray(v) ? v.join(', ') : String(v);
    map.set(k.toLowerCase(), value.trim());
  }
  return map;
}

/** Strip quoted history ("> ..." lines and everything after an "On ... wrote:" marker). */
export function stripQuotedText(body: string): string {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const kept: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (/^on .+wrote:$/i.test(t) || /^-{2,}\s*original message\s*-{2,}$/i.test(t) || /^from:\s/i.test(t) && kept.length > 0) {
      break;
    }
    if (t.startsWith('>')) continue;
    kept.push(line);
  }
  return kept.join('\n').trim();
}

function result(kind: InboundReplyKind, reasons: string[]): InboundReplyClassification {
  return { kind, shouldExitSequence: kind === 'human_reply', reasons };
}

export function classifyInboundReply(msg: InboundMessage): InboundReplyClassification {
  const h = headerMap(msg.headers);
  const from = msg.from ?? '';
  const subject = msg.subject ?? '';
  const body = msg.bodyText ?? '';

  // 1. Bounce (delivery status report or daemon sender).
  const contentType = h.get('content-type') ?? '';
  const bounceReasons: string[] = [];
  if (/multipart\/report/i.test(contentType) && /report-type\s*=\s*"?delivery-status/i.test(contentType)) {
    bounceReasons.push('content_type_delivery_status');
  }
  if (BOUNCE_SENDER.test(from) || /^(mailer-daemon|postmaster)$/i.test(from.trim())) {
    bounceReasons.push('daemon_sender');
  }
  if (bounceReasons.length) return result('bounce', bounceReasons);

  // 2. Auto-reply headers (RFC 3834 and vendor equivalents).
  const autoReasons: string[] = [];
  const autoSubmitted = h.get('auto-submitted');
  if (autoSubmitted !== undefined && autoSubmitted !== '' && autoSubmitted.toLowerCase() !== 'no') {
    autoReasons.push('auto_submitted');
  }
  if (h.has('x-autoreply') || h.has('x-autorespond')) autoReasons.push('x_autoreply');
  const precedence = h.get('precedence');
  if (precedence && AUTO_PRECEDENCE.test(precedence)) autoReasons.push('precedence');
  if (h.has('x-auto-response-suppress')) autoReasons.push('x_auto_response_suppress');
  if (autoReasons.length) return result('auto_reply', autoReasons);

  // 3. Out-of-office patterns in subject/body.
  const oooReasons: string[] = [];
  if (OUT_OF_OFFICE_PATTERNS.some((p) => p.test(subject))) oooReasons.push('ooo_subject');
  if (STRONG_OOO_PATTERNS.some((p) => p.test(stripQuotedText(body)))) oooReasons.push('ooo_body');
  if (oooReasons.length) return result('out_of_office', oooReasons);

  // 4. Body content.
  if (stripQuotedText(body).length === 0) {
    return result('unknown', [body.trim().length === 0 ? 'empty_body' : 'quoted_only']);
  }
  return result('human_reply', ['human_body']);
}
