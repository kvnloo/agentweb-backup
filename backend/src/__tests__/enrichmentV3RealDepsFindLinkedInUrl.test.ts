// Tests for findLinkedInUrlImpl — error-driven cache invalidation.
// Verifies that any failure after accountId is resolved purges both the
// resolved-account cache and the connectivity-status cache, so a newly-connected
// replacement account is picked up on the next call (within 30 min max).

import { findLinkedInUrlImpl } from '../services/enrichmentV3RealDeps';
import { linkedInOutreachService } from '../services/linkedInOutreachService';
import { createLLMService } from '../utils/llmService';

jest.mock('../services/linkedInOutreachService', () => ({
  linkedInOutreachService: {
    resolveAccountIdForEnrichment: jest.fn(),
    searchPeople: jest.fn(),
    invalidateResolvedAccount: jest.fn(),
    clearStatusCache: jest.fn(),
  },
}));

// The name-only contextual-disambiguation path asks an LLM to pick among
// same-name candidates. Mock it so tests control the choice deterministically.
const mockGenerateJSONContent = jest.fn();
jest.mock('../utils/llmService', () => ({
  createLLMService: jest.fn(() => ({ generateJSONContent: mockGenerateJSONContent })),
}));

const svc = linkedInOutreachService as unknown as {
  resolveAccountIdForEnrichment: jest.Mock;
  searchPeople: jest.Mock;
  invalidateResolvedAccount: jest.Mock;
  clearStatusCache: jest.Mock;
};

beforeEach(() => {
  jest.clearAllMocks();
  svc.resolveAccountIdForEnrichment.mockResolvedValue('acct-1');
  (createLLMService as jest.Mock).mockReturnValue({ generateJSONContent: mockGenerateJSONContent });
});

describe('findLinkedInUrlImpl — cache invalidation on error', () => {
  it('invalidates both caches on NOT_FOUND error', async () => {
    const err = Object.assign(new Error('not found'), {
      structuredError: { classification: 'NOT_FOUND' },
    });
    svc.searchPeople.mockRejectedValue(err);

    const result = await findLinkedInUrlImpl('user-1', 'Jane', 'Doe', 'Acme');

    expect(result).toBeNull();
    expect(svc.invalidateResolvedAccount).toHaveBeenCalledWith('user-1');
    expect(svc.clearStatusCache).toHaveBeenCalledWith('acct-1');
  });

  it('invalidates both caches on non-NOT_FOUND error (500)', async () => {
    svc.searchPeople.mockRejectedValue(new Error('Internal server error'));

    const result = await findLinkedInUrlImpl('user-1', 'Jane', 'Doe', 'Acme');

    expect(result).toBeNull();
    expect(svc.invalidateResolvedAccount).toHaveBeenCalledWith('user-1');
    expect(svc.clearStatusCache).toHaveBeenCalledWith('acct-1');
  });

  it('does NOT invalidate when no account resolved (null accountId)', async () => {
    svc.resolveAccountIdForEnrichment.mockResolvedValue(null);

    const result = await findLinkedInUrlImpl('user-1', 'Jane', 'Doe', 'Acme');

    expect(result).toBeNull();
    expect(svc.invalidateResolvedAccount).not.toHaveBeenCalled();
    expect(svc.clearStatusCache).not.toHaveBeenCalled();
  });

  it('does NOT invalidate on successful lookup', async () => {
    svc.searchPeople.mockResolvedValue({
      items: [{ public_identifier: 'jane-doe', first_name: 'Jane', last_name: 'Doe' }],
    });

    await findLinkedInUrlImpl('user-1', 'Jane', 'Doe', 'Acme');

    expect(svc.invalidateResolvedAccount).not.toHaveBeenCalled();
    expect(svc.clearStatusCache).not.toHaveBeenCalled();
  });
});

