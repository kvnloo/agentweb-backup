/**
 * ENG-2809 — CONVERSION_ACTION UPDATE rejected 35% of agent calls with
 * "conversion_action_resource_name is required for CONVERSION_ACTION UPDATE."
 *
 * The model identifies the action the way LIST/CREATE output and Google's UI do:
 * a bare numeric id, or under the generic `resource_name` / `conversion_action_id`
 * keys. The handler now normalises those to the canonical resource name, and when
 * nothing usable is present returns a model-facing error (not a throw) naming the
 * field and where to get it.
 */
jest.mock('../services/googleAdsService', () => ({
  googleAdsService: {
    updateConversionAction: jest.fn().mockImplementation(async (_u: string, _c: string, rn: string) => {
      if (!rn) throw new Error('conversion_action_resource_name is required for CONVERSION_ACTION UPDATE.');
      return { resourceName: rn, stored: {}, drift: [] };
    }),
  },
}));

import { AgentModeService } from '../services/agentModeService';
import { googleAdsService } from '../services/googleAdsService';

const CUSTOMER = '1234567890';
const CANON = `customers/${CUSTOMER}/conversionActions/111`;
let service: AgentModeService;

const update = (extra: Record<string, unknown>) =>
  service.handleCallGoogleAdsApi('user-123', {
    customer_id: CUSTOMER,
    entity_type: 'CONVERSION_ACTION',
    action: 'UPDATE',
    primary_for_goal: true,
    ...extra,
  }, { sessionId: 'sess-1' });

beforeEach(() => {
  jest.clearAllMocks();
  service = new AgentModeService();
});

describe('ENG-2809 CONVERSION_ACTION UPDATE accepts the identifiers the model actually sends', () => {
  it('passes a canonical resource name through unchanged', async () => {
    const r = await update({ conversion_action_resource_name: CANON });
    expect(r.success).toBe(true);
    expect((googleAdsService.updateConversionAction as jest.Mock).mock.calls[0][2]).toBe(CANON);
  });

  it.each([
    ['bare numeric id in the canonical field', { conversion_action_resource_name: '111' }],
    ['conversion_action_id alias', { conversion_action_id: '111' }],
    ['numeric conversion_action_id alias', { conversion_action_id: 111 }],
    ['generic resource_name alias', { resource_name: CANON }],
  ])('normalises %s to the canonical resource name', async (_label, extra) => {
    const r = await update(extra);
    expect(r.success).toBe(true);
    expect((googleAdsService.updateConversionAction as jest.Mock).mock.calls[0][2]).toBe(CANON);
  });

  it('returns a model-facing error naming the field and LIST when no identifier is given', async () => {
    const r = await update({});
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/conversion_action_resource_name/);
    expect(r.error).toMatch(/CONVERSION_ACTION LIST/);
    expect(googleAdsService.updateConversionAction).not.toHaveBeenCalled();
  });

  it('refuses a resource name belonging to a different customer instead of retargeting it', async () => {
    const r = await update({ conversion_action_resource_name: 'customers/999/conversionActions/111' });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/customer_id/);
    expect(googleAdsService.updateConversionAction).not.toHaveBeenCalled();
  });
});
