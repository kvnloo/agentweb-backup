import {
  createSerialReadState,
  recordSerialReadStep,
  SERIAL_READ_THRESHOLD,
} from '../serialReadSpiral';
import { buildIterationLimitReport } from '../iterationLimitReport';
import { isWriteToolCall } from '../../../../utils/toolWriteClassification';

const tc = (name: string, args: Record<string, unknown>) => ({
  function: { name, arguments: JSON.stringify(args) },
});

// Step shape of prod session 5bfb9d06 (ENG-2863): one read-only call per step.
const LIST = 'list_1775599551252_w6uvjg07x';
const sessionSteps = [
  [tc('get_leads', { search: 'Minneapolis', list_id: LIST })],
  [tc('get_leads', { list_id: LIST, limit: 20 })],
  [tc('get_lead_details', { lead_id: 'a', list_id: LIST })],
  [tc('get_lead_details', { lead_id: 'b', list_id: LIST })],
  [tc('get_leads', { list_id: LIST, limit: 20, cursor: 'c1' })],
  [tc('linkedin_outreach', { action: 'search-parameters', keywords: 'Minneapolis', type: 'LOCATION' })],
  [tc('linkedin_outreach', { action: 'search-people', location_id: '90000512', keywords: 'managed IT services', title: 'CEO' })],
  [tc('linkedin_outreach', { action: 'get-profile', profile_url: 'https://www.linkedin.com/in/x', force_refresh: true })],
  [tc('linkedin_outreach', { action: 'get-company', company_id: '9498526' })],
];

describe('serial-read spiral (ENG-2863)', () => {
  it('nudges once when the session pattern reaches the threshold', () => {
    const state = createSerialReadState();
    const fired = sessionSteps.map((step) => recordSerialReadStep(state, step));
    expect(fired.indexOf(true)).toBe(SERIAL_READ_THRESHOLD - 1);
    expect(fired.filter(Boolean)).toHaveLength(1);
  });

  it('does not count batched steps or write steps', () => {
    const state = createSerialReadState();
    for (let i = 0; i < 10; i++) {
      const batched = [tc('get_lead_details', { lead_id: `a${i}` }), tc('get_lead_details', { lead_id: `b${i}` })];
      expect(recordSerialReadStep(state, batched)).toBe(false);
    }
    for (let i = 0; i < 10; i++) {
      expect(recordSerialReadStep(state, [tc('linkedin_outreach', { action: 'send-invite', profile_url: `u${i}` })])).toBe(false);
    }
  });

  it('resets the streak on a non-serial step', () => {
    const state = createSerialReadState();
    for (let i = 0; i < SERIAL_READ_THRESHOLD - 1; i++) recordSerialReadStep(state, [tc('get_leads', { cursor: `${i}` })]);
    recordSerialReadStep(state, [tc('add_leads_to_list', { list_id: LIST })]);
    expect(recordSerialReadStep(state, [tc('get_leads', { cursor: 'z' })])).toBe(false);
  });
});

describe('linkedin_outreach write classification (ENG-2863)', () => {
  it.each(['search-people', 'get-profile', 'get-company', 'search-parameters', 'list_connections'])('%s is a read', (action) => {
    expect(isWriteToolCall({ name: 'linkedin_outreach', arguments: { action } })).toBe(false);
    expect(isWriteToolCall({ name: 'linkedin_outreach', arguments: JSON.stringify({ action }) })).toBe(false);
  });

  it.each(['send-invite', 'send_message', 'send-inmail', 'cancel-invitation', 'accept-invitation', 'set-daily-invite-cap', 'withdraw-stale-invitations', 'update-conversation-history', 'unknown-new-action'])('%s stays a write', (action) => {
    expect(isWriteToolCall({ name: 'linkedin_outreach', arguments: { action } })).toBe(true);
  });

  it('missing or unparseable action stays a write (fail-safe)', () => {
    expect(isWriteToolCall({ name: 'linkedin_outreach', arguments: {} })).toBe(true);
    expect(isWriteToolCall({ name: 'linkedin_outreach', arguments: '{not json' })).toBe(true);
  });

  it('iteration-limit report no longer lists LinkedIn reads as completed writes', () => {
    const calls = [
      { name: 'linkedin_outreach', arguments: { action: 'get-profile', profile_url: 'u' }, result: { success: true } },
      { name: 'linkedin_outreach', arguments: { action: 'search-people' }, result: { success: true } },
      { name: 'linkedin_outreach', arguments: { action: 'send-invite', profile_url: 'u' }, result: { success: true } },
    ];
    const report = buildIterationLimitReport('', calls);
    expect(report).toContain('Completed tool write: linkedin_outreach');
    expect(report).not.toContain('— 3 calls');
    expect(report).not.toContain('— 2 calls');
  });
});
