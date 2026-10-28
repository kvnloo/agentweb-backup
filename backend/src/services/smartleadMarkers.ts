/**
 * The per-lead record of a Smartlead push (ENG-673). It lives in the lead's `system` sidecar under a FLAT key per campaign,
 * `system.smartlead_<campaignId>`, because `crmDb.setLeadFields({system})` sets whole top-level `system` keys (a nested
 * `system.smartlead.<id>` would overwrite the earlier campaigns). The markers are the state of a run: a lead that carries one
 * for a campaign is never pushed to it again, and AgentWeb's own senders skip a lead that carries any.
 */

export interface SmartleadMarker {
  pushedAt: string;
  runId: string;
  /** Smartlead's own lead id (from `return_lead_ids`), needed to pause or unsubscribe the lead later. */
  smartleadLeadId?: string;
  /** sha256 of what was sent, so an audit can say exactly what went out. */
  payloadHash: string;
  /** `withdrawn`: unsubscribed in Smartlead after the lead became do-not-contact here. `released`: a list editor cleared it. */
  state: "pushed" | "withdrawn" | "released";
  /** The address that was pushed (lower case). The sweep trusts `smartleadLeadId` only while the lead still has this address. */
  email?: string;
  /** When the withdrawal sweep unsubscribed the lead in Smartlead after it opted out here. */
  withdrawnAt?: string;
  /** When a list editor released the lead, and who. */
  releasedAt?: string;
  releasedBy?: string;
}

const PREFIX = "smartlead_";

export const smartleadMarkerKey = (campaignId: number | string): string => `${PREFIX}${campaignId}`;

const isMarker = (value: unknown): value is SmartleadMarker =>
  !!value && typeof value === "object" && typeof (value as SmartleadMarker).state === "string";

/** The marker for one campaign, whatever its state, or undefined. */
export function getSmartleadMarker(lead: { system?: Record<string, unknown> } | null | undefined, campaignId: number | string): SmartleadMarker | undefined {
  const value = lead?.system?.[smartleadMarkerKey(campaignId)];
  return isMarker(value) ? value : undefined;
}

/** True when this lead must not be pushed to this campaign again. A released marker no longer counts. */
export function isMarkedForCampaign(lead: { system?: Record<string, unknown> } | null | undefined, campaignId: number | string): boolean {
  const marker = getSmartleadMarker(lead, campaignId);
  return !!marker && marker.state !== "released";
}

/**
 * True when the lead is in a Smartlead campaign, so AgentWeb's own senders (group email, drip, Resend) leave it to Smartlead.
 * Deliberately NOT part of `isDoNotContact`: bounce recording and the unsubscribe page use that, and would break.
 */
export function isPushedToSmartlead(lead: { system?: Record<string, unknown> } | null | undefined): boolean {
  const system = lead?.system;
  if (!system) return false;
  return Object.keys(system).some(key => key.startsWith(PREFIX) && isMarker(system[key]) && (system[key] as SmartleadMarker).state !== "released");
}

/** Every Smartlead marker a lead carries, whatever its state, with the campaign it is for. */
export function listSmartleadMarkers(lead: { system?: Record<string, unknown> } | null | undefined): Array<{ key: string; campaignId: number; marker: SmartleadMarker }> {
  const system = lead?.system;
  if (!system) return [];
  const out: Array<{ key: string; campaignId: number; marker: SmartleadMarker }> = [];
  for (const key of Object.keys(system)) {
    if (!key.startsWith(PREFIX) || !isMarker(system[key])) continue;
    const campaignId = Number(key.slice(PREFIX.length));
    if (Number.isInteger(campaignId) && campaignId > 0) out.push({ key, campaignId, marker: system[key] as SmartleadMarker });
  }
  return out;
}

export function buildSmartleadMarker(input: { runId: string; payloadHash: string; smartleadLeadId?: string; email?: string; now?: Date }): SmartleadMarker {
  return {
    pushedAt: (input.now ?? new Date()).toISOString(),
    runId: input.runId,
    ...(input.smartleadLeadId ? { smartleadLeadId: input.smartleadLeadId } : {}),
    ...(input.email ? { email: input.email.trim().toLowerCase() } : {}),
    payloadHash: input.payloadHash,
    state: "pushed",
  };
}
