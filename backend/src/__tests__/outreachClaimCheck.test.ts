// ENG-3067: shadow-only claim check for outreach drafts.
import {
  findUnsupportedSenderClaims,
  logOutreachClaimCheckShadow,
} from '../services/outreachClaimCheck';

const facts = (brandData: unknown, marketStrategyText = '') => ({ brandData, marketStrategyText });
const texts = (r: ReturnType<typeof findUnsupportedSenderClaims>) =>
  r.status === 'checked' ? r.unsupported.map(c => `${c.kind}:${c.text}`) : r.status;

describe('findUnsupportedSenderClaims', () => {
  it('AC1: returns a percentage the facts never mention, and nothing when they do', () => {
    const draft = { subject: 'Quick idea', body: 'We cut reporting time by 40% for teams like yours.' };
    expect(texts(findUnsupportedSenderClaims({ draft, facts: facts({ valueProposition: 'Faster reporting for finance teams' }) })))
      .toEqual(['percentage:40%']);
    expect(texts(findUnsupportedSenderClaims({ draft, facts: facts({ keyMessages: ['Cuts reporting time by 40%'] }) })))
      .toEqual([]);
    expect(texts(findUnsupportedSenderClaims({ draft, facts: facts({ brandName: 'Acme' }, 'Customers report 40% less time spent') })))
      .toEqual([]);
  });

  it('AC2: does not flag the recipient\'s own company size or funding from the lead record', () => {
    const recipient = { company: 'Globex', customFields: { employees: 250, funding: '$5,000,000 Series A' }, notes: 'Works with Initech' };
    const draft = { body: 'Congrats on the $5M round. With 250 employees at Globex, and since you work with Initech, reporting gets heavy.' };
    expect(texts(findUnsupportedSenderClaims({ draft, facts: facts({ brandName: 'Acme' }), recipient }))).toEqual([]);
    // The same draft with no lead record flags them, so the test above is not vacuous.
    expect(texts(findUnsupportedSenderClaims({ draft, facts: facts({ brandName: 'Acme' }) })))
      .toEqual(['money:$5M', 'number_with_unit:250 employees', 'named_entity:Initech']);
  });

  it('does not treat the lead\'s previous generated drafts as recipient facts', () => {
    const draft = { body: 'We save 40% and $2k for 500 customers, and work with Initech' };
    const recipient = {
      company: 'Globex',
      emailDraft: { subject: 'Hi', htmlContent: '<p>We save 40% and $2k for 500 customers, and work with Initech</p>' },
      messageDraft: { content: 'We save 40% and $2k for 500 customers, and work with Initech' },
    };
    expect(texts(findUnsupportedSenderClaims({ draft, facts: facts({ brandName: 'Acme' }), recipient })))
      .toEqual(['money:$2k', 'percentage:40%', 'number_with_unit:500 customers', 'named_entity:Initech']);
    // Other lead fields still count as recipient evidence.
    expect(texts(findUnsupportedSenderClaims({
      draft: { body: 'With 250 employees at Globex, reporting gets heavy.' },
      facts: facts({ brandName: 'Acme' }),
      recipient: { ...recipient, customFields: { employees: 250 } },
    }))).toEqual([]);
  });

  it('AC3: money and percentage formats match each other', () => {
    for (const inFacts of ['$1,500', '1500 dollars', '$1.5k']) {
      for (const inDraft of ['$1,500', '1500 dollars', '$1.5k']) {
        expect(texts(findUnsupportedSenderClaims({
          draft: { body: `Plans start at ${inDraft} a month.` },
          facts: facts({ tagline: `Pricing from ${inFacts}` }),
        }))).toEqual([]);
      }
    }
    expect(texts(findUnsupportedSenderClaims({ draft: { body: 'Save 40% today.' }, facts: facts({ tagline: 'Save 40 percent' }) }))).toEqual([]);
    expect(texts(findUnsupportedSenderClaims({ draft: { body: 'Save 40 percent today.' }, facts: facts({ tagline: 'Save 40%' }) }))).toEqual([]);
    expect(texts(findUnsupportedSenderClaims({ draft: { body: 'Plans start at $2,500.' }, facts: facts({ tagline: 'Pricing from $1,500' }) })))
      .toEqual(['money:$2,500']);
  });

  it('AC4: empty or missing facts return an explicit no_facts result', () => {
    const draft = { body: 'We cut costs 40% and saved $1,500 in 8 seconds for customers like Initech.' };
    expect(findUnsupportedSenderClaims({ draft, facts: {} })).toEqual({ status: 'no_facts' });
    expect(findUnsupportedSenderClaims({ draft, facts: facts({}, '   ') })).toEqual({ status: 'no_facts' });
    expect(findUnsupportedSenderClaims({ draft, facts: facts(null, undefined as any) })).toEqual({ status: 'no_facts' });
    expect(findUnsupportedSenderClaims({ draft, facts: undefined as any })).toEqual({ status: 'no_facts' });
  });

  it('flags numbers with units and named customers, and accepts them when the facts hold them', () => {
    const draft = { body: 'Our pages load in 8 seconds flat, and customers like Initech, Hooli and Pied Piper rely on us.' };
    expect(texts(findUnsupportedSenderClaims({ draft, facts: facts({ brandName: 'Acme' }) })))
      .toEqual(['number_with_unit:8 seconds', 'named_entity:Initech', 'named_entity:Hooli', 'named_entity:Pied Piper']);
    expect(texts(findUnsupportedSenderClaims({
      draft,
      facts: facts({ keyMessages: ['Loads in 8 second windows'] }, 'Case studies: Initech, Hooli, Pied Piper'),
    }))).toEqual([]);
  });

  it('reads an HTML body, does not double count, and ignores dates and times', () => {
    const draft = { subject: 'Nov 16 at 10 am', body: '<p>We grew <b>40 percent</b> and 40% again.</p>' };
    expect(texts(findUnsupportedSenderClaims({ draft, facts: facts({ brandName: 'Acme' }) }))).toEqual(['percentage:40 percent']);
  });

  it('survives non-string draft and fact shapes', () => {
    expect(findUnsupportedSenderClaims({ draft: { subject: 5 as any, body: null }, facts: facts({ brandName: 'Acme' }) }))
      .toEqual({ status: 'checked', unsupported: [] });
  });
});

