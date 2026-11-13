/**
 * ENG-2966: a lead may only enter the AI-draft review status (pending_review) when a
 * draft is actually persisted on it — otherwise the Pending Review queue lists a lead
 * with nothing to approve.
 */
import { hasPersistedDraftForChannel, missingReviewDraftError, REVIEW_DRAFT_STATUS } from '../utils/leadSchema';

const email = { subject: 'Hi', textContent: 'Body', createdAt: 'x', updatedAt: 'x' };
const message = { content: 'Hola', createdAt: 'x', updatedAt: 'x' };

describe('hasPersistedDraftForChannel (ENG-2966)', () => {
  it('email: needs a non-empty subject AND a non-empty text or html body', () => {
    expect(hasPersistedDraftForChannel({ emailDraft: email }, 'email')).toBe(true);
    expect(hasPersistedDraftForChannel({ emailDraft: { subject: 'Hi', htmlContent: '<p>b</p>' } }, 'email')).toBe(true);
    expect(hasPersistedDraftForChannel({ emailDraft: { subject: '  ', textContent: 'Body' } }, 'email')).toBe(false);
    expect(hasPersistedDraftForChannel({ emailDraft: { subject: 'Hi', textContent: '   ' } }, 'email')).toBe(false);
    expect(hasPersistedDraftForChannel({ emailDraft: null }, 'email')).toBe(false);
    expect(hasPersistedDraftForChannel({ messageDraft: message }, 'email')).toBe(false);
  });

  it('linkedin: needs a non-empty messageDraft.content', () => {
    expect(hasPersistedDraftForChannel({ messageDraft: message }, 'linkedin')).toBe(true);
    expect(hasPersistedDraftForChannel({ messageDraft: { content: '  ' } }, 'linkedin')).toBe(false);
    expect(hasPersistedDraftForChannel({ emailDraft: email }, 'linkedin')).toBe(false);
  });

  it('no channel: either channel\'s draft counts; nothing / malformed does not', () => {
    expect(hasPersistedDraftForChannel({ emailDraft: email })).toBe(true);
    expect(hasPersistedDraftForChannel({ messageDraft: message })).toBe(true);
    expect(hasPersistedDraftForChannel({})).toBe(false);
    expect(hasPersistedDraftForChannel(null)).toBe(false);
    expect(hasPersistedDraftForChannel({ emailDraft: 'str', messageDraft: 42 })).toBe(false);
  });
});

describe('missingReviewDraftError (ENG-2966)', () => {
  it('returns an error only for the review status without a draft', () => {
    expect(REVIEW_DRAFT_STATUS).toBe('pending_review');
    expect(missingReviewDraftError('pending_review', {})).toMatch(/draft/i);
    expect(missingReviewDraftError('pending_review', { messageDraft: message })).toBeNull();
    expect(missingReviewDraftError('contacted', {})).toBeNull();
    expect(missingReviewDraftError(undefined, {})).toBeNull();
  });
});
