import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axios from 'axios';
import SandboxAccounts from '../pages/SandboxAccounts';
import '@testing-library/jest-dom';

// Follows the same convention as Skills.pasteTools.test.tsx.
jest.mock('../config', () => ({
  buildApiUrl: (path: string) => path,
  API_URL: 'http://localhost:3001',
  DEBUG: false,
}));

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

jest.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ token: 'mock-token', user: { userId: 'admin-123', isAdmin: true } }),
}));

const ACCOUNT = {
  userId: 'eval_a1b2c3', email: 'candidate@example.invalid', status: 'active' as const,
  label: 'Ryan take-home', datasetId: 'agentweb-2026q2', datasetVersion: 1,
  expiresAt: Date.now() + 30 * 86400000,
};
const DATASET = { datasetId: 'agentweb-2026q2', version: 1, account: { name: 'AgentWeb Sandbox' }, createdAt: '2026-09-13T00:00:00.000Z' };

function mockGetsFor(accounts: typeof ACCOUNT[], datasets: (typeof DATASET)[]) {
  mockedAxios.get.mockImplementation(async (url: string) => {
    if (url === '/api/admin/evaluations') return { data: { accounts } };
    if (url === '/api/admin/evaluations/datasets') return { data: { datasets } };
    throw new Error(`unexpected GET ${url}`);
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetsFor([ACCOUNT], [DATASET]);
  window.open = jest.fn().mockReturnValue({ closed: false, location: { href: '' } });
});

describe('SandboxAccounts', () => {
  it('lists existing sandbox accounts with their dataset and status', async () => {
    render(<SandboxAccounts />);
    expect(await screen.findByText('candidate@example.invalid')).toBeInTheDocument();
    expect(screen.getByText('Ryan take-home')).toBeInTheDocument();
    expect(screen.getByText('agentweb-2026q2@1')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('shows an empty state instead of an error when nothing is provisioned yet', async () => {
    mockGetsFor([], []);
    render(<SandboxAccounts />);
    expect(await screen.findByText(/no sandbox accounts yet/i)).toBeInTheDocument();
  });

  it('creates a sandbox account from the picked dataset and shows the one-time password once', async () => {
    const user = userEvent.setup();
    mockedAxios.post.mockResolvedValue({ data: { userId: 'eval_new', expiresAt: Date.now() } });
    render(<SandboxAccounts />);
    await screen.findByText('candidate@example.invalid');

    await user.click(screen.getByRole('button', { name: /create sandbox account/i }));
    await user.type(screen.getByLabelText(/display name/i), 'New Candidate');
    await user.type(screen.getByLabelText(/^email$/i), 'new@example.invalid');
    await user.click(screen.getByLabelText(/dataset/i));
    await user.click(await screen.findByRole('option', { name: /agentweb-2026q2@1/i }));
    await user.type(screen.getByLabelText(/brand name/i), 'AgentWeb');

    await user.click(screen.getByRole('button', { name: /^create$/i }));

    await waitFor(() => expect(mockedAxios.post).toHaveBeenCalledWith(
      '/api/admin/evaluations',
      expect.objectContaining({
        email: 'new@example.invalid',
        displayName: 'New Candidate',
        datasetId: 'agentweb-2026q2',
        datasetVersion: 1,
        brandGuidelines: { brandName: 'AgentWeb', description: undefined },
      }),
      expect.anything(),
    ));
    // The generated password is never sent back to the server for review — it is
    // client-generated and shown exactly once.
    const [, body] = mockedAxios.post.mock.calls[0];
    expect(typeof (body as any).password).toBe('string');
    expect((body as any).password.length).toBeGreaterThanOrEqual(16);

    expect(await screen.findByText(/won't be shown again/i)).toBeInTheDocument();
    const passwordField = screen.getByDisplayValue((body as any).password);
    expect(passwordField).toBeInTheDocument();
  });

  it('opens the account via the existing delegate-access route on one click', async () => {
    const user = userEvent.setup();
    mockedAxios.post.mockResolvedValue({ data: { customerPortalUrl: 'https://app.agentweb.pro/oauth-callback?token=xyz' } });
    render(<SandboxAccounts />);
    await screen.findByText('candidate@example.invalid');

    await user.click(screen.getByRole('button', { name: /open as this account/i }));

    await waitFor(() => expect(mockedAxios.post).toHaveBeenCalledWith(
      '/api/admin/users/eval_a1b2c3/delegate-access', {}, expect.anything(),
    ));
  });

  it('cleaning an account revokes then purges it, with one confirmation', async () => {
    const user = userEvent.setup();
    mockedAxios.post.mockResolvedValue({ data: { status: 'revoked' } });
    render(<SandboxAccounts />);
    await screen.findByText('candidate@example.invalid');

    await user.click(screen.getByRole('button', { name: /clean \(revoke \+ purge\)/i }));
    const dialog = await screen.findByRole('dialog', { name: /clean this account/i });
    await user.click(within(dialog).getByRole('button', { name: /^clean$/i }));

    await waitFor(() => {
      expect(mockedAxios.post).toHaveBeenCalledWith('/api/admin/evaluations/eval_a1b2c3/revoke', {}, expect.anything());
      expect(mockedAxios.post).toHaveBeenCalledWith('/api/admin/evaluations/eval_a1b2c3/purge', {}, expect.anything());
    });
  });

  it('resetting an account calls reset only, not revoke or purge', async () => {
    const user = userEvent.setup();
    mockedAxios.post.mockResolvedValue({ data: {} });
    render(<SandboxAccounts />);
    await screen.findByText('candidate@example.invalid');

    await user.click(screen.getByRole('button', { name: /reset to original seed/i }));
    const dialog = await screen.findByRole('dialog', { name: /reset this account/i });
    await user.click(within(dialog).getByRole('button', { name: /^reset$/i }));

    await waitFor(() => expect(mockedAxios.post).toHaveBeenCalledWith('/api/admin/evaluations/eval_a1b2c3/reset', {}, expect.anything()));
    expect(mockedAxios.post).not.toHaveBeenCalledWith(expect.stringContaining('/purge'), expect.anything(), expect.anything());
  });
});
