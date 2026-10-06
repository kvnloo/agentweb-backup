import { resolveNativeTextEdit } from '../tern/textEdit';

describe('Tern native text edit resolver', () => {
  it('rejects an edit against stale terminal text', () => {
    expect(resolveNativeTextEdit('newer', {
      from: 0,
      to: 1,
      text: 'N',
      cursor: 1,
      len: 3,
    })).toBeNull();
  });

  it('applies UTF-16 edits and preserves the caret', () => {
    expect(resolveNativeTextEdit('hello', {
      from: 1,
      to: 4,
      text: 'i',
      cursor: 2,
      len: 5,
    })).toEqual({
      text: 'hio',
      cursor: 2,
      changed: true,
    });
  });

  it('never slices through a surrogate pair', () => {
    const text = 'a🙂b';
    expect(resolveNativeTextEdit(text, {
      // This range starts inside the emoji; the resolver widens to the whole pair.
      from: 2,
      to: 3,
      text: 'X',
      cursor: 2,
      len: text.length,
    })).toEqual({
      text: 'aXb',
      cursor: 2,
      changed: true,
    });
  });

  it('clamps a resulting caret off a surrogate boundary', () => {
    expect(resolveNativeTextEdit('ab', {
      from: 1,
      to: 1,
      text: '🙂',
      cursor: 2,
      len: 2,
    })).toEqual({
      text: 'a🙂b',
      cursor: 1,
      changed: true,
    });
  });

  it('supports pure caret moves without changing text', () => {
    expect(resolveNativeTextEdit('hello', {
      from: 2,
      to: 2,
      text: '',
      cursor: 2,
      len: 5,
    })).toEqual({
      text: 'hello',
      cursor: 2,
      changed: false,
    });
  });
});
