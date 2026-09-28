/**
 * Registered failure replay cases (ENG-591, ENG-2145).
 *
 * failureReplaySuite.ts is the runner; this is the set of cases the nightly schedule
 * (cron/failureReplayNightlyCron.ts) and the offline eval suite (offlineSuite.ts) replay. Each case
 * binds a historical incident to the CURRENT code that must keep it fixed, so a regression turns
 * the case red. Inputs are synthetic reproductions: no customer data, no network, no LLM.
 *
 * Add a case: backend/docs/FAILURE_REPLAY_SUITE.md.
 */

import { gradeToolCorrectness, type LedgerCall } from './agentGraders';
import type { FailureReplayCase } from './failureReplaySuite';

export interface RegisteredReplayCase {
  id: string;
  incident: string;
  /** What must hold, in one line; becomes the filed issue's failure text. */
  failure: string;
  /** Eval-registry id of the grader or contract the case exercises (offline suite metric key). */
  graderId: string;
  /** Runs the current code on the recorded input; true when the incident stays fixed. */
  check: () => boolean | Promise<boolean>;
}

const CUSTOMER = '1234567890';
const CAMPAIGN_RN = `customers/${CUSTOMER}/campaigns/24011409538`;

/** ENG-286: a CAMPAIGN UPDATE to TARGET_SPEND reported success and changed nothing. */
function eng286Update(id: string): LedgerCall {
  return {
    id,
    toolName: 'call_google_ads_api',
    args: { customer_id: CUSTOMER, entity_type: 'CAMPAIGN', action: 'UPDATE', campaign_resource_name: CAMPAIGN_RN, bidding_strategy: 'TARGET_SPEND' },
    status: 'success',
    result: {},
    output: { success: true, message: 'Campaign updated' },
  };
}

function campaignReadBack(id: string): LedgerCall {
  return {
    id,
    toolName: 'call_google_ads_reporting_api',
    args: { customer_id: CUSTOMER, mode: 'raw', query: 'SELECT campaign.bidding_strategy_type FROM campaign WHERE campaign.id = 24011409538' },
    status: 'success',
  };
}

const findingKinds = (ledger: LedgerCall[]) => gradeToolCorrectness({ ledger, events: [] }).findings.map((f) => f.kind);

export const FAILURE_REPLAY_CATALOG: readonly RegisteredReplayCase[] = [
  {
    id: 'eng-286-write-without-read-back',
    incident: 'ENG-286',
    failure: 'A Google Ads write that reported success with no later read-back must be flagged by the tool-correctness grader',
    graderId: 'agent-tool-correctness',
    check: () => findingKinds([eng286Update('call_1')]).includes('write_without_read_back'),
  },
  {
    id: 'eng-286-read-back-accepted',
    incident: 'ENG-286',
    failure: 'A Google Ads write followed by a GAQL read of the same campaign must not be flagged (no false positive on the fix)',
    graderId: 'agent-tool-correctness',
    check: () => gradeToolCorrectness({ ledger: [eng286Update('call_1'), campaignReadBack('call_2')], events: [] }).verdict === 'pass',
  },
];

type ReplayCheck = RegisteredReplayCase['check'];

/** The catalog as runFailureReplaySuite cases: the input is the case's check, the contract runs it. */
export function toFailureReplayCases(catalog: readonly RegisteredReplayCase[] = FAILURE_REPLAY_CATALOG): FailureReplayCase<ReplayCheck, boolean>[] {
  return catalog.map((c) => ({ id: c.id, incident: c.incident, input: c.check, assert: (passed) => passed === true, failure: c.failure }));
}

/** The replay contract for registered cases: run the case's own check against current code. */
export const runRegisteredCheck = (check: ReplayCheck): boolean | Promise<boolean> => check();
