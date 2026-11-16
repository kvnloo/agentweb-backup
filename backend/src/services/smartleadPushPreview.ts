import { campaignStatusDecision, preflightSequence, type PreflightResult } from "./smartleadPreflight";
import { analyseSequence } from "./smartleadSequence";
import { selectSmartleadLeads, type SkipReason } from "./smartleadEligibility";
import { estimateDaysToSend, type SendEstimate } from "./smartleadEstimate";
import type { TagMapping } from "./smartleadPayload";
import { createHash, randomUUID } from "crypto";
import { PUSH_TOKEN_TTL_MS, signPushToken, type PushTokenPayload } from "./smartleadPushToken";
import type { SmartleadCampaignDetail, SmartleadEmailAccount } from "./smartleadService";
import type { LeadCursor } from "./smartleadPushRunDb";

/**
 * The preview of a Smartlead push (ENG-673): everything the user needs to decide, computed fresh and stored nowhere. It reads the
 * customer's campaign and sequence, evaluates the WHOLE list with the same eligibility rules the run will use, shows what would be sent
 * for three real leads, and signs a token over what was shown (smartleadPushToken.ts).
 */

type Lead = Record<string, any>;

/** The first push into a campaign defaults to a small test cohort; all of the list is one choice away. */
export const FIRST_PUSH_COHORT = 50;
/** A list bigger than this is refused rather than half evaluated. */
export const PREVIEW_MAX_LEADS = 50_000;
const PAGE = 200;
const MAX_MAPPING_ENTRIES = 50;
const MAX_NAME_CHARS = 100;

export interface PreviewRequest {
  listId: string;
  campaignId: number;
  userId: string;
  /** The Smartlead connection in use (bound into the approval). */
  accountId: string;
  includeUnverified?: boolean;
  mapping?: Record<string, unknown>;
  acknowledgedTags?: unknown[];
  acknowledgeUnreadable?: boolean;
  /** How many leads to approve: a number, or undefined for the suggested default. */
  cohort?: number;
}

export interface PreviewDeps {
  readLeads(listId: string, after: LeadCursor | null, limit: number): Promise<{ items: Lead[]; hasMore: boolean }>;
  getCampaign(): Promise<SmartleadCampaignDetail | null>;
  getSequences(): Promise<unknown[]>;
  getCampaignMailboxes(): Promise<SmartleadEmailAccount[]>;
  now(): Date;
  /** The signing secret. */
  secret: string;
}

export class PreviewError extends Error {
  constructor(public readonly code: "bad_request" | "campaign_not_found" | "campaign_not_pushable" | "list_too_large" | "sequence_unreadable", message: string) {
    super(message);
    this.name = "PreviewError";
  }
}

export interface PreviewResult {
  campaign: { id: number; name: string; status: string };
  sequence: { stepCount: number; tags: string[]; hash: string };
  preflight: PreflightResult;
  list: { total: number; eligible: number; alreadyPushed: number; skipped: Partial<Record<SkipReason, number>> };
  samples: Array<{ email: string; sends: Record<string, unknown> }>;
  /** How many will be pushed if approved as is, and the choices the dialog offers. */
  cohort: { chosen: number; suggested: number; max: number };
  estimate?: SendEstimate;
  /** False while any blocking finding stands, or when there is nothing to send. */
  canStart: boolean;
  /** The campaign is already ACTIVE: the user must confirm separately, because leads start receiving mail at once. */
  requiresActiveConfirmation: boolean;
  /**
   * The campaign is already sending AND its emails would carry no unsubscribe link: the user must accept that explicitly (start refuses
   * without `acknowledgements.noUnsubscribeAccepted`). A DRAFTED or PAUSED campaign only warns: nothing sends until the customer starts it.
   */
  requiresUnsubscribeAcknowledgement: boolean;
  /**
   * Identifies WHICH contacts (the first `cohort.chosen` eligible ones) would go to WHICH Smartlead connection. Two previews with the same
   * counts but different contacts or a different connection differ here, so an approval given on one cannot be used on the other.
   */
  fingerprint: string;
  token: string;
  expiresAt: string;
}

function cleanMapping(raw: Record<string, unknown> | undefined): TagMapping {
  const out: TagMapping = {};
  if (!raw) return out;
  const entries = Object.entries(raw);
  if (entries.length > MAX_MAPPING_ENTRIES) throw new PreviewError("bad_request", "Too many tag mappings.");
  for (const [tag, path] of entries) {
    if (typeof path !== "string" || !tag || tag.length > MAX_NAME_CHARS || !path || path.length > MAX_NAME_CHARS) throw new PreviewError("bad_request", "A tag mapping is not valid.");
    out[tag] = path;
  }
  return out;
}

function cleanTags(raw: unknown[] | undefined): string[] {
  if (!raw) return [];
  if (raw.length > MAX_MAPPING_ENTRIES || raw.some(t => typeof t !== "string" || !t || t.length > MAX_NAME_CHARS)) throw new PreviewError("bad_request", "The acknowledged tags are not valid.");
  return raw as string[];
}

