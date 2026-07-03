/**
 * Unit tests for the tool-output minimum contract (ENG-105).
 *
 * Imports ONLY the narrow pure validator — no AgentModeService run loop. The
 * extractor is a tiny equivalent of extractToolContent (formattedContent >
 * content[0].text > JSON.stringify) so the test stays isolated + fast.
 */

import { validateToolOutputContract, ToolOutputContractError } from '../utils/toolOutputContract';

// Mirrors agentModeService.extractToolContent without importing the monolith.
function extract(result: any): string {
  if (typeof result === 'string') return result;
  if (result?.formattedContent) return result.formattedContent;
  if (result?.content?.[0]?.text) return result.content[0].text;
  return JSON.stringify(result);
}

describe('validateToolOutputContract (ENG-105)', () => {
  describe('invalid output -> ToolOutputContractError', () => {
    it('flags undefined', () => {
      const err = validateToolOutputContract(undefined, extract);
      expect(err).toBeInstanceOf(ToolOutputContractError);
    });

    it('flags null', () => {
      expect(validateToolOutputContract(null, extract)).toBeInstanceOf(ToolOutputContractError);
    });

    it('flags an empty object {} (extracts to "{}")', () => {
      expect(validateToolOutputContract({}, extract)).toBeInstanceOf(ToolOutputContractError);
    });

    it('flags an empty content array', () => {
      expect(validateToolOutputContract({ content: [] }, extract)).toBeInstanceOf(ToolOutputContractError);
    });

    it('flags a content array whose parts have only blank text', () => {
      expect(validateToolOutputContract({ content: [{ text: '   ' }] }, extract)).toBeInstanceOf(ToolOutputContractError);
    });

    it('flags a result that extracts to the literal string "undefined"', () => {
      // extract(undefined-producing object) — simulate a tool that returns a value
      // whose extraction is the string 'undefined'.
      const weird = { toString: () => 'undefined' } as any;
      // Force the extractor to yield 'undefined' for this shape.
      const err = validateToolOutputContract(weird, () => 'undefined');
      expect(err).toBeInstanceOf(ToolOutputContractError);
    });
  });

  describe('valid output -> null (behavior-preserving)', () => {
    it('accepts a truthy formattedContent', () => {
      expect(validateToolOutputContract({ formattedContent: 'GTM Plan: step 1...' }, extract)).toBeNull();
    });

    it('accepts a plain non-empty string', () => {
      expect(validateToolOutputContract('plain string result', extract)).toBeNull();
    });

    it('accepts an MCP content array with text', () => {
      expect(validateToolOutputContract({ content: [{ text: 'hi' }] }, extract)).toBeNull();
    });

    it('accepts a plain data object that relies on the JSON.stringify fallback', () => {
      expect(validateToolOutputContract({ leads: [{ id: 1 }] }, extract)).toBeNull();
    });

    it('accepts an image-only content array — non-text parts are NOT empty output (ENG-105 false-positive fix)', () => {
      // A tool that returns a generated image as the only content part has no
      // `.text`, but the image IS the payload — it must NOT be downgraded.
      expect(
        validateToolOutputContract(
          { content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KG...' } }] },
          extract,
        ),
      ).toBeNull();
    });

    it('accepts a content array mixing a blank text part with a non-text part', () => {
      // Even when one part has empty text, a sibling non-text part keeps the output usable.
      expect(
        validateToolOutputContract(
          { content: [{ type: 'text', text: '' }, { type: 'image', source: { data: 'x' } }] },
          extract,
        ),
      ).toBeNull();
    });
  });
});
