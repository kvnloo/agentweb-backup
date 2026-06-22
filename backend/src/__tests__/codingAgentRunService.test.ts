import {
  _resetCodingAgentRunsForTest,
  createCodingAgentRun,
  getCodingAgentRun,
  updateCodingAgentRun,
} from '../services/codingAgentRunService';

describe('codingAgentRunService', () => {
  beforeEach(() => {
    _resetCodingAgentRunsForTest();
  });

  test('persists state transitions and does not overwrite terminal states', async () => {
    const run = await createCodingAgentRun({
      sessionId: 'session_1',
      pageId: 'page_1',
      userId: 'user_1',
      branch: 'draft/session_1',
    });

    await updateCodingAgentRun(run.runId, { state: 'editing' });
    await updateCodingAgentRun(run.runId, { state: 'timed_out', failureReason: 'timeout' });
    await updateCodingAgentRun(run.runId, { state: 'passed', previewUrl: 'https://late.example' });

    const saved = await getCodingAgentRun(run.runId);
    expect(saved).toMatchObject({
      state: 'timed_out',
      failureReason: 'timeout',
    });
    expect(saved?.previewUrl).toBeUndefined();
    expect(saved?.transitions.map((t) => t.state)).toEqual(['queued', 'editing', 'timed_out']);
  });
});
