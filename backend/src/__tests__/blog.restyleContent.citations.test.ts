// ENG-351: the deep-research → blog path pipes performDeepResearch output (which now
// carries inline source citations next to quoted figures) through restyleContent. The
// restyle prompt must NOT strip those inline attributions — it should only clean up bare
// academic markers (numbered footnotes, trailing bibliographies) while keeping the source
// sitting next to each figure, matching the Claude/Gemini inline-citation style.

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

describe('restyleContent — inline citation preservation (ENG-351)', () => {
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

  it('instructs the model to preserve inline source attributions next to figures', async () => {
    await restyleContent('The market grew to $5B (Gartner, 2025).', 'AI market');

    const prompt = getPrompt();
    expect(prompt).toMatch(/KEEP inline source attributions/i);
    expect(prompt).toMatch(/Claude\/Gemini/i);
  });

  it('does not tell the model to remove ALL citations and references', async () => {
    await restyleContent('Revenue rose 12% (Statista).', 'revenue');

    const prompt = getPrompt();
    expect(prompt).not.toMatch(/REMOVE ALL CITATIONS AND REFERENCES/);
    expect(prompt).not.toMatch(/remove the citation markers entirely/i);
  });

  it('still strips bare academic markers and bibliography sections', async () => {
    await restyleContent('A fact [1] with a references section.', 'topic');

    const prompt = getPrompt();
    expect(prompt).toMatch(/bibliography/i);
    expect(prompt).toMatch(/\[1\]/);
  });
});
