/**
 * ENG-1978: an empty `allowedSkills` list means NO skills (the runtime no longer reads [] as a
 * wildcard); only an explicit '*' grants every skill. The tier editor has to agree, or an admin
 * who opens a zero-skill tier sees it as "all skills" and saving writes a full grant, and a '*'
 * tier opened before the skill list has loaded saves [] and silently revokes everything.
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

const SKILLS = [
  { skillId: 'skill-1', name: 'Image Gen', description: 'Make images', toolNames: [] },
  { skillId: 'skill-2', name: 'Video Gen', description: 'Make videos', toolNames: [] },
];

function mockMount(subTypes: any[], skills: any[] = SKILLS) {
  // The component fires 4 GETs on mount: subscription-types, skills, pages, features.
  mockedAxiosGet
    .mockResolvedValueOnce({ data: subTypes })
    .mockResolvedValueOnce({ data: skills })
    .mockResolvedValueOnce({ data: { pages: [] } })
    .mockResolvedValueOnce({
      data: { features: [{ id: 'scheduled_chats', label: 'Scheduled chats', description: 'Create and run scheduled chats.' }] },
    });
}

const tier = (name: string, allowedSkills: string[]) => ({
  name,
  allowedPages: ['*'],
  allowedSkills,
  allowedConnectedAccounts: ['*'],
});

function openFirstEditDialog() {
  const iconButtons = screen.getAllByRole('button').filter(
    (b) => b.querySelector('svg') !== null && !b.textContent?.trim()
  );
  fireEvent.click(iconButtons[0]);
}

describe('SubscriptionTypesTab — empty allowedSkills means no skills (ENG-1978)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedAxiosGet.mockResolvedValue({ data: [] });
  });

  it('lists a zero-skill tier as "No skills" and only an explicit * as "All Skills"', async () => {
    mockMount([tier('Locked', []), tier('Everything', ['*'])]);

    render(<SubscriptionTypesTab />);
    await waitFor(() => expect(screen.getByText('Locked')).toBeInTheDocument());

    expect(screen.getByText('No skills')).toBeInTheDocument();
    expect(screen.getAllByText('All Skills')).toHaveLength(1);
  });

  it('opens a zero-skill tier with nothing checked and warns that none are granted', async () => {
    mockMount([tier('Locked', [])]);

    render(<SubscriptionTypesTab />);
    await waitFor(() => expect(screen.getByText('Locked')).toBeInTheDocument());
    openFirstEditDialog();

    expect(await screen.findByText(/No skills are selected/i)).toBeInTheDocument();
    expect(await screen.findByRole('checkbox', { name: /select all skills/i })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: /image gen/i })).not.toBeChecked();
  });

  it('saving an untouched zero-skill tier keeps it at zero skills', async () => {
    mockMount([tier('Locked', [])]);

    render(<SubscriptionTypesTab />);
    await waitFor(() => expect(screen.getByText('Locked')).toBeInTheDocument());
    openFirstEditDialog();
    await screen.findByText(/No skills are selected/i);

    fireEvent.click(screen.getByRole('button', { name: /save|update/i }));

    await waitFor(() => expect(mockedAxiosPost).toHaveBeenCalled());
    const [, body] = mockedAxiosPost.mock.calls[0];
    expect(body.subscriptionTypes.find((t: any) => t.name === 'Locked').allowedSkills).toEqual([]);
  });

  it('saving a * tier whose skill list never loaded keeps the *, not []', async () => {
    mockMount([tier('Everything', ['*'])], []);

    render(<SubscriptionTypesTab />);
    await waitFor(() => expect(screen.getByText('Everything')).toBeInTheDocument());
    openFirstEditDialog();
    await screen.findByText(/Loading skills/i);

    fireEvent.click(screen.getByRole('button', { name: /save|update/i }));

    await waitFor(() => expect(mockedAxiosPost).toHaveBeenCalled());
    const [, body] = mockedAxiosPost.mock.calls[0];
    expect(body.subscriptionTypes.find((t: any) => t.name === 'Everything').allowedSkills).toEqual(['*']);
  });

  it('refuses to save a NEW tier before the skill list has loaded', async () => {
    mockMount([tier('Existing', ['*'])], []);

    render(<SubscriptionTypesTab />);
    await waitFor(() => expect(screen.getByText('Existing')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /add subscription type/i }));

    fireEvent.change(await screen.findByLabelText('Subscription Type Name'), { target: { value: 'Fresh' } });
    fireEvent.click(screen.getByRole('button', { name: /save|create/i }));

    expect(await screen.findByText(/Skills are still loading/i)).toBeInTheDocument();
    expect(mockedAxiosPost).not.toHaveBeenCalled();
  });

  it('a * tier with the skill list loaded still round-trips as *', async () => {
    mockMount([tier('Everything', ['*'])]);

    render(<SubscriptionTypesTab />);
    await waitFor(() => expect(screen.getByText('Everything')).toBeInTheDocument());
    openFirstEditDialog();
    await waitFor(() => expect(screen.getByRole('checkbox', { name: /image gen/i })).toBeChecked());

    fireEvent.click(screen.getByRole('button', { name: /save|update/i }));

    await waitFor(() => expect(mockedAxiosPost).toHaveBeenCalled());
    const [, body] = mockedAxiosPost.mock.calls[0];
    expect(body.subscriptionTypes.find((t: any) => t.name === 'Everything').allowedSkills).toEqual(['*']);
  });
});
