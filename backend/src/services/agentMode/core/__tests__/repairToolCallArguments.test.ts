/**
 * ENG-1477: create_html_file / save_file rejected calls whose arguments
 * contained an unescaped quote inside a string value (a report title with a
 * quoted phrase, or HTML content with `class="..."` attributes) with a raw
 * `JSON.parse` error — "Expected ',' or '}' after property value" — even
 * though the call was otherwise well-formed.
 */

import {
  repairUnescapedQuotes,
  parseToolCallArguments,
  isTruncatedJsonPrefix,
  TruncatedToolCallArgumentsError,
} from '../repairToolCallArguments';

describe('repairUnescapedQuotes (ENG-1477)', () => {
  it('escapes an unescaped quote inside a string value', () => {
    const raw = '{"title":"Phoenix "FFL" Report","content_draft":"hi"}';
    expect(JSON.parse(repairUnescapedQuotes(raw))).toEqual({
      title: 'Phoenix "FFL" Report',
      content_draft: 'hi',
    });
  });

  it('escapes unescaped quotes from HTML attribute markup', () => {
    const raw = '{"title":"ok","content_draft":"<div class="header">Hi</div>"}';
    expect(JSON.parse(repairUnescapedQuotes(raw))).toEqual({
      title: 'ok',
      content_draft: '<div class="header">Hi</div>',
    });
  });

  it('leaves already-valid JSON parseable (round-trips to the same value)', () => {
    const raw = '{"title":"ok","content_draft":"hi","n":3}';
    expect(JSON.parse(repairUnescapedQuotes(raw))).toEqual({ title: 'ok', content_draft: 'hi', n: 3 });
  });

  it('does not touch a legitimately escaped quote', () => {
    const raw = '{"caption":"say \\"hi\\"","status":"ACTIVE"}';
    expect(JSON.parse(repairUnescapedQuotes(raw))).toEqual({ caption: 'say "hi"', status: 'ACTIVE' });
  });

  it('handles multiple unescaped quotes across multiple properties', () => {
    const raw = '{"a":"x "y" z","b":"p "q" r"}';
    expect(JSON.parse(repairUnescapedQuotes(raw))).toEqual({ a: 'x "y" z', b: 'p "q" r' });
  });

  // ENG-1477 review finding: a plain "quote then comma" lookahead misreads a
  // comma-adjacent embedded quote as the string's real terminator — exactly
  // the shape of a CSS font-family list or an unescaped JS/JSON array
  // literal inside styled HTML report content. The comma must only close the
  // string when what follows genuinely looks like the next property.
  it('keeps a comma-adjacent embedded quote open inside a CSS font-family list', () => {
    const raw = '{"title":"Report","content_draft":"<style>body{font-family:"Arial",sans-serif}</style>"}';
    expect(JSON.parse(repairUnescapedQuotes(raw))).toEqual({
      title: 'Report',
      content_draft: '<style>body{font-family:"Arial",sans-serif}</style>',
    });
  });

  it('keeps a comma-adjacent embedded quote open inside an unescaped JSON array literal', () => {
    const raw = '{"title":"Chart","content_draft":"data: [1, "two", 3]"}';
    expect(JSON.parse(repairUnescapedQuotes(raw))).toEqual({
      title: 'Chart',
      content_draft: 'data: [1, "two", 3]',
    });
  });

  // Follow-up gap: a literal `]`/`}` right after a quote used to be treated as
  // ALWAYS terminal, regardless of container — so an embedded array/object
  // literal whose LAST element is itself quoted mis-terminated the string one
  // character early, at the quote closing that last element.
  it('keeps a quote open when it is immediately followed by an embedded (non-real) array-closing bracket', () => {
    const raw = '{"title":"Config","content_draft":"Use ["a","b","c"] as the default list."}';
    expect(JSON.parse(repairUnescapedQuotes(raw))).toEqual({
      title: 'Config',
      content_draft: 'Use ["a","b","c"] as the default list.',
    });
  });

  it('keeps a quote open when it is immediately followed by an embedded (non-real) object-closing brace inside an array element', () => {
    // Mirror of the `]` case, on the `}` side: a quote+`}` immediately after
    // can only be a real terminator when the container is actually an
    // object — here the string is an ARRAY element, so the embedded `{"x"}`
    // is just prose and must not close the string early.
    const raw = '{"tags":["a","Use {"x"} as an example"]}';
    expect(JSON.parse(repairUnescapedQuotes(raw))).toEqual({
      tags: ['a', 'Use {"x"} as an example'],
    });
  });

  it('still terminates a real string on `]` when the container genuinely is an array', () => {
    const raw = '{"tags":["a","say "hi" now"]}';
    expect(JSON.parse(repairUnescapedQuotes(raw))).toEqual({
      tags: ['a', 'say "hi" now'],
    });
  });
});

