/**
 * ENG-1477: create_html_file / save_file rejected calls whose arguments
 * contained an unescaped quote inside a string value (a report title with a
 * quoted phrase, or HTML content with `class="..."` attributes) with a raw
 * `JSON.parse` error — "Expected ',' or '}' after property value" — even
 * though the call was otherwise well-formed.
 */

import {
  repairUnescapedQuotes,
  hasDuplicateObjectKeys,
  parseToolCallArguments,
  normalizeRepairedToolCallArguments,
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

describe('hasDuplicateObjectKeys (ENG-1477 security follow-up)', () => {
  it('returns false for well-formed JSON with no repeated keys', () => {
    expect(hasDuplicateObjectKeys('{"title":"ok","content_draft":"hi","n":3}')).toBe(false);
  });

  it('returns false when the same key text appears only as a nested value, never as a key', () => {
    expect(hasDuplicateObjectKeys('{"title":"the \\"title\\" field is required"}')).toBe(false);
  });

  it('returns true when a top-level key is repeated', () => {
    expect(hasDuplicateObjectKeys('{"title":"Real Title","content_draft":"x","title":"HACKED"}')).toBe(true);
  });

  it('returns true when a key is repeated inside a nested object, not just top-level', () => {
    expect(hasDuplicateObjectKeys('{"a":{"b":"1","b":"2"}}')).toBe(true);
  });

  it('does not confuse array elements with object keys', () => {
    // Same string repeated twice, but as array elements — never followed by
    // `:`, so never in key position. Must not be flagged.
    expect(hasDuplicateObjectKeys('{"tags":["x","x"]}')).toBe(false);
  });

  it('tracks a fresh key-set per nested object, so the same key name in sibling objects is fine', () => {
    expect(hasDuplicateObjectKeys('{"a":{"id":"1"},"b":{"id":"2"}}')).toBe(false);
  });

  // CodeRabbit review on this PR: the check must compare DECODED key values,
  // not raw tokenizer spelling, or a unicode-escaped letter lets an attacker
  // spell a duplicate key differently from the original and dodge detection.
  it('recognizes a unicode-escaped spelling of an existing key as a duplicate', () => {
    const raw = '{"title":"Real","content_draft":"x","tit' + '\\u006c' + 'e":"HACKED"}';
    expect(raw).toContain('\\u006c');
    expect(hasDuplicateObjectKeys(raw)).toBe(true);
  });

  it('does not confuse two DIFFERENT keys that merely share letters after decoding', () => {
    const raw = '{"title":"Real","tit' + '\\u0079' + '":"other"}'; // "tity", not "title"
    expect(hasDuplicateObjectKeys(raw)).toBe(false);
  });
});

describe('parseToolCallArguments — argument injection via repair (ENG-1477 security follow-up)', () => {
  // ENG-1477 review finding: repairUnescapedQuotes's comma heuristic decides a
  // quote is a real string terminator whenever what follows merely LOOKS LIKE
  // the next property (`"key":`). Untrusted echoed content in content_draft
  // (e.g. scraped text) that happens to contain that exact shape gets split
  // into fake structure, and JSON.parse silently keeps the LAST occurrence of
  // a duplicate key — clobbering a legitimate argument with attacker-supplied
  // content. Reproduced directly: without the hasDuplicateObjectKeys guard,
  // this exact payload parses "successfully" with title overwritten to
  // 'HACKED"' and content_draft truncated to just the text before it.
  it('refuses to accept a repair that would inject/overwrite a top-level key via a lookalike property', () => {
    const raw = '{"title":"Real Title","content_draft":"Intro: "quoted phrase", "title":"HACKED""}';
    let expected: Error | undefined;
    try {
      JSON.parse(raw);
    } catch (e) {
      expected = e as Error;
    }
    // Must fail the same way a direct JSON.parse would — never silently
    // return an object with the injected/overwritten title.
    expect(() => parseToolCallArguments(raw)).toThrow(expected!.message);
  });

  it('still recovers the legitimate unescaped-quote case that does not create a duplicate key', () => {
    const raw = '{"title":"Phoenix FFL Merchants — "Creative Fatigue" Audit"}';
    expect(parseToolCallArguments(raw)).toEqual({
      title: 'Phoenix FFL Merchants — "Creative Fatigue" Audit',
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

  // CodeRabbit review on this PR: plain depth-counting (ignoring bracket
  // TYPE) misses cases that are already definitively invalid rather than
  // merely incomplete — appending more bytes can never fix them, so telling
  // the model "retry the same call" is actively wrong guidance.
  it('does not flag a lone stray closing brace as truncated', () => {
    // No opener at all — cannot become valid JSON by appending bytes.
    expect(isTruncatedJsonPrefix('}')).toBe(false);
  });

  it('does not flag a complete object with extra trailing structure as truncated', () => {
    // The object closed cleanly at the first `}` — the second `}` is
    // trailing garbage, not evidence the stream was cut off.
    expect(isTruncatedJsonPrefix('{"title":"ok"}}')).toBe(false);
  });

  it('does not flag mismatched bracket types (object opened, array-closed) as truncated', () => {
    expect(isTruncatedJsonPrefix('{"tags":[1,2}')).toBe(false);
  });

  it('does not flag a colon with a missing value (nothing before the closing brace) as truncated', () => {
    expect(isTruncatedJsonPrefix('{"title":}')).toBe(false);
  });

  it('still flags the real truncation shape: cut off immediately after a colon', () => {
    // Genuine case: the stream stopped before the value token even started —
    // there is no terminator character there at all, just end-of-input.
    expect(isTruncatedJsonPrefix('{"title":')).toBe(true);
  });

  it('still flags an unclosed nested array as truncated', () => {
    expect(isTruncatedJsonPrefix('{"tags":["a","b"')).toBe(true);
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

describe('parseToolCallArguments — duplicated concatenated objects (ENG-2597)', () => {
  it('collapses identical empty objects emitted twice', () => {
    expect(parseToolCallArguments('{}{}')).toEqual({});
  });

  it('collapses byte-identical objects, including whitespace-separated', () => {
    expect(parseToolCallArguments('{"a":1}{"a":1}')).toEqual({ a: 1 });
    expect(parseToolCallArguments('{"a":1,"b":"x}{"} \n {"a":1,"b":"x}{"}{"a":1,"b":"x}{"}')).toEqual({ a: 1, b: 'x}{' });
  });

  it('does not collapse objects that differ only textually (key order) — exact duplicates only', () => {
    expect(() => parseToolCallArguments('{"a":1,"b":2}{"b":2,"a":1}')).toThrow();
  });

  it('does not collapse objects whose long numeric ids differ but round to the same double', () => {
    expect(() => parseToolCallArguments(
      '{"customer_id":12345678901234567890}{"customer_id":12345678901234567891}',
    )).toThrow();
  });

  it('still throws when the concatenated objects differ', () => {
    expect(() => parseToolCallArguments('{"a":1}{"a":2}')).toThrow(/Unexpected non-whitespace/);
    expect(() => parseToolCallArguments('{"to":"a@x.com"}{"to":"b@x.com"}')).toThrow();
  });

  it('does not treat non-object trailing content as a duplicate', () => {
    expect(() => parseToolCallArguments('{}x')).toThrow();
    expect(() => parseToolCallArguments('{}[]')).toThrow();
  });
});

describe('normalizeRepairedToolCallArguments (ENG-2597 history replay)', () => {
  it('rewrites malformed raw arguments to the repaired JSON so history replays one valid object', () => {
    const toolCall = { function: { arguments: '{"platform":"twitter"}{"platform":"twitter"}' } };
    const parsed = parseToolCallArguments(toolCall.function.arguments);
    normalizeRepairedToolCallArguments(toolCall, parsed);
    expect(JSON.parse(toolCall.function.arguments)).toEqual({ platform: 'twitter' });
  });

  it('leaves already-valid arguments byte-for-byte untouched', () => {
    const raw = '{ "b": 2, "a": 1 }';
    const toolCall = { function: { arguments: raw } };
    normalizeRepairedToolCallArguments(toolCall, { a: 1, b: 2 });
    expect(toolCall.function.arguments).toBe(raw);
  });

  it('ignores tool calls without string arguments', () => {
    expect(() => normalizeRepairedToolCallArguments(undefined, {})).not.toThrow();
    const toolCall = { function: { arguments: { a: 1 } as unknown } };
    normalizeRepairedToolCallArguments(toolCall, { a: 1 });
    expect(toolCall.function.arguments).toEqual({ a: 1 });
  });
});
