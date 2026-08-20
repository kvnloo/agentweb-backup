/**
 * ENG-1325 — the OFFLINE_CONVERSION UPLOAD handler branch (CodeRabbit, #2519).
 *
 * The service layer and the tool schema were tested; the handler between them was not.
 * That is the gap that let uploadClickConversions ship to main unreachable — tests either
 * side of a seam prove nothing about the seam.
 *
 * FAIL cases first, per the repo's test rule.
 */
jest.mock('../services/googleAdsService', () => ({
  googleAdsService: {
    uploadClickConversions: jest.fn(),
    getAccountTimeZone: jest.fn(),
  },
}));

import { AgentModeService } from '../services/agentModeService';
import { googleAdsService } from '../services/googleAdsService';

const ACTION = 'customers/2883029950/conversionActions/7724987234';
const PAST = '2026-06-15T07:04:05.000Z';
let service: AgentModeService;

const call = (args: any) => service.handleCallGoogleAdsApi('u1', {
  customer_id: '2883029950', entity_type: 'OFFLINE_CONVERSION', action: 'UPLOAD', ...args,
}, {} as any);

beforeEach(() => {
  jest.clearAllMocks();
  service = new AgentModeService();
  (googleAdsService.getAccountTimeZone as jest.Mock).mockResolvedValue('Asia/Calcutta');
  (googleAdsService.uploadClickConversions as jest.Mock).mockResolvedValue({ uploaded: 1, failures: [], raw: {} });
});

describe('OFFLINE_CONVERSION — refusals before any network call', () => {
  it('rejects an action other than UPLOAD', async () => {
    const out: any = await service.handleCallGoogleAdsApi('u1', {
      customer_id: '2883029950', entity_type: 'OFFLINE_CONVERSION', action: 'LIST',
    }, {} as any);
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/UPLOAD only/);
    expect(googleAdsService.uploadClickConversions).not.toHaveBeenCalled();
  });

  it('rejects a missing gclid', async () => {
    const out: any = await call({ conversion_action_resource_name: ACTION, conversion_at: PAST });
    expect(out.success).toBe(false);
    expect(googleAdsService.uploadClickConversions).not.toHaveBeenCalled();
  });

  it('rejects a missing conversion action', async () => {
    const out: any = await call({ gclid: 'Cj0KCQ', conversion_at: PAST });
    expect(out.success).toBe(false);
    expect(googleAdsService.uploadClickConversions).not.toHaveBeenCalled();
  });

  it('rejects a missing conversion_at, and says it means when it HAPPENED', async () => {
    const out: any = await call({ gclid: 'Cj0KCQ', conversion_action_resource_name: ACTION });
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/when the conversion HAPPENED/);
  });

  it('surfaces a buildClickConversion refusal instead of calling Google', async () => {
    // A future-dated conversion — Google rejects these, and it usually means a timezone
    // bug rather than a real event.
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const out: any = await call({ gclid: 'Cj0KCQ', conversion_action_resource_name: ACTION, conversion_at: future });
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/future/i);
    expect(googleAdsService.uploadClickConversions).not.toHaveBeenCalled();
  });

  it('refuses a value with no currency, which would misstate revenue', async () => {
    const out: any = await call({
      gclid: 'Cj0KCQ', conversion_action_resource_name: ACTION, conversion_at: PAST, conversion_value: 500,
    });
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/currency/i);
  });
});

describe('OFFLINE_CONVERSION — the upload itself', () => {
  const ok = { gclid: 'Cj0KCQ', conversion_action_resource_name: ACTION, conversion_at: PAST };

  it('reads the account time zone rather than assuming UTC', async () => {
    await call(ok);
    expect(googleAdsService.getAccountTimeZone).toHaveBeenCalledWith('u1', '2883029950');
    const [, , conversions] = (googleAdsService.uploadClickConversions as jest.Mock).mock.calls[0];
    expect(conversions[0].conversionDateTime).toBe('2026-06-15 12:34:05+05:30');
  });

  it('honours an explicit time_zone override without calling Google for it', async () => {
    await call({ ...ok, time_zone: 'UTC' });
    expect(googleAdsService.getAccountTimeZone).not.toHaveBeenCalled();
    const [, , conversions] = (googleAdsService.uploadClickConversions as jest.Mock).mock.calls[0];
    expect(conversions[0].conversionDateTime).toBe('2026-06-15 07:04:05+00:00');
  });

  it('passes order_id through so the browser conversion cannot double-count', async () => {
    await call({ ...ok, order_id: 'evt-123' });
    const [, , conversions] = (googleAdsService.uploadClickConversions as jest.Mock).mock.calls[0];
    expect(conversions[0].orderId).toBe('evt-123');
  });

  it('defaults validate_only to false — an omitted flag is a real upload', async () => {
    await call(ok);
    const [, , , opts] = (googleAdsService.uploadClickConversions as jest.Mock).mock.calls[0];
    expect(opts.validateOnly).toBe(false);
  });

  it('passes validate_only through and reports it back', async () => {
    (googleAdsService.uploadClickConversions as jest.Mock).mockResolvedValue({ uploaded: 1, failures: [], raw: {} });
    const out: any = await call({ ...ok, validate_only: true });
    const [, , , opts] = (googleAdsService.uploadClickConversions as jest.Mock).mock.calls[0];
    expect(opts.validateOnly).toBe(true);
    expect(out.validateOnly).toBe(true);
  });

  it('reports success with the built conversion on the happy path', async () => {
    const out: any = await call(ok);
    expect(out.success).toBe(true);
    expect(out.uploaded).toBe(1);
    expect(out.conversion).toMatchObject({ gclid: 'Cj0KCQ', conversionAction: ACTION });
  });

  it('reports FAILURE when Google partial-failed the row, naming the code', async () => {
    // uploaded:0 with a failure must not read as success — that is the difference between
    // "conversion recorded" and "conversion silently never arrived".
    (googleAdsService.uploadClickConversions as jest.Mock).mockResolvedValue({
      uploaded: 0, failures: [{ index: 0, errorCode: 'EXPIRED_CLICK', message: 'The click is too old.' }], raw: {},
    });
    const out: any = await call(ok);
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/EXPIRED_CLICK/);
    expect(out.error).toMatch(/too old/);
  });
});
