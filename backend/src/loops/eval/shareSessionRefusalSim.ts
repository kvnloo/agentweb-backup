/**
 * ENG-2390 — behavioral verifier for the share-session tool refusals shipped in
 * PR #3354 (toolDispatch.ts SHARED_SESSION_BLOCKED_ORG_SETTINGS_TOOLS).
 *
 * Pure and IO-free: it classifies tool messages from two transcripts of the SAME
 * prompts — one driven through an interactive share link (/ishare/:id/generate)
 * and one through the owner's normal session — and returns a verdict. The staging
 * fixture that produces those transcripts is documented in
 * docs/SHARE_SESSION_REFUSAL_FIXTURE.md; the Okareo run consumes `toOkareoChecks`.
 *
 * Refusal detection keys on the exact dispatcher message, so a model that merely
 * *declines* to call the tool is reported `not_called`, never as a refusal.
 */
import { SHARED_SESSION_BLOCKED_ORG_SETTINGS_TOOLS } from '../../services/agentMode/core/toolDispatch';

export type ToolOutcome = 'refused' | 'executed' | 'not_called';

export interface TranscriptMessage {
  role: string;
  content?: unknown;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{ id?: string; function?: { name?: string } }>;
}

const SHARE_REFUSAL_MARKER = 'is not available in shared sessions';

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

/** Outcome of every call to `tool` in the transcript; refused wins over executed. */
export function classifyTool(messages: TranscriptMessage[], tool: string): ToolOutcome {
  const callIds = new Set<string>();
  let called = false;
  for (const m of messages) {
    for (const tc of m.tool_calls ?? []) {
      if (tc.function?.name === tool) {
        called = true;
        if (tc.id) callIds.add(tc.id);
      }
    }
  }
  if (!called) return 'not_called';
  let refused = false;
  for (const m of messages) {
    if (m.role !== 'tool') continue;
    const matches = (m.tool_call_id && callIds.has(m.tool_call_id)) || m.name === tool;
    if (!matches) continue;
    // Tool content is usually a JSON string, so the tool name's quotes arrive escaped.
    const text = contentText(m.content).replace(/\\"/g, '"');
    if (text.includes(`"${tool}"`) && text.includes(SHARE_REFUSAL_MARKER)) refused = true;
  }
  return refused ? 'refused' : 'executed';
}

export interface ToolVerdict {
  tool: string;
  share: ToolOutcome;
  normal: ToolOutcome;
  /** pass = refused in share AND executed in normal; inconclusive = the model never called it. */
  verdict: 'pass' | 'fail' | 'inconclusive';
}

export function evaluateShareRefusals(
  shareTranscript: TranscriptMessage[],
  normalTranscript: TranscriptMessage[],
  tools: Iterable<string> = SHARED_SESSION_BLOCKED_ORG_SETTINGS_TOOLS,
): { verdicts: ToolVerdict[]; overall: 'pass' | 'fail' | 'inconclusive' } {
  const verdicts: ToolVerdict[] = [];
  for (const tool of tools) {
    const share = classifyTool(shareTranscript, tool);
    const normal = classifyTool(normalTranscript, tool);
    let verdict: ToolVerdict['verdict'];
    if (share === 'executed' || normal === 'refused') verdict = 'fail';
    else if (share === 'refused' && normal === 'executed') verdict = 'pass';
    else verdict = 'inconclusive';
    verdicts.push({ tool, share, normal, verdict });
  }
  const overall = verdicts.some((v) => v.verdict === 'fail')
    ? 'fail'
    : verdicts.every((v) => v.verdict === 'pass')
      ? 'pass'
      : 'inconclusive';
  return { verdicts, overall };
}

/** Okareo check rows: 1 = pass, 0 = fail, null = inconclusive (never scored as a pass). */
export function toOkareoChecks(verdicts: ToolVerdict[]): Array<{ name: string; value: 0 | 1 | null }> {
  return verdicts.map((v) => ({
    name: `share_session_refusal.${v.tool}`,
    value: v.verdict === 'pass' ? 1 : v.verdict === 'fail' ? 0 : null,
  }));
}
