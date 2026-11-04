import { createHash } from "crypto";
import { hasVisibleText, sliceSafe, stripUnsafeChars } from "./smartleadSafeText";

/**
 * Turns a Smartlead webhook body into one small, checked event (ENG-673, slice 3). Pure: no network, no storage.
 *
 * Smartlead's documentation disagrees with itself about event names (EMAIL_REPLY / EMAIL_REPLIED / LEAD_REPLIED, EMAIL_BOUNCE / LEAD_BOUNCED,
 * LEAD_UNSUBSCRIBED / EMAIL_UNSUBSCRIBED) and does not document the bounce payload, so this accepts every documented spelling and looks for the
 * contact's address under every field a payload might use. Which contact an event is about is NOT decided here: the caller tries each candidate
 * address and only acts on a contact that was pushed to this campaign through this account, so a wrong guess can never touch the wrong person.
 */
export type SmartleadEventKind = "reply" | "bounce" | "unsubscribe";

export interface SmartleadEvent {
  kind: SmartleadEventKind;
  campaignId: number;
  /** Addresses that may be the contact, best guess first (lower case, deduplicated). */
  candidateEmails: string[];
  subject?: string;
  /**
   * What the contact wrote, without the thread quoted under it, for the owner's alert email only (never stored on the contact: the full reply
   * stays in Smartlead). Plain text only, at most REPLY_TEXT_MAX characters. Absent when the payload has none (a polled reply never does).
   */
  replyText?: string;
  /** The reply's own address and the sending mailbox's, for the alert text. */
  from?: string;
  to?: string;
  /** When Smartlead says it happened, as an ISO string, when the payload says. */
  occurredAt?: string;
  /** A bounce that looks temporary (mailbox full, try again): recorded, but the contact is not blocked. */
  soft: boolean;
  /** Why Smartlead says it bounced, short, for the note on the contact. */
  reason?: string;
  /** Same event delivered twice gives the same key (Smartlead retries and can duplicate). */
  eventKey: string;
  /**
   * Set when the event was found by the hourly poll instead of delivered. The poll only learns THAT a contact replied, bounced or unsubscribed,
   * with no event id, so its key can never match the webhook's for the same event: to avoid recording the same thing twice, the service
   * skips a polled event when the contact already shows it (see SmartleadEventService).
   */
  polled?: boolean;
}

export type ParseResult = { ok: true; event: SmartleadEvent } | { ok: false; reason: string };

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const email = (v: unknown): string | undefined => {
  const s = str(v)?.toLowerCase();
  if (!s) return undefined;
  const m = s.match(/<([^<>\s]+@[^<>\s]+)>/); // "Name <a@b.c>"
  const bare = (m ? m[1] : s).trim();
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(bare) && bare.length <= 254 ? bare : undefined;
};
const short = (v: unknown, max: number): string | undefined => {
  const s = str(v);
  if (!s) return undefined;
  const one = s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};
const isoTime = (v: unknown): string | undefined => {
  const s = str(v);
  if (!s) return undefined;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
};

/** The event kind from whatever name field the payload uses; unknown names are ignored. */
const NAMES: Record<string, SmartleadEventKind> = {
  EMAIL_REPLY: "reply", EMAIL_REPLIED: "reply", LEAD_REPLY: "reply", LEAD_REPLIED: "reply",
  EMAIL_BOUNCE: "bounce", EMAIL_BOUNCED: "bounce", LEAD_BOUNCE: "bounce", LEAD_BOUNCED: "bounce",
  LEAD_UNSUBSCRIBED: "unsubscribe", EMAIL_UNSUBSCRIBED: "unsubscribe", LEAD_UNSUBSCRIBE: "unsubscribe", EMAIL_UNSUBSCRIBE: "unsubscribe",
};
/** Only the exact documented names (any case or separator): a longer name such as a category change on a reply is NOT a reply. */
export function kindOf(name: unknown): SmartleadEventKind | undefined {
  const n = typeof name === "string" ? name.toUpperCase().replace(/[^A-Z]+/g, "_").replace(/^_+|_+$/g, "") : "";
  return Object.prototype.hasOwnProperty.call(NAMES, n) ? NAMES[n] : undefined;
}

// A bounce is only called temporary on clear signs, and never when the same text also says it is permanent: a wrongly "soft" hard bounce would
// leave an address that cannot receive mail unblocked.
const SOFT = /mailbox (is )?full|over quota|quota exceeded|temporar(y|ily)|try again later|greylist|deferred|^\s*4\d\d[ -]|\b4\.\d\.\d{1,3}\b/i;
const HARD = /permanent|do not try again|don't try again|user unknown|no such user|does not exist|invalid (recipient|address|mailbox)|unknown (user|recipient)|address rejected|\b5\d\d\b|\b5\.\d\.\d{1,3}\b/i;

