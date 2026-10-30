import { crmDb, orgDb, userDb } from "./db";
import { isDoNotContact } from "../utils/leadContactStatus";

/**
 * "Blocked means blocked" for sends that name an ADDRESS or a PROFILE rather than a lead record (ENG-673, slice 3): an agent email tool, the Emma
 * HTTP API, the agent's LinkedIn and X tools. Callers that hold the lead check `isDoNotContact(lead)` themselves.
 *
 * The lookups use global cross-tenant indexes, so ownership is enforced here. A lead counts only when its owner (the lead's `userId`, or the
 * owner of its list when that was never filled in) is the caller, the mailbox or account owner, or a member of the caller's org: an opt-out is the
 * contact's, so it holds for the whole team whether or not CRM sharing is switched on. Another customer's block on the same address is not ours to
 * act on or reveal. Anything that cannot be checked is thrown, never skipped: a lookup that failed or hit its row cap (so the caller's own row
 * might be missing) refuses the send, because an unverified send to a possibly blocked contact must not go out.
 */

const EMAIL_ROW_CAP = 200; // findAllLeadsByEmail's default maxItems
const LINKEDIN_ROW_CAP = 10; // findLeadsByLinkedin's Limit

/** The user ids whose leads count as "ours": the given ids plus every member of the first id's org. */
async function ownerSet(userIds: Array<string | undefined>): Promise<Set<string>> {
  const owners = new Set(userIds.filter((u): u is string => !!u));
  const caller = userIds.find(u => !!u);
  if (caller) {
    const user = (await userDb.getUserById(caller)) as any;
    if (user?.orgId) for (const m of (await orgDb.getOrgMembers(user.orgId)) as any[]) owners.add(m.userId);
  }
  return owners;
}

/** Is this lead one of ours and marked do-not-contact? A lead with no owner recorded is resolved through its list. */
async function isOursAndBlocked(lead: any, owners: Set<string>, listOwners: Map<string, string | undefined>): Promise<boolean> {
  if (!isDoNotContact(lead)) return false;
  let owner: string | undefined = lead.userId;
  if (!owner && lead.listId) {
    if (!listOwners.has(lead.listId)) listOwners.set(lead.listId, ((await crmDb.getLeadListById(lead.listId)) as any)?.userId);
    owner = listOwners.get(lead.listId);
  }
  return !!owner && owners.has(owner);
}

/** Plain addresses from a to/cc/bcc value: a string (comma or semicolon separated, "Name <a@b>" allowed) or an array of them. */
export function addressesOf(value: unknown): string[] {
  const parts = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  const out = new Set<string>();
  for (const part of parts) {
    if (typeof part !== "string") continue;
    for (const piece of part.split(/[;,]/)) {
      const bracketed = [...piece.matchAll(/<(?:mailto:)?([^<>\s]+@[^<>\s]+)>/gi)];
      const found = bracketed.length > 0 ? bracketed : [...piece.matchAll(/(?:mailto:)?([^\s<>"';,:]+@[^\s<>"';,]+)/gi)];
      for (const m of found) out.add(m[1].trim().toLowerCase());
    }
  }
  return [...out];
}

/** The addresses among `recipients` that belong to a do-not-contact lead of ours (see above). Throws when it cannot be sure. */
export async function blockedRecipients(userIds: Array<string | undefined>, ...recipients: unknown[]): Promise<string[]> {
  const addresses = recipients.flatMap(addressesOf).filter((a, i, all) => all.indexOf(a) === i);
  if (addresses.length === 0) return [];
  const owners = await ownerSet(userIds);
  const listOwners = new Map<string, string | undefined>();
  const blocked: string[] = [];
  for (const address of addresses) {
    const leads = (await crmDb.findAllLeadsByEmail(address, EMAIL_ROW_CAP)) as any[];
    // At the cap the newest rows (possibly other customers') may have pushed the caller's own out: cannot be sure, so refuse.
    if (leads.length >= EMAIL_ROW_CAP) throw new Error(`Could not verify do-not-contact for ${address}: too many contacts share this address`);
    for (const l of leads) {
      if (await isOursAndBlocked(l, owners, listOwners)) { blocked.push(address); break; }
    }
  }
  return blocked;
}

export const blockedMessage = (blocked: string[]): string =>
  `Not sent: ${blocked.join(", ")} ${blocked.length === 1 ? "is" : "are"} marked do-not-contact (unsubscribed, bounced or opted out) in the CRM. Do not try to reach ${blocked.length === 1 ? "this person" : "these people"} another way: tell the user, and let them decide.`;

/** Is the lead (named by list and lead id, which an agent supplies) one of ours and marked do-not-contact? */
export async function leadIsBlocked(userIds: Array<string | undefined>, listId?: string, leadId?: string): Promise<boolean> {
  if (!listId || !leadId) return false;
  const lead = (await crmDb.getLeadById(listId, leadId)) as any;
  if (!lead) return false;
  return isOursAndBlocked({ ...lead, listId: lead.listId ?? listId }, await ownerSet(userIds), new Map());
}

/** Is any of our leads with this LinkedIn profile marked do-not-contact? Tries the URL as given and with/without a trailing slash. Throws at the row cap. */
export async function linkedinProfileIsBlocked(userIds: Array<string | undefined>, profileUrl?: string): Promise<boolean> {
  const url = (profileUrl ?? "").trim();
  if (!url) return false;
  const owners = await ownerSet(userIds);
  const listOwners = new Map<string, string | undefined>();
  const variants = [...new Set([url, url.replace(/\/+$/, ""), `${url.replace(/\/+$/, "")}/`])];
  for (const v of variants) {
    const leads = (await crmDb.findLeadsByLinkedin(v)) as any[];
    if (leads.length >= LINKEDIN_ROW_CAP) throw new Error("Could not verify do-not-contact for this LinkedIn profile: too many contacts share it");
    for (const l of leads) if (await isOursAndBlocked(l, owners, listOwners)) return true;
  }
  return false;
}

export const blockedContactError = "Not sent: this contact is marked do-not-contact (unsubscribed, bounced or opted out) in the CRM. Do not try to reach this person another way: tell the user, and let them decide.";

/** What the agent is told when the check itself could not be completed (the send is refused, not attempted). */
export const unverifiedContactError = "Not sent: could not check whether this contact is marked do-not-contact, so nothing was sent. Tell the user and let them decide; do not try to reach this person another way.";
