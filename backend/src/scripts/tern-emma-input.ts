import { NativeTextEdit, resolveNativeTextEdit } from '../tern/textEdit';

/**
 * PTY/kitty input for the native Emma client.
 * Native edit/undo and raw keys update one program-owned composer model.
 */
export interface EmmaKey {
  name: string;
  text?: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
}

export type EmmaInputMode = 'composer' | 'picker' | 'approval' | 'runs';

export interface EmmaInputHandlers {
  mode(): EmmaInputMode;
  canSubmit(): boolean;
  onSubmit(prompt: string): void;
  onModalKey(key: EmmaKey): void;
  onInterrupt(): void;
  onChange(): void;
}

interface DecodedKey {
  key?: EmmaKey;
  used: number;
  needMore?: boolean;
}

const ESC = '\x1b';
const PASTE_BEGIN = '\x1b[200~';
const PASTE_END = '\x1b[201~';

function keyFromCode(
  code: number,
  shift = false,
  ctrl = false,
  alt = false,
  meta = false,
  shifted?: number,
): EmmaKey | undefined {
  const functional: Record<number, string> = {
    13: 'enter', 9: 'tab', 27: 'escape', 127: 'backspace',
    57344: 'escape', 57345: 'enter', 57346: 'tab', 57347: 'backspace',
    57349: 'delete', 57350: 'left', 57351: 'right', 57352: 'up',
    57353: 'down', 57354: 'page_up', 57355: 'page_down',
    57356: 'home', 57357: 'end',
    // Preserve the original Emma picker mappings too.
    57417: 'left', 57418: 'right', 57419: 'up', 57420: 'down',
    57421: 'page_up', 57422: 'page_down', 57423: 'home',
    57424: 'end', 57426: 'delete',
  };
  const name = functional[code];
  if (name) return { name, shift, ctrl, alt, meta };
  if (ctrl && code === 3) return { name: 'c', ctrl, shift, alt, meta };
  if (!Number.isInteger(code) || code < 32 || code > 0x10ffff
      || (code >= 0xd800 && code <= 0xdfff)) return undefined;
  const value = shift && shifted !== undefined && shifted >= 32
    && shifted <= 0x10ffff && !(shifted >= 0xd800 && shifted <= 0xdfff)
    ? shifted : code;
  // Kitty may report the unshifted codepoint plus a Shift modifier.
  const unshifted = String.fromCodePoint(value);
  const shiftedSymbols: Record<string, string> = {
    '1': '!', '2': '@', '3': '#', '4': '
    ...(!ctrl && !alt && !meta ? { text: char } : {}),
    shift, ctrl, alt, meta,
  };
}

