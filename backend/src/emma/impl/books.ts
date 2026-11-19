/**
 * ENG-2103 (F2 pilot) — books/whitepapers tool cluster, extracted from
 * `AgentModeService`.
 *
 * Moved verbatim (behavior byte-identical) from `AgentModeService.prototype.*`:
 * listBooks, getBookDetails, getBookContent, updateBookContent, generateBookContent,
 * createBook, createBookOutline, addCharacters. These are 8 of the 134
 * `agentModeService.<method>()` names `emma/tools.ts` calls into (ENG-1816 F1's
 * design draft, §2) — the books/whitepapers domain cluster, picked as the F2 pilot
 * because it has the fewest cross-references to other AgentModeService methods and
 * the least instance-state coupling of any cluster surveyed (only two calls into
 * private class helpers, both pure and both promoted alongside this module — see
 * `emma/impl/shared/contentReplacements.ts` and `emma/impl/shared/toolUsageMetering.ts`).
 *
 * `AgentModeService.prototype.<name>` now delegates to these functions rather than
 * duplicating them — `routes/emmaApi.ts`'s `/books*` REST endpoints call the class
 * methods directly (a real second caller beyond `emma/tools.ts`, found by grepping
 * the whole backend, not just tools.ts), so the class methods could not simply be
 * deleted.
 *
 * Every DB/AWS-backed import below (`bookDb`, `bookContentDb`, `settingsService`,
 * `llmService`'s LangChain-facing factory) is lazily loaded inside the function
 * body that needs it, exactly as the original code already did for `bookDb`/
 * `bookContentDb` — and, new in this extraction, for `settingsService` too. See the
 * per-function comments below for why: this module must be importable (e.g. by a
 * future native-backend bridge, or by this file's own tests) without constructing a
 * real AWS DynamoDB client or transitively pulling `agentModeService.ts` back in
 * (ENG-1816 F1's `lesson-lazy-require-aws-sdk-modules` postmortem).
 */
import { createHash } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { performContentReplacements } from './shared/contentReplacements';
import { makeToolUsageCallback } from './shared/toolUsageMetering';
import { CALLER_URL_MAX_TEXT_BYTES, fetchCallerUrlText } from '../../utils/callerUrlFetch';

