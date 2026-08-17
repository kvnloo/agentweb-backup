// Helpers for reporting the REAL context a chat turn will resume — not the optimistic display size.
//
// The context indicator has to answer "how many tokens will the next `claude -p --resume` actually
// load?", because that's what drives cost. Two facts make the naive answer wrong:
//   • The on-disk transcript .jsonl is an append log of the WHOLE history (every tool result, every
//     turn) — its byte size wildly overcounts the live context. The real number is the LAST assistant
//     message's usage (input + cache_read + cache_creation) = what the model actually saw last turn.
//   • Which session gets resumed depends on state (a stored chat session, a compaction summary, or the
//     pipeline's own session). A stale compactSummary does NOT shrink anything if a chat session is
//     still stored — the chat session wins and the giant transcript is reloaded every turn.
// These are split out of server.mjs (which auto-listens on import) so they can be unit-tested.
import { readFileSync } from 'node:fs';

// Real current context of a session = the last assistant turn's (input + cache_read + cache_creation).
// Scans from the end so it's cheap-ish even on large transcripts. Returns { contextUsed, model } or
// null (missing/unreadable file, or no assistant usage recorded yet).
export function transcriptContextUsed(filePath) {
  let lines;
  try { lines = readFileSync(filePath, 'utf8').split('\n'); }
  catch { return null; }
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (!o || o.type !== 'assistant') continue;
    const u = o.message?.usage;
    if (!u) continue;
    const used = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    if (used > 0) return { contextUsed: used, model: o.message?.model || null };
  }
  return null;
}

// Which base the NEXT non-edit turn resumes — a faithful mirror of the session-selection ladder in
// runTurn (server.mjs): stored chat session (same cwd) → compaction summary (fresh + seed) → the
// pipeline's own session → fresh. Pure: the caller resolves cwd/agentRoot and the pipeline session id.
//
// `resumePipeline` gates whether the FIRST chat turn resumes the pipeline's (fixer) transcript. It is
// OFF by default: that transcript is 300-400k tokens of mostly low-signal exploration, so instead the
// first turn seeds a fresh curated context (issue + diff + verdicts + on-demand code/transcript access)
// — the same knowledge at a fraction of the tokens. Set config.chat.resumePipelineSession=true to
// restore the old resume-the-fixer behavior. Once a chat session exists it's always continued (chatSid).
export function pickResumeBase(cs, { cwd, agentRoot, pipelineSid = null, resumePipeline = false }) {
  const sameCwd = !cs.cwd || cs.cwd === cwd;
  const chatSid = (sameCwd && cs.sessions?.chat) || null;
  if (chatSid) return { kind: 'session', sid: chatSid };
  if (cs.compactSummary) return { kind: 'compact', tokens: Math.round(cs.compactSummary.length / 4) + 3000 };
  if (resumePipeline && cwd !== agentRoot && pipelineSid) return { kind: 'session', sid: pipelineSid };
  return { kind: 'fresh' };
}

// Did a turn fail because the prompt exceeded the model's context window (as opposed to a usage cap, a
// dead resume, or a server error)? This is the one failure /compact can recover from on its own: a
// session at the window ceiling cannot be compacted BY RESUMING IT — the compaction turn reloads the
// same oversized transcript and dies identically, so the only tool that shrinks a session needs the
// session to already fit (ENG-1188 deadlocked this way at 974k of a 1M window). On a match the caller
// re-runs the compaction against the saved display transcript instead, with no session to resume.
//
// Deliberately narrow: a usage/session limit or a 5xx must NOT match. Those are the failures the
// compaction bail-out exists to catch, and treating one as a summary destroys the conversation.
export function isContextOverflowError(text) {
  const t = String(text || '').toLowerCase();
  if (!t) return false;
  if (/usage limit|session limit|rate limit/.test(t)) return false;
  return /prompt is too long|too long:\s*\d+\s*tokens|exceed(s)? context limit|context length exceeded|maximum context length/.test(t);
}
