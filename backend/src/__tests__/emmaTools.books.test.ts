/**
 * ENG-2103 F2 pilot — proves emma/tools.ts's book tool execute() bodies call
 * emma/impl/books.ts directly (not agentModeService.<method>) and forward the
 * result unchanged, mirroring the existing pattern for other tools (see
 * emma.readFileContentTool.test.ts) and F1's own runBackend.test.ts's
 * "returns the result unchanged" style.
 */

jest.mock('../emma/impl/books', () => ({
  listBooks: jest.fn(),
  getBookDetails: jest.fn(),
  getBookContent: jest.fn(),
  updateBookContent: jest.fn(),
  generateBookContent: jest.fn(),
  createBook: jest.fn(),
  createBookOutline: jest.fn(),
  addCharacters: jest.fn(),
}));

// agentModeService.<bookMethod> must NOT be called by these tools anymore — mock
// the whole module so a regression (a call site accidentally left pointed at the
// class) would throw instead of silently succeeding against the real service.
jest.mock('../services/agentModeService', () => ({
  agentModeService: new Proxy(
    {},
    {
      get(_target, prop) {
        return () => {
          throw new Error(`agentModeService.${String(prop)} should not be called by the books tool cluster after ENG-2103 F2`);
        };
      },
    }
  ),
}));

import { emmaToolRegistry } from '../emma/registry';
import * as booksImpl from '../emma/impl/books';
import '../emma/tools';

const mockBooksImpl = booksImpl as jest.Mocked<typeof booksImpl>;

describe('books tool cluster delegates to emma/impl/books.ts (ENG-2103 F2 pilot)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('list_books forwards args and returns the result unchanged', async () => {
    const expected = { success: true, books: [], totalBooks: 0 };
    mockBooksImpl.listBooks.mockResolvedValue(expected);

    const tool = emmaToolRegistry.getTool('list_books')!;
    const result = await tool.execute({ type: 'book', status: 'draft' }, { userId: 'u1' });

    expect(mockBooksImpl.listBooks).toHaveBeenCalledWith('u1', 'book', 'draft');
    expect(result).toBe(expected);
  });

  it('get_book_details forwards args and returns the result unchanged', async () => {
    const expected = { success: true, book: { book_id: 'b1' } };
    mockBooksImpl.getBookDetails.mockResolvedValue(expected);

    const tool = emmaToolRegistry.getTool('get_book_details')!;
    const result = await tool.execute({ book_id: 'b1' }, { userId: 'u1' });

    expect(mockBooksImpl.getBookDetails).toHaveBeenCalledWith('b1', 'u1');
    expect(result).toBe(expected);
  });

  it('get_book_content wraps a successful result in the MCP content envelope', async () => {
    mockBooksImpl.getBookContent.mockResolvedValue({ success: true, content: 'hello' });

    const tool = emmaToolRegistry.getTool('get_book_content')!;
    const result = await tool.execute({ book_id: 'b1', section_id: 's1' }, { userId: 'u1' });

    expect(mockBooksImpl.getBookContent).toHaveBeenCalledWith('b1', 's1', undefined, 'u1');
    expect(result).toEqual({ content: [{ type: 'text', text: 'hello' }] });
  });

  it('get_book_content wraps a failure result as isError', async () => {
    mockBooksImpl.getBookContent.mockResolvedValue({ success: false, message: 'nope', error: 'boom' });

    const tool = emmaToolRegistry.getTool('get_book_content')!;
    const result = await tool.execute({ book_id: 'b1', section_id: 's1' }, { userId: 'u1' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('nope');
  });

  it('update_book_content parses replacement_json and forwards it', async () => {
    const expected = { success: true };
    mockBooksImpl.updateBookContent.mockResolvedValue(expected);
    const replacements = [{ old_content: 'a', new_content: 'b', expected_count: 1 }];

    const tool = emmaToolRegistry.getTool('update_book_content')!;
    const result = await tool.execute(
      { book_id: 'b1', section_id: 's1', replacement_json: JSON.stringify(replacements) },
      { userId: 'u1' }
    );

    expect(mockBooksImpl.updateBookContent).toHaveBeenCalledWith('b1', 's1', undefined, replacements, 'u1');
    expect(result).toBe(expected);
  });

  it('update_book_content reports invalid JSON without calling emma/impl/books.ts', async () => {
    const tool = emmaToolRegistry.getTool('update_book_content')!;
    const result = await tool.execute(
      { book_id: 'b1', section_id: 's1', replacement_json: '{not json' },
      { userId: 'u1' }
    );

    expect(result.success).toBe(false);
    expect(result.message).toBe('Invalid JSON in replacement_json');
    expect(mockBooksImpl.updateBookContent).not.toHaveBeenCalled();
  });

  it('generate_book_content forwards args including session context', async () => {
    const expected = { success: true, content_preview: 'preview' };
    mockBooksImpl.generateBookContent.mockResolvedValue(expected);

    const tool = emmaToolRegistry.getTool('generate_book_content')!;
    const result = await tool.execute(
      { book_id: 'b1', section_id: 's1', chapter_id: 'c1', content_description: 'desc', length: 'long', imagine: false, research_url: 'https://x' },
      { userId: 'u1', sessionId: 'sess1' }
    );

    expect(mockBooksImpl.generateBookContent).toHaveBeenCalledWith('b1', 's1', 'c1', 'desc', 'long', false, 'u1', 'https://x', 'sess1');
    expect(result).toBe(expected);
  });

  it('create_book forwards args with a default empty tags array', async () => {
    const expected = { success: true, book: { book_id: 'b1' } };
    mockBooksImpl.createBook.mockResolvedValue(expected);

    const tool = emmaToolRegistry.getTool('create_book')!;
    const result = await tool.execute(
      { title: 'T', description: 'D', type: 'book', author: 'A', language: 'English', genre: 'Fiction' },
      { userId: 'u1' }
    );

    expect(mockBooksImpl.createBook).toHaveBeenCalledWith('T', 'D', 'book', 'A', 'English', 'Fiction', [], 'u1');
    expect(result).toBe(expected);
  });

  it('create_book_outline forwards args and returns the result unchanged', async () => {
    const expected = { success: true, sections_count: 1 };
    mockBooksImpl.createBookOutline.mockResolvedValue(expected);

    const tool = emmaToolRegistry.getTool('create_book_outline')!;
    const result = await tool.execute({ book_id: 'b1', outline_json: '[]' }, { userId: 'u1' });

    expect(mockBooksImpl.createBookOutline).toHaveBeenCalledWith('b1', '[]', 'u1');
    expect(result).toBe(expected);
  });

  it('add_characters forwards args and returns the result unchanged', async () => {
    const expected = { success: true, characters_added: 1 };
    mockBooksImpl.addCharacters.mockResolvedValue(expected);

    const tool = emmaToolRegistry.getTool('add_characters')!;
    const result = await tool.execute({ book_id: 'b1', characters_json: '[]' }, { userId: 'u1' });

    expect(mockBooksImpl.addCharacters).toHaveBeenCalledWith('b1', '[]', 'u1');
    expect(result).toBe(expected);
  });
});
