/**
 * Tests for the v0 Credits admin-dashboard card (components/admin/V0CreditsCard.tsx).
 *
 * Follows the SubscriptionTypesTab.googleDrive.test.tsx conventions:
 * mocks (axios, config, AuthContext) are declared before the component import.
 */

import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';

// ── Mocks ─────────────────────────────────────────────────────────────────────
// All mocks must be declared before any imports that trigger module loading.

jest.mock('axios', () => ({
  get: jest.fn(),
}));

jest.mock('../config', () => ({
  buildApiUrl: (path: string) => `http://localhost:3001${path}`,
}));

jest.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ token: 'test-token' }),
}));

// Import component after mocks are hoisted
import V0CreditsCard from '../components/admin/V0CreditsCard';
import axios from 'axios';

const mockedAxiosGet = axios.get as jest.Mock;

const CREDITS_LOW = {
  plan: 'v0-team',
  billingCycle: { start: 1781938800000, end: 1784530800000 },
  monthly: { remaining: 2, total: 30 },
  onDemand: { remaining: 10.7621578, total: 50 },
  totalSpendableUsd: 12.76,
  rateLimits: {
    limit: 250,
    remaining: 250,
    reset: 1783814400000,
    daily: { limit: 7, remaining: 7, reset: 1783814400000 },
  },
  warnLevel: 'low',
  fetchedAt: '2026-07-11T00:00:00.000Z',
};

describe('V0CreditsCard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders balances from the API response with the low-credit warning state', async () => {
    mockedAxiosGet.mockResolvedValue({ data: CREDITS_LOW });

    render(<V0CreditsCard />);

    await waitFor(() => {
      expect(screen.getByTestId('v0-total-spendable')).toHaveTextContent('$12.76');
    });

    expect(screen.getByText('v0 Credits')).toBeInTheDocument();
    expect(screen.getByText('Plan: v0-team')).toBeInTheDocument();
    expect(screen.getByText('Monthly: $2.00 / $30.00')).toBeInTheDocument();
    expect(screen.getByText('On-demand: $10.76 / $50.00')).toBeInTheDocument();
    expect(screen.getByTestId('v0-warn-label')).toHaveTextContent('Credits low');
    expect(screen.getByText(/Last checked:/)).toBeInTheDocument();

    // Authenticated fetch against the admin endpoint
    expect(mockedAxiosGet).toHaveBeenCalledWith(
      'http://localhost:3001/api/admin/v0/credits',
      { headers: { Authorization: 'Bearer test-token' } }
    );
  });

  it('shows "Credits critical" for the critical warn level', async () => {
    mockedAxiosGet.mockResolvedValue({
      data: { ...CREDITS_LOW, totalSpendableUsd: 4.5, warnLevel: 'critical' },
    });

    render(<V0CreditsCard />);

    await waitFor(() => {
      expect(screen.getByTestId('v0-warn-label')).toHaveTextContent('Credits critical');
    });
  });

  it('hides the warning label when warnLevel is ok', async () => {
    mockedAxiosGet.mockResolvedValue({
      data: { ...CREDITS_LOW, totalSpendableUsd: 80, warnLevel: 'ok' },
    });

    render(<V0CreditsCard />);

    await waitFor(() => {
      expect(screen.getByTestId('v0-total-spendable')).toHaveTextContent('$80.00');
    });
    expect(screen.queryByTestId('v0-warn-label')).not.toBeInTheDocument();
  });

  it('shows a plain error state on fetch failure — never fake numbers', async () => {
    mockedAxiosGet.mockRejectedValue(new Error('network down'));

    render(<V0CreditsCard />);

    await waitFor(() => {
      expect(screen.getByTestId('v0-credits-error')).toHaveTextContent(
        "Couldn't reach v0 billing"
      );
    });
    expect(screen.queryByTestId('v0-total-spendable')).not.toBeInTheDocument();
  });

  it('surfaces the backend error message when the API returns one', async () => {
    mockedAxiosGet.mockRejectedValue({
      response: { data: { message: 'Failed to fetch v0 billing', error: 'v0 API request failed: GET /user/billing (HTTP 500)' } },
    });

    render(<V0CreditsCard />);

    await waitFor(() => {
      expect(screen.getByTestId('v0-credits-error')).toHaveTextContent(
        'v0 API request failed: GET /user/billing (HTTP 500)'
      );
    });
  });

  it('refresh button refetches with cache bypass', async () => {
    mockedAxiosGet.mockResolvedValue({ data: CREDITS_LOW });

    render(<V0CreditsCard />);
    await waitFor(() => {
      expect(screen.getByTestId('v0-total-spendable')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText('refresh v0 credits'));

    await waitFor(() => {
      expect(mockedAxiosGet).toHaveBeenCalledWith(
        'http://localhost:3001/api/admin/v0/credits?refresh=1',
        { headers: { Authorization: 'Bearer test-token' } }
      );
    });
  });
});
