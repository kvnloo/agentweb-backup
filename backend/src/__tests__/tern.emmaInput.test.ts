import { EmmaInputController, EmmaInputMode, EmmaKey } from '../scripts/tern-emma-input';
import { encodeTspJson, TspStreamReader } from '../tern/protocol';

function fixture() {
  let mode: EmmaInputMode = 'composer';
  let busy = false;
  const posts: string[] = [];
  const commands: string[] = [];
  const modalKeys: EmmaKey[] = [];
  const onInterrupt = jest.fn();
  const onChange = jest.fn();
  const input = new EmmaInputController({
    mode: () => mode,
    canSubmit: () => !busy && mode === 'composer',
    onSubmit: prompt => {
      if (prompt.trim() === '/resume' || prompt.trim() === '/sessions') {
        commands.push(prompt);
        mode = 'picker';
        input.clear();
        return;
      }
      // Match sendPrompt's synchronous busy gate; never model an invented TSP send.
      if (busy) return;
      busy = true;
      posts.push(prompt);
      input.clear();
    },
    onModalKey: key => modalKeys.push(key),
    onInterrupt,
    onChange,
  });
  return {
    input, posts, commands, modalKeys, onInterrupt, onChange,
    setMode: (next: EmmaInputMode) => { mode = next; input.resetRaw(); },
    setBusy: (next: boolean) => { busy = next; },
  };
}

describe('Emma production raw PTY input handler', () => {
  it('submits ordinary typing and Enter exactly once from an empty composer', () => {
    const f = fixture();
    f.input.handleRaw('Run two native fixture tools\r\r');
    expect(f.posts).toEqual(['Run two native fixture tools']);
    expect(f.input.text).toBe('');
    expect(f.onChange).toHaveBeenCalled();
  });

  it('keeps a draft while busy, without a second submit', () => {
    const f = fixture();
    f.input.handleRaw('first\r');
    f.input.handleRaw('second\r');
    expect(f.posts).toEqual(['first']);
    expect(f.input.text).toBe('second');
    f.setBusy(false);
    f.input.handleRaw('\x1b[13u');
    expect(f.posts).toEqual(['first', 'second']);
  });

  it('handles Unicode and split bracketed paste, including literal newlines', () => {
    const f = fixture();
    f.input.handleRaw('é🙂');
    f.input.handleRaw('\x1b[200~line one\n');
    f.input.handleRaw('line two🙂\x1b[201~');
    expect(f.input.text).toBe('é🙂line one\nline two🙂');
    expect(f.posts).toEqual([]);
    f.input.handleRaw('\r');
    expect(f.posts).toEqual(['é🙂line one\nline two🙂']);
  });

  it('inserts Shift+Enter multiline; Ctrl+Enter submits the same text', () => {
    const f = fixture();
    f.input.handleRaw('first\x1b[13;2u');
    f.input.handleRaw('second');
    expect(f.input.text).toBe('first\nsecond');
    f.input.handleRaw('\x1b[13;5u');
    expect(f.posts).toEqual(['first\nsecond']);
  });

  it('moves the caret and deletes Unicode code points without splitting surrogates', () => {
    const f = fixture();
    f.input.handleRaw('a🙂c\x1b[D\x1b[D');
    expect(f.input.cursor).toBe(1);
    f.input.handleRaw('\x1b[3~');
    expect(f.input.text).toBe('ac');
    f.input.handleRaw('é');
    expect(f.input.text).toBe('aéc');
    f.input.handleRaw('\x7f');
    expect(f.input.text).toBe('ac');
    f.input.handleRaw('\x1b[F!\r');
    expect(f.posts).toEqual(['ac!']);
  });

  it('keeps native selection replacement and subsequent raw keys synchronized', () => {
    const f = fixture();
    f.input.handleRaw('abcXYZ');
    expect(f.input.applyNativeEdit({ from: 1, to: 5, text: '🙂', cursor: 3, len: 6 })).toBe(true);
    f.input.handleRaw('!');
    expect(f.input.text).toBe('a🙂!Z');
    expect(f.input.applyNativeEdit({ from: 0, to: 1, text: '?', cursor: 1, len: 6 })).toBe(false);
    f.input.handleRaw('\r');
    expect(f.posts).toEqual(['a🙂!Z']);
  });

  it('shares undo history between native edits and raw Ctrl+Z', () => {
    const f = fixture();
    f.input.handleRaw('abc');
    expect(f.input.applyNativeEdit({ from: 1, to: 1, text: '', cursor: 1, len: 3 })).toBe(true);
    f.input.handleRaw('🙂');
    expect(f.input.text).toBe('a🙂bc');
    f.input.handleRaw('\x1b[122;5u');
    expect(f.input.text).toBe('abc');
    expect(f.input.cursor).toBe(1);
    expect(f.input.undo()).toBe(true);
    expect(f.input.text).toBe('ab');
  });

  it('passes /resume through the normal submit route and then retains picker keyboard input', () => {
    const f = fixture();
    f.input.handleRaw('/resume\r');
    expect(f.commands).toEqual(['/resume']);
    expect(f.posts).toEqual([]);
    f.input.handleRaw('\x1b[B\r');
    expect(f.modalKeys.map(key => key.name)).toEqual(['down', 'enter']);
  });

  it('honors ordinary and kitty-encoded Ctrl+C in composer and modal modes', () => {
    const f = fixture();
    f.input.handleRaw('\x03');
    f.input.handleRaw('\x1b[99;5u');
    f.input.handleRaw('\x1b[99;6u');
    f.setMode('picker');
    f.input.handleRaw('\x1b[3;5u');
    expect(f.onInterrupt).toHaveBeenCalledTimes(4);
    expect(f.posts).toEqual([]);
  });

  it('dispatches raw PTY bytes around real TSP event frames', () => {
    const f = fixture();
    const reader = new TspStreamReader();
    const stream = 'hello' + encodeTspJson('e', { ev: 'ack', sf: 'agentweb-emma', s: 1 }) + '\r';
    for (const part of reader.pushParts(stream)) {
      if (part.type === 'raw') f.input.handleRaw(part.data);
    }
    expect(f.posts).toEqual(['hello']);
  });

  it('preserves shifted Kitty printable characters from unshifted keycodes', () => {
    const f = fixture();
    f.input.handleRaw('\x1b[114;2u\x1b[49;2u\x1b[49:33;2u');
    expect(f.input.text).toBe('R!!');
    f.input.handleRaw('\r');
    expect(f.posts).toEqual(['R!!']);
  });

  it('ignores kitty key-release events and never inserts unrelated CSI replies', () => {
    const f = fixture();
    f.input.handleRaw('\x1b[97;1:3u\x1b[?1;2c');
    expect(f.input.text).toBe('');
    f.input.handleRaw('\x1b[233u');
    expect(f.input.text).toBe('é');
  });
});
