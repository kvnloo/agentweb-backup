jest.mock('../services/settingsService', () => ({ settingsService: { getSetting: jest.fn().mockResolvedValue(null) } }));
jest.mock('../services/db', () => ({ userDb: { getUserById: jest.fn().mockResolvedValue({ orgId: 'blog-org' }) }, orgDb: { getOrgById: jest.fn().mockResolvedValue({ modelRoles: { content_generation: 'openrouter/openai/gpt-5.6-luna' } }) } }));
// ENG-351: inline source citations are required in RESEARCH/MEASUREMENT outputs (the
// deep research report itself, analytics summaries, competitive research). A published
// blog article is a different, polished deliverable — the deep-research → blog restyle
// intentionally strips citation markers so the article reads as clean editorial prose.
// The research report piped in still carries its inline citations; only the blog output
// is citation-free. These tests lock in that the restyle prompt strips citations.

jest.mock('../utils/secretsManager', () => ({
  getSecret: jest.fn().mockResolvedValue('test-api-key'),
}));

const mockCallLLM = jest.fn();
jest.mock('../services/agentModeService', () => ({
  agentModeService: { callLLM: (...a: any[]) => mockCallLLM(...a) },
}));

jest.mock('../config', () => ({
  CONTENT_RESTYLE_MODEL: 'gemini-test-model',
}));

import { restyleContent } from '../controllers/blog';

describe('restyleContent — blog articles are citation-free (ENG-351 scope decision)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCallLLM.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({
        title: 'T',
        description: 'D',
        content: 'C',
        imagePrompt: 'P',
      }) } }],
    });
  });

  const getPrompt = (): string => mockCallLLM.mock.calls[0][1]
    .find((message: any) => message.role === 'user').content as string;

  it('instructs the model to remove all citations and references from the blog', async () => {
    await restyleContent('The market grew to $5B (Gartner, 2025).', 'AI market');

    const prompt = getPrompt();
    expect(prompt).toMatch(/REMOVE ALL CITATIONS AND REFERENCES/);
    expect(prompt).toMatch(/remove the citation markers entirely/i);
  });

  it('does not instruct the model to preserve inline attributions in the blog', async () => {
    await restyleContent('Revenue rose 12% (Statista).', 'revenue');

    const prompt = getPrompt();
    expect(prompt).not.toMatch(/KEEP inline source attributions/i);
  });

  it('names parenthetical author-year citations among the markers to strip', async () => {
    await restyleContent('A fact [1] with a references section.', 'topic');

    const prompt = getPrompt();
    expect(prompt).toMatch(/\(Author, Year\)/);
    expect(prompt).toMatch(/bibliography/i);
  });
  it('uses the tenant content role for blog restyling', async () => {
    await restyleContent('A draft', 'topic', 'professional', 'default', false, 'blog-user');
    expect(mockCallLLM.mock.calls[0][0]).toBe('openrouter/openai/gpt-6-luna'); // GPT-6 Luna: cheaper, newer tenant-content-role model
  });
});
