/**
 * The email a list owner gets when a contact replies to a Smartlead campaign (ENG-673, slice 3).
 *
 * This is customer-facing: the owner is the AgentWeb customer, so it carries plain words, a time with its zone, and one button, never an
 * internal event name or a raw id. Only this one alert uses it; every other lead list alert keeps the generic email in
 * leadListAlertService.ts, because that template is shared and customers receive it today.
 *
 * The builder is pure: everything it shows comes in as an argument, and anything that came from a contact (their name, the reply subject) is
 * escaped or reduced to one line, because a contact controls those words.
 */

import { hasVisibleText, sliceSafe, stripUnsafeChars } from "./smartleadSafeText";

export interface SmartleadReplyAlertInput {
  /** What AgentWeb calls the contact (a name, else the address). */
  leadName: string;
  /** The contact's address, when there is one. */
  leadEmail?: string;
  listName: string;
  campaignName?: string;
  /** The subject of the reply. */
  replySubject?: string;
  /** What the contact wrote (plain text, no quoted thread). Shown in a quoted block, shortened; omitted when absent. */
  replyText?: string;
  /** When the reply arrived (an ISO time). */
  receivedAt?: string;
  /** Opens the contact in AgentWeb. No button when absent. */
  contactUrl?: string;
}

export interface AlertEmailContent {
  subject: string;
  text: string;
  html: string;
}

/** True for the one alert this file builds: a reply that came back through Smartlead. */
export const isSmartleadReplyAlert = (eventType: string, eventData: unknown): boolean =>
  String(eventType).trim().toLowerCase() === "email.received" && !!eventData && typeof eventData === "object" && (eventData as { source?: unknown }).source === "smartlead";

const escapeHtml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** One line: no control, zero-width or direction-changing characters (a name or subject must never add a header line or reorder the text), trimmed and shortened. */
const oneLine = (value: unknown, max: number): string => {
  const cleaned = stripUnsafeChars(String(value ?? "")).replace(/\s+/g, " ").trim();
  if (!hasVisibleText(cleaned)) return "";
  return cleaned.length > max ? `${sliceSafe(cleaned, max - 1).trimEnd()}\u2026` : cleaned;
};

/**
 * What a short alert (Slack, WhatsApp, the email subject) calls the contact: their name, else their address, as one safe line of at most
 * `max` characters. Empty when there is neither. A name that is just the address counts as the address, so it is shown once.
 */
export function smartleadReplyContactLabel(leadName: unknown, leadEmail: unknown, max = 40): string {
  const email = oneLine(leadEmail, 200);
  const rawName = oneLine(leadName, 120);
  const name = rawName && rawName.toLowerCase() !== email.toLowerCase() ? rawName : "";
  return oneLine(name || email, max);
}

/**
 * The one sentence every channel uses for a Smartlead reply: A new lead "Manan Test" replied to your campaign. With neither a name nor an
 * address there is nothing to quote.
 */
export function smartleadReplyHeadline(leadName: unknown, leadEmail: unknown): string {
  const who = smartleadReplyContactLabel(leadName, leadEmail);
  return who ? `A new lead "${who}" replied to your campaign` : "A new lead replied to your campaign";
}

/** "Nov 3, 2026, 9:23 AM UTC". The zone is always shown: no timezone is stored for a user. Undefined when the time is missing or unreadable. */
export const formatUtcTime = (iso: string | undefined): string | undefined => {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return undefined;
  const formatted = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(ms));
  return `${formatted.replace(/[\u202f\u00a0]/g, " ")} UTC`; // newer ICU puts a narrow no-break space before AM/PM
};

const FOOTER = "You are getting this because this lead list sends an alert for new replies. You can turn it off in the lead list's settings in AgentWeb.";
const NOTE_WITH_REPLY = "Smartlead keeps the full thread. Open your Smartlead inbox to answer.";
const NOTE_WITHOUT_REPLY = "Smartlead keeps the full reply. Open your Smartlead inbox to read it and answer.";
/** The most of a reply the email shows. */
const REPLY_SHOWN_MAX = 600;
const REPLY_SHOWN_LINES = 15;
const CAPTION = "The contact's own words. Check any link before you click it.";

/** The reply text as it is shown: safe characters, line breaks normalized, blank runs shrunk, at most REPLY_SHOWN_LINES lines and REPLY_SHOWN_MAX characters, cut at a word where there is one. */
const shownReply = (value: unknown): string => {
  const lines = stripUnsafeChars(String(value ?? "")).replace(/\r\n?/g, "\n").split("\n").map(line => line.trimEnd());
  let cleaned = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!hasVisibleText(cleaned)) return "";
  let cut = false;
  const kept = cleaned.split("\n");
  if (kept.length > REPLY_SHOWN_LINES) {
    cleaned = kept.slice(0, REPLY_SHOWN_LINES).join("\n").trimEnd();
    cut = true;
  }
  if (cleaned.length > REPLY_SHOWN_MAX) {
    const head = sliceSafe(cleaned, REPLY_SHOWN_MAX - 1);
    const space = head.lastIndexOf(" ");
    cleaned = (space > REPLY_SHOWN_MAX * 0.6 ? head.slice(0, space) : head).trimEnd();
    cut = true;
  }
  return cut ? `${cleaned}\u2026` : cleaned;
};

