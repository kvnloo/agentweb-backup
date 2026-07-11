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
// pipeline's own session (only in a worktree, never at agentRoot) → fresh. Pure: the caller resolves
// cwd/agentRoot and the pipeline session id and passes them in.
export function pickResumeBase(cs, { cwd, agentRoot, pipelineSid = null }) {
  const sameCwd = !cs.cwd || cs.cwd === cwd;
  const chatSid = (sameCwd && cs.sessions?.chat) || null;
  if (chatSid) return { kind: 'session', sid: chatSid };
  if (cs.compactSummary) return { kind: 'compact', tokens: Math.round(cs.compactSummary.length / 4) + 3000 };
  if (cwd !== agentRoot && pipelineSid) return { kind: 'session', sid: pipelineSid };
  return { kind: 'fresh' };
}