/** JSON with object keys in a fixed order, so the same body always gives the same text. */
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v as object).sort().map(k => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v) ?? "null";
}

/** The most of a reply an event carries. The alert email shows less. */
export const REPLY_TEXT_MAX = 1000;

// Where the quoted thread under a reply starts: a quoted line, "On <date>, <name> wrote:" (which a mail client may wrap so that a single word or address, or
// just "wrote:", is alone on the next line), the same in English, French, Spanish, German and Italian, an "Original Message" or underscore rule, or an
// Outlook "From: ... Sent: ... To: ..." block. Every pattern is bounded, so none can take long on a hostile line.
const QUOTED_LINE = /^\s*>/;
const WROTE_HEADER = /^\s*(On|Le|El|Am|Il)\s.{3,300}$/;
// German puts the name after the verb: "Am 03.11.2026 um 09:23 schrieb Max Mustermann <max@x.de>:".
const WROTE_END = /(wrote|a \u00e9crit|escribi\u00f3|ha scritto)\s*:\s*$|schrieb\b[^:]{0,200}:\s*$/i;
// The optional token group starts with a non-space, so the leading and the inner whitespace can never split the same run of spaces (that made an earlier form quadratic).
const WROTE_NEXT = /^\s*(?:\S{1,120}\s*)?(wrote|a \u00e9crit|escribi\u00f3|schrieb|ha scritto)\s*:\s*$/i;
const GERMAN_NEXT = /^\s*\S{0,120}:\s*$/;
const ORIGINAL_RULE = /^\s*(-{2,}\s*(original message|forwarded message)\s*-{2,}|_{10,})\s*$/i;
const OUTLOOK_FROM = /^\s*From:\s.+/i;
const OUTLOOK_FIELD = /^\s*(Sent|Date|To|Cc|Subject):\s/i;
/** Only this much of a reply is read at all (the webhook body may be 256 KB, and a reply is a few paragraphs). */
const REPLY_SCAN_MAX = 10_000;
/** Most lines of a reply kept. */
const REPLY_LINES_MAX = 40;

/**
 * What the contact wrote in a reply, from the payload's plain text (`reply_message.text`, else `preview_text`). The HTML copies are never
 * used. Only the first REPLY_SCAN_MAX characters are read; the quoted thread is cut off at its first marker; control, zero-width and
 * direction-changing characters go; blank runs shrink; the result is capped. Linear in its input. Undefined when nothing visible is left (a
 * reply that is only quoted text or invisible characters, or a payload with no text).
 */
export function replyExcerpt(body: Record<string, unknown>): string | undefined {
  const message = body.reply_message && typeof body.reply_message === "object" ? (body.reply_message as Record<string, unknown>).text : undefined;
  const raw = typeof message === "string" && message.trim() ? message : typeof body.preview_text === "string" ? body.preview_text : "";
  if (!raw.trim()) return undefined;
  const lines = stripUnsafeChars(sliceSafe(raw, REPLY_SCAN_MAX)).replace(/\r\n?/g, "\n").split("\n");
  const kept: string[] = [];
  for (let i = 0; i < lines.length && kept.length < REPLY_LINES_MAX; i++) {
    const line = lines[i];
    if (QUOTED_LINE.test(line) || ORIGINAL_RULE.test(line)) break;
    if (WROTE_HEADER.test(line)) {
      const next = lines[i + 1] ?? "";
      if (WROTE_END.test(line) || (line.trim().length >= 15 && (WROTE_NEXT.test(next) || (/\bschrieb\b/i.test(line) && GERMAN_NEXT.test(next))))) break;
    }
    if (OUTLOOK_FROM.test(line) && lines.slice(i + 1, i + 6).filter(l => OUTLOOK_FIELD.test(l)).length >= 2) break;
    kept.push(line.trimEnd());
  }
  const text = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!text || !hasVisibleText(text)) return undefined;
  return text.length > REPLY_TEXT_MAX ? `${sliceSafe(text, REPLY_TEXT_MAX - 1).trimEnd()}\u2026` : text;
}

