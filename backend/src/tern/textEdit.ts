/**
 * Resolve one Tern native text edit against the text the program currently owns.
 *
 * Mirrors the TSP/OMP invariant: `len` is the UTF-16 length Tern saw. If it
 * differs, the edit is stale and must be ignored rather than applied to newer
 * state. Ranges are clamped and never split a surrogate pair.
 *
 * Credit: Stencil TSP edit semantics and can1357/oh-my-pi native text-edit
 * resolution informed this dependency-free AgentWeb helper.
 */
export interface NativeTextEdit {
  from: number;
  to: number;
  text: string;
  cursor: number;
  len: number;
}

export interface ResolvedTextEdit {
  text: string;
  cursor: number;
  changed: boolean;
}

function clampOffset(value: number, max: number): number {
  return Number.isFinite(value)
    ? Math.min(Math.max(Math.trunc(value), 0), max)
    : 0;
}

function splitsSurrogatePair(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return false;
  const high = text.charCodeAt(offset - 1);
  const low = text.charCodeAt(offset);
  return high >= 0xd800 && high <= 0xdbff
    && low >= 0xdc00 && low <= 0xdfff;
}

export function resolveNativeTextEdit(
  current: string,
  edit: NativeTextEdit,
): ResolvedTextEdit | null {
  if (edit.len !== current.length) return null;

  const size = current.length;
  let from = clampOffset(edit.from, size);
  let to = clampOffset(edit.to, size);
  if (to < from) [from, to] = [to, from];

  if (splitsSurrogatePair(current, from)) from--;
  if (splitsSurrogatePair(current, to)) to++;

  const insert = typeof edit.text === 'string' ? edit.text : '';
  const next = current.slice(0, from) + insert + current.slice(to);

  const expectedLength = size - (to - from) + insert.length;
  let cursor = clampOffset(edit.cursor, expectedLength);
  cursor = Math.min(cursor, next.length);
  if (splitsSurrogatePair(next, cursor)) cursor--;

  return {
    text: next,
    cursor,
    changed: from !== to || insert !== '',
  };
}
