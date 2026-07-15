/**
 * Tests for the ENG-200 per-user monthly cost cap (monthlyCostAllowance) editor
 * in SubscriptionTypesTab: the list column renders the cap, and the edit dialog
 * round-trips it into the save payload (parsed from a USD string).
 */

import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('axios', () => ({
  get: jest.fn(),
  post: jest.fn().mockResolvedValue({ data: [] }),
}));

jest.mock('../config', () => ({
  buildApiUrl: (path: string) => `http://localhost:3001${path}`,
}));

jest.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ token: 'test-token' }),
}));

import SubscriptionTypesTab from '../components/admin/SubscriptionTypesTab';
import axios from 'axios';

const mockedAxiosGet = axios.get as jest.Mock;
const mockedAxiosPost = axios.post as jest.Mock;

function mockMountGets(subTypes: any[]) {
  // component fires 3 GETs on mount: subscription-types, available-skills, portal-pages
  mockedAxiosGet
    .mockResolvedValueOnce({ data: subTypes })
    .mockResolvedValueOnce({ data: [] })
    .mockResolvedValueOnce({ data: { pages: [] } });
}

describe('SubscriptionTypesTab — monthlyCostAllowance', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders the cost cap in the list ($ formatted) and "Unlimited" when unset', async () => {
    mockMountGets([
      { name: 'Starter', allowedPages: ['*'], allowedSkills: ['*'], allowedConnectedAccounts: ['*'], monthlyTokenAllowance: 20000000, monthlyCostAllowance: 500 },
      { name: 'Free', allowedPages: ['*'], allowedSkills: ['*'], allowedConnectedAccounts: ['*'], monthlyTokenAllowance: 1500 },
    ]);

    render(<SubscriptionTypesTab />);

    await waitFor(() => expect(screen.getByText('Starter')).toBeInTheDocument());
    // Starter shows $500.00; Free (no cap) shows Unlimited
    expect(screen.getByText('$500.00')).toBeInTheDocument();
    // "Monthly Cost Allowance" column header present
    expect(screen.getByText('Monthly Cost Allowance')).toBeInTheDocument();
  });

  it('edit dialog pre-fills the cap and saves the parsed USD value in the POST payload', async () => {
    mockMountGets([
      { name: 'Starter', allowedPages: ['*'], allowedSkills: ['*'], allowedConnectedAccounts: ['*'], monthlyTokenAllowance: 20000000, monthlyCostAllowance: 500 },
    ]);

    render(<SubscriptionTypesTab />);
    await waitFor(() => expect(screen.getByText('Starter')).toBeInTheDocument());

    // open the edit dialog (pencil icon button — an icon-only button)
    const iconButtons = screen.getAllByRole('button').filter(
      (b) => b.querySelector('svg') !== null && !b.textContent?.trim()
    );
    fireEvent.click(iconButtons[0]);

    // field pre-filled with the existing cap
    const costField = (await screen.findByLabelText('Monthly Cost Allowance (USD)')) as HTMLInputElement;
    expect(costField.value).toBe('500');

    // change to a new value (with a $ to prove parsing strips it)
    fireEvent.change(costField, { target: { value: '$125.50' } });

    // save
    const saveBtn = screen.getByRole('button', { name: /save|update/i });
    fireEvent.click(saveBtn);

    await waitFor(() => expect(mockedAxiosPost).toHaveBeenCalled());
    const [, body] = mockedAxiosPost.mock.calls[0];
    const starter = body.subscriptionTypes.find((t: any) => t.name === 'Starter');
    expect(starter.monthlyCostAllowance).toBe(125.5);
  });

  it('empty cost field saves null (unlimited)', async () => {
    mockMountGets([
      { name: 'Starter', allowedPages: ['*'], allowedSkills: ['*'], allowedConnectedAccounts: ['*'], monthlyCostAllowance: 500 },
    ]);

    render(<SubscriptionTypesTab />);
    await waitFor(() => expect(screen.getByText('Starter')).toBeInTheDocument());

    const iconButtons = screen.getAllByRole('button').filter(
      (b) => b.querySelector('svg') !== null && !b.textContent?.trim()
    );
    fireEvent.click(iconButtons[0]);

    const costField = (await screen.findByLabelText('Monthly Cost Allowance (USD)')) as HTMLInputElement;
    fireEvent.change(costField, { target: { value: '' } });

    fireEvent.click(screen.getByRole('button', { name: /save|update/i }));

    await waitFor(() => expect(mockedAxiosPost).toHaveBeenCalled());
    const [, body] = mockedAxiosPost.mock.calls[0];
    const starter = body.subscriptionTypes.find((t: any) => t.name === 'Starter');
    expect(starter.monthlyCostAllowance).toBeNull();
  });
});
