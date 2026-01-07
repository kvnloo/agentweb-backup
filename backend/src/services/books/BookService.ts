
import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';
import { ToolService } from '../../tools/ServiceRegistry';
import { settingsService } from '../settingsService';
import { createLLMService } from '../../utils/llmService';

// Interfaces for structured data
interface BookSection {
  title: string;
  description?: string;
  chapters?: Array<{
    title: string;
    description?: string;
  }>;
}

interface Character {
  name: string;
  description: string;
}

/**
 * Book Service
 * Manages books, whitepapers, outlines, and content generation.
 */
export class BookService implements ToolService {
  readonly serviceName = 'book';

  /**
   * List all books for a user
   */
  async listBooks(userId: string, type?: string, status?: string): Promise<any> {
    try {
      console.log('BookService: Listing books for user:', userId);
      const { bookDb } = await import('../bookDb');

      const filters: {
        type?: "book" | "whitepaper";
        status?: "draft" | "published" | "archived";
      } = {};

      if (type === "book" || type === "whitepaper") {
        filters.type = type;
      }

      if (status === "draft" || status === "published" || status === "archived") {
        filters.status = status;
      }

      const books = await bookDb.getBooksByUser(userId, filters);

      if (!books || books.length === 0) {
        return {
          success: true,
          message: 'No books found',
          books: [],
          totalBooks: 0
        };
      }

      // Format books for Agent Mode
      const formattedBooks = books.map((book: any) => ({
        book_id: book.bookId,
        title: book.title,
        description: book.description,
        type: book.type,
        author: book.author,
        status: book.status,
        published_at: book.publishedAt,
        created_at: book.createdAt,
        updated_at: book.updatedAt,
        tags: book.tags || [],
        has_sections: !!(book.sections && book.sections.length > 0)
      }));

      return {
        success: true,
        message: `Found ${formattedBooks.length} book(s)`,
        books: formattedBooks,
        totalBooks: formattedBooks.length
      };
    } catch (error) {
      console.error('BookService: Error listing books:', error);
      return {
        success: false,
        message: 'Failed to list books',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Get details of a specific book
   */
  async getBookDetails(bookId: string, userId: string): Promise<any> {
    try {
      console.log('BookService: Getting book details for:', bookId);
      const { bookDb } = await import('../bookDb');
      const { bookContentDb } = await import('../bookContentDb');

      const book = await bookDb.getBookById(bookId, userId);

      if (!book) {
        return {
          success: false,
          message: 'Book not found',
          error: 'Book not found or access denied'
        };
      }

      // Load all contents for this book
      const contents = await bookContentDb.getAllBookContents(bookId, userId);

      // Attach contents to sections and chapters
      if (book.sections) {
        for (const section of book.sections) {
          const sectionContent = contents.find(
            (c) => c.sectionId === section.sectionId && !c.chapterId
          );
          if (sectionContent) {
            section.content = sectionContent.content;
          }

          for (const chapter of section.chapters) {
            const chapterContent = contents.find(
              (c) => c.sectionId === section.sectionId && c.chapterId === chapter.chapterId
            );
            if (chapterContent) {
              chapter.content = chapterContent.content;
            }
          }
        }
      }

      // Format book details for Agent Mode
      const formattedBook = {
        book_id: book.bookId,
        title: book.title,
        description: book.description,
        type: book.type,
        author: book.author,
        language: book.language,
        genre: book.genre,
        status: book.status,
        published_at: book.publishedAt,
        created_at: book.createdAt,
        updated_at: book.updatedAt,
        tags: book.tags || [],
        cover_image_url: book.coverImageUrl,
        characters: book.characters || [],
        outline: book.sections ? book.sections.map((section: any) => ({
          section_id: section.sectionId,
          title: section.title,
          description: section.description,
          order: section.order,
          has_content: !!section.content,
          chapters: section.chapters.map((chapter: any) => ({
            chapter_id: chapter.chapterId,
            title: chapter.title,
            description: chapter.description,
            order: chapter.order,
            has_content: !!chapter.content
          }))
        })) : []
      };

      return {
        success: true,
        message: 'Book details retrieved successfully',
        book: formattedBook
      };
    } catch (error) {
      console.error('BookService: Error getting book details:', error);
      return {
        success: false,
        message: 'Failed to get book details',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Get content of a specific section or chapter
   */
  async getBookContent(
    bookId: string,
    sectionId: string,
    chapterId: string | undefined,
    userId: string
  ): Promise<any> {
    try {
      console.log('BookService: Getting book content for:', { bookId, sectionId, chapterId });
      const { bookDb } = await import('../bookDb');
      const { bookContentDb } = await import('../bookContentDb');

      // Verify book exists and belongs to user
      const book = await bookDb.getBookById(bookId, userId);
      if (!book) {
        return {
          success: false,
          message: 'Book not found',
          error: 'Book not found or access denied'
        };
      }

      // Verify section exists
      const section = book.sections?.find((s) => s.sectionId === sectionId);
      if (!section) {
        return {
          success: false,
          message: 'Section not found',
          error: 'Section not found in this book'
        };
      }

      // If chapterId provided, verify chapter exists
      if (chapterId) {
        const chapter = section.chapters.find((c) => c.chapterId === chapterId);
        if (!chapter) {
          return {
            success: false,
            message: 'Chapter not found',
            error: 'Chapter not found in this section'
          };
        }
      }

      // Get content from bookContentDb
      const content = await bookContentDb.getContent(bookId, userId, sectionId, chapterId);

      if (!content) {
        const emptyContentHash = createHash('sha256').update('').digest('hex');
        return {
          success: true,
          message: chapterId ? 'Chapter content not found' : 'Section content not found',
          content: '',
          content_hash: emptyContentHash,
          content_type: chapterId ? 'chapter' : 'section',
          section_id: sectionId,
          chapter_id: chapterId || null,
          has_content: false
        };
      }

      const contentHash = createHash('sha256').update(content.content).digest('hex');

      return {
        success: true,
        message: chapterId ? 'Chapter content retrieved successfully' : 'Section content retrieved successfully',
        content: content.content,
        content_hash: contentHash,
        content_type: chapterId ? 'chapter' : 'section',
        section_id: sectionId,
        chapter_id: chapterId || null,
        has_content: true,
        updated_at: content.updatedAt,
        imagine: content.imagine
      };

    } catch (error) {
      console.error('BookService: Error getting book content:', error);
      return {
        success: false,
        message: 'Failed to get book content',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Generate content for a book section or chapter
   */
  async generateBookContent(
    bookId: string,
    sectionId: string,
    chapterId: string | undefined,
    contentDescription: string,
    length: string,
    imagine: boolean,
    userId: string,
    researchUrl?: string
  ): Promise<any> {
    try {
      console.log('BookService: Generating book content for:', { bookId, sectionId, chapterId, length, imagine, userId, researchUrl: researchUrl ? 'provided' : 'not provided' });
      const { bookDb } = await import('../bookDb');
      const { bookContentDb } = await import('../bookContentDb');

      // Fetch research content from S3 URL if provided
      let researchContent = '';
      if (researchUrl) {
        try {
          console.log('BookService: Fetching research content from S3:', researchUrl);
          const response = await fetch(researchUrl);
          if (response.ok) {
            researchContent = await response.text();
            console.log(`BookService: Fetched ${researchContent.length} characters of research content`);
          } else {
            console.warn('BookService: Failed to fetch research content from S3:', response.status);
          }
        } catch (fetchError) {
          console.error('BookService: Error fetching research content:', fetchError);
        }
      }

      // Verify book exists and belongs to user
      const book = await bookDb.getBookById(bookId, userId);
      if (!book) {
        return {
          success: false,
          message: 'Book not found',
          error: 'Book not found or access denied'
        };
      }

      // Verify section exists
      const section = book.sections?.find((s) => s.sectionId === sectionId);
      if (!section) {
        return {
          success: false,
          message: 'Section not found',
          error: 'Section not found in this book'
        };
      }

      // If chapterId provided, verify chapter exists
      if (chapterId) {
        const chapter = section.chapters.find((c) => c.chapterId === chapterId);
        if (!chapter) {
          return {
            success: false,
            message: 'Chapter not found',
            error: 'Chapter not found in this section'
          };
        }
      }

      // Get existing content if it exists
      const existingContent = await bookContentDb.getContent(bookId, userId, sectionId, chapterId);
      const existingContentText = existingContent?.content || '';

      // Check if imagine setting exists in content record and overwrite the parameter only when it's false
      let finalImagine = imagine;
      let imagineOverridden = false;
      if (existingContent?.imagine === false) {
        finalImagine = false;
        imagineOverridden = true;
      }

      // Map length to word count range
      const bookWordCounts: Record<string, { min: number; max: number; target: number }> = {
        short: { min: 1000, max: 2000, target: 1500 },
        medium: { min: 2000, max: 3000, target: 2500 },
        long: { min: 3000, max: 4000, target: 3500 }
      };

      const whitepaperWordCounts: Record<string, { min: number; max: number; target: number }> = {
        short: { min: 300, max: 600, target: 450 },   // ~1 page
        medium: { min: 600, max: 1000, target: 800 }, // ~2 pages
        long: { min: 1000, max: 1500, target: 1250 }  // ~3 pages
      };

      const wordCountRanges = book.type === 'whitepaper' ? whitepaperWordCounts : bookWordCounts;
      const wordCount = wordCountRanges[length] || wordCountRanges.medium;

      // Get section/chapter title for context
      const sectionTitle = section.title;
      const chapterTitle = chapterId ? section.chapters.find((c) => c.chapterId === chapterId)?.title : undefined;
      const contentTitle = chapterTitle || sectionTitle;

      // Build the prompt for content generation (shortened for brevity but retaining core logic)
      let contentPrompt = `You are an expert content writer creating ${length} content for a ${book.type === 'book' ? 'book' : 'white paper'} chapter or section.
Book Context:
- Title: ${book.title}
- Author: ${book.author}
- Type: ${book.type}
${book.description ? `- Description: ${book.description}` : ''}
${book.language ? `- Language: ${book.language}` : ''}
${book.type === 'book' && book.genre ? `- Genre: ${book.genre}` : ''}
${book.type === 'book' && book.characters && book.characters.length > 0 ? `
- Characters:
${book.characters.map((char, idx) => `  ${idx + 1}. ${char.name}: ${char.description}`).join('\n')}
IMPORTANT: Only include relevant characters.` : ''}

Content Context:
- ${chapterId ? 'Chapter' : 'Section'} Title: ${contentTitle}
${section.description ? `- Section Description: ${section.description}` : ''}
${chapterId && section.chapters.find((c) => c.chapterId === chapterId)?.description ? `- Chapter Description: ${section.chapters.find((c) => c.chapterId === chapterId)?.description}` : ''}

Content Requirements:
- Content Description: ${contentDescription}
- Target Length: ${wordCount.min}-${wordCount.max} words (aim for ~${wordCount.target})
- Format: Markdown with headings (H2, H3), paragraphs, lists.
- Style: Professional, engaging.
${book.language === '中文' ? '- Language: Write in Chinese (中文)' : '- Language: Write in English'}
${book.type === 'book' && book.genre ? `- Genre: Write in ${book.genre} style` : ''}
${!finalImagine ? `CRITICAL: Do NOT invent details. Stick to facts/provided info.` : ''}

${existingContentText ? `Existing Content (enhance/expand):
${existingContentText}` : 'Instructions: Create from scratch.'}${researchContent ? `

=== DEEP RESEARCH CONTENT ===
${researchContent}
=== END OF RESEARCH CONTENT ===
` : ''}${book.type === 'whitepaper' ? `
IMPORTANT WHITEPAPER GUIDELINES:
- Concise, professional.
${researchContent ? '- EXTRACT and REFORMAT relevant research.' : '- REFORMAT and CONDENSE specific content.'}
- Data-driven, bullet points, tables.
- Target exactly ${wordCount.target} words (max ${wordCount.max}).
- No repetition.` : ''}`;

      // Get content model from settings
      let contentModel: string | undefined;
      try {
        const setting = await settingsService.getSetting('agent_mode_content_model');
        if (setting && setting.settingValue) {
          contentModel = setting.settingValue;
        }
      } catch (error) {
        console.error('Error getting content model setting:', error);
      }

      // Generate content using LLM service
      const modelName = contentModel || process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4';
      
      // Use XML format for Chinese content
      const useXMLFormat = book.language === '中文';
      const format = useXMLFormat ? 'xml' : 'json';
      console.log(`[BookService] Using model: ${modelName}, format: ${format.toUpperCase()}`);

      const llmService = createLLMService(modelName, 0.8, 4000);

      const systemPrompt = `You are a seasoned content writer specializing in ${book.type === 'book' ? 'books' : 'white papers'}. ${book.language === '中文' ? 'Write in Chinese (中文).' : 'Write in English.'}
${useXMLFormat ? `CRITICAL: Respond ONLY in XML format.
<response>
  <content>Full content in markdown...</content>
</response>` : `Format your response as JSON:
{
  "content": "Full content in markdown..."
}`}`;

      const contentData = await llmService.generateJSONContent<{ content: string }>(systemPrompt, contentPrompt, format);

      if (!contentData.content) {
        throw new Error('LLM response missing "content" field');
      }
      let finalContent = contentData.content.trim();
      finalContent = finalContent.replace(/^```markdown\s*|\s*```$/g, '').trim();
      finalContent = finalContent.replace(/^```\s*|\s*```$/g, '').trim();

      // Save content
      await bookContentDb.createOrUpdateContent(
        bookId,
        userId,
        {
          sectionId,
          chapterId,
          content: finalContent
        }
      );

      const wordCountActual = finalContent.split(/\s+/).filter((word: string) => word.length > 0).length;
      
      let message = `${chapterId ? 'Chapter' : 'Section'} content generated successfully`;
      if (imagineOverridden) {
        message += ` (imagine setting from DB: ${finalImagine ? 'enabled' : 'disabled'})`;
      }

      return {
        success: true,
        message,
        content_type: chapterId ? 'chapter' : 'section',
        section_id: sectionId,
        chapter_id: chapterId || null,
        content_length: finalContent.length,
        word_count: wordCountActual,
        target_word_range: `${wordCount.min}-${wordCount.max}`
      };

    } catch (error) {
      console.error('BookService: Error generating content:', error);
      return {
        success: false,
        message: 'Failed to generate content',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Create a new book
   */
  async createBook(
    title: string,
    description: string,
    type: "book" | "whitepaper",
    author: string,
    language: string,
    genre: string,
    tags: string[],
    userId: string
  ): Promise<any> {
    try {
      console.log('BookService: Creating new book:', title);
      const { bookDb } = await import('../bookDb');

      const book = await bookDb.createBook({
        userId,
        title,
        description,
        type,
        author,
        language,
        genre,
        tags,
        status: "draft",
        content: "" // Initialize with empty content
      });

      return {
        success: true,
        message: `Book "${title}" created successfully`,
        book_id: book.bookId,
        book
      };
    } catch (error) {
      console.error('BookService: Error creating book:', error);
      return {
        success: false,
        message: 'Failed to create book',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Create a book outline
   */
  async createBookOutline(bookId: string, outlineJson: string, userId: string): Promise<any> {
    try {
      console.log('BookService: Creating book outline for:', bookId);
      const { bookDb } = await import('../bookDb');

      const book = await bookDb.getBookById(bookId, userId);
      if (!book) {
        return { success: false, message: 'Book not found' };
      }

      let outline: any[];
      try {
        outline = JSON.parse(outlineJson);
      } catch (e) {
        return { success: false, message: 'Invalid JSON in outline_json' };
      }

      if (!Array.isArray(outline)) {
        return { success: false, message: 'Outline must be an array of sections' };
      }

      const sections = outline.map((section: any, sectionIndex: number) => {
        if (!section.title) throw new Error(`Missing title for section ${sectionIndex}`);
        const sectionId = uuidv4();
        
        const chapters = (section.chapters || []).map((chapter: any, chapterIndex: number) => {
          if (!chapter.title) throw new Error(`Missing title for chapter ${chapterIndex}`);
          return {
            chapterId: uuidv4(),
            title: chapter.title.trim(),
            description: chapter.description?.trim() || '',
            order: chapter.order !== undefined ? chapter.order : chapterIndex + 1
          };
        });

        return {
          sectionId,
          title: section.title.trim(),
          description: section.description?.trim() || '',
          order: section.order !== undefined ? section.order : sectionIndex + 1,
          chapters
        };
      });

      const updatedBook = await bookDb.updateBook(bookId, userId, { sections });

      if (!updatedBook) {
        return { success: false, message: 'Failed to update book outline' };
      }

      const totalChapters = sections.reduce((sum, s) => sum + s.chapters.length, 0);

      return {
        success: true,
        message: `Outline created with ${sections.length} sections and ${totalChapters} chapters`,
        book_id: bookId,
        sections_count: sections.length,
        total_chapters: totalChapters
      };
    } catch (error) {
      console.error('BookService: Error creating outline:', error);
      return {
        success: false,
        message: 'Failed to create outline',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Add characters to a book
   */
  async addCharacters(bookId: string, charactersJson: string, userId: string): Promise<any> {
    try {
       console.log('BookService: Adding characters to book:', bookId);
       const { bookDb } = await import('../bookDb');

       const book = await bookDb.getBookById(bookId, userId);
       if (!book) {
         return { success: false, message: 'Book not found' };
       }

       let newCharacters: any[];
       try {
         newCharacters = JSON.parse(charactersJson);
       } catch (e) {
         return { success: false, message: 'Invalid JSON in characters_json' };
       }

       if (!Array.isArray(newCharacters)) {
         return { success: false, message: 'Characters must be an array' };
       }

       const existingCharacters = book.characters || [];
       const updatedCharacters = [...existingCharacters];

       for (const char of newCharacters) {
         if (!char.name || !char.description) {
           throw new Error('Each character must have name and description');
         }
         
         const existingIndex = updatedCharacters.findIndex(
           c => c.name.toLowerCase() === char.name.toLowerCase()
         );
         
         if (existingIndex >= 0) {
           updatedCharacters[existingIndex] = char;
         } else {
           updatedCharacters.push(char);
         }
       }

       const updatedBook = await bookDb.updateBook(bookId, userId, { characters: updatedCharacters });
       
       if (!updatedBook) {
         return { success: false, message: 'Failed to update characters' };
       }

       return {
         success: true,
         message: `Added/Updated ${newCharacters.length} characters`,
         total_characters: updatedCharacters.length,
         characters: updatedCharacters
       };

    } catch (error) {
      console.error('BookService: Error adding characters:', error);
      return {
        success: false,
        message: 'Failed to add characters',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }
}

// Singleton instance
export const bookService = new BookService();
