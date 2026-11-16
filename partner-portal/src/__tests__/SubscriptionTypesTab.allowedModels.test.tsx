/**
 * ENG-669 (#3607 follow-up 7): the tier editor's "Allowed model IDs" field. Blank keeps the field absent (every model);
 * a list is sent as typed (the server canonicalises it). Something typed that names no model (only commas, line breaks
 * or spaces) must be refused, not saved as "every model".
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

const STARTER = { name: 'Starter', allowedPages: ['*'], allowedSkills: ['*'], allowedConnectedAccounts: ['*'], monthlyTokenAllowance: 1000 };

type Tier = Record<string, unknown>;

function mockMountGets(subTypes: Tier[]) {
  // component fires 4 GETs on mount: subscription-types, skills, pages, features
  mockedAxiosGet
    .mockResolvedValueOnce({ data: subTypes })
    .mockResolvedValueOnce({ data: [] })
    .mockResolvedValueOnce({ data: { pages: [] } })
    .mockResolvedValueOnce({ data: { features: [] } });
}

/** The Starter tier as the (first) save POSTed it. */
function savedStarter(): Tier | undefined {
  const [, body] = mockedAxiosPost.mock.calls[0] as [string, { subscriptionTypes: Tier[] }];
  return body.subscriptionTypes.find((t) => t.name === 'Starter');
}

async function editStarterModels(value: string) {
  mockMountGets([STARTER]);
  render(<SubscriptionTypesTab />);
  await waitFor(() => expect(screen.getByText('Starter')).toBeInTheDocument());
  const iconButtons = screen.getAllByRole('button').filter((b) => b.querySelector('svg') !== null && !b.textContent?.trim());
  fireEvent.click(iconButtons[0]);
  const field = (await screen.findByLabelText('Allowed model IDs')) as HTMLInputElement;
  fireEvent.change(field, { target: { value } });
  fireEvent.click(screen.getByRole('button', { name: /save|update/i }));
}

describe('SubscriptionTypesTab — allowed models', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedAxiosGet.mockResolvedValue({ data: [] });
  });

  it.each([', ,', ' , \n , '])('refuses %p (typed, but names no model) with a validation error and saves nothing', async (value) => {
    await editStarterModels(value);
    expect(await screen.findByText(/Allowed models names no model/)).toBeInTheDocument();
    expect(mockedAxiosPost).not.toHaveBeenCalled();
  });

  it('sends a typed list as its ids', async () => {
    await editStarterModels(' gpt-5.5 ,, gemini-3.5-flash ');
    await waitFor(() => expect(mockedAxiosPost).toHaveBeenCalled());
    expect(savedStarter()?.allowedModels).toEqual(['gpt-5.5', 'gemini-3.5-flash']);
  });

  it('blank keeps the field absent (every model)', async () => {
    await editStarterModels('   ');
    await waitFor(() => expect(mockedAxiosPost).toHaveBeenCalled());
    expect(savedStarter()).toBeDefined();
    expect(savedStarter()).not.toHaveProperty('allowedModels');
  });
});
