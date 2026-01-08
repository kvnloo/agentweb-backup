
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

      // Compute content hash for full replacement verification
      const contentHash = createHash('sha256').update(content.content).digest('hex');

      return {
        success: true,
        message: chapterId ? 'Chapter content retrieved successfully' : 'Section content retrieved successfully',
        content: content.content,
        content_hash: contentHash,
        content_type: chapterId ? 'chapter' : 'section',
        section_id: sectionId,
        chapter_id: chapterId || null,
        updated_at: content.updatedAt,
        has_content: true
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
      // (since the default is true, we only need to override when explicitly set to false)
      let finalImagine = imagine;
      let imagineOverridden = false;
      if (existingContent?.imagine === false) {
        finalImagine = false;
        imagineOverridden = true;
      }

      // Map length to word count range - different ranges for books vs whitepapers
      // Whitepapers need smaller word counts to produce concise 8-12 page documents
      const bookWordCounts: Record<string, { min: number; max: number; target: number }> = {
        short: { min: 1000, max: 2000, target: 1500 },
        medium: { min: 2000, max: 3000, target: 2500 },
        long: { min: 3000, max: 4000, target: 3500 }
      };

      const whitepaperWordCounts: Record<string, { min: number; max: number; target: number }> = {
        short: { min: 300, max: 600, target: 450 },   // ~1 page (Executive Summary, Conclusion)
        medium: { min: 600, max: 1000, target: 800 }, // ~2 pages (Introduction, Key Findings)
        long: { min: 1000, max: 1500, target: 1250 }  // ~3 pages (Analysis sections)
      };

      const wordCountRanges = book.type === 'whitepaper' ? whitepaperWordCounts : bookWordCounts;
      const wordCount = wordCountRanges[length] || wordCountRanges.medium;

      // Get section/chapter title for context
      const sectionTitle = section.title;
      const chapterTitle = chapterId ? section.chapters.find((c) => c.chapterId === chapterId)?.title : undefined;
      const contentTitle = chapterTitle || sectionTitle;

      // Build the prompt for content generation
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
${book.characters.map((char: any, idx: number) => `  ${idx + 1}. ${char.name}: ${char.description}`).join('\n')}

IMPORTANT: Not all characters need to be mentioned in every chapter. Only include characters that are relevant to this specific ${chapterId ? 'chapter' : 'section'}. Use characters naturally when they fit the narrative or content, but do not force their inclusion if they are not relevant to this particular ${chapterId ? 'chapter' : 'section'}.` : ''}

Content Context:
- ${chapterId ? 'Chapter' : 'Section'} Title: ${contentTitle}
${section.description ? `- Section Description: ${section.description}` : ''}
${chapterId && section.chapters.find((c) => c.chapterId === chapterId)?.description ? `- Chapter Description: ${section.chapters.find((c) => c.chapterId === chapterId)?.description}` : ''}

Content Requirements:
- Content Description: ${contentDescription}
- Target Length: ${wordCount.min}-${wordCount.max} words (aim for approximately ${wordCount.target} words)
- Format: Markdown with proper headings (H2, H3), paragraphs, lists, and formatting
- Style: Professional, engaging, and well-structured
${book.language === '中文' ? '- Language: Write in Chinese (中文)' : '- Language: Write in English'}
${book.type === 'book' && book.genre ? `- Genre: Write in the style appropriate for ${book.genre} genre` : ''}
${!finalImagine ? `
CRITICAL: Do NOT invent or imagine details that do not exist. Stick strictly to facts, information provided in the content description, and details that are explicitly mentioned in the book context (title, description, characters, etc.). Do not add creative embellishments, fictional scenarios, or details that are not directly supported by the provided information. Focus on factual, accurate content based only on what is explicitly provided.` : ''}

${existingContentText ? `Existing Content (use as base and enhance/expand based on content description):
${existingContentText}

Instructions: Use the existing content above as a foundation, and enhance or expand it based on the content description. Maintain consistency with the existing style and structure while incorporating the new requirements.` : 'Instructions: Create comprehensive, well-structured content from scratch based on the content description.'}${researchContent ? `

=== DEEP RESEARCH CONTENT (SOURCE MATERIAL) ===
The following is comprehensive research content. Use this as your primary source material for creating this section.
Extract the relevant information for the "${contentTitle}" section and reformat it appropriately.

${researchContent}

=== END OF RESEARCH CONTENT ===
` : ''}${book.type === 'whitepaper' ? `

IMPORTANT WHITEPAPER GUIDELINES:
- This is a whitepaper, not a novel. Be concise and professional.
${researchContent ? '- You have been provided with DEEP RESEARCH CONTENT above. Your job is to EXTRACT and REFORMAT the relevant portions for this specific section.' : '- The content_description likely contains deep research content - your job is to REFORMAT and CONDENSE it for this section, not to generate entirely new content.'}
- Focus on key insights, actionable information, and data-driven conclusions.
- Use bullet points, tables, and clear headings for improved readability and scannability.
- Target exactly ${wordCount.target} words - do NOT exceed ${wordCount.max} words under any circumstances.
- Remove verbose language and filler content. Every sentence should add value.

ANTI-REPETITION RULES (CRITICAL):
- Do NOT repeat concepts, frameworks, or key points that belong in other sections of the whitepaper.
- Governance/trust topics should ONLY appear in their dedicated section, not repeated in Analysis or Conclusion.
- If a concept was covered in an earlier section, briefly reference it (e.g., "As noted in the Executive Summary...") instead of re-explaining.
- Each section should contain UNIQUE insights - check what section you're writing and stay focused on its specific purpose.

CITATION FORMATTING (REQUIRED):
- Use numbered references in brackets: [1], [2], [3], etc.
- When citing statistics, research findings, or expert opinions, always include the source.
- Format example: "AI adoption will reach 80% by 2026 [1]" or "According to Gartner research [2]..."
- If writing the Conclusion/References section, include a numbered reference list at the end.
- Prefer specific, verifiable sources over vague attributions like "studies show" or "experts say".` : ''}`;

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

      // Generate content using LangChain LLM service
      const modelName = contentModel || process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4';

      // Use XML format for Chinese content (more forgiving with quotes)
      const useXMLFormat = book.language === '中文';
      const format = useXMLFormat ? 'xml' : 'json';
      console.log(`[generateBookContent] Using model: ${modelName}, output format: ${format.toUpperCase()}, language: ${book.language}`);

      const llmService = createLLMService(modelName, 0.8, 4000);

      const systemPrompt = `You are a seasoned content writer specializing in ${book.type === 'book' ? 'books' : 'white papers'}. Write naturally, avoid AI patterns, and focus on providing comprehensive, well-structured content. ${book.language === '中文' ? 'Write in Chinese (中文).' : 'Write in English.'}

${useXMLFormat ? `CRITICAL: You MUST respond ONLY in XML format. Do NOT use JSON format.

Format your response as XML with this structure:
<response>
  <content>Full content in markdown format. Do not include a title in the content (the title is already provided above). Start directly with the main content.</content>
</response>

IMPORTANT: 
- Use XML format ONLY - do not use JSON
- XML handles quotes and special characters naturally - you do NOT need to escape quotes
- The content can contain any Chinese characters, quotes, or special characters without escaping
- Return ONLY the XML structure above, nothing else` : `Format your response as JSON with this structure:
{
  "content": "Full content in markdown format. Do not include a title in the content (the title is already provided above). Start directly with the main content."
}

IMPORTANT: Always respond with valid JSON. Escape quotes in the content properly.`}`;

      // Generate content using LangChain with appropriate format
      const contentData = await llmService.generateJSONContent<{ content: string }>(systemPrompt, contentPrompt, format);

      // Extract content from JSON
      if (!contentData.content) {
        throw new Error('JSON response missing "content" field');
      }
      let finalContent = contentData.content;
      finalContent = finalContent.trim();
      // Remove markdown code blocks if present
      finalContent = finalContent.replace(/^```markdown\s*|\s*```$/g, '').trim();
      finalContent = finalContent.replace(/^```\s*|\s*```$/g, '').trim();

      // Save the generated content
      await bookContentDb.createOrUpdateContent(
        bookId,
        userId,
        {
          sectionId,
          chapterId,
          content: finalContent
        }
      );

      // Count words (approximate)
      const wordCountActual = finalContent.split(/\s+/).filter((word: string) => word.length > 0).length;

      let message = `${chapterId ? 'Chapter' : 'Section'} content generated successfully`;
      if (imagineOverridden) {
        message += ` (imagine setting from ${chapterId ? 'chapter' : 'section'} record: ${finalImagine ? 'enabled' : 'disabled'})`;
      }

      return {
        success: true,
        message,
        content_type: chapterId ? 'chapter' : 'section',
        section_id: sectionId,
        chapter_id: chapterId || null,
        content_length: finalContent.length,
        word_count: wordCountActual,
        target_word_range: `${wordCount.min}-${wordCount.max}`,
        content_preview: finalContent.substring(0, 200) + (finalContent.length > 200 ? '...' : '')
      };

    } catch (error) {
      console.error('BookService: Error generating content:', error);
      return {
        success: false,
        message: 'Failed to generate book content',
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

      // Validate required parameters
      if (!title || !title.trim()) {
        return {
          success: false,
          message: 'Title is required',
          error: 'Title cannot be empty'
        };
      }

      if (!description || !description.trim()) {
        return {
          success: false,
          message: 'Description is required',
          error: 'Description cannot be empty'
        };
      }

      if (!type || (type !== 'book' && type !== 'whitepaper')) {
        return {
          success: false,
          message: 'Type must be "book" or "whitepaper"',
          error: 'Invalid type specified'
        };
      }

      if (!author || !author.trim()) {
        return {
          success: false,
          message: 'Author is required',
          error: 'Author cannot be empty'
        };
      }

      const { bookDb } = await import('../bookDb');

      // Set genre only for books, default to "Other" if not provided
      const bookGenre = type === 'book' ? (genre?.trim() || 'Other') : undefined;

      const book = await bookDb.createBook({
        userId,
        title: title.trim(),
        description: description.trim(),
        content: '', // Empty content initially
        type: type as 'book' | 'whitepaper',
        author: author.trim(),
        language: language || 'English',
        genre: bookGenre,
        tags: tags && Array.isArray(tags) ? tags : [],
        status: "draft",
        sections: []
      });

      return {
        success: true,
        message: 'Book created successfully',
        book: {
          book_id: book.bookId,
          title: book.title,
          description: book.description,
          type: book.type,
          author: book.author,
          language: book.language,
          genre: book.genre,
          tags: book.tags || [],
          status: book.status,
          sections: book.sections || []
        }
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
        return {
          success: false,
          message: 'Book not found',
          error: 'Book not found or access denied'
        };
      }

      let outline: any[];
      try {
        outline = JSON.parse(outlineJson);
      } catch (e) {
        return {
          success: false,
          message: 'Invalid JSON in outline_json',
          error: e instanceof Error ? e.message : 'Unknown error'
        };
      }

      if (!Array.isArray(outline)) {
        return {
          success: false,
          message: 'Outline must be an array of sections',
          error: 'Invalid outline structure'
        };
      }

      const sections = outline.map((section: any, sectionIndex: number) => {
        if (!section.title || !section.title.trim()) {
          throw new Error(`Section at index ${sectionIndex} is missing required field: title`);
        }

        const sectionId = uuidv4();
        const sectionOrder = section.order !== undefined ? section.order : sectionIndex + 1;
        
        const chapters = (section.chapters || []).map((chapter: any, chapterIndex: number) => {
          if (!chapter.title || !chapter.title.trim()) {
            throw new Error(`Chapter at index ${chapterIndex} in section "${section.title}" is missing required field: title`);
          }
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
          order: sectionOrder,
          chapters
        };
      });

      const updatedBook = await bookDb.updateBook(bookId, userId, { sections });

      if (!updatedBook) {
        return {
          success: false,
          message: 'Failed to update book outline',
          error: 'Book update failed'
        };
      }

      const totalChapters = sections.reduce((sum: number, s: any) => sum + s.chapters.length, 0);

      return {
        success: true,
        message: `Outline created successfully with ${sections.length} section(s) and ${totalChapters} chapter(s)`,
        book_id: bookId,
        sections_count: sections.length,
        total_chapters: totalChapters
      };
    } catch (error) {
      console.error('BookService: Error creating outline:', error);
      return {
        success: false,
        message: 'Failed to create book outline',
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
         return {
           success: false,
           message: 'Book not found',
           error: 'Book not found or access denied'
         };
       }

       let newCharacters: any[];
       try {
         newCharacters = JSON.parse(charactersJson);
       } catch (e) {
         return {
           success: false,
           message: 'Invalid JSON in characters_json',
           error: e instanceof Error ? e.message : 'Unknown error'
         };
       }

       if (!Array.isArray(newCharacters)) {
         return {
           success: false,
           message: 'Characters must be an array',
           error: 'Invalid characters structure'
         };
       }

       // Validate each character has name and description
       for (let i = 0; i < newCharacters.length; i++) {
         const char = newCharacters[i];
         if (!char.name || !char.name.trim()) {
           return {
             success: false,
             message: `Character at index ${i} is missing required field: name`,
             error: 'Invalid character structure'
           };
         }
         if (!char.description || !char.description.trim()) {
           return {
             success: false,
             message: `Character at index ${i} is missing required field: description`,
             error: 'Invalid character structure'
           };
         }
       }

       const existingCharacters = book.characters || [];
       
       // Add new characters to existing list (merging duplicates logic was simpler in original but agentModeService just appends, wait. 
       // AgentModeService.addCharacters (lines 11638+) just spreads existing and new. It doesn't check for duplicates?)
       // Actually lines 11638: `...existingCharacters, ...newCharacters`
       // But wait, my previous read of BookService (original line 641) had a duplicate check loop.
       // AgentModeService line 11638:
       /*
       const updatedCharacters = [
        ...existingCharacters,
        ...newCharacters.map((char: any) => ({
          name: char.name.trim(),
          description: char.description.trim()
        }))
      ];
      */
      // It seems AgentModeService implementation blindly appends. Original BookService had a merge.
      // However, usually I should follow the "Reference" file (AgentModeService). If AgentModeService is the source of truth, I should use its logic.
      // But maybe BookService was smarter?
      // I will follow AgentModeService logic as requested ("match the implementation in agentModeService.ts").
      // But I should double check if I misread AgentModeService.
      // Let's look at AgentModeService addCharacters again.
      
       const updatedCharacters = [
         ...existingCharacters,
         ...newCharacters.map((char: any) => ({
           name: char.name.trim(),
           description: char.description.trim()
         }))
       ];

       const updatedBook = await bookDb.updateBook(bookId, userId, { characters: updatedCharacters });
       
       if (!updatedBook) {
         return {
           success: false,
           message: 'Failed to update book characters',
           error: 'Book update failed'
         };
       }

       return {
         success: true,
         message: `Added ${newCharacters.length} character(s) to book`,
         book_id: bookId,
         characters_added: newCharacters.length,
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