export async function readWholeList(deps: Pick<PreviewDeps, "readLeads">, listId: string): Promise<Lead[]> {
  const all: Lead[] = [];
  let after: LeadCursor | null = null;
  for (;;) {
    const page = await deps.readLeads(listId, after, PAGE);
    if (page.items.length === 0) break;
    all.push(...page.items);
    if (all.length > PREVIEW_MAX_LEADS) throw new PreviewError("list_too_large", `This list has more than ${PREVIEW_MAX_LEADS.toLocaleString("en-US")} contacts; split it before pushing.`);
    after = { listId, leadId: String(page.items[page.items.length - 1].leadId) };
    if (!page.hasMore) break;
  }
  return all;
}

export async function buildPreview(deps: PreviewDeps, req: PreviewRequest): Promise<PreviewResult> {
  if (!req.listId || !Number.isInteger(req.campaignId) || req.campaignId <= 0) throw new PreviewError("bad_request", "A list and a campaign are required.");
  const mapping = cleanMapping(req.mapping);
  const acknowledgedTags = cleanTags(req.acknowledgedTags);
  if (req.cohort !== undefined && (!Number.isInteger(req.cohort) || req.cohort < 1)) throw new PreviewError("bad_request", "The number of leads to push must be a positive whole number.");

  const campaign = await deps.getCampaign();
  if (!campaign) throw new PreviewError("campaign_not_found", "That campaign does not exist in the connected Smartlead account.");
  const decision = campaignStatusDecision(campaign.status);
  if (decision === "refused") throw new PreviewError("campaign_not_pushable", `Leads cannot be added to a ${campaign.status || "unknown"} campaign. Use a draft, paused or active campaign.`);

  const analysis = analyseSequence(await deps.getSequences());
  const preflight = preflightSequence(analysis, {
    status: campaign.status, mapping, acknowledgedTags, acknowledgeUnreadable: req.acknowledgeUnreadable, addUnsubscribeTag: campaign.addUnsubscribeTag, unsubscribeText: campaign.unsubscribeText,
  });

  const leads = await readWholeList(deps, req.listId);
  const now = deps.now();
  const result = selectSmartleadLeads(leads, { campaignId: req.campaignId, tags: analysis.tags, mapping, includeUnverified: req.includeUnverified === true, runStartedAt: now.toISOString() });
  const eligible = result.eligible.length;
  const alreadyPushed = result.counts.already_pushed;
  const skipped = Object.fromEntries(Object.entries(result.counts).filter(([, n]) => n > 0)) as Partial<Record<SkipReason, number>>;

  // The first push into a campaign defaults to a small test cohort; once leads are already in it the whole eligible set is the default.
  const suggested = alreadyPushed === 0 && eligible > FIRST_PUSH_COHORT ? FIRST_PUSH_COHORT : eligible;
  const chosen = Math.min(eligible, req.cohort ?? suggested);

  let estimate: SendEstimate | undefined;
  try {
    estimate = estimateDaysToSend({ leads: chosen, mailboxLimits: (await deps.getCampaignMailboxes()).map(m => m.dailyLimit), campaignMaxLeadsPerDay: campaign.maxLeadsPerDay });
  } catch {
    estimate = undefined; // advisory only: a failed mailbox read must not stop a preview
  }

  const payload: PushTokenPayload = {
    v: 1, jti: randomUUID(), userId: req.userId, accountId: req.accountId, acknowledgeUnreadable: req.acknowledgeUnreadable === true, listId: req.listId, campaignId: req.campaignId, includeUnverified: req.includeUnverified === true, mapping, acknowledgedTags,
    startStatus: campaign.status, sequenceHash: analysis.hash, eligible: chosen, warnings: preflight.warnings.map(w => w.message).slice(0, 20),
    iat: now.getTime(),
    exp: now.getTime() + PUSH_TOKEN_TTL_MS,
  };

  return {
    campaign: { id: campaign.id, name: campaign.name, status: campaign.status },
    sequence: { stepCount: analysis.stepCount, tags: analysis.tags, hash: analysis.hash },
    preflight,
    list: { total: leads.length, eligible, alreadyPushed, skipped },
    samples: result.eligible.slice(0, 3).map(e => ({ email: e.input.email, sends: { ...e.input } })),
    cohort: { chosen, suggested: Math.min(eligible, suggested), max: eligible },
    ...(estimate ? { estimate } : {}),
    canStart: preflight.blocks.length === 0 && chosen > 0,
    requiresActiveConfirmation: decision === "needs_confirmation",
    requiresUnsubscribeAcknowledgement: decision === "needs_confirmation" && preflight.missingUnsubscribe,
    fingerprint: createHash("sha256").update(JSON.stringify({ a: req.accountId, ids: result.eligible.slice(0, chosen).map(e => String(e.lead.leadId)) })).digest("hex").slice(0, 32),
    token: signPushToken(deps.secret, payload),
    expiresAt: new Date(payload.exp).toISOString(),
  };
}
