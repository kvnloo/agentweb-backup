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
  | "duplicate_in_run";

export interface EligibilityContext {
  campaignId: number;
  /** The merge tags the customer's sequence uses (`analyseSequence(...).tags`). */
  tags: string[];
  mapping: TagMapping;
  /** Tags the user confirmed Smartlead supplies itself. */
  acknowledgedTags?: string[];
  /** Risky, unknown and never-validated emails are left out unless the user explicitly asked for them. */
  includeUnverified?: boolean;
  /** Leads created after the run started were never part of what the user approved. ISO string. */
  runStartedAt?: string;
  /** Lower-cased emails already taken in this run; the caller keeps one set across batches so duplicates are caught everywhere. */
  seenEmails?: Set<string>;
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
  "created_after_start", "missing_tag", "template_syntax", "duplicate_in_run",
];

export function selectSmartleadLeads(leads: Lead[], ctx: EligibilityContext): EligibilityResult {
  const eligible: EligibleLead[] = [];
  const skipped: SkippedLead[] = [];
  const counts = Object.fromEntries(REASONS.map(r => [r, 0])) as Record<SkipReason, number>;
  const seen = ctx.seenEmails ?? new Set<string>();

  const skip = (lead: Lead, reason: SkipReason, tag?: string) => {
    counts[reason]++;
    skipped.push({ leadId: lead.leadId, email: typeof lead.email === "string" ? lead.email : undefined, reason, ...(tag ? { tag } : {}) });
  };

  for (const lead of leads) {
    const email = typeof lead.email === "string" ? lead.email.trim().toLowerCase() : "";

    // Cheap checks first; the payload (which can fail on a missing tag value) comes last, then the duplicate check, so a
    // duplicate of a lead we rejected can still be the one that is sent.
    if (isDoNotContact(lead)) { skip(lead, "do_not_contact"); continue; }
    if (isMarkedForCampaign(lead, ctx.campaignId)) { skip(lead, "already_pushed"); continue; }
    if (ctx.runStartedAt && typeof lead.createdAt === "string" && lead.createdAt > ctx.runStartedAt) { skip(lead, "created_after_start"); continue; }

    const status = lead.customFields?.email_validation?.status;
    if (status === "undeliverable") { skip(lead, "undeliverable"); continue; }
    if (status !== "deliverable" && !ctx.includeUnverified) { skip(lead, email ? "unverified" : "no_email"); continue; }

    const payload = buildLeadPayload(lead, { tagsUsed: ctx.tags, mapping: ctx.mapping, acknowledgedTags: ctx.acknowledgedTags });
    if (!payload.ok) { skip(lead, payload.reason, payload.tag); continue; }

    if (seen.has(email)) { skip(lead, "duplicate_in_run"); continue; }
    seen.add(email);
    eligible.push({ lead, input: payload.input, payloadHash: payload.payloadHash });
  }

  return { eligible, skipped, counts };
}
