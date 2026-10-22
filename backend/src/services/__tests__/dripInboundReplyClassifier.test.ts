import { classifyInboundReply, stripQuotedText } from '../dripInboundReplyClassifier';

const human = { from: 'Lead <lead@acme.com>', subject: 'Re: Quick question', bodyText: 'Yes, let us talk Tuesday.' };

describe('classifyInboundReply (ENG-2539)', () => {
  it('plain human reply exits the sequence', () => {
    expect(classifyInboundReply(human)).toEqual({ kind: 'human_reply', shouldExitSequence: true, reasons: ['human_body'] });
  });

  it.each(['auto-replied', 'auto-generated', 'Auto-Notified'])('Auto-Submitted: %s => auto_reply', (v) => {
    const r = classifyInboundReply({ ...human, headers: { 'Auto-Submitted': v } });
    expect(r.kind).toBe('auto_reply');
    expect(r.shouldExitSequence).toBe(false);
    expect(r.reasons).toContain('auto_submitted');
  });

  it('Auto-Submitted: no is treated as human', () => {
    expect(classifyInboundReply({ ...human, headers: { 'auto-submitted': 'no' } }).kind).toBe('human_reply');
  });

  it('X-Autoreply, Precedence and X-Auto-Response-Suppress are auto_reply', () => {
    expect(classifyInboundReply({ ...human, headers: { 'X-Autoreply': 'yes' } }).reasons).toEqual(['x_autoreply']);
    expect(classifyInboundReply({ ...human, headers: { Precedence: 'bulk' } }).reasons).toEqual(['precedence']);
    expect(classifyInboundReply({ ...human, headers: { 'X-Auto-Response-Suppress': 'All' } }).reasons).toEqual([
      'x_auto_response_suppress',
    ]);
    expect(classifyInboundReply({ ...human, headers: { Precedence: 'first-class' } }).kind).toBe('human_reply');
  });

  it('delivery-status report => bounce', () => {
    const r = classifyInboundReply({
      ...human,
      headers: { 'Content-Type': 'multipart/report; report-type=delivery-status; boundary="x"' },
    });
    expect(r).toEqual({ kind: 'bounce', shouldExitSequence: false, reasons: ['content_type_delivery_status'] });
  });

  it.each(['MAILER-DAEMON@mx.google.com', 'Mail Delivery System <postmaster@acme.com>'])('daemon sender %s => bounce', (from) => {
    expect(classifyInboundReply({ ...human, from }).kind).toBe('bounce');
  });

  it.each([
    'Out of Office: Re: Quick question',
    'Automatic reply: Quick question',
    'Autoreply: Quick question',
    'Abwesenheitsnotiz: Quick question',
    'Réponse automatique : Quick question',
    'Fuera de la oficina',
  ])('OOO subject %s => out_of_office', (subject) => {
    const r = classifyInboundReply({ ...human, subject });
    expect(r.kind).toBe('out_of_office');
    expect(r.shouldExitSequence).toBe(false);
  });

  it('OOO body with neutral subject => out_of_office', () => {
    const r = classifyInboundReply({ ...human, bodyText: 'I am out of the office until Monday with limited access.' });
    expect(r).toEqual({ kind: 'out_of_office', shouldExitSequence: false, reasons: ['ooo_body'] });
  });

  it('OOO phrase only inside quoted history does not count', () => {
    const r = classifyInboundReply({ ...human, bodyText: 'Sounds good.\n\n> I will be out of office next week' });
    expect(r.kind).toBe('human_reply');
  });

  it('empty and quoted-only bodies => unknown, no exit', () => {
    expect(classifyInboundReply({ ...human, bodyText: '   ' })).toEqual({
      kind: 'unknown',
      shouldExitSequence: false,
      reasons: ['empty_body'],
    });
    expect(classifyInboundReply({ ...human, bodyText: 'On Mon, Oct 5, 2026 Emma wrote:\n> hi there' }).reasons).toEqual([
      'quoted_only',
    ]);
    expect(classifyInboundReply({}).kind).toBe('unknown');
  });

  describe('precedence: headers beat body', () => {
    it('auto-reply header wins over a human-looking body', () => {
      expect(classifyInboundReply({ ...human, headers: { 'Auto-Submitted': 'auto-replied' } }).kind).toBe('auto_reply');
    });
    it('auto-reply header wins over OOO subject', () => {
      expect(
        classifyInboundReply({ ...human, subject: 'Out of office', headers: { 'Auto-Submitted': 'auto-replied' } }).kind,
      ).toBe('auto_reply');
    });
    it('bounce wins over auto-reply header', () => {
      const r = classifyInboundReply({
        from: 'MAILER-DAEMON@mx.example',
        headers: { 'Auto-Submitted': 'auto-replied' },
        bodyText: 'Delivery failed',
      });
      expect(r.kind).toBe('bounce');
    });
    it('array header values are handled', () => {
      expect(classifyInboundReply({ ...human, headers: { 'Auto-Submitted': ['auto-replied'] } }).kind).toBe('auto_reply');
    });
  });

  it('stripQuotedText drops Original Message tail', () => {
    expect(stripQuotedText('ok\n-----Original Message-----\nFrom: x')).toBe('ok');
  });

  describe('ambiguous absence phrases (CodeRabbit #3598)', () => {
    it.each([
      'I was on vacation last week, but yes let us talk Tuesday.',
      'I will be out of office Friday; Monday works.',
      '我不在意价格，我们谈谈吧',
      '不在乎，周二可以',
    ])('human body %s stays human_reply', (bodyText) => {
      expect(classifyInboundReply({ ...human, bodyText }).kind).toBe('human_reply');
    });
    it('ambiguous phrase in subject is still OOO', () => {
      expect(classifyInboundReply({ ...human, subject: 'Out of Office: back Monday', bodyText: 'Back Monday.' }).kind).toBe('out_of_office');
    });
    it.each(['I am currently out of the office until Monday.', '这是自动回复', '自動返信: 不在です'])('strong body marker %s => OOO', (bodyText) => {
      expect(classifyInboundReply({ ...human, bodyText }).kind).toBe('out_of_office');
    });
  });
});
