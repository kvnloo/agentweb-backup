import { createHash } from "crypto";

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
export function kindOf(name: unknown): SmartleadEventKind | undefined {
  const n = typeof name === "string" ? name.toUpperCase().replace(/[^A-Z]+/g, "_") : "";
  if (!n) return undefined;
  if (n.includes("UNSUBSCRIBE")) return "unsubscribe";
  if (n.includes("BOUNCE")) return "bounce";
  if (n.includes("REPLY") || n.includes("REPLIED")) return "reply";
  return undefined;
}

const SOFT = /mailbox (is )?full|over quota|quota exceeded|temporar|try again|greylist|deferred|\b4\d\d\b/i;

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
  const order = kind === "reply" ? [b.from_email, b.to_email] : [b.to_email, b.from_email];
  const candidateEmails = [...new Set([b.lead_email, b.leadEmail, b.email, lead.email, lead.lead_email, ...order].map(email).filter((e): e is string => !!e))].slice(0, 6);
  if (candidateEmails.length === 0) return { ok: false, reason: "no_contact_address" };

  const occurredAt = isoTime(b.time_replied ?? b.event_timestamp ?? b.timestamp ?? b.time_bounced ?? b.time ?? b.created_at);
  const reasonText = short(b.bounce_reason ?? b.reason ?? b.error ?? b.bounce_message ?? b.message ?? (b.bounce as Record<string, unknown> | undefined)?.reason, 160);
  const bounceType = str(b.bounce_type ?? b.bounceType ?? (b.bounce as Record<string, unknown> | undefined)?.type)?.toLowerCase();
  const soft = kind === "bounce" && (/(soft|temporary|transient)/.test(bounceType ?? "") || (!/(hard|permanent)/.test(bounceType ?? "") && !!reasonText && SOFT.test(reasonText)));

  const sequence = str(String(b.sequence_number ?? b.seq_number ?? "")) ?? "";
  const messageId = str(b.message_id ?? b.messageId ?? b.stats_id ?? b.email_stats_id ?? b.sl_email_lead_id) ?? "";
  const eventKey = createHash("sha256").update(JSON.stringify([kind, campaignId, candidateEmails[0], occurredAt ?? "", sequence, messageId])).digest("hex").slice(0, 32);

  return {
    ok: true,
    event: {
      kind, campaignId, candidateEmails,
      ...(kind === "reply" ? { subject: short(b.subject ?? b.email_subject, 200), from: email(b.from_email), to: email(b.to_email) } : {}),
      ...(occurredAt ? { occurredAt } : {}),
      soft,
      ...(reasonText ? { reason: reasonText } : {}),
      eventKey,
    },
  };
}
