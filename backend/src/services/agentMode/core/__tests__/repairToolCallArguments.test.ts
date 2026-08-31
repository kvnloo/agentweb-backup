/**
 * ENG-1477: create_html_file / save_file rejected calls whose arguments
 * contained an unescaped quote inside a string value (a report title with a
 * quoted phrase, or HTML content with `class="..."` attributes) with a raw
 * `JSON.parse` error — "Expected ',' or '}' after property value" — even
 * though the call was otherwise well-formed.
 */

import { repairUnescapedQuotes, parseToolCallArguments } from '../repairToolCallArguments';

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
