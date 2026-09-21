/**
 * Outreach Onboarding sub-task 7 — CRM-save service.
 *
 * Powers `POST /api/onboarding/outreach/save`. Takes the prospect cards the
 * onboarding flow surfaced (via sub-task 4's preview endpoint) plus the
 * messages Emma drafted for each, and persists them as a brand-new CRM Lead
 * List owned by the authenticated user.
 *
 * Design rationale:
 *   - Reuses the SAME crmDb lead-import path that Emma's
 *     `import_leads_from_search` tool uses: `crmDb.createLeadList` to mint the
 *     list, then `crmDb.batchCreateLeads` to add the prospects. That means
 *     dedup-on-LinkedIn-URL, atomic lead counting, and field-name merging all
 *     behave identically to the agent-mode import path — no bespoke CRM
 *     plumbing here. This is a pure CRM-scope operation; it does NOT touch
 *     agent-mode / Emma core internals.
 *   - The drafted message rides on the lead's `notes` field (the CRM lead
 *     schema's free-text slot, shown in the lead drawer). ICP attribution
 *     goes in the `system.icpSource` sidecar map exactly like the import tool
 *     does, so the list/lead can be traced back to the persona that sourced
 *     it without leaking into CSV exports or template variables.
 *   - `mapProspectToLead` is exported pure so the mapping rules can be unit
 *     tested independent of the crmDb mock.
 *
 * Result envelope mirrors `PreviewResult` from the sub-task 4 service so the
 * route layer can switch on a stable shape:
 *   - ok: true   → carry `leadListId`.
 *   - ok: false  → carry an `error` code the route maps to an HTTP status:
 *                    'no_prospects' — caller sent an empty/absent prospects
 *                                     array (route returns 400).
 *                    'crm_error'    — createLeadList / batchCreateLeads threw
 *                                     (route returns 502).
 */

import { crmDb } from "./db";
import type { PreviewProspect } from "./outreachProspectPreviewService";
import { isAnonymizedSearchLead } from "../utils/anonymizedLinkedInLead";

/** A draft message for each prospect, keyed by the prospect's stable `id`
 *  (the same id the preview endpoint emitted and the FE keyed its draft
 *  edits on). */
export type DraftMap = Record<string, string>;

export interface SaveProspectsArgs {
  /** ICP identifier picked in onboarding. Used as the lead-list name when no
   *  human-readable label is supplied. */
  icpId: string;
  /** Optional human-readable ICP label (e.g. "K-5 program directors"). When
   *  present it's used for the lead-list name; otherwise we fall back to
   *  `icpId`. */
  icpLabel?: string;
  /** Prospect cards from the preview endpoint that the user kept. */
  prospects: PreviewProspect[];
  /** Drafted messages keyed by prospect id. A prospect with no entry simply
   *  gets no note. */
  drafts: DraftMap;
}

export type SaveResult =
  | { ok: true; leadListId: string }
  | { ok: false; error: "no_prospects" | "crm_error"; message?: string };

/** Shape of a single lead handed to `crmDb.batchCreateLeads`. Kept loose —
 *  it intentionally mirrors the (large) batchCreateLeads param type without
 *  re-declaring every optional field. */
interface MappedLead {
  firstName?: string;
  lastName?: string;
  company?: string;
  title?: string;
  linkedin?: string;
  notes?: string;
  system?: Record<string, any>;
}

/**
 * Map a single `PreviewProspect` + its drafted message into a CRM lead.
 * Pure — no IO. Mirrors the field-mapping in
 * `agentModeService.importLeadsFromSearch`:
 *   - `name` is split on the first whitespace run into first/last.
 *   - `linkedin_url` → `linkedin`.
 *   - `headline` → `title`.
 *   - `company` passes through when present.
 *   - the drafted message → `notes` (omitted when blank).
 *   - `icpId` → `system.icpSource` sidecar attribution.
 */
export function mapProspectToLead(
  prospect: PreviewProspect,
  draft: string | undefined,
  icpId: string,
): MappedLead {
  const lead: MappedLead = {};

  const name = (prospect?.name ?? "").trim();
  if (name) {
    const parts = name.split(/\s+/);
    lead.firstName = parts[0] || "";
    lead.lastName = parts.slice(1).join(" ") || "";
  }

  if (typeof prospect?.linkedin_url === "string" && prospect.linkedin_url) {
    lead.linkedin = prospect.linkedin_url;
  }
  if (typeof prospect?.headline === "string" && prospect.headline.trim()) {
    lead.title = prospect.headline.trim();
  }
  if (typeof prospect?.company === "string" && prospect.company.trim()) {
    lead.company = prospect.company.trim();
  }

  const note = typeof draft === "string" ? draft.trim() : "";
  if (note) lead.notes = note;

  if (icpId) {
    lead.system = { ...(lead.system ?? {}), icpSource: icpId };
  }

  return lead;
}

/**
 * Create a CRM lead list for the onboarding prospects and persist each
 * prospect (with its drafted message) as a lead. The caller (route handler)
 * is responsible for HTTP status + response shaping.
 */
export async function saveOutreachProspects(
  userId: string,
  args: SaveProspectsArgs,
): Promise<SaveResult> {
  const prospects = Array.isArray(args?.prospects) ? args.prospects : [];
  if (prospects.length === 0) {
    return { ok: false, error: "no_prospects" };
  }

  // List name from the human-readable label, falling back to the raw icpId.
  const label = (args.icpLabel ?? "").trim() || (args.icpId ?? "").trim();
  const listName = `Outreach — ${label || "Prospects"}`;
  const description = `Auto-created from outreach onboarding for ICP "${
    label || args.icpId || "unknown"
  }".`;

  const drafts: DraftMap =
    args.drafts && typeof args.drafts === "object" ? args.drafts : {};

  try {
    const list = (await crmDb.createLeadList(
      userId,
      listName,
      description,
    )) as { listId?: string } | undefined;

    const leadListId = list?.listId;
    if (!leadListId) {
      return {
        ok: false,
        error: "crm_error",
        message: "Lead list creation returned no id",
      };
    }

    // ENG-1002: belt-and-braces. The preview endpoint already drops LinkedIn's
    // anonymized out-of-network hits, but this write is driven by whatever the
    // client posts back — a stale bundle, or a hand-rolled call, could still
    // carry placeholders. They have no name, email or profile URL, so they
    // would land as un-dedupable nameless leads that every later import
    // re-creates.
    const leads = prospects
      .map((p) => mapProspectToLead(p, drafts[p?.id], args.icpId))
      .filter((lead) => !isAnonymizedSearchLead(lead));

    await crmDb.batchCreateLeads(leadListId, leads);

    return { ok: true, leadListId };
  } catch (err: any) {
    return {
      ok: false,
      error: "crm_error",
      message: err?.message ? String(err.message) : "CRM save failed",
    };
  }
}
