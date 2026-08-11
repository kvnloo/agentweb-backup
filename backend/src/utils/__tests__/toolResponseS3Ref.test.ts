/**
 * Unit tests for toolResponseS3Ref — the tool-response recovery/notice headers.
 *
 * These headers are the only thing that tells a later turn how much of a
 * compressed tool result it is still allowed to trust, so the builders and the
 * matchers are pinned here directly rather than only through the agent-mode
 * suites that consume them (ENG-940).
 *
 * This file deliberately lives outside `__tests__/agentMode*`: CI splits the
 * backend suites into an agentMode job and an "all other + coverage" job, and
 * only the latter measures coverage. A util exercised solely through the
 * agentMode suites therefore reports as uncovered no matter how well tested it
 * is — and a pure util of this size deserves its own test regardless.
 */

import {
  buildToolResponseS3Header,
  buildToolResponseUnavailableHeader,
  extractToolResponseHeader,
  extractToolResponseS3Ref,
  parseToolResponseS3Key,
} from '../toolResponseS3Ref';

const KEY = 'tool-responses/da2a8433-3c62-4e56-be04-a86f164969f3/tooluse_9Qb1Kx7ZTAyH3mNpVrW8sQ_0.txt';

describe('buildToolResponseS3Header', () => {
  it('names the key, the size, and the tool that reads it back', () => {
    const header = buildToolResponseS3Header(KEY, 8981);
    expect(header).toContain(KEY);
    expect(header).toContain('(8981 chars)');
    expect(header).toContain('search_tool_response');
    // Trailing blank line so the payload that follows starts cleanly.
    expect(header.endsWith('\n\n')).toBe(true);
  });
});

describe('buildToolResponseUnavailableHeader', () => {
  it('states the loss and forbids inferring from the later preview', () => {
    const header = buildToolResponseUnavailableHeader(8981);
    expect(header).toContain('could NOT be stored');
    expect(header).toContain('(8981 chars)');
    expect(header).toMatch(/only copy/i);
    expect(header).toMatch(/do NOT infer/i);
    expect(header.endsWith('\n\n')).toBe(true);
  });

  it('offers no key, because there is none', () => {
    expect(parseToolResponseS3Key(buildToolResponseUnavailableHeader(10))).toBeNull();
  });
});

describe('extractToolResponseS3Ref', () => {
  it('returns the whole leading header, newlines included', () => {
    const header = buildToolResponseS3Header(KEY, 100);
    expect(extractToolResponseS3Ref(header + 'the payload')).toBe(header);
  });

  it('returns null for content with no header', () => {
    expect(extractToolResponseS3Ref('{"totalPRs": 2}')).toBeNull();
  });

  it('returns null when the header is not at the very start', () => {
    // toolDispatch always PREPENDS, so a bracket sequence mid-payload is data.
    expect(extractToolResponseS3Ref('noise ' + buildToolResponseS3Header(KEY, 100))).toBeNull();
  });

  it('does not treat the unavailable notice as an S3 reference', () => {
    expect(extractToolResponseS3Ref(buildToolResponseUnavailableHeader(100))).toBeNull();
  });
});

describe('parseToolResponseS3Key', () => {
  it('round-trips a realistic key verbatim', () => {
    expect(parseToolResponseS3Key(buildToolResponseS3Header(KEY, 8981) + 'body')).toBe(KEY);
  });

  it('reads back a key long enough to run past a naive 200-char slice', () => {
    const longKey = `tool-responses/${'s'.repeat(60)}/tooluse_${'K'.repeat(90)}.txt`;
    expect(parseToolResponseS3Key(buildToolResponseS3Header(longKey, 12345) + 'body')).toBe(longKey);
  });

  it('returns null for content with no header', () => {
    expect(parseToolResponseS3Key('plain tool output')).toBeNull();
  });
});

describe('extractToolResponseHeader', () => {
  it('matches an S3 reference header', () => {
    const header = buildToolResponseS3Header(KEY, 100);
    expect(extractToolResponseHeader(header + 'body')).toBe(header);
  });

  it('matches an unavailable notice', () => {
    const header = buildToolResponseUnavailableHeader(9000);
    expect(extractToolResponseHeader(header + 'body')).toBe(header);
  });

  it('returns null when neither header is present', () => {
    expect(extractToolResponseHeader('plain tool output')).toBeNull();
  });

  it('returns null when a notice is not at the very start', () => {
    expect(extractToolResponseHeader('noise ' + buildToolResponseUnavailableHeader(10))).toBeNull();
  });
});
