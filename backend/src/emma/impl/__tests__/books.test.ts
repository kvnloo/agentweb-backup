/**
 * Characterization tests for emma/impl/books.ts (ENG-2103 F2 pilot).
 *
 * These lock in the behavior moved verbatim from
 * AgentModeService.prototype.{listBooks,getBookDetails,getBookContent,
 * updateBookContent,generateBookContent,createBook,createBookOutline,
 * addCharacters} — no prior test file covered these methods directly, so this
 * is the first characterization of the cluster, not a migration of existing tests.
 */

jest.mock('../../../services/bookDb', () => ({
  bookDb: {
    createBook: jest.fn(),
    getBookById: jest.fn(),
    getBooksByUser: jest.fn(),
    updateBook: jest.fn(),
  },
}));

jest.mock('../../../services/bookContentDb', () => ({
  bookContentDb: {
    createOrUpdateContent: jest.fn(),
    getContent: jest.fn(),
    getAllBookContents: jest.fn(),
  },
}));

jest.mock('../../../utils/llmService', () => ({
  createLLMService: jest.fn(),
}));

jest.mock('../../../services/settingsService', () => ({
  settingsService: {
    getSetting: jest.fn(),
  },
}));

jest.mock('../../../services/chatbotService', () => ({
  chatbotDb: {
    addToolCostToSession: jest.fn().mockResolvedValue(undefined),
  },
}));

// A research_url is fetched through utils/callerUrlFetch (guarded DNS, redirects re-checked, size cap; covered in callerUrlFetch.test.ts).
// The real error classes stay real; only the fetch itself is mocked.
jest.mock('../../../utils/callerUrlFetch', () => ({
  ...jest.requireActual('../../../utils/callerUrlFetch'),
  fetchCallerUrlText: jest.fn(),
}));

import { bookDb } from '../../../services/bookDb';
import { bookContentDb } from '../../../services/bookContentDb';
import { createLLMService } from '../../../utils/llmService';
import { settingsService } from '../../../services/settingsService';
import { CallerUrlBlockedError, fetchCallerUrlText } from '../../../utils/callerUrlFetch';
import * as books from '../books';

const mockBookDb = bookDb as jest.Mocked<typeof bookDb>;
const mockBookContentDb = bookContentDb as jest.Mocked<typeof bookContentDb>;
const mockCreateLLMService = createLLMService as jest.Mock;
const mockGetSetting = settingsService.getSetting as jest.Mock;