/** Decode one key or an entire bracketed paste, including split CSI input. */
export function decodeEmmaKey(buffer: string): DecodedKey {
  if (!buffer) return { used: 0, needMore: true };
  if (buffer.startsWith(PASTE_BEGIN)) {
    const end = buffer.indexOf(PASTE_END, PASTE_BEGIN.length);
    if (end < 0) return { used: 0, needMore: true };
    return {
      key: { name: 'paste', text: buffer.slice(PASTE_BEGIN.length, end) },
      used: end + PASTE_END.length,
    };
  }
  if (PASTE_BEGIN.startsWith(buffer)) return { used: 0, needMore: true };

  if (buffer[0] !== ESC) {
    const code = buffer.codePointAt(0);
    if (code === undefined) return { used: 0, needMore: true };
    // setEncoding('utf8') normally gives whole characters; split surrogate
    // pairs are held if a caller provides UTF-16 chunks directly.
    if (code >= 0xd800 && code <= 0xdbff && buffer.length === 1) {
      return { used: 0, needMore: true };
    }
    const char = String.fromCodePoint(code);
    const used = char.length;
    if (char === '\r' || char === '\n') return { key: { name: 'enter' }, used };
    if (char === '\t') return { key: { name: 'tab' }, used };
    if (char === '\x7f' || char === '\b') return { key: { name: 'backspace' }, used };
    if (code >= 1 && code <= 26) {
      return { key: { name: String.fromCharCode(code + 96), ctrl: true }, used };
    }
    if (code < 32) return { used };
    return { key: { name: char.toLowerCase(), text: char }, used };
  }

  if (buffer.length === 1) return { used: 0, needMore: true };

  if (buffer.startsWith('\x1b[')) {
    // Consume unrelated CSI replies too, rather than putting them in the draft.
    const match = /^\x1b\[([0-9:;?<>]*)([@-~])/.exec(buffer);
    if (!match) return buffer.length > 64 ? { used: 1 } : { used: 0, needMore: true };
    const [sequence, params, final] = match;
    if (final === 'u') {
      const parts = params.split(';');
      const codes = (parts[0] || '').split(':');
      const code = Number(codes[0]);
      const modifierAndType = (parts[1] || '1').split(':');
      const modifiers = Math.max(0, Number(modifierAndType[0]) - 1);
      if (modifierAndType[1] === '3') return { used: sequence.length }; // key release
      const shift = (modifiers & 1) !== 0;
      const ctrl = (modifiers & 4) !== 0;
      const alt = (modifiers & 2) !== 0;
      const meta = (modifiers & (8 | 16 | 32)) !== 0;
      const shifted = codes[1] ? Number(codes[1]) : undefined;
      return { key: keyFromCode(code, shift, ctrl, alt, meta, shifted), used: sequence.length };
    }

    const modifiers = Math.max(0, Number(params.split(';')[1] || '1') - 1);
    const shift = (modifiers & 1) !== 0;
    const ctrl = (modifiers & 4) !== 0;
    const alt = (modifiers & 2) !== 0;
    const meta = (modifiers & (8 | 16 | 32)) !== 0;
    const nav: Record<string, string> = {
      A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end',
      Z: 'tab',
    };
    if (nav[final]) {
      return { key: { name: nav[final], shift: shift || final === 'Z', ctrl, alt, meta }, used: sequence.length };
    }
    if (final === '~') {
      const names: Record<number, string> = {
        1: 'home', 3: 'delete', 4: 'end', 5: 'page_up', 6: 'page_down', 7: 'home', 8: 'end',
      };
      const name = names[Number(params.split(';')[0])];
      return { key: name ? { name, shift, ctrl, alt, meta } : undefined, used: sequence.length };
    }
    return { used: sequence.length };
  }

  if (buffer.startsWith('\x1bO')) {
    if (buffer.length < 3) return { used: 0, needMore: true };
    const nav: Record<string, string> = { A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end' };
    return { key: nav[buffer[2]] ? { name: nav[buffer[2]] } : undefined, used: 3 };
  }

  // Legacy Alt+key is ESC plus a printable character.
  const code = buffer.codePointAt(1);
  if (code === undefined) return { used: 0, needMore: true };
  return { key: keyFromCode(code, false, false, true), used: 1 + (code > 0xffff ? 2 : 1) };
}

function safeCaret(text: string, offset: number): number {
  const value = Number.isFinite(offset) ? Math.max(0, Math.min(text.length, Math.trunc(offset))) : 0;
  const high = text.charCodeAt(value - 1);
  const low = text.charCodeAt(value);
  return value > 0 && value < text.length && high >= 0xd800 && high <= 0xdbff
    && low >= 0xdc00 && low <= 0xdfff ? value - 1 : value;
}

function previousPoint(text: string, at: number): number {
  if (at <= 0) return 0;
  const prior = at - 1;
  const low = text.charCodeAt(prior);
  const high = text.charCodeAt(prior - 1);
  return prior > 0 && low >= 0xdc00 && low <= 0xdfff
    && high >= 0xd800 && high <= 0xdbff ? prior - 1 : prior;
}

function nextPoint(text: string, at: number): number {
  if (at >= text.length) return text.length;
  const code = text.codePointAt(at);
  return Math.min(text.length, at + (code !== undefined && code > 0xffff ? 2 : 1));
}

export class EmmaInputController {
  private draft = '';
  private caret = 0;
  private readonly previous: Array<{ text: string; cursor: number }> = [];
  private pending = '';
  private escapeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly handlers: EmmaInputHandlers) {}

  get text(): string { return this.draft; }
  get cursor(): number { return this.caret; }

  clear(): void {
    const changed = this.draft.length > 0 || this.caret !== 0;
    this.draft = '';
    this.caret = 0;
    this.previous.length = 0;
    if (changed) this.handlers.onChange();
  }

  resetRaw(): void {
    this.pending = '';
    if (this.escapeTimer) clearTimeout(this.escapeTimer);
    this.escapeTimer = undefined;
  }

  applyNativeEdit(edit: NativeTextEdit): boolean {
    const resolved = resolveNativeTextEdit(this.draft, edit);
    if (!resolved) return false;
    if (resolved.changed) this.recordUndo();
    const changed = resolved.changed || resolved.cursor !== this.caret;
    this.draft = resolved.text;
    this.caret = resolved.cursor;
    if (changed) this.handlers.onChange();
    return true;
  }

  undo(): boolean {
    const previous = this.previous.pop();
    if (!previous) return false;
    this.draft = previous.text;
    this.caret = previous.cursor;
    this.handlers.onChange();
    return true;
  }

  handleRaw(raw: string): void {
    if (!raw) return;
    if (this.escapeTimer) clearTimeout(this.escapeTimer);
    this.escapeTimer = undefined;
    this.pending += raw;
    while (this.pending) {
      const decoded = decodeEmmaKey(this.pending);
      if (decoded.needMore || decoded.used <= 0) break;
      this.pending = this.pending.slice(decoded.used);
      if (!decoded.key) continue;
      if (decoded.key.ctrl && decoded.key.name === 'c') {
        this.resetRaw();
        this.handlers.onInterrupt();
        return;
      }
      if (this.handlers.mode() === 'composer') this.composerKey(decoded.key);
      else this.handlers.onModalKey(decoded.key);
    }
    if (this.pending === ESC) {
      this.escapeTimer = setTimeout(() => {
        this.escapeTimer = undefined;
        if (this.pending === ESC) {
          this.pending = '';
          if (this.handlers.mode() !== 'composer') this.handlers.onModalKey({ name: 'escape' });
        }
      }, 30);
    }
  }

  private recordUndo(): void {
    this.previous.push({ text: this.draft, cursor: this.caret });
    if (this.previous.length > 100) this.previous.shift();
  }

  private replace(from: number, to: number, insertion: string): void {
    const next = this.draft.slice(0, from) + insertion + this.draft.slice(to);
    if (next === this.draft) return;
    this.recordUndo();
    this.draft = next;
    this.caret = from + insertion.length;
    this.handlers.onChange();
  }

  private move(to: number): void {
    const next = safeCaret(this.draft, to);
    if (next === this.caret) return;
    this.caret = next;
    this.handlers.onChange();
  }

  private wordBoundary(direction: -1 | 1): number {
    let at = this.caret;
    if (direction === -1) {
      while (at > 0 && /\s/u.test(this.draft.slice(previousPoint(this.draft, at), at))) at = previousPoint(this.draft, at);
      while (at > 0 && !/\s/u.test(this.draft.slice(previousPoint(this.draft, at), at))) at = previousPoint(this.draft, at);
    } else {
      while (at < this.draft.length && !/\s/u.test(this.draft.slice(at, nextPoint(this.draft, at)))) at = nextPoint(this.draft, at);
      while (at < this.draft.length && /\s/u.test(this.draft.slice(at, nextPoint(this.draft, at)))) at = nextPoint(this.draft, at);
    }
    return at;
  }

  private lineStart(): number { return this.draft.lastIndexOf('\n', this.caret - 1) + 1; }
  private lineEnd(): number {
    const end = this.draft.indexOf('\n', this.caret);
    return end < 0 ? this.draft.length : end;
  }

  private vertical(delta: -1 | 1): void {
    const start = this.lineStart();
    const column = this.caret - start;
    if (delta === -1 && start > 0) {
      const end = start - 1;
      const previousStart = this.draft.lastIndexOf('\n', end - 1) + 1;
      this.move(Math.min(previousStart + column, end));
    } else if (delta === 1) {
      const end = this.lineEnd();
      if (end < this.draft.length) {
        const nextStart = end + 1;
        const nextEndPos = this.draft.indexOf('\n', nextStart);
        const nextEnd = nextEndPos < 0 ? this.draft.length : nextEndPos;
        this.move(Math.min(nextStart + column, nextEnd));
      }
    }
  }

  private composerKey(key: EmmaKey): void {
    if (key.ctrl && key.name === 'z') { this.undo(); return; }
    if (key.name === 'enter') {
      if (key.shift && !key.ctrl) this.replace(this.caret, this.caret, '\n');
      else if (this.handlers.canSubmit() && this.draft.trim()) this.handlers.onSubmit(this.draft);
      return;
    }
    if (key.ctrl && key.name === 'j') { this.replace(this.caret, this.caret, '\n'); return; }
    if (key.ctrl && key.name === 'a') { this.move(this.lineStart()); return; }
    if (key.ctrl && key.name === 'e') { this.move(this.lineEnd()); return; }
    if (key.ctrl && key.name === 'u') { this.replace(this.lineStart(), this.caret, ''); return; }
    if (key.ctrl && key.name === 'k') { this.replace(this.caret, this.lineEnd(), ''); return; }
    if (key.ctrl && key.name === 'w') { this.replace(this.wordBoundary(-1), this.caret, ''); return; }

    switch (key.name) {
      case 'left': this.move(key.ctrl || key.alt ? this.wordBoundary(-1) : previousPoint(this.draft, this.caret)); return;
      case 'right': this.move(key.ctrl || key.alt ? this.wordBoundary(1) : nextPoint(this.draft, this.caret)); return;
      case 'up': this.vertical(-1); return;
      case 'down': this.vertical(1); return;
      case 'home': this.move(key.ctrl ? 0 : this.lineStart()); return;
      case 'end': this.move(key.ctrl ? this.draft.length : this.lineEnd()); return;
      case 'backspace': this.replace(key.ctrl ? this.wordBoundary(-1) : previousPoint(this.draft, this.caret), this.caret, ''); return;
      case 'delete': this.replace(this.caret, key.ctrl ? this.wordBoundary(1) : nextPoint(this.draft, this.caret), ''); return;
      case 'paste': if (key.text) this.replace(this.caret, this.caret, key.text); return;
      case 'tab': this.replace(this.caret, this.caret, '\t'); return;
      default:
        if (key.text && !key.ctrl && !key.alt && !key.meta) this.replace(this.caret, this.caret, key.text);
    }
  }
}
, '5': '%',
    '6': '^', '7': '&', '8': '*', '9': '(', '0': ')',
    '-': '_', '=': '+', '[': '{', ']': '}', '\\': '|',
    ';': ':', "'": '"', ',': '<', '.': '>', '/': '?', '`': '~',
  };
  const char = shift && shifted === undefined
    ? /^[a-z]$/.test(unshifted) ? unshifted.toUpperCase() : shiftedSymbols[unshifted] || unshifted
    : unshifted;
  return {
    name: char.toLowerCase(),
    ...(!ctrl && !alt && !meta ? { text: char } : {}),
    shift, ctrl, alt, meta,
  };
}

