// ENG-2816: which request a media continuation would carry on, and so which restrictions it must run under.
import { lastUserTurnWasShareVisitor } from '../utils/timeoutContinuation';

const visitor = { role: 'user', content: 'make creatives', metadata: { ishareSender: { isAnonymous: true } } };
const owner = { role: 'user', content: 'make creatives', metadata: { timestamp: '2026-11-05T10:00:00Z' } };
const synthetic = { role: 'user', content: '[automatic continuation]', metadata: { kind: 'auto-continuation' } };
const syntheticStamped = { role: 'user', content: '[automatic continuation]', metadata: { kind: 'auto-continuation', ishareSender: { isAnonymous: true } } };
const assistant = { role: 'assistant', content: '3 done' };

describe('lastUserTurnWasShareVisitor', () => {
  it('is true when the newest real user message was typed by a share-link visitor', () => {
    expect(lastUserTurnWasShareVisitor([visitor, assistant] as any)).toBe(true);
  });

  it("is false when the newest real user message was the owner's", () => {
    expect(lastUserTurnWasShareVisitor([owner, assistant] as any)).toBe(false);
  });

  it('judges by the NEWEST real user message: a visitor earlier in the chat does not taint a later owner request, and vice versa', () => {
    expect(lastUserTurnWasShareVisitor([visitor, assistant, owner, assistant] as any)).toBe(false);
    expect(lastUserTurnWasShareVisitor([owner, assistant, visitor, assistant] as any)).toBe(true);
  });

  it('skips a synthetic auto-continuation message and looks at the request it continues', () => {
    expect(lastUserTurnWasShareVisitor([visitor, assistant, synthetic, assistant] as any)).toBe(true);
    expect(lastUserTurnWasShareVisitor([owner, assistant, synthetic, assistant] as any)).toBe(false);
  });

  it('keeps a stamped continuation (a continuation of a visitor turn is flagged, so the chain holds round after round)', () => {
    expect(lastUserTurnWasShareVisitor([owner, assistant, syntheticStamped, assistant] as any)).toBe(true);
  });

  it('is false for an empty, missing or user-less history', () => {
    expect(lastUserTurnWasShareVisitor([] as any)).toBe(false);
    expect(lastUserTurnWasShareVisitor(undefined)).toBe(false);
    expect(lastUserTurnWasShareVisitor(null)).toBe(false);
    expect(lastUserTurnWasShareVisitor([assistant] as any)).toBe(false);
  });

  it('treats a message with no metadata as the owner\'s', () => {
    expect(lastUserTurnWasShareVisitor([{ role: 'user', content: 'hi' }] as any)).toBe(false);
  });
});