const BASE_BOOK = {
  bookId: 'book-1',
  userId: 'user-1',
  title: 'My Book',
  description: 'A book',
  content: '',
  type: 'book' as const,
  author: 'Author',
  language: 'English',
  genre: 'Fiction',
  tags: ['tag1'],
  status: 'draft' as const,
  sections: [
    {
      sectionId: 'sec-1',
      title: 'Section 1',
      description: 'S1 desc',
      order: 1,
      chapters: [
        { chapterId: 'chap-1', title: 'Chapter 1', description: 'C1 desc', order: 1 },
      ],
    },
  ],
  characters: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('emma/impl/books.ts (ENG-2103 F2 pilot)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetSetting.mockResolvedValue(undefined);
  });

  describe('listBooks', () => {
    it('returns formatted books', async () => {
      mockBookDb.getBooksByUser.mockResolvedValue([BASE_BOOK as any]);

      const result = await books.listBooks('user-1', 'book', 'draft');

      expect(mockBookDb.getBooksByUser).toHaveBeenCalledWith('user-1', { type: 'book', status: 'draft' });
      expect(result.success).toBe(true);
      expect(result.totalBooks).toBe(1);
      expect(result.books[0]).toMatchObject({ book_id: 'book-1', title: 'My Book', has_sections: true });
    });

    it('returns an empty-but-successful result when no books exist', async () => {
      mockBookDb.getBooksByUser.mockResolvedValue([]);

      const result = await books.listBooks('user-1');

      expect(result).toEqual({ success: true, message: 'No books found', books: [], totalBooks: 0 });
    });

    it('ignores an out-of-enum type/status filter rather than passing it through', async () => {
      mockBookDb.getBooksByUser.mockResolvedValue([]);

      await books.listBooks('user-1', 'not-a-real-type', 'not-a-real-status');

      expect(mockBookDb.getBooksByUser).toHaveBeenCalledWith('user-1', {});
    });

    it('fails closed on a DB error', async () => {
      mockBookDb.getBooksByUser.mockRejectedValue(new Error('ddb down'));

      const result = await books.listBooks('user-1');

      expect(result).toEqual({ success: false, message: 'Failed to list books', error: 'ddb down' });
    });
  });

  describe('getBookDetails', () => {
    it('attaches section/chapter content and formats the outline', async () => {
      mockBookDb.getBookById.mockResolvedValue(BASE_BOOK as any);
      mockBookContentDb.getAllBookContents.mockResolvedValue([
        { bookId: 'book-1', userId: 'user-1', sectionId: 'sec-1', chapterId: 'chap-1', content: 'Chapter body', updatedAt: '2026-01-02T00:00:00.000Z' } as any,
      ]);

      const result = await books.getBookDetails('book-1', 'user-1');

      expect(result.success).toBe(true);
      expect(result.book.outline[0].chapters[0]).toMatchObject({ chapter_id: 'chap-1', has_content: true });
    });

    it('reports not found without leaking whether the book exists for another user', async () => {
      mockBookDb.getBookById.mockResolvedValue(null);

      const result = await books.getBookDetails('missing', 'user-1');

      expect(result).toEqual({ success: false, message: 'Book not found', error: 'Book not found or access denied' });
    });
  });

  describe('getBookContent', () => {
    it('returns has_content: false with an empty-string content hash when nothing was ever written', async () => {
      mockBookDb.getBookById.mockResolvedValue(BASE_BOOK as any);
      mockBookContentDb.getContent.mockResolvedValue(null);

      const result = await books.getBookContent('book-1', 'sec-1', undefined, 'user-1');

      expect(result).toMatchObject({ success: true, has_content: false, content: '' });
      expect(typeof result.content_hash).toBe('string');
      expect(result.content_hash).toHaveLength(64); // sha256 hex digest
    });

    it('fails when the section does not exist on the book', async () => {
      mockBookDb.getBookById.mockResolvedValue(BASE_BOOK as any);

      const result = await books.getBookContent('book-1', 'no-such-section', undefined, 'user-1');

      expect(result).toEqual({ success: false, message: 'Section not found', error: 'Section not found in this book' });
    });
  });

  describe('updateBookContent', () => {
    it('validates replacement_json shape before touching the DB', async () => {
      const result = await books.updateBookContent('book-1', 'sec-1', undefined, [], 'user-1');

      expect(result).toEqual({ success: false, message: 'At least one replacement instruction is required' });
      expect(mockBookDb.getBookById).not.toHaveBeenCalled();
    });

    it('applies a real partial replacement end to end (exercises the shared contentReplacements engine)', async () => {
      mockBookDb.getBookById.mockResolvedValue(BASE_BOOK as any);
      mockBookContentDb.getContent.mockResolvedValue({ content: 'Hello old world' } as any);
      mockBookContentDb.createOrUpdateContent.mockResolvedValue({} as any);

      const result = await books.updateBookContent(
        'book-1', 'sec-1', undefined,
        [{ old_content: 'old', new_content: 'new', expected_count: 1 }],
        'user-1'
      );

      expect(result.success).toBe(true);
      expect(mockBookContentDb.createOrUpdateContent).toHaveBeenCalledWith('book-1', 'user-1', {
        sectionId: 'sec-1',
        chapterId: undefined,
        content: 'Hello new world',
      });
    });

    it('fails with the real mismatch message when expected_count does not match actual occurrences', async () => {
      mockBookDb.getBookById.mockResolvedValue(BASE_BOOK as any);
      mockBookContentDb.getContent.mockResolvedValue({ content: 'old old' } as any);

      const result = await books.updateBookContent(
        'book-1', 'sec-1', undefined,
        [{ old_content: 'old', new_content: 'new', expected_count: 1 }],
        'user-1'
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('Expected 1 occurrences of old_content, but found 2');
      expect(mockBookContentDb.createOrUpdateContent).not.toHaveBeenCalled();
    });
  });

  describe('createBook', () => {
    it('rejects an empty title before calling the DB', async () => {
      const result = await books.createBook('', 'desc', 'book', 'author', 'English', undefined, [], 'user-1');

      expect(result).toEqual({ success: false, message: 'Title is required', error: 'Title cannot be empty' });
      expect(mockBookDb.createBook).not.toHaveBeenCalled();
    });

    it('defaults genre to "Other" for a book type with no genre supplied', async () => {
      mockBookDb.createBook.mockResolvedValue({ ...BASE_BOOK, genre: 'Other' } as any);

      await books.createBook('Title', 'Desc', 'book', 'Author', 'English', undefined, [], 'user-1');

      expect(mockBookDb.createBook).toHaveBeenCalledWith(expect.objectContaining({ genre: 'Other' }));
    });

    it('leaves genre undefined for a whitepaper', async () => {
      mockBookDb.createBook.mockResolvedValue({ ...BASE_BOOK, type: 'whitepaper', genre: undefined } as any);

      await books.createBook('Title', 'Desc', 'whitepaper', 'Author', 'English', 'ignored-for-whitepapers', [], 'user-1');

      expect(mockBookDb.createBook).toHaveBeenCalledWith(expect.objectContaining({ genre: undefined }));
    });
  });

  describe('createBookOutline', () => {
    it('builds sections/chapters with fresh ids and default ordering', async () => {
      mockBookDb.getBookById.mockResolvedValue(BASE_BOOK as any);
      mockBookDb.updateBook.mockResolvedValue(BASE_BOOK as any);

      const result = await books.createBookOutline(
        'book-1',
        JSON.stringify([{ title: 'New Section', chapters: [{ title: 'New Chapter' }] }]),
        'user-1'
      );

      expect(result).toMatchObject({ success: true, sections_count: 1, total_chapters: 1 });
      const updateCall = mockBookDb.updateBook.mock.calls[0][2] as any;
      expect(updateCall.sections[0].title).toBe('New Section');
      expect(typeof updateCall.sections[0].sectionId).toBe('string');
      expect(updateCall.sections[0].chapters[0].order).toBe(1);
    });

    it('reports invalid JSON without touching updateBook', async () => {
      mockBookDb.getBookById.mockResolvedValue(BASE_BOOK as any);

      const result = await books.createBookOutline('book-1', '{not json', 'user-1');

      expect(result.success).toBe(false);
      expect(result.message).toBe('Invalid JSON in outline_json');
      expect(mockBookDb.updateBook).not.toHaveBeenCalled();
    });
  });

  describe('addCharacters', () => {
    it('appends to existing characters rather than replacing them', async () => {
      const bookWithCharacter = { ...BASE_BOOK, characters: [{ name: 'Existing', description: 'D' }] };
      mockBookDb.getBookById.mockResolvedValue(bookWithCharacter as any);
      mockBookDb.updateBook.mockResolvedValue(bookWithCharacter as any);

      const result = await books.addCharacters(
        'book-1',
        JSON.stringify([{ name: 'New', description: 'New desc' }]),
        'user-1'
      );

      expect(result).toMatchObject({ success: true, characters_added: 1, total_characters: 2 });
      expect(mockBookDb.updateBook).toHaveBeenCalledWith('book-1', 'user-1', {
        characters: [{ name: 'Existing', description: 'D' }, { name: 'New', description: 'New desc' }],
      });
    });

    it('rejects a character missing a required field', async () => {
      mockBookDb.getBookById.mockResolvedValue(BASE_BOOK as any);

      const result = await books.addCharacters('book-1', JSON.stringify([{ name: 'No description' }]), 'user-1');

      expect(result.success).toBe(false);
      expect(result.message).toContain('missing required field: description');
      expect(mockBookDb.updateBook).not.toHaveBeenCalled();
    });
  });

  describe('generateBookContent', () => {
    function mockLlmServiceReturning(content: string) {
      const generateJSONContent = jest.fn().mockResolvedValue({ content });
      mockCreateLLMService.mockReturnValue({ generateJSONContent });
      return generateJSONContent;
    }

    it('generates and saves content, and reads the model from settingsService', async () => {
      mockBookDb.getBookById.mockResolvedValue(BASE_BOOK as any);
      mockBookContentDb.getContent.mockResolvedValue(null);
      mockBookContentDb.createOrUpdateContent.mockResolvedValue({} as any);
      mockGetSetting.mockResolvedValue({ settingValue: 'claude-sonnet-5' } as any);
      const generateJSONContent = mockLlmServiceReturning('Generated chapter body.');

      const result = await books.generateBookContent(
        'book-1', 'sec-1', 'chap-1', 'Write about X', 'short', true, 'user-1', undefined, 'session-1'
      );

      expect(result.success).toBe(true);
      expect(result.content_preview).toContain('Generated chapter body.');
      expect(mockCreateLLMService).toHaveBeenCalledWith('claude-sonnet-5', 0.8, 4000);
      expect(mockBookContentDb.createOrUpdateContent).toHaveBeenCalledWith('book-1', 'user-1', {
        sectionId: 'sec-1',
        chapterId: 'chap-1',
        content: 'Generated chapter body.',
      });
    });

    // ENG-2103 F2 audit (RunFunding/billingUserId metering — F1 rounds 3-5,
    // lesson-forwarding-resolved-field-suppresses-downstream-resolver): the real
    // production bug in that lesson was a same-value billingUserId forwarded
    // into a usageContext, which short-circuits meterWithResolvedBilling's own
    // org-billing-subject resolution. Assert this call site does NOT do that —
    // userId is forwarded (as today) and billingUserId is absent, letting
    // meterWithResolvedBilling's own resolver run.
    it('forwards userId but never billingUserId in the LLM usageContext (no metering short-circuit)', async () => {
      mockBookDb.getBookById.mockResolvedValue(BASE_BOOK as any);
      mockBookContentDb.getContent.mockResolvedValue(null);
      mockBookContentDb.createOrUpdateContent.mockResolvedValue({} as any);
      const generateJSONContent = mockLlmServiceReturning('Body.');

      // chap-1: ENG-2790 (ecde12f29) refuses a chapter-less generate on a section that has chapters.
      await books.generateBookContent('book-1', 'sec-1', 'chap-1', 'desc', 'short', true, 'user-42', undefined, 'session-9');

      const usageContext = generateJSONContent.mock.calls[0][4];
      expect(usageContext).toEqual({ userId: 'user-42', sessionId: 'session-9', feature: 'content_gen' });
      expect(usageContext.billingUserId).toBeUndefined();
    });

    it('fetches research content from the given URL and includes it in the prompt', async () => {
      mockBookDb.getBookById.mockResolvedValue(BASE_BOOK as any);
      mockBookContentDb.getContent.mockResolvedValue(null);
      mockBookContentDb.createOrUpdateContent.mockResolvedValue({} as any);
      const generateJSONContent = mockLlmServiceReturning('Body.');
      (fetchCallerUrlText as jest.Mock).mockResolvedValue('DEEP RESEARCH TEXT');

      await books.generateBookContent(
        'book-1', 'sec-1', 'chap-1', 'desc', 'short', true, 'user-1', 'https://example.com/research.md', 'session-1'
      );

      expect(fetchCallerUrlText).toHaveBeenCalledWith(
        'https://example.com/research.md',
        expect.objectContaining({ tool: 'generate_book_content', userId: 'user-1' })
      );
      const userPrompt = generateJSONContent.mock.calls[0][1] as string;
      expect(userPrompt).toContain('DEEP RESEARCH TEXT');
    });

    // The research text is optional context: any failure leaves it empty and the book content is still written, as before.
    it.each([
      ['a URL the guard refuses (private or internal address)', () => new CallerUrlBlockedError()],
      ['a dead link', () => new Error('Request failed with status code 404')],
    ])('still generates the content, without research, when the research_url is %s', async (_label, makeError) => {
      mockBookDb.getBookById.mockResolvedValue(BASE_BOOK as any);
      mockBookContentDb.getContent.mockResolvedValue(null);
      mockBookContentDb.createOrUpdateContent.mockResolvedValue({} as any);
      const generateJSONContent = mockLlmServiceReturning('Body.');
      (fetchCallerUrlText as jest.Mock).mockRejectedValue(makeError());
      const err = jest.spyOn(console, 'error').mockImplementation(() => undefined);

      const result = await books.generateBookContent(
        'book-1', 'sec-1', 'chap-1', 'desc', 'short', true, 'user-1', 'http://169.254.169.254/latest/meta-data/', 'session-1'
      );
      err.mockRestore();

      expect(result.success).toBe(true);
      expect(generateJSONContent).toHaveBeenCalledTimes(1);
      const userPrompt = generateJSONContent.mock.calls[0][1] as string;
      expect(userPrompt).not.toContain('169.254');
      expect(userPrompt).not.toContain('meta-data');
    });

    it('returns a failure envelope (not a throw) when the book does not exist', async () => {
      mockBookDb.getBookById.mockResolvedValue(null);

      const result = await books.generateBookContent('missing', 'sec-1', undefined, 'desc', 'short', true, 'user-1');

      expect(result).toEqual({ success: false, message: 'Book not found', error: 'Book not found or access denied' });
      expect(mockCreateLLMService).not.toHaveBeenCalled();
    });
  });
});
