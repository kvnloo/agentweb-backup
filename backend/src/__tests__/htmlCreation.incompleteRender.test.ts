jest.mock('../services/usageRecorderService', () => ({ meterUserUsage: jest.fn() }));
const mockCallLLM = jest.fn();
jest.mock('../services/agentModeService', () => ({ agentModeService: { callLLM: mockCallLLM } }));

import { LLMService } from '../utils/llmService';
import {
  assertCompleteHtmlRender,
  isIncompleteHtmlRenderError,
} from '../emma/impl/htmlCreation';

// ENG-2679 regression: the real truncated render from session b0c3fe70 — a 3-person
// brief whose output stopped after person 1's header, then auto-closed by the sanitizer.
const draft = [
  'PERSON 1 — PRAVEEN SATTARU', 'Verified against his live LinkedIn profile. '.repeat(30),
  'PERSON 2 — DR. ANIL KUMAR SISTU', 'Orthopedic surgeon listed by Global Neuro Care. '.repeat(30),
  'PERSON 3 — MADHURI VEGARAJU', 'Director of Software Engineering, Redmond. '.repeat(30),
].join('\n');
const head = '<!DOCTYPE html><html><head><style>body{}</style></head><body><h1>Meeting Brief</h1>';
const truncated = `${head}<div class="person-card"><span>Praveen Sattaru</span><p>Primary source:`;

describe('ENG-2679 incomplete HTML render detection', () => {
  it('rejects a render missing </html>', () => {
    expect(() => assertCompleteHtmlRender(truncated, draft)).toThrow(/missing closing/);
  });

  it('rejects a closed document that dropped most of the draft (sanitizer auto-close case)', () => {
    let err: unknown;
    try { assertCompleteHtmlRender(`${truncated}</p></div></body></html>`, draft); } catch (e) { err = e; }
    expect(isIncompleteHtmlRenderError(err)).toBe(true);
  });

  it('accepts a complete render that carries the draft content', () => {
    const full = `${head}${draft.split('\n').map((l) => `<p>${l}</p>`).join('')}</body></html>`;
    expect(() => assertCompleteHtmlRender(full, draft)).not.toThrow();
  });

  it('does not apply the coverage floor to short drafts', () => {
    expect(() => assertCompleteHtmlRender('<html><body><h1>Hi</h1></body></html>', 'Short banner text')).not.toThrow();
  });

  it('generateHTML throws on finish_reason=length instead of returning the partial', async () => {
    mockCallLLM.mockResolvedValueOnce({ choices: [{ finish_reason: 'length', message: { content: truncated } }] });
    await expect(new LLMService('anthropic.claude-sonnet-4-6', 0.8, 64000).generateHTML('s', 'u'))
      .rejects.toMatchObject({ name: 'IncompleteHtmlRenderError' });
  });

  it('generateHTML still returns content when finish_reason=stop', async () => {
    mockCallLLM.mockResolvedValueOnce({ choices: [{ finish_reason: 'stop', message: { content: '<actual_html_content><html></html></actual_html_content>' } }] });
    await expect(new LLMService('anthropic.claude-sonnet-4-6', 0.8, 64000).generateHTML('s', 'u')).resolves.toBe('<html></html>');
  });
});
