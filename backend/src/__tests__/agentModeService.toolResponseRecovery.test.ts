/**
 * ENG-940 — a large tool response must always keep a recovery path.
 *
 * Two independent limits decide what the model can still read on a later turn:
 *
 *   1. TOOL_RESPONSE_S3_THRESHOLD — above this, toolDispatch uploads the FULL
 *      response to S3 and prepends a "[Full response stored at S3 key: …]"
 *      header so search_tool_response / read_tool_response can page through it.
 *   2. CONTEXT_TRIM_TOOL_CONTENT_LIMIT — above this, trimToolMessagesForContext
 *      compresses an older tool message down to a 200-char preview.
 *
 * When the trim floor sat BELOW the S3 threshold there was a dead zone
 * (8,000–10,000 chars) where a response was big enough to be compressed away
 * but too small to be offloaded: the payload was destroyed with no key to
 * recover it. That is exactly what happened to the Daily PR Digest run — its
 * get_pr_digest payload was ~8,981 chars, so the model was left with a 200-char
 * preview cut mid-URL and no way back to the PR titles/authors/diff stats.
 *
 * A second failure mode is the header itself: the 200-char preview slices from
 * the START of the content and then wraps it in "[Tool: name — …...]", so the
 * recovery header no longer sits at the front of the compressed output. Both
 * extractToolResponseS3Ref and parseToolResponseS3Key are ^-anchored, so the
 * key becomes unreadable even when its characters survive — and for a key long
 * enough to run past the 200-char slice (>167 chars, since the header prefix is
 * 33) the characters do not survive either.
 */

import {
  TOOL_RESPONSE_S3_THRESHOLD,
  CONTEXT_TRIM_TOOL_CONTENT_LIMIT,
  AgentModeService,
} from '../services/agentModeService';
import {
  buildToolResponseS3Header,
  buildToolResponseUnavailableHeader,
  extractToolResponseHeader,
  extractToolResponseS3Ref,
  parseToolResponseS3Key,
} from '../utils/toolResponseS3Ref';

// The real get_pr_digest payload size for the reported run (2 merged PRs).
const PR_DIGEST_PAYLOAD_SIZE = 8981;

describe('ENG-940: tool responses that can be trimmed away are always offloaded', () => {
  it('never leaves a dead zone between the S3 offload threshold and the context-trim floor', () => {
    // Anything the trimmer is allowed to destroy must already be in S3.
    expect(TOOL_RESPONSE_S3_THRESHOLD).toBeLessThanOrEqual(CONTEXT_TRIM_TOOL_CONTENT_LIMIT);
  });

  it('offloads a PR-digest-sized payload (~8,981 chars) so a later turn can recover it', () => {
    expect(PR_DIGEST_PAYLOAD_SIZE).toBeGreaterThan(TOOL_RESPONSE_S3_THRESHOLD);
  });

  it('keeps every per-tool trim allowance at or above the S3 offload threshold', () => {
    // A per-tool allowance below the threshold would re-open the dead zone for
    // that tool only — the invariant has to hold for each entry, not just the
    // default floor.
    const limits: Record<string, number> = (AgentModeService as any).LARGE_TOOL_RESULT_LIMIT;
    for (const [toolName, limit] of Object.entries(limits)) {
      expect(`${toolName}:${limit >= TOOL_RESPONSE_S3_THRESHOLD}`).toBe(`${toolName}:true`);
    }
  });
});

