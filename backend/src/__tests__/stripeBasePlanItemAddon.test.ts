import { findBasePlanItem } from '../services/stripeService';

jest.mock('stripe', () => jest.fn().mockImplementation(() => ({})));
jest.mock('../services/db', () => ({ userDb: {}, User: {} }));
jest.mock('../services/waitlistDb', () => ({ waitlistDb: {}, WaitlistEntry: {} }));
jest.mock('../services/hotLeadCallBillingService', () => ({ mirrorHotLeadCallBilling: jest.fn() }));

const item = (id: string, product: string) => ({ id, price: { id: `price_${id}`, product } }) as never;
const sub = (...items: unknown[]) => ({ items: { data: items } }) as never;

describe('findBasePlanItem with the hot lead calls add-on (ENG-2783)', () => {
  afterEach(() => { delete process.env.STRIPE_HOT_LEAD_CALL_PRODUCT_ID; delete process.env.STRIPE_EXTRA_SEAT_PRODUCT_ID; });

  it('never returns the add-on item, even when it is listed first', () => {
    process.env.STRIPE_HOT_LEAD_CALL_PRODUCT_ID = 'prod_hlc';
    expect(findBasePlanItem(sub(item('si_hlc', 'prod_hlc'), item('si_plan', 'prod_plan')))?.id).toBe('si_plan');
    expect(findBasePlanItem(sub(item('si_plan', 'prod_plan'), item('si_hlc', 'prod_hlc')))?.id).toBe('si_plan');
  });
  it('skips both the seat item and the add-on item', () => {
    process.env.STRIPE_HOT_LEAD_CALL_PRODUCT_ID = 'prod_hlc';
    process.env.STRIPE_EXTRA_SEAT_PRODUCT_ID = 'prod_seat';
    expect(findBasePlanItem(sub(item('si_hlc', 'prod_hlc'), item('si_seat', 'prod_seat'), item('si_plan', 'prod_plan')))?.id).toBe('si_plan');
  });
  it('is unchanged without the add-on configured', () => {
    expect(findBasePlanItem(sub(item('si_a', 'prod_a'), item('si_b', 'prod_b')))?.id).toBe('si_a');
    expect(findBasePlanItem(sub(item('si_only', 'prod_a')))?.id).toBe('si_only');
  });
});
