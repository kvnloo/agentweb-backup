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
      // Both offsets point into the surrogate pair. The resolver widens them.
      from: 2,
      to: 2,
      text: 'X',
      cursor: 3,
      len: text.length,
    })).toEqual({
      text: 'aX🙂b',
      cursor: 3,
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
