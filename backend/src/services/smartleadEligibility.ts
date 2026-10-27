import { isDoNotContact } from "../utils/leadContactStatus";
import { isMarkedForCampaign } from "./smartleadMarkers";
import { buildLeadPayload, type TagMapping } from "./smartleadPayload";
import type { SmartleadLeadInput } from "./smartleadService";

/**
 * Which leads of a list may be pushed to a Smartlead campaign, and why the others may not (ENG-673). Pure and unit tested:
 * the engine calls it once per batch with the leads it just read. Smartlead then applies its own block, unsubscribe and
 * bounce lists on top (AgentWeb never switches those protections off).
 */

export type SkipReason =
  | "no_email"
  | "invalid_email"
  | "do_not_contact"
  | "undeliverable"
  | "unverified"
  | "already_pushed"
  | "created_after_start"
  | "missing_tag"
  | "template_syntax"
  | "unsafe_text"
  | "unknown_creation_time"
  | "duplicate_in_run";

export interface EligibilityContext {
  campaignId: number;
  /** The merge tags the customer's sequence uses (`analyseSequence(...).tags`). */
  tags: string[];
  mapping: TagMapping;
  /** Risky, unknown and never-validated emails are left out unless the user explicitly asked for them. */
  includeUnverified?: boolean;
  /** Leads created after the run started were never part of what the user approved. ISO string. Required: without it nothing would stop an unapproved lead. */
  runStartedAt: string;
  /** Lower-cased emails already taken in this run; the caller keeps one set across batches so duplicates are caught everywhere. */
  seenEmails?: Set<string>;
  /**
   * Lower-cased emails of leads skipped as do-not-contact in this run. The opt-out is on the lead record, but the person is the
   * email: another record with the same address must not be emailed. The caller keeps one set across batches. (A record in
   * ANOTHER list is out of reach here; that limit is documented in the design.)
   */
  suppressedEmails?: Set<string>;
}

type Lead = Record<string, any>;

export interface EligibleLead {
  lead: Lead;
  input: SmartleadLeadInput;
  payloadHash: string;
}

export interface SkippedLead {
  leadId?: string;
  email?: string;
  reason: SkipReason;
  tag?: string;
}

export interface EligibilityResult {
  eligible: EligibleLead[];
  skipped: SkippedLead[];
  counts: Record<SkipReason, number>;
}

const REASONS: SkipReason[] = [
  "no_email", "invalid_email", "do_not_contact", "undeliverable", "unverified", "already_pushed",
  "created_after_start", "missing_tag", "template_syntax", "unsafe_text", "unknown_creation_time", "duplicate_in_run",
];

/**
 * Epoch milliseconds of a lead's creation time, `undefined` when there is none, `NaN` when there is one we cannot read. The CRM
 * stores an ISO string; a number below 1e11 is read as epoch SECONDS (1e11 seconds is the year 5138, 1e11 milliseconds is 1973), and
 * a string must start like an ISO date, so a locale-formatted or year-less string fails closed instead of being guessed.
 */
function createdAtMs(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return Number.isFinite(value) ? (value < 1e11 ? value * 1000 : value) : NaN;
  if (typeof value === "string") {
    if (!/^\d{4}-\d{2}-\d{2}/.test(value)) return NaN;
    // A time with no zone would be read in the SERVER's local zone; the CRM writes UTC, so a bare time is UTC.
    return Date.parse(/(z|[+-]\d{2}:?\d{2})$/i.test(value) || value.length <= 10 ? value : `${value}Z`);
  }
  return NaN;
}

export function selectSmartleadLeads(leads: Lead[], ctx: EligibilityContext): EligibilityResult {
  const eligible: EligibleLead[] = [];
  const skipped: SkippedLead[] = [];
  const counts = Object.fromEntries(REASONS.map(r => [r, 0])) as Record<SkipReason, number>;
  const seen = ctx.seenEmails ?? new Set<string>();
  const suppressed = ctx.suppressedEmails ?? new Set<string>();
  const startedMs = Date.parse(ctx.runStartedAt);

  const skip = (lead: Lead, reason: SkipReason, tag?: string) => {
    counts[reason]++;
    skipped.push({ leadId: lead.leadId, email: typeof lead.email === "string" ? lead.email : undefined, reason, ...(tag ? { tag } : {}) });
  };

  // Pass one: an opted-out address stops every record with that address in this batch, wherever it sits in the batch. (A record
  // pushed in an EARLIER batch cannot be pulled back, and one in another list is out of reach; both are limits the design states.)
  for (const lead of leads) {
    if (isDoNotContact(lead) && typeof lead.email === "string" && lead.email.trim()) suppressed.add(lead.email.trim().toLowerCase());
  }

  for (const lead of leads) {
    const email = typeof lead.email === "string" ? lead.email.trim().toLowerCase() : "";

    // Cheap checks first; the payload (which can fail on a missing tag value) comes last, then the duplicate check, so a
    // duplicate of a lead we rejected can still be the one that is sent.
    if (isDoNotContact(lead) || (email && suppressed.has(email))) {
      if (email) suppressed.add(email);
      skip(lead, "do_not_contact");
      continue;
    }
    if (isMarkedForCampaign(lead, ctx.campaignId)) { skip(lead, "already_pushed"); continue; }
    {
      // A lead with no creation time is an old lead; one whose time we cannot read fails closed (it may be newer than the run).
      const created = createdAtMs(lead.createdAt);
      if (created !== undefined && (Number.isNaN(created) || Number.isNaN(startedMs))) { skip(lead, "unknown_creation_time"); continue; }
      if (created !== undefined && created > startedMs) { skip(lead, "created_after_start"); continue; }
    }

    const status = lead.customFields?.email_validation?.status;
    if (status === "undeliverable") { skip(lead, "undeliverable"); continue; }
    if (status !== "deliverable" && !ctx.includeUnverified) { skip(lead, email ? "unverified" : "no_email"); continue; }

    const payload = buildLeadPayload(lead, { tagsUsed: ctx.tags, mapping: ctx.mapping });
    if (!payload.ok) { skip(lead, payload.reason, payload.tag); continue; }

    if (seen.has(email)) { skip(lead, "duplicate_in_run"); continue; }
    seen.add(email);
    eligible.push({ lead, input: payload.input, payloadHash: payload.payloadHash });
  }

  return { eligible, skipped, counts };
}
