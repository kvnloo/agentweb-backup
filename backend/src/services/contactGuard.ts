import { crmDb, orgDb, userDb } from "./db";
import { isDoNotContact } from "../utils/leadContactStatus";

/**
 * "Blocked means blocked" for email sends that name an ADDRESS rather than a lead record (ENG-673, slice 3): an agent email tool, the Emma HTTP API. Callers that hold the lead check `isDoNotContact(lead)` themselves.
 *
 * The lookup uses a global cross-tenant index, so ownership is enforced here. A lead counts only when its owner (the lead's `userId`, or the
 * owner of its list when that was never filled in) is the caller, the mailbox owner, or a member of the caller's org: an opt-out is the
 * contact's, so it holds for the whole team whether or not CRM sharing is switched on. Another customer's block on the same address is not ours to
 * act on or reveal. Anything that cannot be checked is thrown, never skipped: a lookup that failed or hit its row cap (so the caller's own row
 * might be missing) refuses the send, because an unverified send to a possibly blocked contact must not go out.
 */

const EMAIL_ROW_CAP = 200; // findAllLeadsByEmail's default maxItems

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


const MAX_PIECE = 600;
const MAX_READINGS = 6;

/** A matched address without the punctuation around it. A `?query` is cut only after the `@` (a local part may contain `?`); trimming is a loop, not a regex. */
function cleanAddress(raw: string): string {
  let s = raw.trim().toLowerCase();
  const at = s.indexOf("@");
  const q = at >= 0 ? s.indexOf("?", at) : -1;
  if (q >= 0) s = s.slice(0, q);
  let start = 0;
  let end = s.length;
  while (start < end && "([".includes(s[start])) start++;
  while (end > start && ")].".includes(s[end - 1])) end--;
  return s.slice(start, end);
}

/** The same, and also without quote marks at either end: for readings where an apostrophe may be quoting, not part of the address. */
function cleanQuoted(raw: string): string {
  let s = cleanAddress(raw);
  let start = 0;
  let end = s.length;
  while (start < end && "'\"([".includes(s[start])) start++;
  while (end > start && "'\")].".includes(s[end - 1])) end--;
  s = s.slice(start, end);
  return s;
}

/**
 * Extra readings for a piece that contains an apostrophe, ADDED to the ones the main pass finds (never instead of them, so nothing the main pass
 * catches can be lost). An apostrophe is legal in a local part (o'brien@x.com) but can also be quoting around an address (`'a@x.com'`,
 * `name='a@x.com'`, `x'(a@x.com)`), in which case everything up to it is not part of the address. Which is meant cannot be known, so the address is also
 * looked up as each apostrophe-delimited tail of its local part. The price
 * of a wrong extra reading is refusing a send to someone blocked under that other name (`brien@x.com` for `o'brien@x.com`): it fails safe and is rare.
 */
function apostropheReadings(piece: string): string[] {
  if (!piece.includes("'")) return [];
  const matches = [
    ...piece.matchAll(/<(?:mailto:)?([^<>\s]+@[^<>\s]+)>/gi),
    ...piece.matchAll(/(?:mailto:)?([^\s<>";,:]+@[^\s<>"';,]+)/gi),
  ];
  const out: string[] = [];
  for (const m of matches) {
    const base = cleanQuoted(m[1]);
    if (!base.includes("@")) continue;
    const readings = [base];
    const at = base.indexOf("@");
    for (let i = base.indexOf("'"); i >= 0 && i < at; i = base.indexOf("'", i + 1)) {
      const tail = cleanQuoted(base.slice(i + 1));
      if (tail.indexOf("@") > 0) readings.push(tail); // something is left before the @
    }
    // The number of lookups is capped. The plain address after the LAST apostrophe needs no special care here: the main pass always finds it.
    out.push(...readings.slice(0, MAX_READINGS));
  }
  return out;
}

/** Addresses from a to/cc/bcc value, and whether any piece was too long to look at (see MAX_PIECE). */
function parseAddresses(value: unknown): { addresses: string[]; oversize: boolean } {
  let oversize = false;
  const parts = Array.isArray(value) ? value.flat(Infinity) : typeof value === "string" ? [value] : [];
  const out = new Set<string>();
  for (const part of parts) {
    if (typeof part !== "string") continue;
    for (const piece of part.split(/[;,]/)) {
      // No address is longer than 254 characters: a longer piece is not matched (the regexes below are quadratic on long input with no address).
      if (piece.length > MAX_PIECE) { oversize = true; continue; }
      const bracketed = [...piece.matchAll(/<(?:mailto:)?([^<>\s]+@[^<>\s]+)>/gi)];
      const found = bracketed.length > 0 ? bracketed : [...piece.matchAll(/(?:mailto:)?([^\s<>"';,:]+@[^\s<>"';,]+)/gi)];
      // Punctuation and a mailto query around an address are not part of it: `(a@x.com)`, `a@x.com.`, `a@x.com?subject=hi`. A lookup with them left on would miss.
      for (const m of found) {
        const cleaned = cleanAddress(m[1]);
        if (cleaned.includes("@")) out.add(cleaned);
      }
      // Added on top, never instead: see apostropheReadings.
      for (const a of apostropheReadings(piece)) out.add(a);
    }
  }
  return { addresses: [...out], oversize };
}

/** Plain addresses from a to/cc/bcc value: a string (comma or semicolon separated, "Name <a@b>" allowed) or an array of them. */
export function addressesOf(value: unknown): string[] {
  return parseAddresses(value).addresses;
}

/** The addresses among `recipients` that belong to a do-not-contact lead of ours (see above). Throws when it cannot be sure. */
export async function blockedRecipients(userIds: Array<string | undefined>, ...recipients: unknown[]): Promise<string[]> {
  const parsed = recipients.map(parseAddresses);
  // A piece too long to look at (a huge display name) could hide an address: not being able to check it means not sending, like a failed lookup.
  if (parsed.some(p => p.oversize)) throw new Error("A recipient is too long to check against do-not-contact");
  const addresses = parsed.flatMap(p => p.addresses).filter((a, i, all) => all.indexOf(a) === i);
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

/** What the agent is told when the check itself could not be completed (the send is refused, not attempted). */
export const unverifiedContactError = "Not sent: could not check whether this contact is marked do-not-contact, so nothing was sent. Tell the user and let them decide; do not try to reach this person another way.";
