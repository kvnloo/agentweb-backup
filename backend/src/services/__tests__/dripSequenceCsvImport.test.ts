import { parseEnrollmentCsv } from '../dripSequenceCsvImport';

describe('parseEnrollmentCsv (ENG-2532)', () => {
  it('AC1: maps headers case/whitespace-insensitively', () => {
    const csv = ' Email Address ,First Name,last_name,COMPANY,Tags\nA@x.com,Ann,Lee,Acme,vip\n';
    expect(parseEnrollmentCsv(csv)).toEqual({
      candidates: [
        { email: 'a@x.com', firstName: 'Ann', lastName: 'Lee', company: 'Acme', tags: ['vip'] },
      ],
      rejected: [],
      duplicates: 0,
    });
    expect(parseEnrollmentCsv('email,first_name\nb@x.com,Bo\n').candidates).toEqual([
      { email: 'b@x.com', firstName: 'Bo', tags: [] },
    ]);
  });

  it('AC1: missing email column rejects every row', () => {
    const r = parseEnrollmentCsv('name,company\nAnn,Acme\nBo,Beta\n');
    expect(r.candidates).toEqual([]);
    expect(r.rejected).toEqual([
      { row: 1, reason: 'missing_email_column' },
      { row: 2, reason: 'missing_email_column' },
    ]);
  });

  it('AC2: trims + lowercases emails and rejects invalid ones', () => {
    const r = parseEnrollmentCsv('email,company\n  Foo@Bar.COM  ,A\nnot-an-email,B\n,C\n');
    expect(r.candidates.map((c) => c.email)).toEqual(['foo@bar.com']);
    expect(r.rejected).toEqual([
      { row: 2, reason: 'invalid_email' },
      { row: 3, reason: 'invalid_email' },
    ]);
  });

  it('AC3: duplicates collapse (first wins, tags unioned) and are counted', () => {
    const r = parseEnrollmentCsv('email,first_name,tags\na@x.com,Ann,"a;b"\nA@X.com,Other,"b,c"\n');
    expect(r.candidates).toEqual([{ email: 'a@x.com', firstName: 'Ann', tags: ['a', 'b', 'c'] }]);
    expect(r.duplicates).toBe(1);
    expect(r.rejected).toEqual([]);
  });

  it('AC4: excludeEmails rejects matches as suppressed', () => {
    const r = parseEnrollmentCsv('email\na@x.com\nb@x.com\n', { excludeEmails: [' A@X.COM '] });
    expect(r.candidates.map((c) => c.email)).toEqual(['b@x.com']);
    expect(r.rejected).toEqual([{ row: 1, reason: 'suppressed' }]);
  });

  it('AC5: handles BOM, CRLF, quoted commas/quotes, trailing blank lines', () => {
    const csv = '\uFEFFemail,company\r\na@x.com,"Acme, Inc. ""West"""\r\n\r\n\r\n';
    const r = parseEnrollmentCsv(csv);
    expect(r.candidates).toEqual([{ email: 'a@x.com', company: 'Acme, Inc. "West"', tags: [] }]);
    expect(r.rejected).toEqual([]);
  });

  it('AC6: maxRows caps processing; overflow rejected row_limit (default 5000)', () => {
    const r = parseEnrollmentCsv('email\na@x.com\nb@x.com\nc@x.com\n', { maxRows: 2 });
    expect(r.candidates).toHaveLength(2);
    expect(r.rejected).toEqual([{ row: 3, reason: 'row_limit' }]);

    const many = 'email\n' + Array.from({ length: 5001 }, (_, i) => `u${i}@x.com`).join('\n');
    const d = parseEnrollmentCsv(many);
    expect(d.candidates).toHaveLength(5000);
    expect(d.rejected).toEqual([{ row: 5001, reason: 'row_limit' }]);
  });

  it('empty input yields empty result', () => {
    expect(parseEnrollmentCsv('')).toEqual({ candidates: [], rejected: [], duplicates: 0 });
  });
});
