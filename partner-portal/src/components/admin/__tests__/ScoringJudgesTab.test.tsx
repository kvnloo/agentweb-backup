import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import ScoringJudgesTab from '../ScoringJudgesTab';
import axios from 'axios';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

jest.mock('../../../contexts/AuthContext', () => ({
  useAuth: () => ({
    token: 'fake-token',
  }),
}));

jest.mock('../../../config', () => ({
  buildApiUrl: (path: string) => `http://localhost:3000${path}`,
}));

const shadowJudge = {
  id: 'outcome-judge-b-shadow',
  name: 'Outcome Judge (shadow)',
  systemPrompt: 'rubric b prompt',
  llmModel: 'anthropic.claude-sonnet-4-6',
  shadow: true,
  sampleRate: 0.33,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-28T00:00:00.000Z',
};

const ordinaryJudge = {
  id: 'j1',
  name: 'Fangfang',
  systemPrompt: 'rate it',
  llmModel: 'gemini-3.5-flash',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
};

function mockJudgesResponse(judges: Array<Record<string, unknown>>) {
  mockedAxios.get.mockImplementation((url: string) => {
    if (url.includes('/default-prompt')) {
      return Promise.resolve({ data: { systemPrompt: 'default prompt', isCustom: true, llmModel: '' } });
    }
    return Promise.resolve({ data: { judges, availableModels: ['gemini-3.5-flash', 'anthropic.claude-sonnet-4-6'] } });
  });
}

describe('ScoringJudgesTab', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('renders a shadow badge with sample rate for a shadow judge but not for an ordinary judge', async () => {
    mockJudgesResponse([shadowJudge, ordinaryJudge]);

    render(<ScoringJudgesTab />);

    await waitFor(() => expect(screen.getByText('Outcome Judge (shadow)')).toBeInTheDocument());

    expect(screen.getByText('shadow · 33%')).toBeInTheDocument();

    const fangfangRow = screen.getByText('Fangfang').closest('tr')!;
    expect(within(fangfangRow).queryByText(/shadow/i)).not.toBeInTheDocument();
  });

  it('shows a read-only shadow/sampleRate note in the edit dialog and preserves it on save', async () => {
    mockJudgesResponse([shadowJudge]);
    mockedAxios.put.mockResolvedValue({
      data: { judge: { ...shadowJudge, name: 'Outcome Judge (shadow) v2' } },
    });

    render(<ScoringJudgesTab />);

    await waitFor(() => expect(screen.getByText('Outcome Judge (shadow)')).toBeInTheDocument());

    const editButtons = screen.getAllByRole('button', { name: '' });
    // First edit icon belongs to the "Default" row; the judge row's edit icon is the next one.
    fireEvent.click(editButtons[1]);

    expect(await screen.findByText(/Shadow judge · sampled 33%/i)).toBeInTheDocument();
    expect(screen.getByText(/never affects the primary satisfaction score/i)).toBeInTheDocument();

    // No editable shadow/sampleRate controls — only name/model/prompt are editable.
    expect(screen.queryByLabelText(/sample rate/i)).not.toBeInTheDocument();

    const nameInput = screen.getByLabelText('Name') as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: 'Outcome Judge (shadow) v2' } });

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(mockedAxios.put).toHaveBeenCalledWith(
        'http://localhost:3000/api/settings/scoring-judges/outcome-judge-b-shadow',
        expect.objectContaining({ name: 'Outcome Judge (shadow) v2' }),
        expect.anything()
      );
    });

    // The PUT payload never includes shadow/sampleRate — the backend preserves them server-side.
    const [, payload] = mockedAxios.put.mock.calls[0];
    expect(payload).not.toHaveProperty('shadow');
    expect(payload).not.toHaveProperty('sampleRate');
  });

  it('does not show the shadow note when editing an ordinary judge', async () => {
    mockJudgesResponse([ordinaryJudge]);

    render(<ScoringJudgesTab />);

    await waitFor(() => expect(screen.getByText('Fangfang')).toBeInTheDocument());

    const editButtons = screen.getAllByRole('button', { name: '' });
    fireEvent.click(editButtons[1]);

    await waitFor(() => expect(screen.getByText('Edit Judge')).toBeInTheDocument());
    expect(screen.queryByText(/Shadow judge/i)).not.toBeInTheDocument();
  });

  it('replaces the native confirm() with an in-page dialog explaining the reset before it happens', async () => {
    const confirmSpy = jest.spyOn(window, 'confirm');
    mockJudgesResponse([]);
    mockedAxios.delete.mockResolvedValue({ data: { systemPrompt: 'built-in default', isCustom: false, llmModel: '' } });

    render(<ScoringJudgesTab />);

    await waitFor(() => expect(screen.getByText('Default')).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText(/Reset to built-in default/i));

    // The native dialog must never be invoked.
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(mockedAxios.delete).not.toHaveBeenCalled();

    expect(await screen.findByText('Reset default judge prompt?')).toBeInTheDocument();
    expect(screen.getByText(/restores the built-in default prompt/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));

    await waitFor(() => {
      expect(mockedAxios.delete).toHaveBeenCalledWith(
        'http://localhost:3000/api/settings/scoring-judges/default-prompt',
        expect.anything()
      );
    });
  });

  it('cancelling the reset confirmation does not call the reset endpoint', async () => {
    mockJudgesResponse([]);

    render(<ScoringJudgesTab />);

    await waitFor(() => expect(screen.getByText('Default')).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText(/Reset to built-in default/i));
    expect(await screen.findByText('Reset default judge prompt?')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => {
      expect(screen.queryByText('Reset default judge prompt?')).not.toBeInTheDocument();
    });
    expect(mockedAxios.delete).not.toHaveBeenCalled();
  });
});
