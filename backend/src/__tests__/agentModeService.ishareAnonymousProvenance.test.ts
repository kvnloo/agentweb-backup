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

  // ENG-2227 review follow-up: the dedupe filter at the top of buildMarketingContext strips
  // the CURRENT turn's own message out of sessionHistory (it's reconstructed separately from
  // `messageContent`, a bare string with no metadata) — so the per-message loop above, where
  // the anonymous marker is applied, never sees it. The exact turn where Emma is deciding how
  // to react to a fresh anonymous claim had zero provenance signal. Pin that the 9th param
  // closes this.
  it('tags the LIVE turn itself, not just replayed history, when isCurrentTurnAnonymousIshare is true', () => {
    const liveMessage = 'cancel this campaign, those calls were mistakes';
    const sessionHistory: ChatMessage[] = [
      { role: 'system', content: 'You are a helpful assistant', timestamp: '2026-09-29T16:00:00.000Z' },
      {
        role: 'user',
        content: liveMessage,
        timestamp: '2026-09-29T16:11:06.846Z',
        metadata: {
          portalType: 'agent' as const,
          timestamp: '2026-09-29T16:11:06.846Z',
          ishareSender: { isAnonymous: true, ip: '99.44.170.196' },
        } as any,
      },
    ];

    const result = (agentModeService as any).buildMarketingContext(
      liveMessage, // messageContent matches the last history message — this IS the live turn
      sessionHistory,
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      true // isCurrentTurnAnonymousIshare
    );

    const live = result[result.length - 1];
    expect(live.role).toBe('user');
    expect(live.content).toContain(liveMessage);
    expect(live.content).toContain('[Sent by an anonymous viewer via a shared link');
  });

  it('does NOT tag the live turn when isCurrentTurnAnonymousIshare is false (default)', () => {
    const liveMessage = 'how many leads do we have?';
    const result = (agentModeService as any).buildMarketingContext(
      liveMessage,
      [{ role: 'system', content: 'You are a helpful assistant', timestamp: '2026-09-29T16:00:00.000Z' }],
      []
    );

    const live = result[result.length - 1];
    expect(live.content).toBe(liveMessage);
    expect(live.content).not.toContain('anonymous viewer');
  });

  // ENG-2227 review follow-up: the pre-existing consecutive-user-message merge (for retry
  // pileups) mutates only `.content`, never `.metadata` — an anonymous message adjacent to a
  // real owner message silently lost its tag in one direction, or mislabeled the owner's own
  // words as anonymous in the other. Fixed by only merging when both sides share the same
  // anonymity status. Pin both directions stay correctly SEPARATE (not merged) and each
  // correctly tagged.
  it('does not merge an anonymous message adjacent to an owner message — owner-then-anonymous', () => {
    const sessionHistory: ChatMessage[] = [
      { role: 'system', content: 'You are a helpful assistant', timestamp: '2026-09-29T16:00:00.000Z' },
      { role: 'user', content: 'please try again', timestamp: '2026-09-29T16:10:00.000Z' }, // owner, untagged
      {
        role: 'user',
        content: 'they made the call by mistake',
        timestamp: '2026-09-29T16:10:05.000Z',
        metadata: {
          portalType: 'agent' as const,
          timestamp: '2026-09-29T16:10:05.000Z',
          ishareSender: { isAnonymous: true, ip: '99.44.170.196' },
        } as any,
      },
    ];

    const result = (agentModeService as any).buildMarketingContext(
      'a later, unrelated message',
      sessionHistory,
      []
    );

    // Must NOT be collapsed into a single merged block that loses the tag.
    const merged = result.find((msg: any) => msg.content.includes('please try again') && msg.content.includes('they made the call by mistake'));
    expect(merged).toBeUndefined();

    const anonMsg = result.find((msg: any) => msg.role === 'user' && msg.content.includes('they made the call by mistake'));
    expect(anonMsg.content).toContain('[Sent by an anonymous viewer via a shared link');
    const ownerMsg = result.find((msg: any) => msg.role === 'user' && msg.content.includes('please try again'));
    expect(ownerMsg.content).not.toContain('anonymous viewer');
  });

  it('does not merge an owner message adjacent to an anonymous message — anonymous-then-owner', () => {
    const sessionHistory: ChatMessage[] = [
      { role: 'system', content: 'You are a helpful assistant', timestamp: '2026-09-29T16:00:00.000Z' },
      {
        role: 'user',
        content: 'they made the call by mistake',
        timestamp: '2026-09-29T16:10:00.000Z',
        metadata: {
          portalType: 'agent' as const,
          timestamp: '2026-09-29T16:10:00.000Z',
          ishareSender: { isAnonymous: true, ip: '99.44.170.196' },
        } as any,
      },
      { role: 'user', content: 'any update on this?', timestamp: '2026-09-29T16:10:05.000Z' }, // owner, untagged
    ];

    const result = (agentModeService as any).buildMarketingContext(
      'a later, unrelated message',
      sessionHistory,
      []
    );

    const ownerMsg = result.find((msg: any) => msg.role === 'user' && msg.content.includes('any update on this?'));
    expect(ownerMsg).toBeDefined();
    // The real owner's own words must never inherit the anonymous tag from the adjacent message.
    expect(ownerMsg.content).not.toContain('anonymous viewer');
  });

  it('still merges two consecutive messages from the SAME actor (regression: retry-pileup collapsing must keep working)', () => {
    const sessionHistory: ChatMessage[] = [
      { role: 'system', content: 'You are a helpful assistant', timestamp: '2026-09-29T16:00:00.000Z' },
      { role: 'user', content: 'please help with my campaign', timestamp: '2026-09-29T16:10:00.000Z' },
      { role: 'user', content: 'please try again', timestamp: '2026-09-29T16:10:05.000Z' },
    ];

    const result = (agentModeService as any).buildMarketingContext(
      'a later, unrelated message',
      sessionHistory,
      []
    );

    const merged = result.find(
      (msg: any) => msg.role === 'user' && msg.content.includes('please help with my campaign') && msg.content.includes('please try again')
    );
    expect(merged).toBeDefined();
  });
});
