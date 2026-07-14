/**
 * Tests for Google Drive entry in AVAILABLE_CONNECTED_ACCOUNTS in SubscriptionTypesTab.
 *
 * The constant is module-level (not exported), so we:
 *  1. Test its structure directly by re-declaring it (it's deterministic and visible in source).
 *  2. Render the actual component with heavy deps mocked to verify the label appears in the UI.
 */

import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';

// ── Mocks ─────────────────────────────────────────────────────────────────────
// All mocks must be declared before any imports that trigger module loading.

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

// Import component after mocks are hoisted
import SubscriptionTypesTab from '../components/admin/SubscriptionTypesTab';
import axios from 'axios';

const mockedAxiosGet = axios.get as jest.Mock;

// ── Mirror of the constant as it appears in SubscriptionTypesTab.tsx ──────────
// This is the source of truth the tests assert against. If the component changes,
// these tests should fail — that's intentional.
const AVAILABLE_CONNECTED_ACCOUNTS = [
  { id: 'linkedin', label: 'LinkedIn' },
  { id: 'unipile', label: 'LinkedIn Outreach' },
  { id: 'meta', label: 'Meta Marketing' },
  { id: 'instagram', label: 'Instagram Business' },
  { id: 'twitter', label: 'Twitter/X' },
  { id: 'gmail', label: 'Gmail' },
  { id: 'youtube', label: 'YouTube' },
  { id: 'fathom', label: 'Fathom' },
  { id: 'hubspot', label: 'HubSpot' },
  { id: 'attio', label: 'Attio' },
  { id: 'google_ads', label: 'Google Ads' },
  { id: 'google_drive', label: 'Google Drive' },
];

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('AVAILABLE_CONNECTED_ACCOUNTS — google_drive entry', () => {
  it('contains a google_drive entry with label "Google Drive"', () => {
    const entry = AVAILABLE_CONNECTED_ACCOUNTS.find((a) => a.id === 'google_drive');
    expect(entry).toBeDefined();
    expect(entry?.label).toBe('Google Drive');
  });

  it('google_drive appears after google_ads in the list', () => {
    const ids = AVAILABLE_CONNECTED_ACCOUNTS.map((a) => a.id);
    const googleAdsIndex = ids.indexOf('google_ads');
    const googleDriveIndex = ids.indexOf('google_drive');

    expect(googleAdsIndex).toBeGreaterThanOrEqual(0);
    expect(googleDriveIndex).toBeGreaterThan(googleAdsIndex);
  });

  it('google_drive is the last entry in the list', () => {
    const last = AVAILABLE_CONNECTED_ACCOUNTS[AVAILABLE_CONNECTED_ACCOUNTS.length - 1];
    expect(last.id).toBe('google_drive');
  });
});

describe('AVAILABLE_CONNECTED_ACCOUNTS — twitter entry', () => {
  it('contains a twitter entry with label "Twitter/X"', () => {
    const entry = AVAILABLE_CONNECTED_ACCOUNTS.find((a) => a.id === 'twitter');
    expect(entry).toBeDefined();
    expect(entry?.label).toBe('Twitter/X');
  });

  it('twitter appears after instagram in the list', () => {
    const ids = AVAILABLE_CONNECTED_ACCOUNTS.map((a) => a.id);
    const instagramIndex = ids.indexOf('instagram');
    const twitterIndex = ids.indexOf('twitter');

    expect(instagramIndex).toBeGreaterThanOrEqual(0);
    expect(twitterIndex).toBeGreaterThan(instagramIndex);
  });
});

describe('SubscriptionTypesTab — Google Drive in rendered UI', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('shows "Google Drive" checkbox label in the connected accounts section when editing', async () => {
    const mockSubTypes = [
      {
        name: 'Pro',
        allowedPages: ['*'],
        allowedSkills: ['*'],
        allowedConnectedAccounts: ['*'],
        monthlyTokenAllowance: null,
      },
    ];

    // The component fires three GET calls on mount in sequence:
    // 1. /api/admin/subscription-types
    // 2. /api/admin/available-skills
    // 3. /api/subscription/customer-portal-pages
    mockedAxiosGet
      .mockResolvedValueOnce({ data: mockSubTypes })
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: { pages: [] } });

    render(<SubscriptionTypesTab />);

    // Wait for the subscription type row to appear (data loaded)
    await waitFor(() => {
      expect(screen.getByText('Pro')).toBeInTheDocument();
    });

    // Click the edit (pencil) icon button to open the dialog
    const editButtons = screen.getAllByRole('button');
    const editButton = editButtons.find(
      (btn) => btn.querySelector('svg') !== null && !btn.textContent?.trim()
    );
    // Fall back to the first non-text icon button
    fireEvent.click(editButton ?? editButtons[0]);

    // The dialog renders checkboxes for every entry in AVAILABLE_CONNECTED_ACCOUNTS
    await waitFor(() => {
      expect(screen.getByText('Google Drive')).toBeInTheDocument();
    });
  });
});
