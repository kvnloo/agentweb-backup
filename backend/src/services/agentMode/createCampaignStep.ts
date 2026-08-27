/**
 * ENG-397's demonstrative Workflow step, taken directly from the ticket's own
 * "What" example: create_campaign(objective, budget_mode) -> campaign_id.
 *
 * `objective` and `budget_mode` are the irreversible/spend-bearing values the
 * ticket requires to be resolved via an AskUserQuestion gate before this step
 * may mutate anything (see requiredParameters below) — `name` and
 * `special_ad_categories`/`budget_amount` are ordinary (non-gated) inputs
 * supplied by the caller's initial parameter bag.
 *
 * This crosses the metaService I/O boundary deliberately — the pure engine in
 * `core/workflow.ts` never imports metaService.
 */

import { metaService } from '../metaService';
import { WorkflowStepDefinition, WorkflowStepVerification, WorkflowVerificationMismatch } from './core/workflow';

export interface CreateCampaignStepDeps {
  accessToken: string;
  adAccountId: string;
}

export function buildCreateCampaignStep(deps: CreateCampaignStepDeps): WorkflowStepDefinition {
  return {
    id: 'create_campaign',
    inputs: ['objective', 'budget_mode', 'name', 'budget_amount', 'special_ad_categories'],
    outputs: ['campaign_id'],
    requiredParameters: [
      { key: 'objective', questionKind: 'workflow_meta_objective', payloadField: 'objective' },
      { key: 'budget_mode', questionKind: 'workflow_meta_budget_mode', payloadField: 'budget_mode' },
    ],
    execute: async (params: Record<string, unknown>) => {
      const useCbo = params.budget_mode === 'campaign_budget_optimization';
      const created = await metaService.createCampaign(deps.adAccountId, deps.accessToken, {
        name: params.name as string,
        objective: params.objective as string,
        special_ad_categories: (params.special_ad_categories as string[]) ?? ['NONE'],
        status: 'PAUSED',
        ...(useCbo
          ? { advantage_campaign_budget: true, budget_amount: params.budget_amount }
          : {}),
      } as any);
      return { campaign_id: created.id, raw: created };
    },
    verify: async (
      executeResult: Record<string, unknown>,
      params: Record<string, unknown>,
    ): Promise<WorkflowStepVerification> => {
      const campaignId = executeResult.campaign_id as string;
      if (!campaignId) return { verified: false, error: 'createCampaign returned no id' };
      try {
        const readBack = await metaService.getCampaign(deps.adAccountId, deps.accessToken, campaignId);
        const mismatches: WorkflowVerificationMismatch[] = [];
        // The immutable parameter (ENG-400) is the one whose drift actually
        // matters — this is the exact class of silent-default failure the
        // whole ticket exists to catch.
        if (readBack.objective !== params.objective) {
          mismatches.push({
            parameter: 'objective',
            requested: params.objective,
            applied: readBack.objective ?? null,
          });
        }
        if (mismatches.length) return { verified: false, mismatches };
        return { verified: true, verifiedFields: { objective: readBack.objective, id: readBack.id } };
      } catch (err: any) {
        return { verified: false, error: err?.message || 'read-back failed' };
      }
    },
  };
}
