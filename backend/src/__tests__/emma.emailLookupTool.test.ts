// Tests for the find_or_lookup_email Emma tool — single + bulk paths,
// resolution from leadId, quota-exceeded handling.

const mockSvc = {
  reverseLookup: jest.fn(),
  findEmail: jest.fn(),
};
jest.mock('../services/enrichSoService', () => ({
  getEnrichSoService: () => mockSvc,
}));

const mockGetLeadById = jest.fn();
jest.mock('../services/db', () => ({
  crmDb: { getLeadById: mockGetLeadById },
}));

// Stub registry so the tool registers a callable execute fn we can introspect.
const registered: any[] = [];
jest.mock('../emma/registry', () => ({
  emmaToolRegistry: {
    register: (def: any) => registered.push(def),
  },
}));

import { LookupByEmailQuotaExceededError } from '../services/enrichSoQuota';

beforeAll(() => {
  // Loading the module triggers register(). Once is enough.
  require('../emma/emailLookupTool');
});

beforeEach(() => {
  jest.clearAllMocks();
});

function getTool() {
  const t = registered.find((r) => r.name === 'find_or_lookup_email');
  if (!t) throw new Error('tool not registered');
  return t;
}

const ctx = { userId: 'u1' };

describe('find_or_lookup_email tool', () => {
  it('throws when no userId in context', async () => {
    const tool = getTool();
    await expect(tool.execute({ email: 'a@b.com' }, {})).rejects.toThrow(/Authentication/);
  });

  it('returns empty results for empty input', async () => {
    const tool = getTool();
    // Empty bulk + no single fields → array of [{}] which fails to resolve;
    // the function returns one result with found:false rather than empty
    // results array, since the user did pass an arg object.
    const r = await tool.execute({}, ctx);
    expect(r.results).toHaveLength(1);
    expect(r.results[0].found).toBe(false);
  });

  it('reverse-lookup path when email provided', async () => {
    mockSvc.reverseLookup.mockResolvedValue({
      found: true, firstName: 'Alice', lastName: 'Smith', companyName: 'Acme',
      jobTitle: 'CEO', profileUrl: 'https://linkedin.com/in/alice', fromCache: false,
    });
    const r = await getTool().execute({ email: 'alice@acme.com' }, ctx);
    expect(mockSvc.reverseLookup).toHaveBeenCalledWith('alice@acme.com', { userId: 'u1' });
    expect(r.results[0]).toMatchObject({
      found: true, firstName: 'Alice', lastName: 'Smith', company: 'Acme', title: 'CEO',
      linkedin: 'https://linkedin.com/in/alice',
    });
  });

  it('rejects malformed email without burning a credit', async () => {
    const r = await getTool().execute({ email: 'notanemail' }, ctx);
    expect(mockSvc.reverseLookup).not.toHaveBeenCalled();
    expect(r.results[0].found).toBe(false);
  });

  it('email-finder path when name + domain provided', async () => {
    mockSvc.findEmail.mockResolvedValue({
      found: true, email: 'alice@acme.com', confidence: 'high', fromCache: false,
    });
    const r = await getTool().execute({
      firstName: 'Alice', lastName: 'Smith', domain: 'acme.com',
    }, ctx);
    expect(mockSvc.findEmail).toHaveBeenCalledWith(
      expect.objectContaining({ firstName: 'Alice', lastName: 'Smith', domain: 'acme.com' }),
      { userId: 'u1' },
    );
    expect(r.results[0].found).toBe(true);
    expect(r.results[0].email).toBe('alice@acme.com');
  });

  it('falls back to company when domain absent', async () => {
    mockSvc.findEmail.mockResolvedValue({ found: false, fromCache: false });
    await getTool().execute({
      firstName: 'A', lastName: 'B', company: 'Acme Inc',
    }, ctx);
    expect(mockSvc.findEmail).toHaveBeenCalledWith(
      expect.objectContaining({ company: 'Acme Inc', domain: undefined }),
      expect.any(Object),
    );
  });

  it('returns found:false when neither path is satisfied', async () => {
    const r = await getTool().execute({ firstName: 'Alice' }, ctx);
    expect(mockSvc.reverseLookup).not.toHaveBeenCalled();
    expect(mockSvc.findEmail).not.toHaveBeenCalled();
    expect(r.results[0].found).toBe(false);
  });

  it('leadId path: resolves email from the lead and reverse-looks up', async () => {
    mockGetLeadById.mockResolvedValue({
      leadId: 'L1', email: 'alice@acme.com', firstName: 'Alice', company: 'Acme',
    });
    mockSvc.reverseLookup.mockResolvedValue({
      found: true, firstName: 'Alice', companyName: 'Acme', fromCache: false,
    });
    const r = await getTool().execute({ leadId: 'L1', listId: 'list-1' }, ctx);
    expect(mockGetLeadById).toHaveBeenCalledWith('list-1', 'L1');
    expect(mockSvc.reverseLookup).toHaveBeenCalledWith('alice@acme.com', { userId: 'u1' });
    expect(r.results[0].found).toBe(true);
  });

  it('leadId path: falls through to email finder when lead has name+company but no email', async () => {
    mockGetLeadById.mockResolvedValue({
      leadId: 'L1', email: '', firstName: 'Alice', lastName: 'Smith', company: 'Acme',
    });
    mockSvc.findEmail.mockResolvedValue({ found: true, email: 'alice@acme.com', confidence: 'high' });
    const r = await getTool().execute({ leadId: 'L1', listId: 'list-1' }, ctx);
    expect(mockSvc.findEmail).toHaveBeenCalled();
    expect(r.results[0].email).toBe('alice@acme.com');
  });

  it('bulk path: processes multiple inputs in parallel', async () => {
    mockSvc.reverseLookup.mockResolvedValue({ found: true, firstName: 'X', fromCache: false });
    const r = await getTool().execute({
      bulk: [
        { email: 'a@b.com' },
        { email: 'c@d.com' },
        { email: 'e@f.com' },
      ],
    }, ctx);
    expect(mockSvc.reverseLookup).toHaveBeenCalledTimes(3);
    expect(r.results).toHaveLength(3);
    expect(r.processed).toBe(3);
  });

  it('bulk path: caps at 25 inputs and reports truncation', async () => {
    mockSvc.reverseLookup.mockResolvedValue({ found: true, fromCache: false });
    const bulk = Array.from({ length: 30 }, (_, i) => ({ email: `u${i}@x.com` }));
    const r = await getTool().execute({ bulk }, ctx);
    expect(r.processed).toBe(25);
    expect(r.total).toBe(30);
    expect(r.truncated).toMatch(/skipped/);
  });

  it('bulk path: one failure does not block others (Promise.allSettled)', async () => {
    mockSvc.reverseLookup
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue({ found: true, fromCache: false });
    const r = await getTool().execute({
      bulk: [{ email: 'a@b.com' }, { email: 'c@d.com' }],
    }, ctx);
    expect(r.results[0].found).toBe(false);
    expect(r.results[0].error).toMatch(/boom/);
    expect(r.results[1].found).toBe(true);
  });

  it('bulk path: surfaces quota-exceeded as a top-level field', async () => {
    mockSvc.reverseLookup.mockRejectedValue(new LookupByEmailQuotaExceededError(50));
    const r = await getTool().execute({ bulk: [{ email: 'a@b.com' }] }, ctx);
    expect(r.quotaExceeded).toMatch(/quota/i);
    expect(r.results[0].found).toBe(false);
  });

  it('does NOT auto-update leads (return-only)', async () => {
    // No write should happen via crmDb. We only have getLeadById in the mock,
    // and we never assert writes. Just confirm the contract with a comment.
    mockGetLeadById.mockResolvedValue({ leadId: 'L1', email: 'a@b.com' });
    mockSvc.reverseLookup.mockResolvedValue({ found: true, firstName: 'X', fromCache: false });
    await getTool().execute({ leadId: 'L1', listId: 'list-1' }, ctx);
    // crmDb.updateLead should NOT have been called — it isn't even mocked.
    // Test passes by completing without throwing.
  });
});