export function buildSmartleadReplyAlertEmail(input: SmartleadReplyAlertInput): AlertEmailContent {
  const email = oneLine(input.leadEmail, 200);
  const rawName = oneLine(input.leadName, 120);
  // A name that is just the address is shown once.
  const name = rawName && rawName.toLowerCase() !== email.toLowerCase() ? rawName : "";
  const who = name || email;

  // The contact's name sits in straight quotes: "A new lead "Manan Test" replied to your campaign". With neither a name nor an address there is nothing to quote.
  const subject = smartleadReplyHeadline(input.leadName, input.leadEmail);
  const heading = who ? `A new lead "${oneLine(who, 60)}" replied` : "A new lead replied";
  const quotedWho = who ? `"${who}"` : "A contact";
  const intro = name && email ? `"${name}" (${email}) replied to an email sent from your Smartlead campaign.` : `${quotedWho} replied to an email sent from your Smartlead campaign.`;

  const rows: Array<[string, string]> = [];
  const campaign = oneLine(input.campaignName, 160);
  if (campaign) rows.push(["Campaign", campaign]);
  const list = oneLine(input.listName, 160);
  if (list) rows.push(["Lead list", list]);
  const replySubject = oneLine(input.replySubject, 200);
  if (replySubject) rows.push(["Subject", replySubject]);
  const received = formatUtcTime(input.receivedAt);
  if (received) rows.push(["Received", received]);

  const reply = shownReply(input.replyText);
  const note = reply ? NOTE_WITH_REPLY : NOTE_WITHOUT_REPLY;
  const url = input.contactUrl && /^https?:\/\//i.test(input.contactUrl) ? input.contactUrl : "";

  const text = [
    heading,
    "",
    intro,
    "",
    ...rows.map(([label, value]) => `${label}: ${value}`),
    ...(reply ? ["", "Their reply:", ...reply.split("\n").map(line => `> ${line}`), `(${CAPTION})`] : []),
    ...(url ? ["", `View contact in AgentWeb: ${url}`] : []),
    "",
    note,
    "",
    FOOTER,
  ].join("\n");

  const rowsHtml = rows
    .map(
      ([label, value]) =>
        `<tr><td style="padding:3px 12px 3px 0;font-size:14px;line-height:1.5;color:#52606d;vertical-align:top;width:96px;">${escapeHtml(label)}</td>` +
        `<td style="padding:3px 0;font-size:14px;line-height:1.5;color:#1f2933;vertical-align:top;word-break:break-word;">${escapeHtml(value)}</td></tr>`,
    )
    .join("");
  const replyHtml = reply
    ? `<p style="margin:0 0 6px;font-size:13px;color:#52606d;">Their reply</p>` +
      `<div style="margin:0 0 4px;padding:10px 14px;border-left:4px solid #9aa5b1;background-color:#f1f5f9;font-size:14px;line-height:1.55;color:#1f2933;word-break:break-word;">${escapeHtml(reply).replace(/\n/g, "<br>")}</div>` +
      `<p style="margin:0 0 18px;font-size:12px;line-height:1.4;color:#616e7c;">${escapeHtml(CAPTION)}</p>`
    : "";
  const button = url
    ? `<p style="margin:0 0 18px;"><a href="${escapeHtml(url)}" style="display:inline-block;background-color:#1976d2;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:4px;font-size:15px;font-weight:bold;">View contact in AgentWeb</a></p>`
    : "";
  // The inbox preview line is fixed wording: the contact's own text must never be able to pose as AgentWeb there.
  const preheader = escapeHtml(`${oneLine(who || "A contact", 60)} replied to your campaign`);

  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(subject)}</title></head>` +
    `<body style="margin:0;padding:0;background-color:#eef1f4;">` +
    `<span style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${preheader}</span>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#eef1f4;"><tr><td align="center" style="padding:24px 12px;">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:640px;background-color:#ffffff;border:1px solid #d9e2ec;border-radius:8px;font-family:Arial,Helvetica,sans-serif;color:#1f2933;">` +
    `<tr><td style="padding:20px 28px 0;font-size:13px;color:#52606d;letter-spacing:0.3px;">AgentWeb</td></tr>` +
    `<tr><td style="padding:8px 28px 24px;">` +
    `<h1 style="margin:12px 0 8px;font-size:22px;line-height:1.3;color:#1f2933;">${escapeHtml(heading)}</h1>` +
    `<p style="margin:0 0 14px;font-size:15px;line-height:1.55;">${escapeHtml(intro)}</p>` +
    (rows.length ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f8f9fa;border-radius:6px;margin:18px 0;"><tr><td style="padding:12px 16px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rowsHtml}</table></td></tr></table>` : "") +
    replyHtml +
    button +
    `<p style="margin:0;font-size:15px;line-height:1.55;">${escapeHtml(note)}</p>` +
    `</td></tr>` +
    `<tr><td style="border-top:1px solid #e4e7eb;padding:16px 28px 22px;font-size:12px;line-height:1.5;color:#616e7c;">${escapeHtml(FOOTER)}</td></tr>` +
    `</table></td></tr></table></body></html>`;

  return { subject, text, html };
}
