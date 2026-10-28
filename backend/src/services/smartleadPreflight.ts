import { classifyTags, type TagMapping } from "./smartleadPayload";
import type { SequenceAnalysis } from "./smartleadSequence";

/**
 * The risk-based check of a campaign before a push (ENG-673). The hazard is a broken email reaching a real person, and nothing
 * sends before the customer starts the campaign, so findings are warnings for a DRAFTED or PAUSED campaign and hard blocks for an
 * ACTIVE one (leads start receiving mail at once). Two findings block for every status: a tag that would render blank for every
 * lead, and a near-miss tag.
 */

export type CampaignStatusDecision = "allowed" | "needs_confirmation" | "refused";

/** DRAFTED and PAUSED are allowed, ACTIVE needs a second confirmation, everything else (and anything unknown) is refused. */
export function campaignStatusDecision(status: unknown): CampaignStatusDecision {
  const s = typeof status === "string" ? status.trim().toUpperCase() : ""; // a missing or odd status is refused, never guessed
  if (s === "DRAFTED" || s === "PAUSED") return "allowed";
  if (s === "ACTIVE") return "needs_confirmation";
  return "refused";
}

export type FindingCode = "unreadable" | "empty" | "near_miss_tag" | "unknown_tag" | "spintax" | "no_unsubscribe";

export interface PreflightFinding {
  code: FindingCode;
  message: string;
  tag?: string;
}

export interface PreflightResult {
  blocks: PreflightFinding[];
  warnings: PreflightFinding[];
  /** Tags the user must map to a CRM field, or confirm Smartlead supplies. */
  tagsToMap: string[];
}

export function preflightSequence(
  analysis: SequenceAnalysis,
  opts: {
    status: unknown;
    mapping: TagMapping;
    acknowledgedTags?: string[];
    /** The user ticked "we could not read my sequence, send anyway". */
    acknowledgeUnreadable?: boolean;
    /** The campaign's own `add_unsubscribe_tag` setting, when known. */
    addUnsubscribeTag?: boolean;
  },
): PreflightResult {
  const result: PreflightResult = { blocks: [], warnings: [], tagsToMap: [] };
  // An unknown status is treated like ACTIVE (the stricter rules): the caller refuses it anyway, and this must not throw.
  const status = typeof opts.status === "string" ? opts.status.trim().toUpperCase() : "";
  const active = status === "ACTIVE" || campaignStatusDecision(status) === "refused";
  const add = (finding: PreflightFinding, blockWhenActive: boolean) => (active && blockWhenActive ? result.blocks : result.warnings).push(finding);

  if (!analysis.readable) {
    const finding: PreflightFinding = { code: "unreadable", message: "Smartlead's answer about this campaign's sequence could not be read." };
    // Acknowledged: still recorded as a warning, so the run's audit shows the user sent it anyway.
    if (opts.acknowledgeUnreadable) result.warnings.push(finding);
    else add(finding, true);
    return result; // nothing else can be said about a sequence we cannot read
  }
  if (!analysis.hasContent) add({ code: "empty", message: "This campaign's sequence has no content yet, so nothing useful will be sent until you add it." }, true);

  const classes = classifyTags(analysis.tags, opts.mapping, opts.acknowledgedTags);
  for (const { tag, meant } of classes.nearMiss) {
    result.blocks.push({ code: "near_miss_tag", tag, message: `{{${tag}}} looks like {{${meant}}} but would render blank; Smartlead tags are case-sensitive.` });
  }
  for (const tag of classes.unknown) {
    result.blocks.push({ code: "unknown_tag", tag, message: `{{${tag}}} is not a standard field and is not mapped to a CRM field, so it would be blank for every lead. Map it, or confirm Smartlead supplies it.` });
    result.tagsToMap.push(tag);
  }
  if (analysis.usesSpintax) result.warnings.push({ code: "spintax", message: "The template uses {a|b} spintax; AgentWeb does not touch it." });
  if (opts.addUnsubscribeTag === false && !analysis.tags.some(t => /unsub/i.test(t))) {
    result.warnings.push({ code: "no_unsubscribe", message: "The campaign's unsubscribe tag is off and no unsubscribe link appears in the sequence." });
  }
  return result;
}
