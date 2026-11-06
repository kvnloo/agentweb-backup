/**
 * The retry sweep's per-run cap on retries STARTED (20). The member cooldown and the 10-person team limit keep real starts far
 * below it, so the retry itself is stubbed here and only the sweep's accounting is real (on the in-memory CRM).
 */
jest.mock('../services/db', () => ({ ENGAGED_EVENT_KEYWORDS: jest.requireActual('../services/db').ENGAGED_EVENT_KEYWORDS, ...jest.requireActual('./helpers/hotLeadCallFakeCrm').dbMock }));
jest.mock('../services/hotLeadCallService', () => ({ processHotLeadCallRetry: jest.fn() }));

import { processHotLeadCallRetry } from '../services/hotLeadCallService';
import { setHotLeadCallEnabledOverride } from '../services/voice/hotLeadCallMode';
import { resetRetrySweepRotationForTests, runHotLeadCallRetrySweep } from '../services/voice/hotLeadCallRetrySweep';
import { FakeCrm, crmHolder } from './helpers/hotLeadCallFakeCrm';

const retry = processHotLeadCallRetry as jest.Mock;
let crm: FakeCrm;

beforeEach(() => {
  retry.mockReset();
  resetRetrySweepRotationForTests();
  setHotLeadCallEnabledOverride(true);
  crm = new FakeCrm();
  crmHolder.current = crm;
  crm.addOrg(
    { orgId: 'org-a', hotLeadCall: { enabled: true, twilioNumber: '+14155550111', announcedName: 'A', callingHours: { start: '08:00', end: '21:00', timezone: 'America/Chicago' }, team: [{ id: 'maaaaaaa', name: 'D', phone: '+14155550100', verifiedAt: '2026-01-01T00:00:00.000Z', windows: [{ days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '24:00' }] }] } },
    [{ userId: 'owner-a' }], [{ listId: 'list-a', userId: 'owner-a' }],
  );
  for (let i = 0; i < 25; i++) {
    const leadId = `L${String(i).padStart(3, '0')}`;
    crm.addLead({ listId: 'list-a', leadId });
    crm.lead('list-a', leadId).system = { hot_lead_call: { state: 'finished', outcome: 'lead_deferred', updatedAt: '2026-10-19T00:00:00.000Z', deferral: { dueAt: '2026-10-19T00:00:00.000Z', count: 1 } } };
  }
});
afterEach(() => setHotLeadCallEnabledOverride(null));

describe('retries started per run', () => {
  it('stops after 20 started retries, says it truncated, and the rest wait for the next run', async () => {
    retry.mockResolvedValue('attempted');
    const run = await runHotLeadCallRetrySweep(new Date('2026-10-19T12:00:00Z'));
    expect(run).toMatchObject({ found: 25, attempted: 20, truncated: true });
    expect(retry).toHaveBeenCalledTimes(20);
  });

  it('rescheduled and refused outcomes do not use the 20 up (they count toward the 100 handled)', async () => {
    retry.mockResolvedValue('rescheduled');
    const run = await runHotLeadCallRetrySweep(new Date('2026-10-19T12:00:00Z'));
    expect(run).toMatchObject({ found: 25, rescheduled: 25, attempted: 0, truncated: false });
  });
});
