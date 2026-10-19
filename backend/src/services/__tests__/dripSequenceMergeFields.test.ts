import { renderDripTemplate } from '../dripSequenceMergeFields';

const contact = { first_name: 'Ana', company: 'Haven & Co <HQ>', last_name: '  ' };

describe('renderDripTemplate (ENG-2535)', () => {
  it('substitutes known fields and uses inline fallback for missing/blank', () => {
    const r = renderDripTemplate(
      { subject: 'Hi {{first_name}}', html: '<p>{{ last_name | friend }}</p>', text: 'Hey {{title|there}}' },
      contact,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.subject).toBe('Hi Ana');
    expect(r.html).toBe('<p>friend</p>');
    expect(r.text).toBe('Hey there');
    expect(r.missingFields).toEqual([]);
  });

  it('HTML-escapes values in html only; raw in text and subject', () => {
    const r = renderDripTemplate(
      { subject: '{{company}}', html: '<b>{{company}}</b>', text: '{{company}}' },
      contact,
    );
    if (!r.ok) throw new Error('expected ok');
    expect(r.html).toBe('<b>Haven &amp; Co &lt;HQ&gt;</b>');
    expect(r.text).toBe('Haven & Co <HQ>');
    expect(r.subject).toBe('Haven & Co <HQ>');
  });

  it('escapes fallback text in html too', () => {
    const r = renderDripTemplate({ subject: '', html: '{{x|<i>}}', text: '' }, {});
    if (!r.ok) throw new Error('expected ok');
    expect(r.html).toBe('&lt;i&gt;');
  });

  it('strips CR/LF from subject to prevent header injection', () => {
    const r = renderDripTemplate(
      { subject: 'Hi {{first_name}}', html: '', text: '{{first_name}}' },
      { first_name: 'Ana\r\nBcc: evil@x.com' },
    );
    if (!r.ok) throw new Error('expected ok');
    expect(r.subject).toBe('Hi Ana Bcc: evil@x.com');
    expect(r.subject).not.toMatch(/[\r\n]/);
    expect(r.text).toBe('Ana\r\nBcc: evil@x.com');
  });

  it('reports missing fields (deduped) and renders them empty in lenient mode', () => {
    const r = renderDripTemplate(
      { subject: 'Hi {{nickname}}', html: '{{nickname}} {{last_name}}', text: '' },
      contact,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.missingFields).toEqual(['nickname', 'last_name']);
    expect(r.subject).toBe('Hi ');
  });

  it('strict mode returns an error instead of rendering', () => {
    const r = renderDripTemplate(
      { subject: 'Hi {{first_name}}', html: '', text: '' },
      {},
      { mode: 'strict' },
    );
    expect(r).toEqual({ ok: false, error: 'missing_merge_fields', missingFields: ['first_name'] });
  });

  it('strict mode renders when every field resolves', () => {
    const r = renderDripTemplate({ subject: '{{first_name}}', html: '', text: '' }, contact, { mode: 'strict' });
    expect(r.ok).toBe(true);
  });

  it('passes through text with no tokens unchanged', () => {
    const t = { subject: 'Plain {subject}', html: '<p>{ not a token }</p>', text: 'nothing here' };
    const r = renderDripTemplate(t, contact);
    expect(r).toEqual({ ok: true, ...t, missingFields: [] });
  });

  it('stringifies numeric values', () => {
    const r = renderDripTemplate({ subject: '{{seats}}', html: '', text: '' }, { seats: 3 });
    if (!r.ok) throw new Error('expected ok');
    expect(r.subject).toBe('3');
  });
});
