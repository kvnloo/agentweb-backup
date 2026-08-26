import { parseCsvProvenance } from '../services/agentMode/csvProvenance';

/**
 * ENG-1600 — `parseCsvProvenance` fed the cross-call comparison that HARD-REJECTS an analysis
 * with `inconsistent_result`. A hand-rolled `line.split(',')` shifted every column after a
 * quoted comma, so a correct analysis could be refused. Exercised through the private method
 * directly, matching the convention used by the other agentModeService suites.
 */
const parse = (csv: string) => parseCsvProvenance(csv);

describe('ENG-1600 parseCsvProvenance', () => {
  it('keeps columns aligned when a field contains a quoted comma', () => {
    // The old splitter turned `"Acme, Inc"` into two cells and shifted `spend`/`leads` left.
    const csv = 'account,spend,leads\n"Acme, Inc",1000,25\n"Smith, Jones & Co",2000,40';
    const p = parse(csv);
    expect(p!.header).toEqual(['account', 'spend', 'leads']);
    expect(p!.rowsOut).toBe(2);
    expect(p!.rows[0]).toEqual(['Acme, Inc', '1000', '25']);
    expect(p!.rows[1]).toEqual(['Smith, Jones & Co', '2000', '40']);
  });

  it('groups by the real first column, not a fragment of it', () => {
    // This is the value that feeds the inconsistent_result rejection.
    const csv = 'account,spend\n"Acme, Inc",1000\n"Acme, Inc",2000\n"Beta Ltd",50';
    expect(parse(csv)!.groupingKeyValues).toEqual(['Acme, Inc', 'Beta Ltd']);
  });

  it('produces identical grouping keys across repeat parses of the same data', () => {
    // Two runs disagreeing is precisely what triggers the hard rejection.
    const csv = 'name,v\n"X, Y",1\n"Z, W",2';
    expect(parse(csv)!.groupingKeyValues).toEqual(parse(csv)!.groupingKeyValues);
  });

  it('handles plain unquoted CSV exactly as before', () => {
    const p = parse('campaign,leads\nalpha,10\nbeta,20');
    expect(p!.header).toEqual(['campaign', 'leads']);
    expect(p!.rowsOut).toBe(2);
    expect(p!.groupingKeyValues).toEqual(['alpha', 'beta']);
  });

  it('tolerates ragged rows rather than losing the whole provenance check', () => {
    // Returning null here would silently disable the only guard against fabricated output.
    const p = parse('a,b,c\n1,2,3\n4,5');
    expect(p).not.toBeNull();
    expect(p!.rowsOut).toBe(2);
  });

  it('returns null for empty input', () => {
    expect(parse('')).toBeNull();
    expect(parse('   \n  ')).toBeNull();
  });

  it('does not treat embedded quotes as row boundaries', () => {
    const p = parse('q,v\n"He said ""hi"", loudly",7');
    expect(p!.rowsOut).toBe(1);
    expect(p!.rows[0][1]).toBe('7');
  });
});
