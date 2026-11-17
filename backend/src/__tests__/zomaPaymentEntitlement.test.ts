jest.mock('../services/db', () => ({ userDb: {} }));
jest.mock('../services/mcpUsageEventsService', () => ({ getMcpUserUsage: jest.fn(), recordZomaBillingFunnel: jest.fn() }));
import type Stripe from 'stripe';
import { planStateFromSubscriptions, planAllowsPublish } from '../mcp/zomaBilling';

function subscription(status: string, latestInvoice: unknown): Stripe.Subscription {
  return {
    id: 'sub_zoma', created: 1, status, metadata: { product: 'zoma_plan' },
    latest_invoice: latestInvoice, items: { data: [] },
  } as unknown as Stripe.Subscription;
}

describe('publishing requires a settled Zoma invoice, not just subscription status', () => {
  it.each(['trialing', 'active'])('%s without a paid invoice cannot publish', (status) => {
    const state = planStateFromSubscriptions('cus_zoma', [subscription(status, { id: 'in_fee', status: 'open', paid: false })]);
    expect(planAllowsPublish(state)).toBe(false);
  });

  it.each([null, 'in_unexpanded', { id: 'in_fee', status: 'draft', paid: false }, { id: 'in_fee', status: 'void', paid: false }])('fails closed when invoice evidence is absent or unpaid: %p', (invoice) => {
    expect(planAllowsPublish(planStateFromSubscriptions('cus_zoma', [subscription('trialing', invoice)]))).toBe(false);
  });

  it.each(['trialing', 'active'])('%s with a paid invoice can publish', (status) => {
    expect(planAllowsPublish(planStateFromSubscriptions('cus_zoma', [subscription(status, { id: 'in_fee', status: 'paid', paid: true })]))).toBe(true);
  });

  it.each(['past_due', 'unpaid', 'canceled', 'incomplete', 'paused'])('%s cannot publish even if its last invoice was paid', (status) => {
    expect(planAllowsPublish(planStateFromSubscriptions('cus_zoma', [subscription(status, { id: 'in_old', status: 'paid', paid: true })]))).toBe(false);
  });
});