/** Decode one key or an entire bracketed paste, including split CSI input. */
export function decodeEmmaKey(buffer: string): DecodedKey {
  if (!buffer) return { used: 0, needMore: true };
  if (buffer.startsWith(PASTE_BEGIN)) {
    const end = buffer.indexOf(PASTE_END, PASTE_BEGIN.length);
    if (end < 0) return { used: 0, needMore: true };
    return {
      key: { name: 'paste', text: buffer.slice(PASTE_BEGIN.length, end) },
      used: end + PASTE_END.length,
    };
  }
  if (PASTE_BEGIN.startsWith(buffer)) return { used: 0, needMore: true };

  if (buffer[0] !== ESC) {
    const code = buffer.codePointAt(0);
    if (code === undefined) return { used: 0, needMore: true };
    // setEncoding('utf8') normally gives whole characters; split surrogate
    // pairs are held if a caller provides UTF-16 chunks directly.
    if (code >= 0xd800 && code <= 0xdbff && buffer.length === 1) {
      return { used: 0, needMore: true };
    }
    const char = String.fromCodePoint(code);
    const used = char.length;
    if (char === '\r' || char === '\n') return { key: { name: 'enter' }, used };
    if (char === '\t') return { key: { name: 'tab' }, used };
    if (char === '\x7f' || char === '\b') return { key: { name: 'backspace' }, used };
    if (code >= 1 && code <= 26) {
      return { key: { name: String.fromCharCode(code + 96), ctrl: true }, used };
    }
    if (code < 32) return { used };
    return { key: { name: char.toLowerCase(), text: char }, used };
  }

  if (buffer.length === 1) return { used: 0, needMore: true };

  if (buffer.startsWith('\x1b[')) {
    // Consume unrelated CSI replies too, rather than putting them in the draft.
    const match = /^\x1b\[([0-9:;?<>]*)([@-~])/.exec(buffer);
    if (!match) return buffer.length > 64 ? { used: 1 } : { used: 0, needMore: true };
    const [sequence, params, final] = match;
    if (final === 'u') {
      const parts = params.split(';');
      const codes = (parts[0] || '').split(':');
      const code = Number(codes[0]);
      const modifierAndType = (parts[1] || '1').split(':');
      const modifiers = Math.max(0, Number(modifierAndType[0]) - 1);
      if (modifierAndType[1] === '3') return { used: sequence.length }; // key release
      const shift = (modifiers & 1) !== 0;
      const ctrl = (modifiers & 4) !== 0;
      const alt = (modifiers & 2) !== 0;
      const meta = (modifiers & (8 | 16 | 32)) !== 0;
      const shifted = codes[1] ? Number(codes[1]) : undefined;
      return { key: keyFromCode(code, shift, ctrl, alt, meta, shifted), used: sequence.length };
    }

    const modifiers = Math.max(0, Number(params.split(';')[1] || '1') - 1);
    const shift = (modifiers & 1) !== 0;
    const ctrl = (modifiers & 4) !== 0;
    const alt = (modifiers & 2) !== 0;
    const meta = (modifiers & (8 | 16 | 32)) !== 0;
    const nav: Record<string, string> = {
      A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end',
      Z: 'tab',
    };
    if (nav[final]) {
      return { key: { name: nav[final], shift: shift || final === 'Z', ctrl, alt, meta }, used: sequence.length };
    }
    if (final === '~') {
      const names: Record<number, string> = {
        1: 'home', 3: 'delete', 4: 'end', 5: 'page_up', 6: 'page_down', 7: 'home', 8: 'end',
      };
      const name = names[Number(params.split(';')[0])];
      return { key: name ? { name, shift, ctrl, alt, meta } : undefined, used: sequence.length };
    }
    return { used: sequence.length };
  }

  if (buffer.startsWith('\x1bO')) {
    if (buffer.length < 3) return { used: 0, needMore: true };
    const nav: Record<string, string> = { A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end' };
    return { key: nav[buffer[2]] ? { name: nav[buffer[2]] } : undefined, used: 3 };
  }

  // Legacy Alt+key is ESC plus a printable character.
  const code = buffer.codePointAt(1);
  if (code === undefined) return { used: 0, needMore: true };
  return { key: keyFromCode(code, false, false, true), used: 1 + (code > 0xffff ? 2 : 1) };
}

function safeCaret(text: string, offset: number): number {
  const value = Number.isFinite(offset) ? Math.max(0, Math.min(text.length, Math.trunc(offset))) : 0;
  const high = text.charCodeAt(value - 1);
  const low = text.charCodeAt(value);
  return value > 0 && value < text.length && high >= 0xd800 && high <= 0xdbff
    && low >= 0xdc00 && low <= 0xdfff ? value - 1 : value;
}

function previousPoint(text: string, at: number): number {
  if (at <= 0) return 0;
  const prior = at - 1;
  const low = text.charCodeAt(prior);
  const high = text.charCodeAt(prior - 1);
  return prior > 0 && low >= 0xdc00 && low <= 0xdfff
    && high >= 0xd800 && high <= 0xdbff ? prior - 1 : prior;
}

function nextPoint(text: string, at: number): number {
  if (at >= text.length) return text.length;
  const code = text.codePointAt(at);
  return Math.min(text.length, at + (code !== undefined && code > 0xffff ? 2 : 1));
}

export class EmmaInputController {
  private draft = '';
  private caret = 0;
  private readonly previous: Array<{ text: string; cursor: number }> = [];
  private pending = '';
  private escapeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly handlers: EmmaInputHandlers) {}

  get text(): string { return this.draft; }
  get cursor(): number { return this.caret; }

  clear(): void {
    const changed = this.draft.length > 0 || this.caret !== 0;
    this.draft = '';
    this.caret = 0;
    this.previous.length = 0;
    if (changed) this.handlers.onChange();
  }

  resetRaw(): void {
    this.pending = '';
    if (this.escapeTimer) clearTimeout(this.escapeTimer);
    this.escapeTimer = undefined;
  }

  applyNativeEdit(edit: NativeTextEdit): boolean {
    const resolved = resolveNativeTextEdit(this.draft, edit);
    if (!resolved) return false;
    if (resolved.changed) this.recordUndo();
    const changed = resolved.changed || resolved.cursor !== this.caret;
    this.draft = resolved.text;
    this.caret = resolved.cursor;
    if (changed) this.handlers.onChange();
    return true;
  }

  undo(): boolean {
    const previous = this.previous.pop();
    if (!previous) return false;
    this.draft = previous.text;
    this.caret = previous.cursor;
    this.handlers.onChange();
    return true;
  }

  handleRaw(raw: string): void {
    if (!raw) return;
    if (this.escapeTimer) clearTimeout(this.escapeTimer);
    this.escapeTimer = undefined;
    this.pending += raw;
    while (this.pending) {
      const decoded = decodeEmmaKey(this.pending);
      if (decoded.needMore || decoded.used <= 0) break;
      this.pending = this.pending.slice(decoded.used);
      if (!decoded.key) continue;
      if (decoded.key.ctrl && decoded.key.name === 'c') {
        this.resetRaw();
        this.handlers.onInterrupt();
        return;
      }
      if (this.handlers.mode() === 'composer') this.composerKey(decoded.key);
      else this.handlers.onModalKey(decoded.key);
    }
    if (this.pending === ESC) {
      this.escapeTimer = setTimeout(() => {
        this.escapeTimer = undefined;
        if (this.pending === ESC) {
          this.pending = '';
          if (this.handlers.mode() !== 'composer') this.handlers.onModalKey({ name: 'escape' });
        }
      }, 30);
    }
  }

  private recordUndo(): void {
    this.previous.push({ text: this.draft, cursor: this.caret });
    if (this.previous.length > 100) this.previous.shift();
  }

  private replace(from: number, to: number, insertion: string): void {
    const next = this.draft.slice(0, from) + insertion + this.draft.slice(to);
    if (next === this.draft) return;
    this.recordUndo();
    this.draft = next;
    this.caret = from + insertion.length;
    this.handlers.onChange();
  }

  private move(to: number): void {
    const next = safeCaret(this.draft, to);
    if (next === this.caret) return;
    this.caret = next;
    this.handlers.onChange();
  }

  private wordBoundary(direction: -1 | 1): number {
    let at = this.caret;
    if (direction === -1) {
      while (at > 0 && /\s/u.test(this.draft.slice(previousPoint(this.draft, at), at))) at = previousPoint(this.draft, at);
      while (at > 0 && !/\s/u.test(this.draft.slice(previousPoint(this.draft, at), at))) at = previousPoint(this.draft, at);
    } else {
      while (at < this.draft.length && !/\s/u.test(this.draft.slice(at, nextPoint(this.draft, at)))) at = nextPoint(this.draft, at);
      while (at < this.draft.length && /\s/u.test(this.draft.slice(at, nextPoint(this.draft, at)))) at = nextPoint(this.draft, at);
    }
    return at;
  }

  private lineStart(): number { return this.draft.lastIndexOf('\n', this.caret - 1) + 1; }
  private lineEnd(): number {
    const end = this.draft.indexOf('\n', this.caret);
    return end < 0 ? this.draft.length : end;
  }

  private vertical(delta: -1 | 1): void {
    const start = this.lineStart();
    const column = this.caret - start;
    if (delta === -1 && start > 0) {
      const end = start - 1;
      const previousStart = this.draft.lastIndexOf('\n', end - 1) + 1;
      this.move(Math.min(previousStart + column, end));
    } else if (delta === 1) {
      const end = this.lineEnd();
      if (end < this.draft.length) {
        const nextStart = end + 1;
        const nextEndPos = this.draft.indexOf('\n', nextStart);
        const nextEnd = nextEndPos < 0 ? this.draft.length : nextEndPos;
        this.move(Math.min(nextStart + column, nextEnd));
      }
    }
  }

  private composerKey(key: EmmaKey): void {
    if (key.ctrl && key.name === 'z') { this.undo(); return; }
    if (key.name === 'enter') {
      if (key.shift && !key.ctrl) this.replace(this.caret, this.caret, '\n');
      else if (this.handlers.canSubmit() && this.draft.trim()) this.handlers.onSubmit(this.draft);
      return;
    }
    if (key.ctrl && key.name === 'j') { this.replace(this.caret, this.caret, '\n'); return; }
    if (key.ctrl && key.name === 'a') { this.move(this.lineStart()); return; }
    if (key.ctrl && key.name === 'e') { this.move(this.lineEnd()); return; }
    if (key.ctrl && key.name === 'u') { this.replace(this.lineStart(), this.caret, ''); return; }
    if (key.ctrl && key.name === 'k') { this.replace(this.caret, this.lineEnd(), ''); return; }
    if (key.ctrl && key.name === 'w') { this.replace(this.wordBoundary(-1), this.caret, ''); return; }

    switch (key.name) {
      case 'left': this.move(key.ctrl || key.alt ? this.wordBoundary(-1) : previousPoint(this.draft, this.caret)); return;
      case 'right': this.move(key.ctrl || key.alt ? this.wordBoundary(1) : nextPoint(this.draft, this.caret)); return;
      case 'up': this.vertical(-1); return;
      case 'down': this.vertical(1); return;
      case 'home': this.move(key.ctrl ? 0 : this.lineStart()); return;
      case 'end': this.move(key.ctrl ? this.draft.length : this.lineEnd()); return;
      case 'backspace': this.replace(key.ctrl ? this.wordBoundary(-1) : previousPoint(this.draft, this.caret), this.caret, ''); return;
      case 'delete': this.replace(this.caret, key.ctrl ? this.wordBoundary(1) : nextPoint(this.draft, this.caret), ''); return;
      case 'paste': if (key.text) this.replace(this.caret, this.caret, key.text); return;
      case 'tab': this.replace(this.caret, this.caret, '\t'); return;
      default:
        if (key.text && !key.ctrl && !key.alt && !key.meta) this.replace(this.caret, this.caret, key.text);
    }
  }
}
