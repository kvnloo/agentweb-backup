import { renderDripTemplate } from '../dripSequenceMergeFields';

describe('renderDripTemplate (ENG-2535)', () => {
  it('substitutes known fields from the contact', () => {
    const r = renderDripTemplate(
      { subject: 'Hi {{first_name}}', text: '{{ company }} rocks' },
      { first_name: 'Ada', company: 'Haven' },
    );
    expect(r).toEqual({
      ok: true,
      rendered: { subject: 'Hi Ada', text: 'Haven rocks' },
      missingFields: [],
    });
  });

  it('uses inline fallback when value is missing or blank', () => {
    const r = renderDripTemplate(
      { subject: 'Hi {{first_name|there}}', text: 'At {{company|your team}}' },
      { first_name: '   ', company: null },
    );
    expect(r.ok && r.rendered).toEqual({ subject: 'Hi there', text: 'At your team' });
    expect(r.missingFields).toEqual([]);
  });

  it('HTML-escapes values in html but not in text/subject', () => {
    const contact = { first_name: '<b>A&"B\'</b>' };
    const r = renderDripTemplate(
      { subject: 'Hi {{first_name}}', html: '<p>Hi {{first_name}}</p>', text: 'Hi {{first_name}}' },
      contact,
    );
    if (!r.ok) throw new Error('expected ok');
    expect(r.rendered.html).toBe('<p>Hi &lt;b&gt;A&amp;&quot;B&#39;&lt;/b&gt;</p>');
    expect(r.rendered.text).toBe('Hi <b>A&"B\'</b>');
    expect(r.rendered.subject).toBe('Hi <b>A&"B\'</b>');
  });

  it('strips CR/LF from subject to prevent header injection', () => {
    const r = renderDripTemplate(
      { subject: 'Hi {{first_name}}', text: 'x {{first_name}}' },
      { first_name: 'Ada\r\nBcc: evil@example.com' },
    );
    if (!r.ok) throw new Error('expected ok');
    expect(r.rendered.subject).toBe('Hi Ada Bcc: evil@example.com');
    expect(r.rendered.subject).not.toMatch(/[\r\n]/);
    expect(r.rendered.text).toBe('x Ada\r\nBcc: evil@example.com');
  });

  it('reports unknown tokens and missing fields without fallback (lenient)', () => {
    const r = renderDripTemplate(
      { subject: 'Hi {{first_name}}', text: '{{favorite_color}} {{nickname|pal}}' },
      {},
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rendered.subject).toBe('Hi');
    expect(r.rendered.text).toBe('{{favorite_color}} pal');
    expect(r.missingFields).toEqual(['favorite_color', 'first_name', 'nickname']);
  });

  it('strict mode returns an error instead of rendering', () => {
    const r = renderDripTemplate({ subject: 'Hi {{first_name}}' }, {}, { mode: 'strict' });
    expect(r).toEqual({ ok: false, error: 'missing_merge_fields', missingFields: ['first_name'] });
  });

  it('strict mode renders when every token resolves', () => {
    const r = renderDripTemplate(
      { subject: 'Hi {{first_name|there}}' },
      {},
      { mode: 'strict' },
    );
    expect(r).toEqual({ ok: true, rendered: { subject: 'Hi there' }, missingFields: [] });
  });

  it('passes through templates with no tokens unchanged', () => {
    const t = { subject: 'Hello', html: '<p>a & b</p>', text: 'plain {single}' };
    const r = renderDripTemplate(t, { first_name: 'Ada' }, { mode: 'strict' });
    expect(r).toEqual({ ok: true, rendered: t, missingFields: [] });
  });

  it('honours custom knownFields', () => {
    const r = renderDripTemplate({ subject: '{{plan}}' }, { plan: 'Pro' }, { knownFields: ['plan'] });
    expect(r.ok && r.rendered.subject).toBe('Pro');
  });
});
