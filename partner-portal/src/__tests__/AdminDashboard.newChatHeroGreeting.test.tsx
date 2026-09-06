import React, { useState } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import axios from 'axios';

// Mock axios
jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

// Minimal component mirroring AdminDashboard's "New Chat greeting" card
// (AdminDashboard.tsx is a ~12k-line monolith not practical to mount whole;
// this repo's established pattern is to test the extracted slice — see
// AdminDashboard.seoAeo.test.tsx / AdminDashboard.replayColumn.test.tsx).
const NewChatHeroGreetingCard: React.FC = () => {
  const [namedTemplate, setNamedTemplate] = useState("Hey {firstName}! Let's get after it");
  const [anonymousText, setAnonymousText] = useState("Hey! Let's get after it");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const save = async () => {
    try {
      setSaving(true);
      setError('');
      setSuccess('');
      const response = await mockedAxios.put(
        'http://localhost:3001/api/agent-mode/new-chat-hero-greeting',
        { namedTemplate, anonymousText },
        { headers: { Authorization: 'Bearer test-token' } }
      );
      setNamedTemplate(response.data.namedTemplate);
      setAnonymousText(response.data.anonymousText);
      setSuccess('New Chat greeting updated successfully!');
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to save New Chat greeting');
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    try {
      setSaving(true);
      setError('');
      setSuccess('');
      const response = await mockedAxios.delete(
        'http://localhost:3001/api/agent-mode/new-chat-hero-greeting',
        { headers: { Authorization: 'Bearer test-token' } }
      );
      setNamedTemplate(response.data.namedTemplate);
      setAnonymousText(response.data.anonymousText);
      setSuccess('Reset New Chat greeting to default.');
    } catch {
      setError('Failed to reset New Chat greeting');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <input
        aria-label="Named greeting"
        value={namedTemplate}
        onChange={(e) => setNamedTemplate(e.target.value)}
        maxLength={120}
      />
      <input
        aria-label="Anonymous greeting"
        value={anonymousText}
        onChange={(e) => setAnonymousText(e.target.value)}
        maxLength={120}
      />
      <div data-testid="new-chat-greeting-named-preview">
        Named (e.g. Harsha): {namedTemplate.split('{firstName}').join('Harsha')}
      </div>
      <div data-testid="new-chat-greeting-anonymous-preview">Anonymous: {anonymousText}</div>
      <button onClick={save} disabled={saving}>Save Changes</button>
      <button onClick={reset} disabled={saving}>Reset to Default</button>
      {error && <div role="alert">{error}</div>}
      {success && <div>{success}</div>}
    </div>
  );
};

describe('AdminDashboard - New Chat hero greeting', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders a named preview interpolating {firstName} as Harsha', () => {
    render(<NewChatHeroGreetingCard />);
    expect(screen.getByTestId('new-chat-greeting-named-preview')).toHaveTextContent(
      "Named (e.g. Harsha): Hey Harsha! Let's get after it"
    );
  });

  it('renders an anonymous preview with no name substitution', () => {
    render(<NewChatHeroGreetingCard />);
    expect(screen.getByTestId('new-chat-greeting-anonymous-preview')).toHaveTextContent(
      "Anonymous: Hey! Let's get after it"
    );
  });

  it('updates both previews independently as each field is edited', () => {
    render(<NewChatHeroGreetingCard />);
    fireEvent.change(screen.getByLabelText('Named greeting'), {
      target: { value: 'Welcome back, {firstName}!' },
    });
    fireEvent.change(screen.getByLabelText('Anonymous greeting'), {
      target: { value: 'Welcome back!' },
    });
    expect(screen.getByTestId('new-chat-greeting-named-preview')).toHaveTextContent(
      'Named (e.g. Harsha): Welcome back, Harsha!'
    );
    expect(screen.getByTestId('new-chat-greeting-anonymous-preview')).toHaveTextContent(
      'Anonymous: Welcome back!'
    );
  });

  it('renders previews as ordinary React text, never as raw HTML', () => {
    render(<NewChatHeroGreetingCard />);
    fireEvent.change(screen.getByLabelText('Named greeting'), {
      target: { value: '<b>Hey {firstName}</b>' },
    });
    // The literal tag text is shown verbatim, not parsed as an <b> element.
    expect(screen.getByTestId('new-chat-greeting-named-preview').innerHTML).toContain('&lt;b&gt;');
    expect(screen.queryByRole('strong')).not.toBeInTheDocument();
  });

  it('saves via the dedicated PUT endpoint with both fields and updates state from the response', async () => {
    mockedAxios.put.mockResolvedValueOnce({
      data: { namedTemplate: 'Hi {firstName}!', anonymousText: 'Hi!' },
      status: 200,
    });
    render(<NewChatHeroGreetingCard />);
    fireEvent.click(screen.getByText('Save Changes'));

    await waitFor(() => expect(screen.getByText('New Chat greeting updated successfully!')).toBeInTheDocument());
    expect(mockedAxios.put).toHaveBeenCalledWith(
      expect.stringContaining('/api/agent-mode/new-chat-hero-greeting'),
      { namedTemplate: "Hey {firstName}! Let's get after it", anonymousText: "Hey! Let's get after it" },
      expect.objectContaining({ headers: { Authorization: 'Bearer test-token' } })
    );
    expect(screen.getByTestId('new-chat-greeting-named-preview')).toHaveTextContent('Hi Harsha!');
  });

  it('shows the server validation error on a 400 save response and does not clear the fields', async () => {
    mockedAxios.put.mockRejectedValueOnce({
      response: { status: 400, data: { error: 'Named greeting template must contain exactly one {firstName} token' } },
    });
    render(<NewChatHeroGreetingCard />);
    fireEvent.click(screen.getByText('Save Changes'));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Named greeting template must contain exactly one {firstName} token')
    );
    expect(screen.getByLabelText('Named greeting')).toHaveValue("Hey {firstName}! Let's get after it");
  });

  it('resets via the dedicated DELETE endpoint and repopulates both fields from the response', async () => {
    mockedAxios.delete.mockResolvedValueOnce({
      data: { namedTemplate: "Hey {firstName}! Let's get after it", anonymousText: "Hey! Let's get after it" },
      status: 200,
    });
    render(<NewChatHeroGreetingCard />);
    fireEvent.change(screen.getByLabelText('Named greeting'), { target: { value: 'Something custom {firstName}' } });
    fireEvent.click(screen.getByText('Reset to Default'));

    await waitFor(() => expect(screen.getByText('Reset New Chat greeting to default.')).toBeInTheDocument());
    expect(mockedAxios.delete).toHaveBeenCalledWith(
      expect.stringContaining('/api/agent-mode/new-chat-hero-greeting'),
      expect.objectContaining({ headers: { Authorization: 'Bearer test-token' } })
    );
    expect(screen.getByLabelText('Named greeting')).toHaveValue("Hey {firstName}! Let's get after it");
  });

  it('shows a fixed error message on a reset failure', async () => {
    mockedAxios.delete.mockRejectedValueOnce(new Error('network error'));
    render(<NewChatHeroGreetingCard />);
    fireEvent.click(screen.getByText('Reset to Default'));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Failed to reset New Chat greeting'));
  });

  it('never calls the legacy welcome-message or system-prompt endpoints', async () => {
    mockedAxios.put.mockResolvedValueOnce({
      data: { namedTemplate: "Hey {firstName}! Let's get after it", anonymousText: "Hey! Let's get after it" },
      status: 200,
    });
    render(<NewChatHeroGreetingCard />);
    fireEvent.click(screen.getByText('Save Changes'));
    await waitFor(() => expect(mockedAxios.put).toHaveBeenCalledTimes(1));

    const [calledUrl] = mockedAxios.put.mock.calls[0];
    expect(calledUrl).not.toContain('welcome-message');
    expect(calledUrl).not.toContain('system-prompt');
  });
});