describe('findLinkedInUrlImpl — name-only keywords (never folds context into the query)', () => {
  it('always searches with name-only keywords even when listContext is provided', async () => {
    // Empirically, folding context into the keyword string collapses a name
    // search to zero LinkedIn hits. Context must NEVER reach the query — it is
    // only used to re-rank candidates after the fetch.
    svc.searchPeople.mockResolvedValue({
      items: [{ public_identifier: 'jane-doe-yc', first_name: 'Jane', last_name: 'Doe' }],
    });

    const url = await findLinkedInUrlImpl('user-1', 'Jane', 'Doe', undefined, 'YC Poker Night');

    // Single name-matched candidate → no LLM disambiguation needed, accepted directly.
    expect(url).toBe('https://www.linkedin.com/in/jane-doe-yc');
    expect(svc.searchPeople).toHaveBeenCalledWith(
      'acct-1',
      expect.objectContaining({ keywords: 'Jane Doe', company: undefined }),
    );
    expect(mockGenerateJSONContent).not.toHaveBeenCalled();
  });

  it('keeps keywords name-only and uses the company filter when company is present', async () => {
    svc.searchPeople.mockResolvedValue({
      items: [{ public_identifier: 'jane-acme', first_name: 'Jane', last_name: 'Doe' }],
    });

    await findLinkedInUrlImpl('user-1', 'Jane', 'Doe', 'Acme', 'YC Poker Night');

    expect(svc.searchPeople).toHaveBeenCalledWith(
      'acct-1',
      expect.objectContaining({ keywords: 'Jane Doe', company: 'Acme' }),
    );
  });

  it('searches by name only when neither company nor listContext is provided', async () => {
    svc.searchPeople.mockResolvedValue({
      items: [{ public_identifier: 'jane-doe', first_name: 'Jane', last_name: 'Doe' }],
    });

    await findLinkedInUrlImpl('user-1', 'Jane', 'Doe', undefined, undefined);

    expect(svc.searchPeople).toHaveBeenCalledWith(
      'acct-1',
      expect.objectContaining({ keywords: 'Jane Doe', company: undefined }),
    );
  });
});