describe('ENG-940: trimming preserves the S3 recovery reference', () => {
  // A realistic key: "tool-responses/" + a 36-char sessionId + a Bedrock
  // tool_use id. Its characters survive a naive 200-char slice (the key ends at
  // index 121), but the slice is re-wrapped in "[Tool: name — …]" so the header
  // is no longer at the front and the ^-anchored parser cannot read it back.
  const s3Key =
    'tool-responses/da2a8433-3c62-4e56-be04-a86f164969f3/tooluse_9Qb1Kx7ZTAyH3mNpVrW8sQ_0.txt';

  function buildMessages(toolContent: string) {
    const messages: any[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'run the digest' },
    ];
    // The tool message under test, followed by enough newer tool messages that
    // it falls outside the preserved-recent window.
    //
    // The padding results must themselves be over the trim limit: the window
    // only spends slots on results the trimmer could actually destroy, so small
    // ones no longer evict anything (see the eviction suite below). These tests
    // are about what the COMPRESSED form keeps, so they have to force the
    // compression to happen.
    messages.push({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'tc_digest', function: { name: 'get_pr_digest', arguments: '{}' } }],
    });
    messages.push({ role: 'tool', tool_call_id: 'tc_digest', name: 'get_pr_digest', content: toolContent });
    for (let i = 0; i < 4; i++) {
      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: [{ id: `tc_${i}`, function: { name: 'bulky_tool', arguments: '{}' } }],
      });
      messages.push({ role: 'tool', tool_call_id: `tc_${i}`, name: 'bulky_tool', content: `${i}`.repeat(9_000) });
    }
    return messages;
  }

  it('keeps the full, usable S3 key in the compressed message', () => {
    const body = `{\n  "totalPRs": 2,\n  "text": "${'*'.repeat(9000)}"\n}`;
    const content = buildToolResponseS3Header(s3Key, body.length) + body;

    const service = new AgentModeService();
    const trimmed = service.trimToolMessagesForContext(buildMessages(content));
    const digest = trimmed.find((m: any) => m.tool_call_id === 'tc_digest');

    expect(digest.content.length).toBeLessThan(content.length); // still compressed
    expect(digest.content).toContain(s3Key);
    // The key must be recoverable verbatim, not just present as a prefix.
    expect(parseToolResponseS3Key(digest.content)).toBe(s3Key);
  });

  it('keeps a key too long to survive a 200-char slice', () => {
    // The header prefix is 33 chars, so any key past 167 runs off the end of a
    // naive 200-char slice and would come back truncated mid-key.
    const longKey = `tool-responses/da2a8433-3c62-4e56-be04-a86f164969f3/${'d'.repeat(150)}/tooluse_9Qb1Kx7ZTAyH3mNpVrW8sQ_0.txt`;
    expect(longKey.length).toBeGreaterThan(167);

    const body = `{\n  "totalPRs": 2\n}${'y'.repeat(9000)}`;
    const content = buildToolResponseS3Header(longKey, body.length) + body;

    const service = new AgentModeService();
    const trimmed = service.trimToolMessagesForContext(buildMessages(content));
    const digest = trimmed.find((m: any) => m.tool_call_id === 'tc_digest');

    expect(digest.content.length).toBeLessThan(content.length);
    expect(parseToolResponseS3Key(digest.content)).toBe(longKey);
  });

  it('still shows a preview of the payload alongside the S3 reference', () => {
    const body = `{\n  "totalPRs": 2,\n  "since": "2026-08-06T01:00:00.000Z",\n${'x'.repeat(9000)}`;
    const content = buildToolResponseS3Header(s3Key, body.length) + body;

    const service = new AgentModeService();
    const trimmed = service.trimToolMessagesForContext(buildMessages(content));
    const digest = trimmed.find((m: any) => m.tool_call_id === 'tc_digest');

    expect(digest.content).toContain('get_pr_digest');
    expect(digest.content).toContain('"totalPRs": 2');
  });

  it('leaves the compressed form unchanged for content with no S3 reference', () => {
    const content = 'R'.repeat(12000);
    const service = new AgentModeService();
    const trimmed = service.trimToolMessagesForContext(buildMessages(content));
    const digest = trimmed.find((m: any) => m.tool_call_id === 'tc_digest');

    expect(digest.content).toBe(`[Tool: get_pr_digest — ${'R'.repeat(200)}...]`);
  });
});

