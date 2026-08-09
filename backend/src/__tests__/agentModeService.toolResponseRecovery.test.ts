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
        tool_calls: [{ id: `tc_${i}`, function: { name: 'small_tool', arguments: '{}' } }],
      });
      messages.push({ role: 'tool', tool_call_id: `tc_${i}`, name: 'small_tool', content: `ok ${i}` });
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