describe('isTruncatedJsonPrefix (ENG-1477 follow-up)', () => {
  it('flags a payload that stops mid-object with no closing brace', () => {
    expect(isTruncatedJsonPrefix('{"title":"Phoenix FFL Merchants — 30-Day Report"')).toBe(true);
  });

  it('flags a payload that stops mid-string (unterminated quote)', () => {
    expect(isTruncatedJsonPrefix('{"title":"cut off partway thro')).toBe(true);
  });

  it('does not flag a complete, self-closed object', () => {
    expect(isTruncatedJsonPrefix('{"title":"ok","content_draft":"hi"}')).toBe(false);
  });

  it('does not flag genuinely malformed-but-complete JSON (depth returns to 0)', () => {
    expect(isTruncatedJsonPrefix('{not json}')).toBe(false);
  });

  it('ignores brackets embedded inside string content when computing depth', () => {
    // The trailing `]` here is prose inside the string, not real structure —
    // depth never left 0 because of it, so this is NOT a truncation.
    expect(isTruncatedJsonPrefix('{"content_draft":"Use [1,2,3] as the list."}')).toBe(false);
  });
});

describe('parseToolCallArguments — truncation (ENG-1477 follow-up)', () => {
  it('throws TruncatedToolCallArgumentsError for a clean prefix missing the closing brace', () => {
    const raw = '{"title":"Phoenix FFL Merchants — 30-Day Meta Performance and Creative Fatigue Report"';
    expect(() => parseToolCallArguments(raw)).toThrow(TruncatedToolCallArgumentsError);
  });

  it('throws TruncatedToolCallArgumentsError for a payload missing the required trailing field entirely', () => {
    // Matches the real production shape: title + format_requirements present,
    // content_draft never started, no trailing comma, no closing brace.
    const raw = '{"title":"Report","format_requirements":"Dark theme with Manrope font."';
    expect(() => parseToolCallArguments(raw)).toThrow(TruncatedToolCallArgumentsError);
  });

  it('still throws the original JSON.parse error for non-truncated malformed JSON', () => {
    let expected: Error | undefined;
    try {
      JSON.parse('{not json}');
    } catch (e) {
      expected = e as Error;
    }
    expect(() => parseToolCallArguments('{not json}')).toThrow(expected!.message);
  });

  it('does not misclassify a recoverable unescaped-quote payload as truncated', () => {
    const raw = '{"title":"Phoenix FFL Merchants — "Creative Fatigue" Audit"}';
    expect(parseToolCallArguments(raw)).toEqual({
      title: 'Phoenix FFL Merchants — "Creative Fatigue" Audit',
    });
  });
});

describe('parseToolCallArguments (ENG-1477)', () => {
  it('parses well-formed arguments directly', () => {
    expect(parseToolCallArguments('{"title":"ok"}')).toEqual({ title: 'ok' });
  });

  it('recovers a title containing an unescaped quoted phrase', () => {
    const raw = '{"title":"Phoenix FFL Merchants — "Creative Fatigue" Audit"}';
    expect(parseToolCallArguments(raw)).toEqual({
      title: 'Phoenix FFL Merchants — "Creative Fatigue" Audit',
    });
  });

  it('recovers a large content_draft with embedded HTML attribute quotes', () => {
    const raw = '{"title":"Report","content_draft":"<section class="kpi" data-id="1">Spend $4,001.72</section>"}';
    const parsed = parseToolCallArguments(raw);
    expect(parsed.title).toBe('Report');
    expect(parsed.content_draft).toBe('<section class="kpi" data-id="1">Spend $4,001.72</section>');
  });

  it('throws the original JSON.parse error when the payload is not recoverable', () => {
    let expected: Error | undefined;
    try {
      JSON.parse('{not json}');
    } catch (e) {
      expected = e as Error;
    }
    expect(() => parseToolCallArguments('{not json}')).toThrow(expected!.message);
  });
});
