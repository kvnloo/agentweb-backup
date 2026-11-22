import { isNoTaskSession, judgeScoringPath } from '../services/sessionScoringService';
import { ChatMessage, ChatSession } from '../services/chatbotService';

jest.mock('../services/chatbotService', () => ({ chatbotDb: {} }));
jest.mock('../services/settingsService', () => ({ settingsService: { getSetting: jest.fn().mockResolvedValue(null) } }));

const FRESH = new Date().toISOString();
const sessionOf = (messages: ChatMessage[]): ChatSession =>
  ({ sessionId: 's1', userId: 'u1', createdAt: FRESH, updatedAt: FRESH, messages, messageCount: messages.length } as unknown as ChatSession);

const toolCallsOnly = (): ChatMessage =>
  ({ role: 'assistant', content: undefined, metadata: { toolCalls: [{ name: 'search_web' }] } } as unknown as ChatMessage);

/**
 * Message content that is absent (a tool-calls-only turn persists with no `content`) is empty
 * text. `JSON.stringify(undefined ?? "")` is the truthy two-character string `""`, which made
 * these classifiers read an absent field as real text (ENG-2409).
 */
describe('classifiers treat absent content as empty text', () => {
  it('a fresh session whose last turn is tool-calls-only with absent content is still in-flight', () => {
    const messages = [{ role: 'user', content: 'Build my ad.' } as ChatMessage, { role: 'assistant', content: 'On it.' } as ChatMessage, toolCallsOnly()];
    expect(judgeScoringPath(sessionOf(messages))).toBe('in-flight');
  });

  it('a session whose only assistant turn is empty with absent content is not a real assistant turn', () => {
    const messages = [{ role: 'user', content: 'Build my ad.' } as ChatMessage, { role: 'assistant', content: undefined } as unknown as ChatMessage];
    expect(judgeScoringPath(sessionOf(messages))).toBe('in-flight');
  });

  it('a user turn with absent content is not read as a literal "" instruction', () => {
    expect(isNoTaskSession([{ role: 'user', content: undefined } as unknown as ChatMessage, { role: 'assistant', content: 'Hi' } as ChatMessage])).toBe(
      isNoTaskSession([{ role: 'user', content: '' } as ChatMessage, { role: 'assistant', content: 'Hi' } as ChatMessage]),
    );
  });
});
