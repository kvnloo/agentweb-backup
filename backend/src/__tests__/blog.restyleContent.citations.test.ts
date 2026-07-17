// ENG-351: inline source citations are required in RESEARCH/MEASUREMENT outputs (the
// deep research report itself, analytics summaries, competitive research). A published
// blog article is a different, polished deliverable — the deep-research → blog restyle
// intentionally strips citation markers so the article reads as clean editorial prose.
// The research report piped in still carries its inline citations; only the blog output
// is citation-free. These tests lock in that the restyle prompt strips citations.

jest.mock('../utils/secretsManager', () => ({
  getSecret: jest.fn().mockResolvedValue('test-api-key'),
}));

jest.mock('../utils/llmClients', () => ({
  getGeminiClient: jest.fn(),
}));

jest.mock('../config', () => ({
  CONTENT_RESTYLE_MODEL: 'gemini-test-model',
}));

import { restyleContent } from '../controllers/blog';
import { getGeminiClient } from '../utils/llmClients';

describe('restyleContent — blog articles are citation-free (ENG-351 scope decision)', () => {
  let generateContentMock: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    generateContentMock = jest.fn().mockResolvedValue({
      text: JSON.stringify({
        title: 'T',
        description: 'D',
        content: 'C',
        imagePrompt: 'P',
      }),
    });
    (getGeminiClient as jest.Mock).mockResolvedValue({
      models: { generateContent: generateContentMock },
    });
  });

  const getPrompt = (): string => generateContentMock.mock.calls[0][0].contents as string;

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
});
