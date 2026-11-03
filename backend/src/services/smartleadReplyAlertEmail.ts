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

export interface SmartleadReplyAlertInput {
  /** What AgentWeb calls the contact (a name, else the address). */
  leadName: string;
  /** The contact's address, when there is one. */
  leadEmail?: string;
  listName: string;
  campaignName?: string;
  /** The subject of the reply. */
  replySubject?: string;
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

/** One line, no control characters (a name or subject must never be able to add a header line), trimmed and shortened. */
const oneLine = (value: unknown, max: number): string => {
  const cleaned = String(value ?? "").replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1).trimEnd()}\u2026` : cleaned;
};

/** "Nov 3, 2026, 9:23 AM UTC". The zone is always shown: no timezone is stored for a user. Undefined when the time is missing or unreadable. */
export const formatUtcTime = (iso: string | undefined): string | undefined => {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return undefined;
  const formatted = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(ms));
  return `${formatted.replace(/[\u202f\u00a0]/g, " ")} UTC`; // newer ICU puts a narrow no-break space before AM/PM
};

const FOOTER = "You are getting this because this lead list sends an alert for new replies. You can turn it off in the lead list's settings in AgentWeb.";
const NOTE = "Smartlead keeps the full reply. Open your Smartlead inbox to read it and answer.";

export function buildSmartleadReplyAlertEmail(input: SmartleadReplyAlertInput): AlertEmailContent {
  const email = oneLine(input.leadEmail, 200);
  const rawName = oneLine(input.leadName, 120);
  // A name that is just the address is shown once.
  const name = rawName && rawName.toLowerCase() !== email.toLowerCase() ? rawName : "";
  const who = name || email || "A contact";
  const whoWithAddress = name && email ? `${name} (${email})` : who;

  const subject = `${oneLine(who, 55)} replied to your campaign`; // 80 characters at most
  const heading = `${oneLine(who, 80)} replied`;
  const intro = `${whoWithAddress} replied to an email sent from your Smartlead campaign.`;

  const rows: Array<[string, string]> = [];
  const campaign = oneLine(input.campaignName, 160);
  if (campaign) rows.push(["Campaign", campaign]);
  const list = oneLine(input.listName, 160);
  if (list) rows.push(["Lead list", list]);
  const replySubject = oneLine(input.replySubject, 200);
  if (replySubject) rows.push(["Subject", replySubject]);
  const received = formatUtcTime(input.receivedAt);
  if (received) rows.push(["Received", received]);

  const url = input.contactUrl && /^https?:\/\//i.test(input.contactUrl) ? input.contactUrl : "";

  const text = [
    heading,
    "",
    intro,
    "",
    ...rows.map(([label, value]) => `${label}: ${value}`),
    ...(url ? ["", `View contact in AgentWeb: ${url}`] : []),
    "",
    NOTE,
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
  const button = url
    ? `<p style="margin:0 0 18px;"><a href="${escapeHtml(url)}" style="display:inline-block;background-color:#1976d2;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:4px;font-size:15px;font-weight:bold;">View contact in AgentWeb</a></p>`
    : "";
  const preheader = escapeHtml(replySubject || intro);

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
    button +
    `<p style="margin:0;font-size:15px;line-height:1.55;">${escapeHtml(NOTE)}</p>` +
    `</td></tr>` +
    `<tr><td style="border-top:1px solid #e4e7eb;padding:16px 28px 22px;font-size:12px;line-height:1.5;color:#616e7c;">${escapeHtml(FOOTER)}</td></tr>` +
    `</table></td></tr></table></body></html>`;

  return { subject, text, html };
}
