import {
  WorkPlanInputRequestError,
  buildWorkPlanInputRequest,
  resolveWorkPlanInputAnswer,
} from '../workPlanInputRequest';

const request = () => buildWorkPlanInputRequest({
  requestId: 'luma-session-and-window',
  stepCount: 1,
  title: 'Event details',
  prompt: 'Add the Luma guest-list URL and the registration lookback window.',
  fields: [
    { id: 'guest_list_url', label: 'Luma guest-list URL', type: 'url', required: true },
    { id: 'lookback_days', label: 'Lookback window', type: 'number', required: true, defaultValue: 14, minimum: 1, maximum: 90 },
  ],
});

describe('WorkPlanInputRequest', () => {
  it('builds a channel-neutral, validated request with stable field order', () => {
    expect(request()).toMatchObject({
      requestId: 'luma-session-and-window',
      status: 'awaiting',
      fields: [
        { id: 'guest_list_url', type: 'url', required: true },
        { id: 'lookback_days', defaultValue: 14, minimum: 1, maximum: 90 },
      ],
    });
  });

  it('rejects an answer that omits a required field', () => {
    expect(() => resolveWorkPlanInputAnswer(request(), { lookback_days: 14 }, '2026-08-20T00:00:00.000Z'))
      .toThrow(/guest_list_url is required/);
  });

  it('rejects values that do not conform to the declared type or constraints', () => {
    expect(() => resolveWorkPlanInputAnswer(request(), {
      guest_list_url: 'not a url',
      lookback_days: 91,
    }, '2026-08-20T00:00:00.000Z')).toThrow(/guest_list_url must be a valid URL/);

    expect(() => resolveWorkPlanInputAnswer(request(), {
      guest_list_url: 'https://lu.ma/event/manage/evt-123/guests',
      lookback_days: 91,
    }, '2026-08-20T00:00:00.000Z')).toThrow(/lookback_days must be at most 90/);
  });

  it('accepts a typed answer exactly once and preserves the submitted values', () => {
    const answered = resolveWorkPlanInputAnswer(request(), {
      guest_list_url: 'https://lu.ma/event/manage/evt-123/guests',
      lookback_days: 14,
    }, '2026-08-20T00:00:00.000Z');

    expect(answered).toMatchObject({
      status: 'answered',
      answer: {
        values: {
          guest_list_url: 'https://lu.ma/event/manage/evt-123/guests',
          lookback_days: 14,
        },
      },
    });

    expect(() => resolveWorkPlanInputAnswer(answered, answered.answer!.values, '2026-08-20T00:01:00.000Z'))
      .toThrow(WorkPlanInputRequestError);
  });
});
