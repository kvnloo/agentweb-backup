/**
 * Admin editor for the onboarding outreach invite prompt (AC #3).
 *
 * Renders the real PromptTemplates page and drives the OutreachInviteCard:
 * load, edit, save (blank lines dropped, version bumped), and the two ways
 * the card can be left without a row — a failed fetch and an absent token.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import userEvent from '@testing-library/user-event';
import axios from 'axios';
import PromptTemplates from '../pages/PromptTemplates';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

// `../config` reads `import.meta.env`, which Jest's CJS transform cannot
// parse. Stub it — the URL it builds is all this suite cares about.
jest.mock('../config', () => ({
  buildApiUrl: (path: string) => `http://localhost:3001${path}`,
}));

let mockToken: string | null = 'test-token';
jest.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ token: mockToken }),
}));

const INVITE_URL = '/api/admin/prompt-templates/outreach/invite';

const ROW = {
  templateId: 'onboarding-outreach-invite',
  version: 'v2-2026-07-13',
  systemPrompt: 'SEED SYSTEM PROMPT',
  withCompanyVariants: ['Hi {firstName} at {company}'],
  withoutCompanyVariants: ['Hi {firstName}'],
  updatedAt: '2026-07-13T00:00:00Z',
  updatedBy: 'admin-1',
};

/** Route GETs by URL: the invite row vs the archetype list the page also loads. */
function stubGets(inviteImpl: () => Promise<unknown>) {
  mockedAxios.get.mockImplementation((url: string) => {
    if (String(url).includes(INVITE_URL)) return inviteImpl() as never;
    return Promise.resolve({ data: { templates: [] } }) as never;
  });
}

/** The card is the region owning the outreach system-prompt field. */
async function findCard(): Promise<HTMLElement> {
  const field = await screen.findByLabelText(/System prompt/i);
  return field.closest('.MuiCard-root') as HTMLElement;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockToken = 'test-token';
  stubGets(() => Promise.resolve({ data: { template: ROW } }));
  mockedAxios.put.mockResolvedValue({ data: { template: ROW } } as never);
});

describe('PromptTemplates — onboarding outreach invite card', () => {
  it('loads the row and hydrates both variant pools one-per-line', async () => {
    render(<PromptTemplates />);

    const systemPrompt = await screen.findByLabelText(/System prompt/i);
    expect(systemPrompt).toHaveValue('SEED SYSTEM PROMPT');
    expect(screen.getByLabelText(/prospect HAS a company/i)).toHaveValue(
      'Hi {firstName} at {company}',
    );
    expect(screen.getByLabelText(/prospect has NO company/i)).toHaveValue(
      'Hi {firstName}',
    );
    // Provenance is surfaced so an admin knows which version is live.
    const card = await findCard();
    expect(within(card).getByText(/Version v2-2026-07-13/)).toBeInTheDocument();
    expect(within(card).getByText(/admin-1/)).toBeInTheDocument();
  });

  it('keeps Save disabled until something actually changes', async () => {
    render(<PromptTemplates />);
    await screen.findByLabelText(/System prompt/i);

    const card = await findCard();
    const save = within(card).getByRole('button', { name: /Save/i });
    expect(save).toBeDisabled();

    await userEvent.type(screen.getByLabelText(/System prompt/i), '!');
    expect(save).toBeEnabled();
  });

  it('saves the edited pools, dropping blank lines', async () => {
    render(<PromptTemplates />);
    const withCompany = await screen.findByLabelText(/prospect HAS a company/i);

    // fireEvent.change, not userEvent.type: `{...}` is userEvent keyboard
    // syntax, so typing "{firstName}" would be swallowed as a key name.
    // Deliberate blank line in the middle — it must not be persisted.
    fireEvent.change(withCompany, {
      target: {
        value: 'Hi {firstName} at {company}!\n\nHi {firstName}, hello',
      },
    });

    const card = await findCard();
    await userEvent.click(within(card).getByRole('button', { name: /Save/i }));

    await waitFor(() => expect(mockedAxios.put).toHaveBeenCalledTimes(1));
    const [url, body] = mockedAxios.put.mock.calls[0];
    expect(String(url)).toContain(INVITE_URL);
    expect((body as any).withCompanyVariants).toEqual([
      'Hi {firstName} at {company}!',
      'Hi {firstName}, hello',
    ]);
    // Untouched pool round-trips unchanged.
    expect((body as any).withoutCompanyVariants).toEqual(['Hi {firstName}']);
  });

  it('surfaces a save failure instead of silently dropping the edit', async () => {
    mockedAxios.put.mockRejectedValueOnce({
      response: { data: { message: 'withCompanyVariants must be a non-empty array of strings' } },
    } as never);

    render(<PromptTemplates />);
    await userEvent.type(
      await screen.findByLabelText(/System prompt/i),
      ' more',
    );

    const card = await findCard();
    await userEvent.click(within(card).getByRole('button', { name: /Save/i }));

    expect(
      await screen.findByText(/must be a non-empty array of strings/i),
    ).toBeInTheDocument();
  });

  it('shows the load error rather than an empty editor when the fetch fails', async () => {
    stubGets(() =>
      Promise.reject({ response: { data: { message: 'ddb unreachable' } } }),
    );

    render(<PromptTemplates />);

    expect(await screen.findByText(/ddb unreachable/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/System prompt/i)).not.toBeInTheDocument();
  });

  it('does not spin forever when there is no token to fetch with', async () => {
    mockToken = null;

    render(<PromptTemplates />);

    // Scope to the card — the page keeps its own spinner for the archetype
    // list, which is not what this asserts.
    const card = screen
      .getByText(/Onboarding outreach invite/i)
      .closest('.MuiCard-root') as HTMLElement;

    await waitFor(() => {
      expect(within(card).queryByRole('progressbar')).not.toBeInTheDocument();
    });
    // ...and it never called the invite endpoint without a token.
    const calledInvite = mockedAxios.get.mock.calls.some(([url]) =>
      String(url).includes(INVITE_URL),
    );
    expect(calledInvite).toBe(false);
  });
});
