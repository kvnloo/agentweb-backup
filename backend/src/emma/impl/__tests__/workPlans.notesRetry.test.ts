// ENG-2998: ack-lost/status-only retries must not erase prerequisite evidence.
jest.mock('../../../services/chatbotService', () => ({
  chatbotDb: {
    getChatSession: jest.fn(),
    updateSessionWorkPlan: jest.fn().mockResolvedValue(undefined),
  },
}));

import { setWorkPlanStatus } from '../workPlans';
import { chatbotDb } from '../../../services/chatbotService';

const db = chatbotDb as jest.Mocked<typeof chatbotDb>;
type Status = 'pending' | 'completed' | 'skipped';

async function apply(previous: Status, status: Status, notes?: string) {
  const workPlan = {
    title: 'Guest extraction',
    steps: [{ stepCount: 1, title: 'Extract guests', status: previous, notes: 'reason=no_key' }],
  };
  db.getChatSession.mockResolvedValue({ workPlan, messages: [] } as any);
  const result = await setWorkPlanStatus([{ stepCount: 1, status, ...(notes === undefined ? {} : { notes }) }], 'fixture');
  expect(result.success).toBe(true);
  expect(db.updateSessionWorkPlan).toHaveBeenCalled();
  return workPlan.steps[0];
}

beforeEach(() => jest.clearAllMocks());

describe('status retry notes', () => {
  it.each<Status>(['pending', 'completed', 'skipped'])('preserves evidence on an unchanged %s status when notes are omitted', async status => {
    expect((await apply(status, status)).notes).toBe('reason=no_key');
  });

  it('allows an explicit empty note to clear a recovered prerequisite', async () => {
    expect((await apply('pending', 'pending', '')).notes).toBe('');
  });

  it('allows replacement evidence on a same-status retry', async () => {
    expect((await apply('pending', 'pending', 'upstream timeout')).notes).toBe('upstream timeout');
  });

  it.each<Status>(['completed', 'skipped'])('does not carry a stale prerequisite into a newly %s step', async status => {
    expect((await apply('pending', status)).notes).toBeUndefined();
  });
});
