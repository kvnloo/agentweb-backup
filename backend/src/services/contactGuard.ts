import { crmDb } from "./db";
import { isDoNotContact } from "../utils/leadContactStatus";

/**
 * "Blocked means blocked" for sends that name an ADDRESS rather than a lead record (ENG-673, slice 3): an agent email tool, the Emma HTTP API.
 * Callers that hold the lead check `isDoNotContact(lead)` themselves; these have only an address, so it is looked up.
 *
 * The lookup uses the global cross-tenant email index, so ownership is enforced here: only leads that belong to the sender (or the account owner
 * whose mailbox is used) count. Another customer's block on the same address is not ours to act on or to reveal. A lookup failure is thrown, not
 * swallowed: an unverified send to a possibly blocked contact must not go out.
 */

/** Plain addresses from a to/cc/bcc value: a string (comma or semicolon separated, "Name <a@b>" allowed) or an array of them. */
export function addressesOf(value: unknown): string[] {
  const parts = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  const out = new Set<string>();
  for (const part of parts) {
    if (typeof part !== "string") continue;
    for (const piece of part.split(/[;,]/)) {
      const m = piece.match(/<([^<>\s]+@[^<>\s]+)>/) ?? piece.match(/([^\s<>"']+@[^\s<>"']+)/);
      if (m) out.add(m[1].trim().toLowerCase());
    }
  }
  return [...out];
}

/** The addresses among `recipients` that belong to a do-not-contact lead of one of `userIds`. */
export async function blockedRecipients(userIds: Array<string | undefined>, ...recipients: unknown[]): Promise<string[]> {
  const owners = new Set(userIds.filter((u): u is string => !!u));
  const blocked: string[] = [];
  for (const address of recipients.flatMap(addressesOf).filter((a, i, all) => all.indexOf(a) === i)) {
    const leads = (await crmDb.findAllLeadsByEmail(address)) as any[];
    if (leads.some(l => owners.has(l.userId) && isDoNotContact(l))) blocked.push(address);
  }
  return blocked;
}

export const blockedMessage = (blocked: string[]): string =>
  `Not sent: ${blocked.join(", ")} ${blocked.length === 1 ? "is" : "are"} marked do-not-contact (unsubscribed, bounced or opted out) in the CRM. Do not try to reach ${blocked.length === 1 ? "this person" : "these people"} another way: tell the user, and let them decide.`;

/** Is the lead (named by list and lead id, which an agent supplies) marked do-not-contact? Only the caller's own leads count. */
export async function leadIsBlocked(userIds: Array<string | undefined>, listId?: string, leadId?: string): Promise<boolean> {
  if (!listId || !leadId) return false;
  const owners = new Set(userIds.filter((u): u is string => !!u));
  const lead = (await crmDb.getLeadById(listId, leadId)) as any;
  return !!lead && owners.has(lead.userId) && isDoNotContact(lead);
}

/** Is any of the caller's leads with this LinkedIn profile marked do-not-contact? Tries the URL as given and with/without a trailing slash. */
export async function linkedinProfileIsBlocked(userIds: Array<string | undefined>, profileUrl?: string): Promise<boolean> {
  const url = (profileUrl ?? "").trim();
  if (!url) return false;
  const owners = new Set(userIds.filter((u): u is string => !!u));
  const variants = [...new Set([url, url.replace(/\/+$/, ""), `${url.replace(/\/+$/, "")}/`])];
  for (const v of variants) {
    const leads = (await crmDb.findLeadsByLinkedin(v)) as any[];
    if (leads.some(l => owners.has(l.userId) && isDoNotContact(l))) return true;
  }
  return false;
}

export const blockedContactError = "Not sent: this contact is marked do-not-contact (unsubscribed, bounced or opted out) in the CRM. Do not try to reach this person another way: tell the user, and let them decide.";
