/**
 * ENG-2599: version-tolerant readers for the invoice fields Basil moved.
 * Basil shapes follow stripe@18 types (Invoices.d.ts `parent`, InvoiceLineItems.d.ts `pricing`);
 * legacy shapes are what a webhook endpoint pinned to a pre-Basil version still sends.
 */
import type Stripe from 'stripe';
import { invoiceLinePriceId, invoiceSubscriptionId } from '../utils/stripeInvoiceFields';

describe('invoiceSubscriptionId', () => {
  it('reads a Basil subscription parent (string id)', () => {
    // Typed as the SDK's own Basil invoice shape: the helper must accept it as-is.
    const invoice: Pick<Stripe.Invoice, 'parent'> = {
      parent: {
        type: 'subscription_details',
        quote_details: null,
        subscription_details: { metadata: null, subscription: 'sub_basil' },
      },
    };
    expect(invoiceSubscriptionId(invoice)).toBe('sub_basil');
  });

  it('reads a Basil subscription parent expanded into a subscription object', () => {
    expect(invoiceSubscriptionId({
      parent: { subscription_details: { subscription: { id: 'sub_expanded' } } },
    })).toBe('sub_expanded');
  });

  it('prefers the Basil field over the legacy one', () => {
    expect(invoiceSubscriptionId({
      parent: { subscription_details: { subscription: 'sub_basil' } },
      subscription: 'sub_legacy',
    })).toBe('sub_basil');
  });

  it('falls back to the legacy top-level field (string id)', () => {
    expect(invoiceSubscriptionId({ subscription: 'sub_legacy' })).toBe('sub_legacy');
  });

  it('falls back to the legacy top-level field (expanded object)', () => {
    expect(invoiceSubscriptionId({ subscription: { id: 'sub_legacy_obj' } })).toBe('sub_legacy_obj');
  });

  it('falls back to legacy when a Basil parent carries no subscription id', () => {
    expect(invoiceSubscriptionId({
      parent: { subscription_details: { subscription: '' } },
      subscription: 'sub_legacy',
    })).toBe('sub_legacy');
  });

  it('is null for a one-off invoice (null parent, no legacy field)', () => {
    expect(invoiceSubscriptionId({ parent: null })).toBeNull();
    expect(invoiceSubscriptionId({ parent: null, subscription: null })).toBeNull();
  });

  it('is null for a quote parent', () => {
    const invoice: Pick<Stripe.Invoice, 'parent'> = {
      parent: { type: 'quote_details', quote_details: { quote: 'qt_1' }, subscription_details: null },
    };
    expect(invoiceSubscriptionId(invoice)).toBeNull();
  });

  it('is null for missing input and for an object without an id', () => {
    expect(invoiceSubscriptionId(undefined)).toBeNull();
    expect(invoiceSubscriptionId(null)).toBeNull();
    expect(invoiceSubscriptionId({})).toBeNull();
    expect(invoiceSubscriptionId({ subscription: {} })).toBeNull();
    expect(invoiceSubscriptionId({ subscription: '' })).toBeNull();
  });
});

describe('invoiceLinePriceId', () => {
  it('reads Basil pricing.price_details.price (string id)', () => {
    const line: Pick<Stripe.InvoiceLineItem, 'pricing'> = {
      pricing: { type: 'price_details', unit_amount_decimal: '2900', price_details: { price: 'price_basil', product: 'prod_1' } },
    };
    expect(invoiceLinePriceId(line)).toBe('price_basil');
  });

  it('reads Basil pricing.price_details.price expanded into an object', () => {
    expect(invoiceLinePriceId({ pricing: { price_details: { price: { id: 'price_obj' } } } })).toBe('price_obj');
  });

  it('prefers the Basil field over the legacy one', () => {
    expect(invoiceLinePriceId({
      pricing: { price_details: { price: 'price_basil' } },
      price: { id: 'price_legacy' },
    })).toBe('price_basil');
  });

  it('falls back to the legacy expanded price', () => {
    expect(invoiceLinePriceId({ price: { id: 'price_legacy' } })).toBe('price_legacy');
  });

  it('falls back to legacy when Basil pricing has no price_details', () => {
    expect(invoiceLinePriceId({ pricing: { price_details: undefined }, price: { id: 'price_legacy' } })).toBe('price_legacy');
    expect(invoiceLinePriceId({ pricing: null, price: { id: 'price_legacy' } })).toBe('price_legacy');
  });

  it('is null when the line has no price anywhere', () => {
    expect(invoiceLinePriceId(undefined)).toBeNull();
    expect(invoiceLinePriceId(null)).toBeNull();
    expect(invoiceLinePriceId({})).toBeNull();
    expect(invoiceLinePriceId({ pricing: null, price: null })).toBeNull();
  });
});