describe('ENG-940: S3 reference header round-trip', () => {
  it('builds a header the parser can read back', () => {
    const key = 'tool-responses/abc-def/tooluse_123.txt';
    const header = buildToolResponseS3Header(key, 12345);
    expect(header).toContain(key);
    expect(header).toContain('12345 chars');
    expect(extractToolResponseS3Ref(header + 'body')).toBe(header);
    expect(parseToolResponseS3Key(header + 'body')).toBe(key);
  });

  it('returns null when the content does not start with a reference header', () => {
    expect(extractToolResponseS3Ref('plain tool output')).toBeNull();
    expect(parseToolResponseS3Key('plain tool output')).toBeNull();
    // A header that is not at the very start is not a recovery reference —
    // toolDispatch always prepends it.
    const header = buildToolResponseS3Header('tool-responses/x/y.txt', 10);
    expect(extractToolResponseS3Ref('noise ' + header)).toBeNull();
  });
});

/**
 * ENG-940 follow-up A — the preserve window must not be spent on results that
 * were never at risk.
 *
 * trimToolMessagesForContext keeps the N most recent tool results at full size.
 * It used to pick those N by recency ALONE, so a tool result small enough that
 * the trimmer would never touch it still consumed a slot and evicted a large
 * one. In the reported run that is precisely what happened: three 488-char
 * save_memory schema rejections landed after the 8,981-char get_pr_digest
 * payload and pushed it out of a 3-slot window inside a single logical turn.
 *
 * A result at or below its trim limit is passed through untouched whether or
 * not it is "preserved", so protecting it buys nothing. The window therefore
 * only spends slots on results the trimmer could actually destroy.
 */
describe('ENG-940: small tool results do not evict a large one from the preserve window', () => {
  const DIGEST = 'D'.repeat(PR_DIGEST_PAYLOAD_SIZE);
  const SCHEMA_ERROR =
    '⚠️ Tool Error: save_memory\nReason: Tool "save_memory" arguments failed schema validation before execution. ' +
    'Argument "content" must be at most 2000 character(s).';

  /** The reported run: one big digest, then three small save_memory rejections. */
  function reportedRun() {
    const messages: any[] = [
      { role: 'user', content: 'Fetch the last 24 hours of merged PRs.' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'tc_digest', function: { name: 'get_pr_digest', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'tc_digest', name: 'get_pr_digest', content: DIGEST },
    ];
    for (let i = 0; i < 3; i++) {
      messages.push({ role: 'assistant', content: '', tool_calls: [{ id: `tc_mem${i}`, function: { name: 'save_memory', arguments: '{}' } }] });
      messages.push({ role: 'tool', tool_call_id: `tc_mem${i}`, name: 'save_memory', content: SCHEMA_ERROR });
    }
    return messages;
  }

  it('keeps the digest readable after three failed save_memory calls', () => {
    const service = new AgentModeService();
    const trimmed = service.trimToolMessagesForContext(reportedRun());
    const digest = trimmed.find((m: any) => m.tool_call_id === 'tc_digest');

    // Previously: compressed to "[Tool: get_pr_digest — DDD...]" with no S3 key.
    expect(digest.content).toBe(DIGEST);
  });

  it('still passes the small error results through untouched', () => {
    const service = new AgentModeService();
    const trimmed = service.trimToolMessagesForContext(reportedRun());
    for (const m of trimmed.filter((x: any) => x.name === 'save_memory')) {
      expect(m.content).toBe(SCHEMA_ERROR);
    }
  });

  it('still bounds the window — a 4th large result evicts the oldest large one', () => {
    const messages: any[] = [{ role: 'user', content: 'go' }];
    for (let i = 0; i < 4; i++) {
      messages.push({ role: 'assistant', content: '', tool_calls: [{ id: `tc${i}`, function: { name: 'get_pr_digest', arguments: '{}' } }] });
      messages.push({ role: 'tool', tool_call_id: `tc${i}`, name: 'get_pr_digest', content: `${i}`.repeat(9_000) });
    }
    const trimmed = new AgentModeService().trimToolMessagesForContext(messages);

    // Oldest of four large results is compressed; the three most recent survive.
    expect(trimmed.find((m: any) => m.tool_call_id === 'tc0').content).toContain('[Tool: get_pr_digest —');
    for (const id of ['tc1', 'tc2', 'tc3']) {
      expect(trimmed.find((m: any) => m.tool_call_id === id).content.length).toBe(9_000);
    }
  });

  it('honours a per-tool allowance when deciding what is at risk', () => {
    // read_market_strategy may hold 50,000 chars, so a 9,000-char one is NOT at
    // risk and must not consume a slot that the 9,000-char digest needs.
    const messages: any[] = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'tc_digest', function: { name: 'get_pr_digest', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'tc_digest', name: 'get_pr_digest', content: 'D'.repeat(9_000) },
    ];
    for (let i = 0; i < 3; i++) {
      messages.push({ role: 'assistant', content: '', tool_calls: [{ id: `tc_ms${i}`, function: { name: 'read_market_strategy', arguments: '{}' } }] });
      messages.push({ role: 'tool', tool_call_id: `tc_ms${i}`, name: 'read_market_strategy', content: 'M'.repeat(9_000) });
    }
    const trimmed = new AgentModeService().trimToolMessagesForContext(messages);

    expect(trimmed.find((m: any) => m.tool_call_id === 'tc_digest').content.length).toBe(9_000);
  });
});

