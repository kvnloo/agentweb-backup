/**
 * ENG-1054: a truncated tool payload must never reach the model as an OPEN
 * structure. The production session's final answer (`}]`) and an earlier
 * 20,081-char echo were the model finishing JSON we had cut mid-string.
 */

import { sealTruncatedPayload, TRUNCATION_NOTICE } from '../truncatedPayload';

/** The payload is only useful to the model if it still parses. */
function parsedBody(sealed: string): any {
  return JSON.parse(sealed.slice(0, sealed.indexOf(TRUNCATION_NOTICE)).trim());
}

describe('sealTruncatedPayload (ENG-1054)', () => {
  it('closes an object cut between keys', () => {
    const sealed = sealTruncatedPayload('{"success":true,"message":"Found 25 ad(s)"');
    expect(parsedBody(sealed)).toEqual({ success: true, message: 'Found 25 ad(s)' });
    expect(sealed).toContain(TRUNCATION_NOTICE);
  });

  it('closes nested arrays and objects in the right order', () => {
    const sealed = sealTruncatedPayload('{"ads":[{"id":"1"},{"id":"2"}');
    expect(parsedBody(sealed)).toEqual({ ads: [{ id: '1' }, { id: '2' }] });
  });

  it('drops a value cut mid-string rather than inventing a whole one', () => {
    // The real ENG-1054 slice ended inside a URL. Closing the quote in place would
    // hand the model a truncated URL that looks complete — worse than omitting it.
    const sealed = sealTruncatedPayload('{"id":"120248669405960585","picture":"https://s3.amaz');
    const body = parsedBody(sealed);
    expect(body).toEqual({ id: '120248669405960585' });
    expect(sealed).not.toContain('https://s3.amaz');
  });

  it('is not fooled by a brace or quote inside a string value', () => {
    const sealed = sealTruncatedPayload('{"name":"P3 A1 [lo-fi] {draft}","status":"PAUSED"');
    expect(parsedBody(sealed)).toEqual({ name: 'P3 A1 [lo-fi] {draft}', status: 'PAUSED' });
  });

  it('is not fooled by an escaped quote', () => {
    const sealed = sealTruncatedPayload('{"caption":"say \\"hi\\"","status":"ACTIVE"');
    expect(parsedBody(sealed)).toEqual({ caption: 'say "hi"', status: 'ACTIVE' });
  });

  it('strips a dangling comma or colon left by the cut', () => {
    expect(parsedBody(sealTruncatedPayload('{"a":1,'))).toEqual({ a: 1 });
    expect(parsedBody(sealTruncatedPayload('{"a":1,"b":'))).toEqual({ a: 1 });
  });

  it('leaves already-balanced JSON alone apart from the notice', () => {
    const sealed = sealTruncatedPayload('{"success":true}');
    expect(parsedBody(sealed)).toEqual({ success: true });
    expect(sealed.startsWith('{"success":true}')).toBe(true);
  });

  it('adds only the notice to a non-JSON payload', () => {
    const sealed = sealTruncatedPayload('Brand guidelines: use the primary logo on light');
    expect(sealed).toBe(`Brand guidelines: use the primary logo on light\n\n${TRUNCATION_NOTICE}`);
  });

  it('seals the REAL production slice that produced the "}]" answer', () => {
    // Verbatim shape of message 213 in session 5ac8aeef… — a knowledge-base listing
    // sliced at the 20,000-char cap, landing inside a Google Storage URL.
    const real =
      '{"success":true,"message":"Found 85 knowledge base(s) with 256 file(s).",'
      + '"knowledge_bases":[{"identifier":"1da58804","name":"Hello World Test","files":['
      + '{"fileName":"knowledge-base.txt","fileSize":220,"url":null}]},'
      + '{"identifier":"e0e7eab4","name":"1_fixed_csv","files":['
      + '{"fileName":"1_fixed.csv","fileSize":4134,"url":"https://storage.googleapis.com/agentweb-knowledge-b';

    const sealed = sealTruncatedPayload(real);
    const body = parsedBody(sealed);

    expect(body.success).toBe(true);
    expect(body.knowledge_bases).toHaveLength(2);
    // The complete entry survives; only the half-written one is dropped.
    expect(body.knowledge_bases[0].name).toBe('Hello World Test');
    expect(body.knowledge_bases[1].name).toBe('1_fixed_csv');
    expect(sealed).toContain(TRUNCATION_NOTICE);
  });
});
