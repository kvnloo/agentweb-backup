import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('axios', () => ({
  get: jest.fn().mockResolvedValue({ data: [] }),
  post: jest.fn().mockResolvedValue({
    data: {
      sessionId: 'session-1',
      userId: 'user-1',
      messages: [],
      createdAt: '2026-08-10T00:00:00.000Z',
      updatedAt: '2026-08-10T00:00:00.000Z',
    },
  }),
}));

jest.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ token: 'test-token', user: { userId: 'user-1' } }),
}));

jest.mock('react-router-dom', () => ({
  useLocation: () => ({ pathname: '/tasks' }),
}));

const socket = {
  on: jest.fn(),
  emit: jest.fn(),
  disconnect: jest.fn(),
  connected: false,
};

jest.mock('socket.io-client', () => ({
  io: () => socket,
}));

jest.mock('chart.js/auto', () => ({
  Chart: Object.assign(jest.fn(), { getChart: jest.fn() }),
}));

jest.mock('../../config', () => ({
  API_URL: 'http://localhost:3001',
  DISCORD_INVITE_URL: 'https://example.com/discord',
}));

import ChatSupport from '../ChatSupport';
import axios from 'axios';

const preferenceKey = 'agentweb.chatDisplay.v1.user-1';
const mockedAxiosGet = axios.get as jest.Mock;

async function openChat() {
  render(<ChatSupport />);
  fireEvent.click(screen.getByRole('button', { name: 'Open support chat' }));
  const heading = screen.getByText('AgentWeb Support');
  await waitFor(() => expect(screen.queryByRole('progressbar')).not.toBeInTheDocument());
  return heading;
}

describe('ChatSupport display preferences', () => {
  beforeEach(() => {
    localStorage.clear();
    jest.clearAllMocks();
    Element.prototype.scrollIntoView = jest.fn();
  });

  it('preserves the existing open-chat behavior', async () => {
    expect(await openChat()).toBeInTheDocument();
  });

  it('toggles a viewport-safe wide panel and persists it for this user', async () => {
    await openChat();

    fireEvent.click(screen.getByRole('button', { name: 'Use wide chat' }));

    expect(screen.getByTestId('chat-support-panel')).toHaveAttribute('data-chat-width', 'wide');
    expect(JSON.parse(localStorage.getItem(preferenceKey) || '{}')).toMatchObject({ width: 'wide' });
    expect(screen.getByRole('button', { name: 'Use default chat width' })).toBeInTheDocument();
  });

  it('changes only message text to compact size and persists the choice', async () => {
    await openChat();

    fireEvent.click(screen.getByRole('button', { name: 'Chat display settings' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Small text' }));

    expect(screen.getByTestId('chat-messages')).toHaveAttribute('data-chat-font-size', 'small');
    expect(JSON.parse(localStorage.getItem(preferenceKey) || '{}')).toMatchObject({ fontSize: 'small' });
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
  });

  it('restores this user\'s saved width and font size on the next mount', async () => {
    localStorage.setItem(preferenceKey, JSON.stringify({ width: 'wide', fontSize: 'small' }));

    await openChat();

    expect(screen.getByTestId('chat-support-panel')).toHaveAttribute('data-chat-width', 'wide');
    expect(screen.getByTestId('chat-messages')).toHaveAttribute('data-chat-font-size', 'small');
  });

  it('keeps wide assistant tables inline with their own horizontal scroll', async () => {
    mockedAxiosGet.mockResolvedValueOnce({
      data: [{
        sessionId: 'session-with-table',
        userId: 'user-1',
        messages: [{
          role: 'assistant',
          content: '<table><tbody><tr><td>Keyword</td><td>Recommendation</td></tr></tbody></table>',
        }],
        createdAt: '2026-08-10T00:00:00.000Z',
        updatedAt: '2026-08-10T00:00:00.000Z',
      }],
    });

    await openChat();

    const table = await screen.findByRole('table');
    const messageContent = screen.getByTestId('chat-message-content-0');
    expect(getComputedStyle(messageContent).overflowX).toBe('hidden');
    expect(getComputedStyle(table).display).toBe('block');
    expect(getComputedStyle(table).overflowX).toBe('auto');
    expect(getComputedStyle(table.querySelector('td') as HTMLElement).whiteSpace).toBe('nowrap');
  });
});
