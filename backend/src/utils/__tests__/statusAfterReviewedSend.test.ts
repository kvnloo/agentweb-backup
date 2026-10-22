import { statusAfterReviewedSend } from '../../utils/leadSchema';

// Reproduced production regression: a lead sent manually from the lead panel stayed in Pending Review.
describe('statusAfterReviewedSend', () => {
  it('moves a pending_review lead to contacted by default', () => {
    expect(statusAfterReviewedSend('pending_review', undefined)).toBe('contacted');
  });
  it('uses the first active working status when the list has no contacted status', () => {
    expect(statusAfterReviewedSend('pending_review', [
      { value: 'pending_review', type: 'active' }, { value: 'won', type: 'won' }, { value: 'reached_out', type: 'active' },
    ])).toBe('reached_out');
  });
  it('leaves leads that are not in review untouched', () => {
    expect(statusAfterReviewedSend('qualified', undefined)).toBeNull();
    expect(statusAfterReviewedSend(undefined, undefined)).toBeNull();
  });
});