describe('findLinkedInUrlImpl — LLM context disambiguation among same-name candidates', () => {
  const sameNameCandidates = {
    items: [
      { public_identifier: 'jane-wrong-1', name: 'Jane Doe', headline: 'Dentist' },
      { public_identifier: 'jane-right', name: 'Jane Doe', headline: 'Founder at Y Combinator' },
      { public_identifier: 'jane-wrong-2', name: 'Jane Doe', headline: 'Barista' },
    ],
  };

  it('uses the LLM-chosen index when the pick is confident and its evidence is grounded in the profile', async () => {
    svc.searchPeople.mockResolvedValue(sameNameCandidates);
    mockGenerateJSONContent.mockResolvedValue({ index: 1, confidence: 'high', evidence: 'Y Combinator', context_strength: 'specific' });

    const url = await findLinkedInUrlImpl('user-1', 'Jane', 'Doe', undefined, 'YC alumni');

    expect(url).toBe('https://www.linkedin.com/in/jane-right');
    expect(mockGenerateJSONContent).toHaveBeenCalledTimes(1);
  });

  it('refuses (returns null) when the LLM declines with index -1', async () => {
    svc.searchPeople.mockResolvedValue(sameNameCandidates);
    mockGenerateJSONContent.mockResolvedValue({ index: -1, confidence: 'low', evidence: '' });

    const url = await findLinkedInUrlImpl('user-1', 'Jane', 'Doe', undefined, 'Acme Dentists');

    expect(url).toBeNull();
  });

  it('refuses when the LLM returns an out-of-range index', async () => {
    svc.searchPeople.mockResolvedValue(sameNameCandidates);
    mockGenerateJSONContent.mockResolvedValue({ index: 99, confidence: 'high', evidence: 'Y Combinator' });

    const url = await findLinkedInUrlImpl('user-1', 'Jane', 'Doe', undefined, 'YC alumni');

    expect(url).toBeNull();
  });

  it('refuses when the LLM pick is low confidence (threshold guard)', async () => {
    svc.searchPeople.mockResolvedValue(sameNameCandidates);
    mockGenerateJSONContent.mockResolvedValue({ index: 1, confidence: 'low', evidence: 'Y Combinator' });

    const url = await findLinkedInUrlImpl('user-1', 'Jane', 'Doe', undefined, 'YC alumni');

    expect(url).toBeNull();
  });

  it('refuses when the LLM evidence is not found in the chosen profile (hallucination guard)', async () => {
    svc.searchPeople.mockResolvedValue(sameNameCandidates);
    // "Sequoia Capital" appears in NO candidate's profile — fabricated justification.
    mockGenerateJSONContent.mockResolvedValue({ index: 1, confidence: 'high', evidence: 'Sequoia Capital' });

    const url = await findLinkedInUrlImpl('user-1', 'Jane', 'Doe', undefined, 'YC alumni');

    expect(url).toBeNull();
  });

  it('refuses when the LLM omits evidence entirely', async () => {
    svc.searchPeople.mockResolvedValue(sameNameCandidates);
    mockGenerateJSONContent.mockResolvedValue({ index: 1, confidence: 'high' });

    const url = await findLinkedInUrlImpl('user-1', 'Jane', 'Doe', undefined, 'YC alumni');

    expect(url).toBeNull();
  });

  it('refuses when the LLM judges the list context too weak to disambiguate', async () => {
    // Vague context like "Imported Contacts" / "Tech Founders" can't reliably
    // separate same-name people — the LLM flags context_strength 'weak' and we
    // refuse even if it nominated an index.
    svc.searchPeople.mockResolvedValue(sameNameCandidates);
    mockGenerateJSONContent.mockResolvedValue({
      index: 1, confidence: 'high', evidence: 'Y Combinator', context_strength: 'weak',
    });

    const url = await findLinkedInUrlImpl('user-1', 'Jane', 'Doe', undefined, 'Imported Contacts');

    expect(url).toBeNull();
  });

  it('accepts when context is specific (context_strength=specific) and other guards pass', async () => {
    svc.searchPeople.mockResolvedValue(sameNameCandidates);
    mockGenerateJSONContent.mockResolvedValue({
      index: 1, confidence: 'high', evidence: 'Y Combinator', context_strength: 'specific',
    });

    const url = await findLinkedInUrlImpl('user-1', 'Jane', 'Doe', undefined, 'YC alumni');

    expect(url).toBe('https://www.linkedin.com/in/jane-right');
  });

  it('refuses when the LLM call throws (fail-soft, no wrong-person guess)', async () => {
    svc.searchPeople.mockResolvedValue(sameNameCandidates);
    mockGenerateJSONContent.mockRejectedValue(new Error('LLM down'));

    const url = await findLinkedInUrlImpl('user-1', 'Jane', 'Doe', undefined, 'YC alumni');

    expect(url).toBeNull();
  });

  it('does NOT call the LLM when company is present (server-side filter already narrowed)', async () => {
    svc.searchPeople.mockResolvedValue(sameNameCandidates);

    const url = await findLinkedInUrlImpl('user-1', 'Jane', 'Doe', 'Acme', 'YC alumni');

    // First name-matched candidate is taken directly.
    expect(url).toBe('https://www.linkedin.com/in/jane-wrong-1');
    expect(mockGenerateJSONContent).not.toHaveBeenCalled();
  });

  it('rejects candidates whose name does not match before LLM disambiguation', async () => {
    svc.searchPeople.mockResolvedValue({
      items: [
        { public_identifier: 'someone-else', name: 'John Smith', headline: 'Founder at Y Combinator' },
      ],
    });

    const url = await findLinkedInUrlImpl('user-1', 'Jane', 'Doe', undefined, 'YC alumni');

    expect(url).toBeNull();
    expect(mockGenerateJSONContent).not.toHaveBeenCalled();
  });
});

describe('findLinkedInUrlImpl — the anonymized sentinel is not a URL', () => {
  // LinkedIn returns out-of-network profiles with `public_identifier` set to the
  // literal string "undefined", which is truthy. A bare presence check therefore
  // resolved it to https://www.linkedin.com/in/undefined and returned that as the
  // lead's LinkedIn URL — a link belonging to nobody, written back onto the lead.
  it('returns null instead of resolving an anonymized hit', async () => {
    svc.searchPeople.mockResolvedValue({
      items: [{ name: 'Jane Doe', public_identifier: 'undefined' }],
    });

    const result = await findLinkedInUrlImpl('user-1', 'Jane', 'Doe', 'Acme');

    expect(result).toBeNull();
  });

  it('still resolves a real hit', async () => {
    svc.searchPeople.mockResolvedValue({
      items: [{ name: 'Jane Doe', public_identifier: 'jane-doe-123' }],
    });

    const result = await findLinkedInUrlImpl('user-1', 'Jane', 'Doe', 'Acme');

    expect(result).toBe('https://www.linkedin.com/in/jane-doe-123');
  });
});
