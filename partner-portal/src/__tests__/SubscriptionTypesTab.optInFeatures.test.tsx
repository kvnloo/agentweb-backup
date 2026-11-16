/**
 * Features that cost AgentWeb money per use (hot_lead_call) are opt-in: the editor must not tick
 * them for a new tier or for a legacy tier, and saving must not re-add them. Only an admin's own
 * tick puts one in the payload.
 */

import React from 'react';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
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

const SKILLS = [{ skillId: 'skill-1', name: 'Image Gen', description: 'Make images', toolNames: [] }];
const FEATURES = [
  { id: 'scheduled_chats', label: 'Scheduled chats', description: 'Create and run scheduled chats.', optInOnly: false },
  { id: 'hot_lead_call', label: 'Hot lead calls', description: 'Phone a team member when a hot lead arrives and connect them to the lead.', optInOnly: true },
];

const PAGES = [
  { path: '/research', label: 'Research' },
  { path: '/blog', label: 'Blog' },
];

function mockMount(subTypes: unknown[]) {
  mockedAxiosGet
    .mockResolvedValueOnce({ data: subTypes })
    .mockResolvedValueOnce({ data: SKILLS })
    .mockResolvedValueOnce({ data: { pages: PAGES } })
    .mockResolvedValueOnce({ data: { features: FEATURES } });
}

// Answers by URL, with the pages list held back until the test lets it through, so it can arrive after a dialog is open.
function mockMountWithLatePages(subTypes: unknown[]): () => void {
  let release: () => void = () => undefined;
  mockedAxiosGet.mockImplementation((url: string) => {
    if (url.includes('subscription-types')) return Promise.resolve({ data: subTypes });
    if (url.includes('available-skills')) return Promise.resolve({ data: SKILLS });
    if (url.includes('subscription-features')) return Promise.resolve({ data: { features: FEATURES } });
    return new Promise((resolve) => { release = () => resolve({ data: { pages: PAGES } }); });
  });
  return () => release();
}

// What the admin GET returns for a legacy row: the server already leaves hot_lead_call out.
const legacyTier = (name: string, allowedFeatures?: string[]) => ({
  name,
  allowedPages: ['*'],
  allowedSkills: ['skill-1'],
  allowedConnectedAccounts: ['*'],
  ...(allowedFeatures ? { allowedFeatures } : {}),
});

function openFirstEditDialog() {
  const iconButtons = screen.getAllByRole('button').filter(
    (b) => b.querySelector('svg') !== null && !b.textContent?.trim()
  );
  fireEvent.click(iconButtons[0]);
}

const savedFeatures = (name: string): string[] =>
  mockedAxiosPost.mock.calls[0][1].subscriptionTypes.find((t: { name: string }) => t.name === name).allowedFeatures;

describe('SubscriptionTypesTab - opt-in-only product features', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedAxiosGet.mockResolvedValue({ data: [] });
  });

  it('a new tier starts with hot_lead_call unticked and the cost warning shown', async () => {
    mockMount([legacyTier('Existing', ['scheduled_chats'])]);
    render(<SubscriptionTypesTab />);
    await waitFor(() => expect(screen.getByText('Existing')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /add subscription type/i }));

    expect(await screen.findByText(/Costs AgentWeb money per use/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('checkbox', { name: /scheduled chats/i })).toBeChecked());
    expect(screen.getByRole('checkbox', { name: /hot lead calls/i })).not.toBeChecked();
  });

  it('saving a new tier without touching the box leaves hot_lead_call out of the payload', async () => {
    mockMount([legacyTier('Existing', ['scheduled_chats'])]);
    render(<SubscriptionTypesTab />);
    await waitFor(() => expect(screen.getByText('Existing')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /add subscription type/i }));
    fireEvent.change(await screen.findByLabelText('Subscription Type Name'), { target: { value: 'Fresh' } });
    await waitFor(() => expect(screen.getByRole('checkbox', { name: /scheduled chats/i })).toBeChecked());
    fireEvent.click(screen.getByRole('button', { name: /save|create/i }));

    await waitFor(() => expect(mockedAxiosPost).toHaveBeenCalled());
    expect(savedFeatures('Fresh')).toEqual(['scheduled_chats']);
  });

  it('a tier row from the server without a feature list shows hot_lead_call unticked and keeps it out on save', async () => {
    mockMount([legacyTier('Free')]);
    render(<SubscriptionTypesTab />);
    await waitFor(() => expect(screen.getByText('Free')).toBeInTheDocument());
    openFirstEditDialog();

    await waitFor(() => expect(screen.getByRole('checkbox', { name: /scheduled chats/i })).toBeChecked());
    expect(screen.getByRole('checkbox', { name: /hot lead calls/i })).not.toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: /save|update/i }));

    await waitFor(() => expect(mockedAxiosPost).toHaveBeenCalled());
    expect(savedFeatures('Free')).toEqual(['scheduled_chats']);
  });

  it('an explicit tick is sent, and a tier that already has it keeps it', async () => {
    mockMount([legacyTier('Pro', ['scheduled_chats', 'hot_lead_call'])]);
    render(<SubscriptionTypesTab />);
    await waitFor(() => expect(screen.getByText('Pro')).toBeInTheDocument());
    openFirstEditDialog();

    await waitFor(() => expect(screen.getByRole('checkbox', { name: /hot lead calls/i })).toBeChecked());
    fireEvent.click(screen.getByRole('button', { name: /save|update/i }));

    await waitFor(() => expect(mockedAxiosPost).toHaveBeenCalled());
    expect(savedFeatures('Pro')).toEqual(['scheduled_chats', 'hot_lead_call']);
  });

  it('a new tier gets every page and skill once the lists have loaded after the dialog opened', async () => {
    const releasePages = mockMountWithLatePages([legacyTier('Existing', ['scheduled_chats'])]);
    render(<SubscriptionTypesTab />);
    await waitFor(() => expect(screen.getByText('Existing')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /add subscription type/i }));
    fireEvent.change(await screen.findByLabelText('Subscription Type Name'), { target: { value: 'Fresh' } });
    await act(async () => releasePages());
    await waitFor(() => expect(screen.getByRole('checkbox', { name: /scheduled chats/i })).toBeChecked());
    fireEvent.click(screen.getByRole('button', { name: /save|create/i }));

    await waitFor(() => expect(mockedAxiosPost).toHaveBeenCalled());
    const saved = mockedAxiosPost.mock.calls[0][1].subscriptionTypes.find((t: { name: string }) => t.name === 'Fresh');
    expect(saved.allowedPages).toEqual(['/research', '/blog']);
    expect(saved.allowedSkills).toEqual(['*']); // every skill ticked is saved as the wildcard
  });

  it('a tier saved with "*" pages is expanded to the real pages once they have loaded after the dialog opened', async () => {
    const releasePages = mockMountWithLatePages([legacyTier('Free', ['scheduled_chats'])]);
    render(<SubscriptionTypesTab />);
    await waitFor(() => expect(screen.getByText('Free')).toBeInTheDocument());
    openFirstEditDialog();
    await act(async () => releasePages());
    await waitFor(() => expect(screen.getByRole('checkbox', { name: /scheduled chats/i })).toBeChecked());
    fireEvent.click(screen.getByRole('button', { name: /save|update/i }));

    await waitFor(() => expect(mockedAxiosPost).toHaveBeenCalled());
    const saved = mockedAxiosPost.mock.calls[0][1].subscriptionTypes.find((t: { name: string }) => t.name === 'Free');
    expect(saved.allowedPages).toEqual(['/research', '/blog']);
  });
});