export async function listBooks(userId: string, type?: string, status?: string): Promise<any> {
  try {
    console.log('AgentMode: Listing books for user:', userId);

    const { bookDb } = await import('../../services/bookDb');

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
    console.error('Error listing books:', error);
    return {
      success: false,
      message: 'Failed to list books',
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

export async function getBookDetails(bookId: string, userId: string): Promise<any> {
  try {
    console.log('AgentMode: Getting book details for:', bookId);

    const { bookDb } = await import('../../services/bookDb');
    const { bookContentDb } = await import('../../services/bookContentDb');

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
    console.error('Error getting book details:', error);
    return {
      success: false,
      message: 'Failed to get book details',
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

export async function getBookContent(
  bookId: string,
  sectionId: string,
  chapterId: string | undefined,
  userId: string
): Promise<any> {
  // ENG-2790: treat empty/null chapter_id as absent so section content is stored and read under one key.
  chapterId = chapterId || undefined;
  try {
    console.log('AgentMode: Getting book content for:', { bookId, sectionId, chapterId });

    const { bookDb } = await import('../../services/bookDb');
    const { bookContentDb } = await import('../../services/bookContentDb');

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
    console.error('Error getting book content:', error);
    return {
      success: false,
      message: 'Failed to get book content',
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

export async function updateBookContent(
  bookId: string,
  sectionId: string,
  chapterId: string | undefined,
  replacementInstructions: any[],
  userId: string
): Promise<any> {
  // ENG-2790: treat empty/null chapter_id as absent so section content is stored and read under one key.
  chapterId = chapterId || undefined;
  try {
    // Validate that replacementInstructions is an array
    if (!Array.isArray(replacementInstructions)) {
      return {
        success: false,
        message: 'replacement_json must be an array of replacement instructions'
      };
    }

    if (replacementInstructions.length === 0) {
      return {
        success: false,
        message: 'At least one replacement instruction is required'
      };
    }

    // Validate each replacement instruction (always partial replacement)
    for (let i = 0; i < replacementInstructions.length; i++) {
      const instruction = replacementInstructions[i];

      if (instruction.new_content === undefined || instruction.expected_count === undefined) {
        return {
          success: false,
          message: `Missing required fields in replacement instruction ${i + 1}: new_content and expected_count are required`
        };
      }

      // For partial replacement, require old_content
      if (!instruction.old_content) {
        return {
          success: false,
          message: `Replacement instruction ${i + 1} missing old_content. old_content is required for partial replacements`
        };
      }
    }

    // Get current content
    const { bookDb } = await import('../../services/bookDb');
    const { bookContentDb } = await import('../../services/bookContentDb');

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

    // Get current content
    const currentContentRecord = await bookContentDb.getContent(bookId, userId, sectionId, chapterId);
    const currentContent = currentContentRecord?.content || '';

    console.log(`AgentMode: Current content length: ${currentContent.length} characters`);

    // Compute hash of current content for verification
    const currentContentHash = createHash('sha256').update(currentContent).digest('hex');
    console.log(`AgentMode: Computed current content hash: ${currentContentHash}`);

    // Use common replacement function (always "part" for partial replacements)
    const replacementResult = performContentReplacements(
      currentContent,
      currentContentHash,
      'part',
      replacementInstructions
    );

    if (!replacementResult.success) {
      return {
        success: false,
        message: replacementResult.error?.message || 'Failed to perform replacements',
        suggestion: replacementResult.error?.suggestion
      };
    }

    // Save the updated content
    await bookContentDb.createOrUpdateContent(bookId, userId, {
      sectionId: sectionId,
      chapterId: chapterId,
      content: replacementResult.updatedContent!
    });

    return {
      success: true,
      message: `Content updated successfully with ${replacementResult.replacementResults!.length} replacement(s)`,
      content_type: chapterId ? 'chapter' : 'section',
      section_id: sectionId,
      chapter_id: chapterId || null,
      replacements: replacementResult.replacementResults,
      updated_content_length: replacementResult.updatedContent!.length
    };

  } catch (error) {
    console.error('Error updating book content:', error);
    return {
      success: false,
      message: 'Failed to update book content',
      error: error instanceof Error ? error.message : 'Unknown error',
      suggestion: 'Use get_book_content to retrieve the current content, then provide the exact old_content to replace. For generating full content, use generate_book_content instead.'
    };
  }
}

export async function generateBookContent(
  bookId: string,
  sectionId: string,
  chapterId: string | undefined,
  contentDescription: string,
  length: string,
  imagine: boolean,
  userId: string,
  researchUrl?: string,
  sessionId?: string
): Promise<any> {
  // ENG-2790: treat empty/null chapter_id as absent so section content is stored and read under one key.
  chapterId = chapterId || undefined;
  try {
    console.log('AgentMode: Generating book content for:', { bookId, sectionId, chapterId, length, imagine, userId, researchUrl: researchUrl ? 'provided' : 'not provided' });

    const { bookDb } = await import('../../services/bookDb');
    const { bookContentDb } = await import('../../services/bookContentDb');

    // Fetch research content from S3 URL if provided
    let researchContent = '';
    if (researchUrl) {
      try {
        console.log('AgentMode: Fetching research content from S3:', researchUrl);
        // The URL is the caller's: fetched only through the guarded fetch (public addresses only, redirects re-checked, size and time
        // bounded). The research text is optional context, so any failure, a refused URL included, leaves it empty as before.
        researchContent = await fetchCallerUrlText(researchUrl, { tool: 'generate_book_content', userId, maxBytes: CALLER_URL_MAX_TEXT_BYTES });
        console.log(`AgentMode: Fetched ${researchContent.length} characters of research content`);
      } catch (fetchError) {
        console.error('AgentMode: Error fetching research content:', fetchError);
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
    } else if (section.chapters && section.chapters.length > 0) {
      // ENG-2790 (Opslane P1): a chapter_id-less call on a section that has chapters
      // is almost always a chapter request with the id dropped. Writing section
      // content and reporting success misleads the user, so refuse and list the
      // chapter ids for the model to retry with. Chapterless sections still work.
      const candidates = section.chapters.map((c) => `${c.chapterId} ("${c.title}")`).join(', ');
      return {
        success: false,
        message: `chapter_id is required: section "${section.title}" has ${section.chapters.length} chapter(s). Call generate_book_content again with one of these chapter_ids: ${candidates}`,
        error: 'chapter_id required for a section with chapters'
      };
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
${book.characters.map((char, idx) => `  ${idx + 1}. ${char.name}: ${char.description}`).join('\n')}

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
      // Lazy require, not a top-level import: settingsService.ts constructs a real
      // AWS.DynamoDB.DocumentClient at module load. A static import here would drag
      // that into every importer of this standalone module (ENG-1816 F1's
      // lesson-lazy-require-aws-sdk-modules postmortem) — exactly what F2's
      // "the bridge can serve tools without importing agentModeService" goal exists
      // to avoid.
      const { settingsService } = require('../../services/settingsService') as typeof import('../../services/settingsService');
      const setting = await settingsService.getSetting('agent_mode_content_model');
      if (setting && setting.settingValue) {
        contentModel = setting.settingValue;
      }
    } catch (error) {
      console.error('Error getting content model setting:', error);
    }

    // Generate content using LangChain LLM service
    const { createLLMService } = await import('../../utils/llmService');
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
{{
  "content": "Full content in markdown format. Do not include a title in the content (the title is already provided above). Start directly with the main content."
}}

IMPORTANT: Always respond with valid JSON. Escape quotes in the content properly.`}`;

    // Generate content using LangChain with appropriate format
    //
    // ENG-2103 F2 audit (RunFunding/billingUserId metering, per F1's rounds 3-5
    // findings — lesson-forwarding-resolved-field-suppresses-downstream-resolver):
    // this call reaches meterWithResolvedBilling via llmService's gateway path
    // (generateJSONContent -> invoke -> invokeGateway -> agentModeService.callLLM,
    // the ONLY path — LLMService.invoke always takes it, since chatModel ===
    // gatewayAdapter by construction). billingUserId is correctly left unset here
    // (never forwarded), so meterWithResolvedBilling's own
    // `!ctx.userId || ctx.billingUserId` check takes the resolve-the-real-billing-
    // subject branch instead of short-circuiting on a same-value copy — this
    // call site does NOT have the bug found (and fixed) elsewhere in blog.ts/
    // agentModeService.ts. Preserved exactly as-is; verified, not assumed.
    const contentData = await llmService.generateJSONContent<{ content: string }>(systemPrompt, contentPrompt, format, makeToolUsageCallback(sessionId, 'generateBookContent'), { userId, sessionId, feature: 'content_gen' });

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
    console.error('Error generating book content:', error);
    return {
      success: false,
      message: 'Failed to generate book content',
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

export async function createBook(
  title: string,
  description: string,
  type: string,
  author: string,
  language: string,
  genre: string | undefined,
  tags: string[],
  userId: string
): Promise<any> {
  try {
    console.log('AgentMode: Creating book for user:', userId);

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

    const { bookDb } = await import('../../services/bookDb');

    // Set genre only for books, default to "Other" if not provided
    const bookGenre = type === 'book' ? (genre?.trim() || 'Other') : undefined;

    const bookData = {
      userId,
      title: title.trim(),
      description: description.trim(),
      content: '', // Empty content initially
      type: type as 'book' | 'whitepaper',
      author: author.trim(),
      language: language || 'English',
      genre: bookGenre,
      tags: tags && Array.isArray(tags) ? tags : [],
      status: 'draft' as const,
      sections: []
    };

    const book = await bookDb.createBook(bookData);

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
    console.error('Error creating book:', error);
    return {
      success: false,
      message: 'Failed to create book',
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

export async function createBookOutline(
  bookId: string,
  outlineJson: string,
  userId: string
): Promise<any> {
  try {
    console.log('AgentMode: Creating book outline for:', bookId);

    // Validate book exists and belongs to user
    const { bookDb } = await import('../../services/bookDb');
    const book = await bookDb.getBookById(bookId, userId);

    if (!book) {
      return {
        success: false,
        message: 'Book not found',
        error: 'Book not found or access denied'
      };
    }

    // Parse outline JSON
    let outline: any[];
    try {
      outline = JSON.parse(outlineJson);
    } catch (error) {
      return {
        success: false,
        message: 'Invalid JSON in outline_json',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }

    // Validate outline structure
    if (!Array.isArray(outline)) {
      return {
        success: false,
        message: 'Outline must be an array of sections',
        error: 'Invalid outline structure'
      };
    }

    // Build sections array with proper structure
    const sections = outline.map((section: any, sectionIndex: number) => {
      // Validate section has title
      if (!section.title || !section.title.trim()) {
        throw new Error(`Section at index ${sectionIndex} is missing required field: title`);
      }

      const sectionId = uuidv4();
      const sectionOrder = section.order !== undefined ? section.order : sectionIndex + 1;

      // Process chapters if provided
      const chapters = (section.chapters || []).map((chapter: any, chapterIndex: number) => {
        // Validate chapter has title
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

    // Update book with new outline
    const updatedBook = await bookDb.updateBook(bookId, userId, { sections });

    if (!updatedBook) {
      return {
        success: false,
        message: 'Failed to update book outline',
        error: 'Book update failed'
      };
    }

    const totalChapters = sections.reduce((sum, section) => sum + section.chapters.length, 0);

    return {
      success: true,
      message: `Outline created successfully with ${sections.length} section(s) and ${totalChapters} chapter(s)`,
      book_id: bookId,
      sections_count: sections.length,
      total_chapters: totalChapters
    };
  } catch (error) {
    console.error('Error creating book outline:', error);
    return {
      success: false,
      message: 'Failed to create book outline',
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

export async function addCharacters(
  bookId: string,
  charactersJson: string,
  userId: string
): Promise<any> {
  try {
    console.log('AgentMode: Adding characters to book:', bookId);

    // Validate book exists and belongs to user
    const { bookDb } = await import('../../services/bookDb');
    const book = await bookDb.getBookById(bookId, userId);

    if (!book) {
      return {
        success: false,
        message: 'Book not found',
        error: 'Book not found or access denied'
      };
    }

    // Parse characters JSON
    let newCharacters: any[];
    try {
      newCharacters = JSON.parse(charactersJson);
    } catch (error) {
      return {
        success: false,
        message: 'Invalid JSON in characters_json',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }

    // Validate characters structure
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

    // Get existing characters or initialize empty array
    const existingCharacters = book.characters || [];

    // Add new characters to existing list
    const updatedCharacters = [
      ...existingCharacters,
      ...newCharacters.map((char: any) => ({
        name: char.name.trim(),
        description: char.description.trim()
      }))
    ];

    // Update book with new characters
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
    console.error('Error adding characters:', error);
    return {
      success: false,
      message: 'Failed to add characters',
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}
