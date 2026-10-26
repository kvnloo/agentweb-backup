/**
 * ENG-2196: every grader in the eval registry carries the version of the logic it describes, so a
 * trend or a validation can say which grader produced it. Where the code has a version constant,
 * the registry must match it.
 */
import { EVAL_REGISTRY, getGrader } from '../loops/eval/evalRegistry';
import { AGENT_GRADER_VERSIONS, type AgentGraderId } from '../loops/eval/agentGraders';
import { REPLY_LENGTH_FIXTURES_GRADER, REPLY_LENGTH_FIXTURES_VERSION } from '../loops/eval/offlineSuiteSources';
import { CREATIVE_GATES_GRADER_ID, CREATIVE_GATES_VERSION } from '../services/creativeGates';
import { CREATIVE_RUBRIC_GRADER_ID, CREATIVE_RUBRIC_VERSION } from '../services/creativeRubricJudge';
import { OUTCOME_RUBRIC_B_VERSION } from '../services/outcomeJudge';
import { TASK_SUCCESS_JUDGE_GRADER_ID, TASK_SUCCESS_JUDGE_VERSION } from '../services/taskSuccessJudge';

const VERSION_FORMAT = /^(\d+|\d{4}-\d{2}-\d{2}\.[\w.-]+|v\d+|prompt-sha256:[0-9a-f]{12}|untracked@\d{4}-\d{2}-\d{2})$/;

describe('eval registry versions', () => {
  it('gives every grader a version in one of the documented forms', () => {
    for (const g of EVAL_REGISTRY) {
      expect({ id: g.id, version: g.version, ok: VERSION_FORMAT.test(g.version) }).toEqual({ id: g.id, version: g.version, ok: true });
    }
  });

  it('matches the version constants in code', () => {
    const expected: Record<string, string> = {
      ...Object.fromEntries((Object.keys(AGENT_GRADER_VERSIONS) as AgentGraderId[]).map((id) => [id, String(AGENT_GRADER_VERSIONS[id])])),
      [REPLY_LENGTH_FIXTURES_GRADER]: String(REPLY_LENGTH_FIXTURES_VERSION),
      [CREATIVE_GATES_GRADER_ID]: CREATIVE_GATES_VERSION,
      [CREATIVE_RUBRIC_GRADER_ID]: CREATIVE_RUBRIC_VERSION,
      'session-judge-outcome-b-shadow': OUTCOME_RUBRIC_B_VERSION,
      [TASK_SUCCESS_JUDGE_GRADER_ID]: TASK_SUCCESS_JUDGE_VERSION,
    };
    for (const [id, version] of Object.entries(expected)) {
      expect({ id, version: getGrader(id)?.version }).toEqual({ id, version });
    }
  });

  it('gives the two AW-Settings judges that share one prompt the same fingerprint', () => {
    expect(getGrader('session-judge-matt')?.version).toBe(getGrader('session-judge-general')?.version);
  });
});
