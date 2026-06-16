/**
 * Tests for shortenInviteNoteToLimit — the capped LLM re-generation step used by the
 * invite-note DRAFT paths (CRM draft-note + agent draft-email+message). When a drafted
 * note exceeds the account's char limit we ask the model to rewrite it shorter, up to a
 * bounded number of attempts, then the caller hard-trims as a final guarantee. This is
 * NOT used on the agent inline send path (that one stays pure deterministic trim).
 */

import { shortenInviteNoteToLimit } from '../services/inviteNoteShortener';

const makeClient = (responses: string[]) => {
  const create = jest.fn();
  responses.forEach((r) =>
    create.mockResolvedValueOnce({ choices: [{ message: { content: r } }] }),
  );
  return { create, client: { chat: { completions: { create } } } };
};

const json = (s: string) => JSON.stringify({ content: s });

describe('shortenInviteNoteToLimit', () => {
  it('returns the note unchanged and never calls the model when already under the limit', async () => {
    const { create, client } = makeClient([]);
    const note = 'Fang, your activation-funnel work is sharp.';
    const out = await shortenInviteNoteToLimit(client, note, 200, 2);
    expect(out).toBe(note);
    expect(create).not.toHaveBeenCalled();
  });

  it('returns the rewritten note when the first attempt comes back under the limit', async () => {
    const longNote = 'x'.repeat(260);
    const shortNote = 'Fang, loved your funnel work — keeping it tight here.';
    const { create, client } = makeClient([json(shortNote)]);
    const out = await shortenInviteNoteToLimit(client, longNote, 200, 2);
    expect(out).toBe(shortNote);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('stops after the capped number of attempts and returns the shortest result', async () => {
    const longNote = 'x'.repeat(260);
    const attempt1 = 'y'.repeat(240); // still over, but shorter
    const attempt2 = 'z'.repeat(220); // still over, shorter again
    const { create, client } = makeClient([json(attempt1), json(attempt2)]);
    const out = await shortenInviteNoteToLimit(client, longNote, 200, 2);
    expect(create).toHaveBeenCalledTimes(2);
    expect(out).toBe(attempt2); // shortest seen; caller trims as the hard guarantee
  });

  it('returns as soon as an attempt fits, without using the remaining attempts', async () => {
    const longNote = 'x'.repeat(260);
    const attempt1 = 'y'.repeat(240); // over
    const attempt2 = 'Fang, short and done.'; // fits
    const { create, client } = makeClient([json(attempt1), json(attempt2)]);
    const out = await shortenInviteNoteToLimit(client, longNote, 200, 3);
    expect(create).toHaveBeenCalledTimes(2);
    expect(out).toBe(attempt2);
  });

  it('falls back to the original note when the model call throws', async () => {
    const longNote = 'x'.repeat(260);
    const create = jest.fn().mockRejectedValue(new Error('gemini down'));
    const client = { chat: { completions: { create } } };
    const out = await shortenInviteNoteToLimit(client, longNote, 200, 2);
    expect(out).toBe(longNote);
  });

  it('parses a markdown-fenced JSON response', async () => {
    const longNote = 'x'.repeat(260);
    const shortNote = 'Fang, fenced but fine.';
    const { client } = makeClient(['```json\n' + json(shortNote) + '\n```']);
    const out = await shortenInviteNoteToLimit(client, longNote, 200, 2);
    expect(out).toBe(shortNote);
  });

  it('unwraps a double-encoded JSON content value', async () => {
    const longNote = 'x'.repeat(260);
    const shortNote = 'Fang, double-encoded but recovered.';
    // The "content" value is itself a JSON string: {"content":"{\"content\":\"...\"}"}
    const { client } = makeClient([json(json(shortNote))]);
    const out = await shortenInviteNoteToLimit(client, longNote, 200, 2);
    expect(out).toBe(shortNote);
  });

  it('repairs a response truncated mid-JSON (missing closing quote and brace)', async () => {
    const longNote = 'x'.repeat(260);
    const shortNote = 'Fang, truncated but completed';
    const { client } = makeClient([`{"content":"${shortNote}`]); // no closing " or }
    const out = await shortenInviteNoteToLimit(client, longNote, 200, 2);
    expect(out).toBe(shortNote);
  });

  it('falls back to quote extraction when the JSON does not parse', async () => {
    const longNote = 'x'.repeat(260);
    const shortNote = 'Fang concise note here';
    // No braces at all → JSON block parse is skipped, quote-after-"content" path runs.
    const { client } = makeClient([`"content": "${shortNote}"`]);
    const out = await shortenInviteNoteToLimit(client, longNote, 200, 2);
    expect(out).toBe(shortNote);
  });

  it('keeps the original when the model returns an empty/garbage response', async () => {
    const longNote = 'x'.repeat(260);
    // Empty content both attempts → no usable candidate → original returned, caller trims.
    const { create, client } = makeClient(['', 'no json here at all']);
    const out = await shortenInviteNoteToLimit(client, longNote, 200, 2);
    expect(out).toBe(longNote);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('rejects a candidate that is not shorter than the current best', async () => {
    const longNote = 'x'.repeat(260);
    const longerNote = 'y'.repeat(280); // parses fine but is longer → must be ignored
    const { create, client } = makeClient([json(longerNote), json(longerNote)]);
    const out = await shortenInviteNoteToLimit(client, longNote, 200, 2);
    expect(out).toBe(longNote); // best never replaced by a longer candidate
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('treats a non-positive attempts value as no re-generation', async () => {
    const longNote = 'x'.repeat(260);
    const { create, client } = makeClient([json('short')]);
    const out = await shortenInviteNoteToLimit(client, longNote, 200, 0);
    expect(out).toBe(longNote);
    expect(create).not.toHaveBeenCalled();
  });

  it('defaults to 2 attempts when the count is omitted', async () => {
    const longNote = 'x'.repeat(260);
    const longerNote = 'y'.repeat(280); // never fits → exhausts the default cap
    const { create, client } = makeClient([json(longerNote), json(longerNote)]);
    const out = await shortenInviteNoteToLimit(client, longNote, 200); // no attempts arg
    expect(out).toBe(longNote);
    expect(create).toHaveBeenCalledTimes(2); // proves the default of 2
  });

  it('tolerates a response object with no choices (keeps the original)', async () => {
    const longNote = 'x'.repeat(260);
    const create = jest.fn().mockResolvedValue({}); // no .choices at all
    const client = { chat: { completions: { create } } };
    const out = await shortenInviteNoteToLimit(client, longNote, 200, 2);
    expect(out).toBe(longNote);
  });

  it('tolerates a null completion (keeps the original)', async () => {
    const longNote = 'x'.repeat(260);
    const create = jest.fn().mockResolvedValue(null); // model client returns nothing
    const client = { chat: { completions: { create } } };
    const out = await shortenInviteNoteToLimit(client, longNote, 200, 2);
    expect(out).toBe(longNote);
  });

  it('tolerates a choice whose message has no content field', async () => {
    const longNote = 'x'.repeat(260);
    const create = jest.fn().mockResolvedValue({ choices: [{ message: {} }] }); // message present, content missing
    const client = { chat: { completions: { create } } };
    const out = await shortenInviteNoteToLimit(client, longNote, 200, 2);
    expect(out).toBe(longNote);
  });

  it('handles a null content field in the parsed JSON', async () => {
    const longNote = 'x'.repeat(260);
    const { client } = makeClient(['{"content":null}', '{"content":null}']);
    const out = await shortenInviteNoteToLimit(client, longNote, 200, 2);
    expect(out).toBe(longNote); // null → empty → no usable candidate
  });

  it('keeps the outer value when a double-encoded inner JSON has no usable content', async () => {
    const longNote = 'x'.repeat(260);
    // Outer content is itself JSON whose inner content is null → unwrap falls back to the
    // outer value string (exercises the `?? val` arm), which is shorter so it is accepted.
    const { client } = makeClient([json('{"content":null}')]);
    const out = await shortenInviteNoteToLimit(client, longNote, 200, 2);
    expect(out).toBe('{"content":null}');
  });
});
