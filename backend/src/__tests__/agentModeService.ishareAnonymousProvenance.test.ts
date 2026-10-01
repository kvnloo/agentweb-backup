import { AgentModeService } from '../services/agentModeService';
import { ChatMessage } from '../services/chatbotService';

// ENG-2227: metadata.ishareSender.isAnonymous was stored on a message submitted via an
// ishare link (agentModeController.ts) but never surfaced into what buildMarketingContext
// hands to the LLM — an anonymous claim read identically to one from the verified account
// owner, on every turn it was replayed into context. Pin that the provenance marker is
// folded into content the same way attachments are, and that it survives into a LATER
// turn's reconstruction (not just the turn the message arrived in).

jest.mock('../services/db', () => ({
  getSession: jest.fn(),
  saveMessage: jest.fn(),
  updateSession: jest.fn(),
  getTask: jest.fn(),
  getTaskExecution: jest.fn(),
  getUserById: jest.fn(),
  taskTemplateDb: {
    listTemplates: jest.fn().mockResolvedValue([]),
  },
}));

jest.mock('aws-sdk');
jest.mock('../services/chatbotService');
jest.mock('../services/settingsService');
jest.mock('../utils/secretsManager');

describe('AgentModeService - buildMarketingContext with anonymous ishare provenance', () => {
  let agentModeService: AgentModeService;

  beforeEach(() => {
    agentModeService = new AgentModeService();
    jest.clearAllMocks();
  });

  it('folds the anonymous-sender marker into a message tagged metadata.ishareSender.isAnonymous', () => {
    const sessionHistory: ChatMessage[] = [
      { role: 'system', content: 'You are a helpful assistant', timestamp: '2026-09-29T16:10:00.000Z' },
      {
        role: 'user',
        content: 'yes, we have contacted them, they made the call by mistake',
        timestamp: '2026-09-29T16:11:06.846Z',
        metadata: {
          portalType: 'agent' as const,
          timestamp: '2026-09-29T16:11:06.846Z',
          ishareSender: { isAnonymous: true, ip: '99.44.170.196' },
        } as any,
      },
    ];

    const result = (agentModeService as any).buildMarketingContext(
      'a later, unrelated message',
      sessionHistory,
      []
    );

    const taggedMessage = result.find(
      (msg: any) => msg.role === 'user' && msg.content.includes('they made the call by mistake')
    );
    expect(taggedMessage).toBeDefined();
    expect(taggedMessage.content).toContain(
      '[Sent by an anonymous viewer via a shared link — not a verified account owner]'
    );
  });

  it('does NOT tag a message from a normal (non-ishare) session', () => {
    const sessionHistory: ChatMessage[] = [
      { role: 'system', content: 'You are a helpful assistant', timestamp: '2026-09-29T16:10:00.000Z' },
      {
        role: 'user',
        content: 'how many leads came from Google',
        timestamp: '2026-09-29T16:11:00.000Z',
        metadata: { portalType: 'agent' as const, timestamp: '2026-09-29T16:11:00.000Z' },
      },
    ];

    const result = (agentModeService as any).buildMarketingContext(
      'a later, unrelated message',
      sessionHistory,
      []
    );

    const message = result.find((msg: any) => msg.role === 'user' && msg.content.includes('how many leads'));
    expect(message).toBeDefined();
    expect(message.content).not.toContain('anonymous viewer');
  });

  it('survives into a LATER turn reconstruction, not just the turn the message arrived in', () => {
    // The anonymous message is now several turns back in history — buildMarketingContext
    // re-derives the full LLM-bound array fresh on every call, so the marker must still
    // be present when a much later turn replays this same history.
    const sessionHistory: ChatMessage[] = [
      { role: 'system', content: 'You are a helpful assistant', timestamp: '2026-09-29T16:00:00.000Z' },
      {
        role: 'user',
        content: 'they made the call by mistake',
        timestamp: '2026-09-29T16:11:06.846Z',
        metadata: {
          portalType: 'agent' as const,
          timestamp: '2026-09-29T16:11:06.846Z',
          ishareSender: { isAnonymous: true, ip: '99.44.170.196' },
        } as any,
      },
      { role: 'assistant', content: 'Understood, noted.', timestamp: '2026-09-29T16:11:10.000Z' },
      { role: 'user', content: 'what about the other leads?', timestamp: '2026-09-29T16:19:00.000Z' },
      { role: 'assistant', content: 'They remain active.', timestamp: '2026-09-29T16:19:05.000Z' },
    ];

    const result = (agentModeService as any).buildMarketingContext(
      'a much later follow-up question',
      sessionHistory,
      []
    );

    const taggedMessage = result.find(
      (msg: any) => msg.role === 'user' && msg.content.includes('they made the call by mistake')
    );
    expect(taggedMessage).toBeDefined();
    expect(taggedMessage.content).toContain('[Sent by an anonymous viewer via a shared link');
  });
});
