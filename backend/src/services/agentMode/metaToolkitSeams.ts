/**
 * ENG-2303 P3 — pure pieces of the Meta Toolkit write seams, kept out of the agentMode
 * monolith. AgentModeService keeps only the accessors that need its private members.
 */
type ObjectiveGateResult = { allowed: true; objective: string } | { allowed: false; response: any };

/**
 * Objective gate for a sessionless toolkit preview: an external agent has no Emma
 * transcript or approval deck, so the objective must be explicit and valid; it is shown in
 * the bound preview and the user's approval of that preview is the human choice (ENG-400).
 */
export function buildToolkitObjectiveGate(allowedObjectives: readonly string[]) {
  return async (_userId: string, _sessionId: string | undefined, _accountId: string, params: any): Promise<ObjectiveGateResult> => {
    const objective = params?.objective;
    if (typeof objective === 'string' && allowedObjectives.includes(objective)) return { allowed: true, objective };
    const message = `CAMPAIGN CREATE needs an explicit objective, one of: ${allowedObjectives.join(', ')}. It cannot be changed after creation, so ask the user which one they want.`;
    return { allowed: false, response: { success: false, message, error: `PARAM_VALIDATION_ERROR: ${message}` } };
  };
}

export interface MetaReadBackReader {
  listCampaigns(accountId: string, accessToken: string, options: { campaignId?: string; fields?: string[] }): Promise<{ campaigns: any[] }>;
  listAdSets(accountId: string, accessToken: string, campaignId: string | undefined, options: { adSetId?: string; fields?: string[] }): Promise<{ adSets: any[] }>;
  getAd(accessToken: string, adId: string, adAccountId?: string): Promise<any>;
}

const READ_BACK_FIELDS = ['id', 'status', 'effective_status', 'daily_budget', 'lifetime_budget'];

/** Ownership-scoped read-back of one written node: status, effective status, budgets. */
export async function readBackMetaNode(
  reader: MetaReadBackReader, accountId: string, accessToken: string, entityType: string, id: string,
) {
  let node: any;
  if (entityType === 'CAMPAIGN') {
    node = (await reader.listCampaigns(accountId, accessToken, { campaignId: id, fields: READ_BACK_FIELDS })).campaigns?.[0];
  } else if (entityType === 'AD_SET') {
    node = (await reader.listAdSets(accountId, accessToken, undefined, { adSetId: id, fields: READ_BACK_FIELDS })).adSets?.[0];
  } else if (entityType === 'AD') {
    node = await reader.getAd(accessToken, id, accountId);
  } else {
    throw new Error(`No read-back for ${entityType}`);
  }
  if (!node?.id) return null;
  return {
    id: String(node.id),
    status: node.status,
    effective_status: node.effective_status,
    daily_budget: node.daily_budget,
    lifetime_budget: node.lifetime_budget,
  };
}