/**
 * ENG-940 follow-up B — a failed S3 offload must not degrade into silent loss.
 *
 * The offload is the ONLY recovery path, and uploadFileToS3WithPath reports a
 * failure by returning {success:false} rather than throwing — so the original
 * code simply skipped the header and carried on. The payload then looked exactly
 * like a small response until the trimmer compressed it away, and the model was
 * left with a preview it had no way to know was lossy. That is the state that
 * made the reported run disbelieve its own correct summary.
 *
 * We cannot conjure a recovery path when S3 is down, but we can refuse to hide
 * it: the response carries an explicit "could NOT be stored" notice, and the
 * trimmer preserves that notice exactly as it preserves a real S3 key.
 */
describe('ENG-940: an un-offloadable response is marked, not silently lost', () => {
  it('builds an unavailable notice that the matcher reads back', () => {
    const header = buildToolResponseUnavailableHeader(8981);
    expect(header).toContain('8981 chars');
    expect(header).toMatch(/could NOT be stored/);
    expect(extractToolResponseHeader(header + 'body')).toBe(header);
    // It is NOT an S3 reference — there is no key to parse out of it.
    expect(parseToolResponseS3Key(header + 'body')).toBeNull();
  });

  it('still recognises a real S3 reference through the shared matcher', () => {
    const header = buildToolResponseS3Header('tool-responses/x/y.txt', 10);
    expect(extractToolResponseHeader(header + 'body')).toBe(header);
  });

  it('returns null for content carrying neither header', () => {
    expect(extractToolResponseHeader('plain tool output')).toBeNull();
  });

  it('keeps the notice at the front when the trimmer compresses the payload', () => {
    const notice = buildToolResponseUnavailableHeader(9_000);
    const messages: any[] = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'tc_digest', function: { name: 'get_pr_digest', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'tc_digest', name: 'get_pr_digest', content: notice + 'D'.repeat(9_000) },
    ];
    for (let i = 0; i < 3; i++) {
      messages.push({ role: 'assistant', content: '', tool_calls: [{ id: `tc${i}`, function: { name: 'get_pr_digest', arguments: '{}' } }] });
      messages.push({ role: 'tool', tool_call_id: `tc${i}`, name: 'get_pr_digest', content: `${i}`.repeat(9_000) });
    }
    const trimmed = new AgentModeService().trimToolMessagesForContext(messages);
    const digest = trimmed.find((m: any) => m.tool_call_id === 'tc_digest');

    // Compressed (it is the oldest of four at-risk results) but still self-describing:
    // the model is told the payload is gone rather than being handed a bare preview.
    expect(digest.content).toContain('[Tool: get_pr_digest —');
    expect(extractToolResponseHeader(digest.content)).not.toBeNull();
    // The preview shows the PAYLOAD, not the notice text.
    expect(digest.content).toContain('DDD');
  });
});
