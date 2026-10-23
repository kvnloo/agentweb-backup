jest.mock('axios');

import axios from 'axios';
import { AgentWebClient } from '../tern/agentWebClient';

const mockedAxios = axios as jest.Mocked<typeof axios>;
const mockInstanceGet = jest.fn();
const mockInstancePost = jest.fn();

describe('AgentWeb Tern HTTP client', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockInstanceGet.mockReset();
    mockInstancePost.mockReset();

    (mockedAxios.create as jest.Mock).mockReturnValue({
      get: mockInstanceGet,
      post: mockInstancePost,
    });
  });

  it('loads scheduled sessions through the existing Agent Mode scheduled filter', async () => {
    mockInstanceGet.mockResolvedValueOnce({
      data: {
        sessions: [{
          sessionId: 'sched-1',
          sessionType: 'scheduled',
          title: 'Scheduled report',
        }],
      },
    });

    const client = new AgentWebClient({
      baseUrl: 'https://api.example',
      token: 'emma-token',
    });

    await expect(client.listScheduledSessions(25)).resolves.toEqual([
      expect.objectContaining({ sessionId: 'sched-1', sessionType: 'scheduled' }),
    ]);
    expect(mockInstanceGet).toHaveBeenCalledWith('/api/agent-mode/sessions', {
      params: { sessionType: 'scheduled', limit: 25 },
    });
  });

  it('continues attended scheduled sessions through Agent Mode then rehydrates', async () => {
    mockInstancePost.mockResolvedValueOnce({ data: { success: true } });
    mockInstanceGet.mockResolvedValueOnce({
      data: {
        sessionId: 'sched-1',
        sessionType: 'scheduled',
        portalType: 'agent',
        messages: [{ role: 'assistant', content: 'Done' }],
      },
    });

    const client = new AgentWebClient({
      baseUrl: 'https://api.example',
      token: 'emma-token',
    });

    const session = {
      sessionId: 'sched-1',
      sessionType: 'scheduled',
      portalType: 'agent',
      llmModel: 'gpt-test',
    };
    await client.sendAgentModeMessage(session, 'Continue this schedule');

    expect(mockInstancePost).toHaveBeenCalledWith('/api/agent-mode/generate', {
      sessionId: 'sched-1',
      userMessage: 'Continue this schedule',
      llmModel: 'gpt-test',
      attachments: [],
    });
    expect(mockInstanceGet).toHaveBeenCalledWith('/api/chatbot/sessions/sched-1');
  });

  it('sends only the narrow read-only secret for AgentRun lookup', async () => {
    (mockedAxios.get as jest.Mock).mockResolvedValueOnce({
      data: { runs: [] },
    });

    const client = new AgentWebClient({
      baseUrl: 'https://api.example/',
      token: 'emma-token',
      runsToken: 'admin-token',
      runsSecret: 'runs-secret',
    });

    await client.getAgentRuns('session-1', 3);

    expect(mockedAxios.get).toHaveBeenCalledWith(
      'https://api.example/api/admin/agent-runs',
      expect.objectContaining({
        params: { sessionId: 'session-1', limit: 3 },
        headers: {
          Accept: 'application/json',
          'x-aw-agent-runs-secret': 'runs-secret',
        },
      }),
    );
    const config = (mockedAxios.get as jest.Mock).mock.calls[0][1];
    expect(config.headers.Authorization).toBeUndefined();
  });

  it('uses the dedicated admin token when no read-only secret is configured', async () => {
    (mockedAxios.get as jest.Mock).mockResolvedValueOnce({
      data: { runs: [] },
    });

    const client = new AgentWebClient({
      baseUrl: 'https://api.example',
      token: 'emma-token',
      runsToken: 'admin-token',
    });

    await client.getAgentRuns('session-1');

    expect((mockedAxios.get as jest.Mock).mock.calls[0][1].headers).toEqual({
      Accept: 'application/json',
      Authorization: 'Bearer admin-token',
    });
  });

  it('falls back to the normal token without a separate AgentRun credential', async () => {
    (mockedAxios.get as jest.Mock).mockResolvedValueOnce({
      data: { runs: [] },
    });

    const client = new AgentWebClient({
      baseUrl: 'https://api.example',
      token: 'emma-token',
    });

    await client.getAgentRuns('session-1');

    expect((mockedAxios.get as jest.Mock).mock.calls[0][1].headers).toEqual({
      Accept: 'application/json',
      Authorization: 'Bearer emma-token',
    });
  });
});