describe('findUnsupportedSenderClaims runtime on hostile input', () => {
  // The check runs synchronously on the draft path. Lead records are customer
  // supplied, so each shape below must stay near-linear rather than quadratic.
  const N = 60_000;
  const cases: Array<[string, string]> = [
    ['one long digit run', '7'.repeat(N)],
    ['comma-separated digits', '1,'.repeat(N / 2)],
    ['a number followed by a long whitespace run', `5${' '.repeat(N)}!`],
    ['unclosed angle brackets', '<'.repeat(N)],
    ['a long capitalised run after a trigger', `we work with ${'A'.repeat(N)}`],
  ];
  it.each(cases)('finishes quickly on %s in the lead record, the facts and the draft', (_label, hostile) => {
    const started = Date.now();
    const result = findUnsupportedSenderClaims({
      draft: { body: hostile },
      facts: facts({ brandName: 'Acme', notes: hostile }),
      recipient: { notes: hostile },
    });
    expect(result.status).toBe('checked');
    expect(Date.now() - started).toBeLessThan(1500);
  });

  // Name lookup scans the evidence once per draft name, so the two sizes multiply.
  const manyNames = (n: number) => Array.from({ length: n }, (_, i) => `We work with Zq${i}x Corp${i}.`).join(' ');
  const filler = (chars: number) => 'lorem ipsum dolor sit amet zq '.repeat(Math.ceil(chars / 30));

  it('stays fast with many draft names against the largest evidence it accepts', () => {
    const started = Date.now();
    const result = findUnsupportedSenderClaims({
      draft: { body: manyNames(2000) },
      facts: facts({ notes: filler(240_000) }),
      recipient: { notes: filler(240_000) },
    });
    expect(Date.now() - started).toBeLessThan(1500);
    expect(result.status).toBe('checked');
    // Only the first 50 draft names are looked up.
    expect(texts(result).length).toBe(50);
  });

  it('skips instead of measuring when the facts and lead record exceed the budget', () => {
    const started = Date.now();
    const result = findUnsupportedSenderClaims({
      draft: { body: manyNames(2000) },
      facts: facts({ notes: filler(3_000_000) }),
      recipient: { notes: filler(3_000_000) },
    });
    expect(result).toEqual({ status: 'skipped_oversize' });
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('skips an oversize draft', () => {
    expect(findUnsupportedSenderClaims({
      draft: { body: filler(150_000) },
      facts: facts({ brandName: 'Acme' }),
    })).toEqual({ status: 'skipped_oversize' });
  });
});

describe('logOutreachClaimCheckShadow', () => {
  let logSpy: jest.SpyInstance;
  beforeEach(() => { logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined); });
  afterEach(() => { logSpy.mockRestore(); });

  const input = () => ({
    channel: 'email' as const,
    listId: 'list-123',
    draft: Object.freeze({ subject: 'Secret subject', body: 'We cut reporting time by 40% and charge $99 for customers like Initech.' }),
    facts: facts({ brandName: 'Acme' }),
  });

  it('logs one structured line with counts by kind and the list id, and no draft text', () => {
    logOutreachClaimCheckShadow(input());
    expect(logSpy).toHaveBeenCalledTimes(1);
    const line = String(logSpy.mock.calls[0][0]);
    expect(JSON.parse(line)).toEqual({
      event: 'outreach_claim_check_shadow',
      channel: 'email',
      listId: 'list-123',
      status: 'checked',
      unsupportedTotal: 3,
      unsupportedByKind: { percentage: 1, money: 1, number_with_unit: 0, named_entity: 1 },
    });
    for (const leaked of ['Secret', 'reporting', '40', '99', 'Initech']) expect(line).not.toContain(leaked);
  });

  it('logs no_facts with zero counts', () => {
    logOutreachClaimCheckShadow({ ...input(), facts: {} });
    expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toMatchObject({ status: 'no_facts', unsupportedTotal: 0 });
  });

  it('logs skipped_oversize with zero counts', () => {
    logOutreachClaimCheckShadow({ ...input(), draft: { body: 'x '.repeat(80_000) } });
    expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toMatchObject({ status: 'skipped_oversize', unsupportedTotal: 0 });
  });

  it('AC5: a throwing check never propagates, returns synchronously, and leaves the draft untouched', () => {
    const i = input();
    const before = JSON.stringify(i.draft);
    const out = logOutreachClaimCheckShadow(i, () => { throw new Error('boom'); });
    expect(out).toBeUndefined();
    expect(JSON.stringify(i.draft)).toBe(before);
    expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toEqual({
      event: 'outreach_claim_check_shadow', channel: 'email', listId: 'list-123', status: 'error',
    });
  });

  it('AC5: a throwing logger never propagates either', () => {
    logSpy.mockImplementation(() => { throw new Error('log down'); });
    expect(() => logOutreachClaimCheckShadow(input())).not.toThrow();
  });

  it('AC6: makes no network call', () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch' as any).mockImplementation(() => { throw new Error('network used'); });
    logOutreachClaimCheckShadow(input());
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
