/**
 * Minimal Tern Surface Protocol (TSP) transport for the AgentWeb Emma dogfood CLI.
 *
 * Framing/chunking semantics follow the Tern v1 protocol and the production
 * implementation in can1357/oh-my-pi (packages/tui/src/native/encode.ts).
 * Kept local and dependency-free so this experiment does not couple AgentWeb
 * business logic to OMP.
 */
const APC = '\x1b_';
const OSC = '\x1b]';
const BEL = '\x07';
const ST = '\x1b\\';
export const TSP_PREFIX = `${APC}tsp;`;
export const TSP_OSC_PREFIX = `${OSC}877;tsp;`;
export const TSP_VERSION = 1;
export const TSP_DEFAULT_APC_LIMIT = 65_536;

export type TspVerb = 'q' | 'o' | 'f' | 'b' | 't' | 'x' | 'r' | 'e';
export type TspParams = Readonly<Record<string, string | number>>;

export interface TspRawMessage {
  verb: string;
  params: Record<string, string>;
  body: string;
}

let nextChunkId = 1;

function codePointBytes(text: string, i: number): { bytes: number; units: number } {
  const c = text.charCodeAt(i);
  if (c < 0x80) return { bytes: 1, units: 1 };
  if (c < 0x800) return { bytes: 2, units: 1 };
  if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
    const next = text.charCodeAt(i + 1);
    if (next >= 0xdc00 && next <= 0xdfff) return { bytes: 4, units: 2 };
  }
  return { bytes: 3, units: 1 };
}

function leadsWithParameterAt(body: string, at: number): boolean {
  let i = at;
  if (i >= body.length) return false;

  const keyStart = i;
  while (i < body.length && /[A-Za-z0-9_-]/.test(body[i])) i++;
  if (i === keyStart || body[i] !== '=') return false;
  i++;

  while (i < body.length) {
    const code = body.charCodeAt(i);
    if (body[i] === ';') return true;
    if (code < 0x21 || code > 0x7e) return false;
    i++;
  }
  return false;
}

export function splitUtf8(body: string, limit: number): string[] {
  const max = Math.max(4, Math.trunc(limit));
  const pieces: string[] = [];
  let start = 0;

  while (start < body.length) {
    let i = start;
    let bytes = 0;
    let safeEnd = start;

    while (i < body.length) {
      const step = codePointBytes(body, i);
      if (bytes + step.bytes > max) break;
      bytes += step.bytes;
      i += step.units;
      if (!leadsWithParameterAt(body, i)) safeEnd = i;
    }

    if (i >= body.length) {
      pieces.push(body.slice(start));
      break;
    }

    let end = safeEnd > start ? safeEnd : i;

    // If every boundary inside the byte budget would make the next chunk look
    // like another TSP parameter (e.g. "foo=bar;"), walk forward to the first
    // safe code-point boundary. This mirrors the Tern SDK's chunk_end rule.
    if (end === i && leadsWithParameterAt(body, end)) {
      let forward = end;
      while (forward < body.length && leadsWithParameterAt(body, forward)) {
        forward += codePointBytes(body, forward).units;
      }
      end = forward;
    }

    if (end <= start) {
      // Defensive progress guarantee for malformed surrogate input.
      end = start + codePointBytes(body, start).units;
    }

    pieces.push(body.slice(start, end));
    start = end;
  }

  return pieces.length ? pieces : [''];
}

function encodeParams(params?: TspParams): string {
  if (!params) return '';
  let out = '';
  for (const key in params) out += `;${key}=${params[key]}`;
  return out;
}

function frame(verb: TspVerb, params: string, body: string): string {
  return `${TSP_PREFIX}${verb}${params};${body}${ST}`;
}

export function encodeTspMessage(
  verb: TspVerb,
  body: string,
  params?: TspParams,
  limit = TSP_DEFAULT_APC_LIMIT,
): string {
  const base = encodeParams(params);
  if (body.length * 3 <= limit || Buffer.byteLength(body, 'utf8') <= limit) {
    return frame(verb, base, body);
  }

  const chunkId = (nextChunkId++).toString(36);
  const pieces = splitUtf8(body, limit);
  let out = '';
  for (let i = 0; i < pieces.length; i++) {
    // TSP carries caller parameters only on the first chunk. Continuations
    // carry c=<id> (+ m=1 when more follows), exactly like the official SDK.
    const original = i === 0 ? base : '';
    const more = i < pieces.length - 1 ? ';m=1' : '';
    out += frame(verb, `${original};c=${chunkId}${more}`, pieces[i]);
  }
  return out;
}

export function encodeTspJson(
  verb: TspVerb,
  value: unknown,
  params?: TspParams,
  limit?: number,
): string {
  return encodeTspMessage(verb, JSON.stringify(value), params, limit);
}

export function encodeHelloQuery(app = 'agentweb-emma'): string {
  return encodeTspJson('q', {
    q: 'hello',
    v: [TSP_VERSION],
    app,
    features: ['edit', 'undo', 'send'],
  });
}

