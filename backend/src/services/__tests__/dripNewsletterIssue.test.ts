import { validateNewsletterIssue, NEWSLETTER_SUBJECT_MAX } from '../dripNewsletterIssue';

const valid = () => ({
  subject: 'How to qualify inbound leads faster',
  sections: [
    { kind: 'topic', title: 'Lead scoring 101', body: '...' },
    { kind: 'customer_story', title: 'How Acme doubled demos', body: '...' },
  ],
  ctas: [{ kind: 'book_call', label: 'Grab 15 minutes', url: 'https://calendly.com/haven/intro' }],
  body: '<p>...</p><a href="{{unsubscribe_url}}">Unsubscribe</a>',
});

const errs = (x: unknown) => {
  const r = validateNewsletterIssue(x);
  return r.ok ? [] : r.errors;
};

describe('validateNewsletterIssue (ENG-2552)', () => {
  it('accepts one topic, one story, one book_call CTA, unsubscribe link', () => {
    expect(validateNewsletterIssue(valid())).toEqual({ ok: true });
  });

  it('accepts Resend unsubscribe placeholder', () => {
    expect(errs({ ...valid(), body: 'x <a href="{{{RESEND_UNSUBSCRIBE_URL}}}">Unsubscribe</a>' })).toEqual([]);
  });

  it('fails closed on invalid input', () => {
    expect(errs(null)).toEqual(['invalid_input']);
    expect(errs('x')).toEqual(['invalid_input']);
    expect(errs({ ...valid(), sections: undefined })).toEqual(['invalid_input']);
  });

  it('rejects missing or duplicate topic', () => {
    const v = valid();
    expect(errs({ ...v, sections: [v.sections[1]] })).toEqual(['topic_missing']);
    expect(errs({ ...v, sections: [v.sections[0], ...v.sections] })).toEqual(['topic_duplicate']);
  });

  it('rejects missing or duplicate customer story', () => {
    const v = valid();
    expect(errs({ ...v, sections: [v.sections[0]] })).toEqual(['customer_story_missing']);
    expect(errs({ ...v, sections: [...v.sections, v.sections[1]] })).toEqual(['customer_story_duplicate']);
  });

  it('rejects unknown section kinds', () => {
    const v = valid();
    expect(errs({ ...v, sections: [...v.sections, { kind: 'promo' }] })).toEqual(['unknown_section']);
  });

  it('requires exactly one book_call CTA with https url', () => {
    const v = valid();
    expect(errs({ ...v, ctas: [] })).toEqual(['cta_missing']);
    expect(errs({ ...v, ctas: [v.ctas[0], v.ctas[0]] })).toEqual(['cta_multiple']);
    expect(errs({ ...v, ctas: [{ kind: 'buy_now', url: 'https://x.com' }] })).toEqual(['cta_not_book_call']);
    expect(errs({ ...v, ctas: [{ kind: 'book_call', url: 'http://x.com' }] })).toEqual(['cta_url_invalid']);
    expect(errs({ ...v, ctas: [{ kind: 'book_call', url: 'not a url' }] })).toEqual(['cta_url_invalid']);
  });

  it('validates subject', () => {
    expect(errs({ ...valid(), subject: '  ' })).toEqual(['subject_missing']);
    expect(errs({ ...valid(), subject: 'a'.repeat(NEWSLETTER_SUBJECT_MAX + 1) })).toEqual(['subject_too_long']);
  });

  it('ENG-2557 rejects unsubscribe text or placeholders that are not a link', () => {
    for (const body of [
      '<p>See /unsubscribe for help</p>',
      '<p>{{unsubscribe_url}}</p>',
      'x {{{RESEND_UNSUBSCRIBE_URL}}}',
      '<a href="https://x.io/help">/unsubscribe</a>',
    ]) {
      expect(errs({ ...valid(), body })).toEqual(['unsubscribe_missing']);
    }
  });

  it('ENG-2557 accepts an https unsubscribe URL in an href', () => {
    expect(errs({ ...valid(), body: "<a class='u' href='https://x.io/unsubscribe?t=abc'>Unsub</a>" })).toEqual([]);
  });

  it('requires an unsubscribe link', () => {
    expect(errs({ ...valid(), body: '<p>no link</p>' })).toEqual(['unsubscribe_missing']);
  });
});