export function parseSmartleadEvent(body: unknown): ParseResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, reason: "not_an_object" };
  const b = body as Record<string, unknown>;
  const kind = [b.event_type, b.eventType, b.event, b.type, b.webhook_event, b.event_name].map(kindOf).find(Boolean);
  if (!kind) return { ok: false, reason: "unhandled_event" };

  const rawCampaign = b.campaign_id ?? b.campaignId ?? (b.campaign as Record<string, unknown> | undefined)?.id;
  const campaignId = typeof rawCampaign === "number" ? rawCampaign : typeof rawCampaign === "string" && /^\d+$/.test(rawCampaign) ? Number(rawCampaign) : NaN;
  if (!Number.isSafeInteger(campaignId) || campaignId <= 0) return { ok: false, reason: "no_campaign" };

  const lead = (b.lead && typeof b.lead === "object" ? b.lead : b.lead_data && typeof b.lead_data === "object" ? b.lead_data : {}) as Record<string, unknown>;
  // The contact's own field names first, then the two mailbox fields in the order that fits the kind (a reply comes FROM the contact;
  // a bounce goes TO them).
  // Seen in real payloads (2026-10-29): `from_email` is the SENDING MAILBOX and `to_email` the contact, for a reply as well as an unsubscribe;
  // a reply also carries the contact as `sl_lead_email` and in `leadCorrespondence`. The mailbox address goes last.
  const corr = (b.leadCorrespondence && typeof b.leadCorrespondence === "object" ? b.leadCorrespondence : {}) as Record<string, unknown>;
  const candidateEmails = [...new Set([b.sl_lead_email, b.lead_email, corr.targetLeadEmail, corr.replyReceivedFrom, b.leadEmail, b.email, lead.email, lead.lead_email, b.to_email, b.from_email].map(email).filter((e): e is string => !!e))].slice(0, 6);
  if (candidateEmails.length === 0) return { ok: false, reason: "no_contact_address" };

  const occurredAt = isoTime(b.time_replied ?? b.event_timestamp ?? b.timestamp ?? b.time_bounced ?? b.time ?? b.created_at);
  // Seen in a real bounce (2026-10-29): the receiving server's notice is `bounce_message.text` (also `bounce_reply_email_preview`), e.g.
  // "slice3-nosuchuser wasn't found at withagentweb.com". The HTML copies of it are never used.
  const bounceMessage = b.bounce_message && typeof b.bounce_message === "object" ? (b.bounce_message as Record<string, unknown>).text : b.bounce_message;
  const reasonText = short(b.bounce_reason ?? b.reason ?? b.error ?? bounceMessage ?? b.bounce_reply_email_preview ?? b.message ?? (b.bounce as Record<string, unknown> | undefined)?.reason, 160);
  const bounceType = str(b.bounce_type ?? b.bounceType ?? (b.bounce as Record<string, unknown> | undefined)?.type)?.toLowerCase();
  // A bounce Smartlead says came from OUR side (`is_sender_originated_bounce`, e.g. the sending mailbox was refused or is broken) says nothing
  // about the contact's address, and `is_bounced: false` is no bounce at all: both are recorded but never block the contact.
  const notTheContacts = b.is_sender_originated_bounce === true || b.is_bounced === false;
  const soft = kind === "bounce" && (notTheContacts || /(soft|temporary|transient)/.test(bounceType ?? "") || (!/(hard|permanent)/.test(bounceType ?? "") && !!reasonText && SOFT.test(reasonText) && !HARD.test(reasonText)));

  const replyText = kind === "reply" ? replyExcerpt(b) : undefined;
  const sequence = str(String(b.sequence_number ?? b.seq_number ?? "")) ?? "";
  // `event_id` is unique per event and the same on every retry of it (it is also the `webhook-id` header): the best identity there is.
  const messageId = str(b.event_id ?? b.message_id ?? b.messageId ?? b.stats_id ?? b.email_stats_id ?? b.sl_email_lead_id) ?? "";
  // With no time or id in the payload, the body itself identifies the delivery (a retry sends the same body); otherwise two different replies
  // from one contact would share a key and the second would be dropped as a duplicate.
  const identity = occurredAt || sequence || messageId ? "" : createHash("sha256").update(canonicalJson(body)).digest("hex");
  const eventId = typeof b.event_id === "number" ? String(b.event_id) : str(b.event_id);
  // With an event id, ONLY it (plus the kind and campaign) decides the key: nothing else in a retried delivery can change it.
  const eventKey = createHash("sha256").update(JSON.stringify(eventId ? [kind, campaignId, eventId] : [kind, campaignId, candidateEmails[0], occurredAt ?? "", sequence, messageId, identity])).digest("hex").slice(0, 32);

  return {
    ok: true,
    event: {
      kind, campaignId, candidateEmails,
      ...(kind === "reply" ? { subject: short(b.subject ?? b.email_subject, 200), from: candidateEmails[0], to: email(b.sl_senders_mailbox) ?? email(b.from_email) } : {}),
      ...(replyText ? { replyText } : {}),
      ...(occurredAt ? { occurredAt } : {}),
      soft,
      ...(reasonText ? { reason: reasonText } : {}),
      eventKey,
    },
  };
}