const PARAM_PATTERN = /^[A-Za-z0-9_-]+=[\x21-\x3a\x3c-\x7e]*$/;

export function splitTspMessage(sequence: string): TspRawMessage | null {
  const prefix = sequence.startsWith(TSP_PREFIX)
    ? TSP_PREFIX
    : sequence.startsWith(TSP_OSC_PREFIX)
      ? TSP_OSC_PREFIX
      : null;
  if (!prefix) return null;

  const terminator = sequence.endsWith(ST)
    ? ST
    : sequence.endsWith(BEL)
      ? BEL
      : null;
  if (!terminator) return null;

  const inner = sequence.slice(prefix.length, -terminator.length);
  let semi = inner.indexOf(';');
  if (semi <= 0) {
    return semi === -1 && inner.length > 0
      ? { verb: inner, params: {}, body: '' }
      : null;
  }

  const verb = inner.slice(0, semi);
  const params: Record<string, string> = {};
  let pos = semi + 1;

  for (;;) {
    semi = inner.indexOf(';', pos);
    if (semi === -1) break;
    const segment = inner.slice(pos, semi);
    if (!PARAM_PATTERN.test(segment)) break;
    const eq = segment.indexOf('=');
    params[segment.slice(0, eq)] = segment.slice(eq + 1);
    pos = semi + 1;
  }

  return { verb, params, body: inner.slice(pos) };
}

/**
 * Incremental PTY reader. Raw keyboard bytes before a TSP APC are intentionally
 * discarded; the native editor owns text input once the hello handshake opts
 * into edit/send events.
 */
export type TspInputPart =
  | { type: 'raw'; data: string }
  | { type: 'message'; message: TspRawMessage };

function partialPrefixSuffix(text: string, prefix: string): number {
  const max = Math.min(prefix.length - 1, text.length);
  for (let length = max; length > 0; length--) {
    if (text.endsWith(prefix.slice(0, length))) return length;
  }
  return 0;
}

function tspPrefixAt(text: string): { at: number; prefix: string } | null {
  const apc = text.indexOf(TSP_PREFIX);
  const osc = text.indexOf(TSP_OSC_PREFIX);
  if (apc < 0 && osc < 0) return null;
  if (apc >= 0 && (osc < 0 || apc <= osc)) return { at: apc, prefix: TSP_PREFIX };
  return { at: osc, prefix: TSP_OSC_PREFIX };
}

function terminatorAt(text: string, from: number): { at: number; length: number } | null {
  const st = text.indexOf(ST, from);
  const bel = text.indexOf(BEL, from);
  if (st < 0 && bel < 0) return null;
  if (st >= 0 && (bel < 0 || st <= bel)) return { at: st, length: ST.length };
  return { at: bel, length: BEL.length };
}

export class TspStreamReader {
  private buffer = '';
  private chunks = new Map<string, string>();

  pushParts(chunk: string): TspInputPart[] {
    this.buffer += chunk;
    const parts: TspInputPart[] = [];

    const emitRaw = (data: string) => {
      if (!data) return;
      const previous = parts[parts.length - 1];
      if (previous?.type === 'raw') previous.data += data;
      else parts.push({ type: 'raw', data });
    };

    for (;;) {
      const found = tspPrefixAt(this.buffer);
      if (!found) {
        const hold = Math.max(
          partialPrefixSuffix(this.buffer, TSP_PREFIX),
          partialPrefixSuffix(this.buffer, TSP_OSC_PREFIX),
        );
        const rawEnd = this.buffer.length - hold;
        emitRaw(this.buffer.slice(0, rawEnd));
        this.buffer = this.buffer.slice(rawEnd);
        break;
      }

      if (found.at > 0) {
        emitRaw(this.buffer.slice(0, found.at));
        this.buffer = this.buffer.slice(found.at);
      }

      const end = terminatorAt(this.buffer, found.prefix.length);
      if (!end) break;

      const sequence = this.buffer.slice(0, end.at + end.length);
      this.buffer = this.buffer.slice(end.at + end.length);
      const raw = splitTspMessage(sequence);
      if (!raw) continue;

      const chunkId = raw.params.c;
      if (chunkId !== undefined) {
        const joined = (this.chunks.get(chunkId) ?? '') + raw.body;
        if (raw.params.m === '1') {
          this.chunks.set(chunkId, joined);
          continue;
        }
        this.chunks.delete(chunkId);
        raw.body = joined;
      }

      parts.push({ type: 'message', message: raw });
    }

    return parts;
  }

  push(chunk: string): TspRawMessage[] {
    return this.pushParts(chunk)
      .filter((part): part is Extract<TspInputPart, { type: 'message' }> => part.type === 'message')
      .map(part => part.message);
  }
}

export function parseTspJson(raw: TspRawMessage): Record<string, unknown> | null {
  if (raw.verb !== 'r' && raw.verb !== 'e') return null;
  try {
    const parsed: unknown = JSON.parse(raw.body);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}
