import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import CustomSubscriptionLinkButton from '../components/admin/CustomSubscriptionLinkButton';
import {
  buildCustomLinkRequest,
  isCustomSubscriptionLinksEnabled,
} from '../components/admin/customSubscriptionLinkForm';

describe('buildCustomLinkRequest (ENG-2488)', () => {
  const base = { orgId: 'org-1', label: 'Managed ads retainer', amountUsd: '499.99', frequency: 'month' };

  it.each(['one_time', 'week', 'month', 'quarter', 'year'])('accepts frequency %s', (frequency) => {
    const r = buildCustomLinkRequest({ ...base, frequency });
    expect(r).toEqual({ ok: true, body: { orgId: 'org-1', label: 'Managed ads retainer', amountUsd: 499.99, frequency } });
  });

  it.each([
    [{ label: '' }, 'label'],
    [{ label: 'x'.repeat(101) }, 'label'],
    [{ amountUsd: '0' }, 'amountUsd'],
    [{ amountUsd: '-5' }, 'amountUsd'],
    [{ amountUsd: '1.999' }, 'amountUsd'],
    [{ amountUsd: 'abc' }, 'amountUsd'],
    [{ frequency: 'daily' }, 'frequency'],
    [{ orgId: '' }, 'orgId'],
  ])('rejects %j', (patch, field) => {
    const r = buildCustomLinkRequest({ ...base, ...patch } as any);
    expect(r.ok).toBe(false);
    expect((r as any).errors).toHaveProperty(field as string);
  });

  it('accepts a 100-char label and trims it', () => {
    const r = buildCustomLinkRequest({ ...base, label: `  ${'a'.repeat(100)}  ` });
    expect(r.ok).toBe(true);
  });

  it('flag defaults off', () => {
    expect(isCustomSubscriptionLinksEnabled(undefined)).toBe(false);
    expect(isCustomSubscriptionLinksEnabled('')).toBe(false);
    expect(isCustomSubscriptionLinksEnabled('1')).toBe(false);
    expect(isCustomSubscriptionLinksEnabled('true')).toBe(true);
  });
});

describe('CustomSubscriptionLinkButton (ENG-2488)', () => {
  const BTN = /create custom subscription link/i;

  it('is hidden when the flag is off', () => {
    const submit = jest.fn();
    render(<CustomSubscriptionLinkButton orgId="org-1" viewerIsAdmin enabled={false} submit={submit} />);
    expect(screen.queryByRole('button', { name: BTN })).not.toBeInTheDocument();
  });

  it('is hidden for non-admins even with the flag on', () => {
    render(<CustomSubscriptionLinkButton orgId="org-1" viewerIsAdmin={false} enabled submit={jest.fn()} />);
    expect(screen.queryByRole('button', { name: BTN })).not.toBeInTheDocument();
  });

  it('blocks invalid input without calling submit', async () => {
    const submit = jest.fn();
    render(<CustomSubscriptionLinkButton orgId="org-1" viewerIsAdmin enabled submit={submit} />);
    fireEvent.click(screen.getByRole('button', { name: BTN }));
    fireEvent.click(screen.getByRole('button', { name: /create link/i }));
    expect(await screen.findByText(/name is required/i)).toBeInTheDocument();
    expect(submit).not.toHaveBeenCalled();
  });

  it('submits a validated body and shows the returned link', async () => {
    const submit = jest.fn().mockResolvedValue({ url: 'https://checkout.stripe.com/c/pay/cs_test_1' });
    render(<CustomSubscriptionLinkButton orgId="org-1" viewerIsAdmin enabled submit={submit} />);
    fireEvent.click(screen.getByRole('button', { name: BTN }));
    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'Retainer' } });
    fireEvent.change(screen.getByLabelText(/price/i), { target: { value: '250' } });
    fireEvent.click(screen.getByRole('button', { name: /create link/i }));
    await waitFor(() =>
      expect(submit).toHaveBeenCalledWith({ orgId: 'org-1', label: 'Retainer', amountUsd: 250, frequency: 'month' }),
    );
    expect(await screen.findByText('https://checkout.stripe.com/c/pay/cs_test_1')).toBeInTheDocument();
  });
});
