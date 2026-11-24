import { classifyToolFailureType } from '../utils/toolFailureType';
import { CALLER_URL_BLOCKED_MESSAGE } from '../utils/callerUrlFetch';

describe('ENG-3165: caller-URL SSRF refusal is by_design, not a tool bug', () => {
  it('classifies the raw guard refusal as by_design', () => {
    expect(classifyToolFailureType('Error', CALLER_URL_BLOCKED_MESSAGE)).toBe('by_design');
  });

  it('classifies the create_html_template wrapped refusal as by_design', () => {
    expect(classifyToolFailureType('Error', `Failed to fetch HTML from URL: ${CALLER_URL_BLOCKED_MESSAGE}`)).toBe('by_design');
    expect(classifyToolFailureType(undefined, `Failed to fetch HTML from URL: ${CALLER_URL_BLOCKED_MESSAGE}`)).toBe('by_design');
  });

  it('keeps genuine fetch failures out of by_design', () => {
    for (const m of ['Failed to fetch HTML from URL: socket hang up', 'Failed to fetch HTML from URL: read ECONNRESET', 'Failed to fetch HTML from URL: Request failed with status code 502']) {
      expect(classifyToolFailureType('Error', m)).not.toBe('by_design');
    }
  });
});
