/**
 * Book Tools Definitions
 * 
 * Tools for creating and managing books, whitepapers, and long-form content.
 * 
 * UNIFIED DEFINITION: Includes schema, handler config, and intent keywords.
 */

import { ToolDefinition, CategoryConfig } from '../types';
import { registerCategoryConfig } from './utils';

/**
 * Books category configuration
 */
export const booksCategory: CategoryConfig = {
  name: 'books',
  intentPatterns: [
    /\b(book|whitepaper|white\s*paper|chapter|outline|ebook|e-book|publication|manuscript)\b/i
  ],
  categoryKeywords: [
    'book', 'whitepaper', 'white', 'paper', 'chapter', 'outline',
    'ebook', 'publication', 'manuscript', 'document'
  ]
};

// Register the category config for aggregation
registerCategoryConfig(booksCategory);

/**
 * Book tools with unified definitions
 */
export const bookTools: ToolDefinition[] = [
  {
    name: 'list_books',
    version: '1.0.0',
    category: 'books',
    intentKeywords: ['books', 'list', 'all', 'whitepapers'],
    schema: {
      description: 'List all books/whitepapers for the user. Optionally filter by type and status.',
      parameters: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            description: 'Optional filter by book type (e.g., "book", "whitepaper", "ebook")'
          },
          status: {
            type: 'string',
            description: 'Optional filter by status (e.g., "draft", "published")'
          }
        },
        required: []
      }
    },
    handler: {
      methodName: 'listBooks',
      customArgOrder: ['context.userId', 'args.type', 'args.status']
    }
  },
  {
    name: 'get_book_details',
    version: '1.0.0',
    category: 'books',
    intentKeywords: ['book', 'details', 'info', 'metadata'],
    schema: {
      description: 'Get detailed information about a specific book including outline, characters, and metadata.',
      parameters: {
        type: 'object',
        properties: {
          book_id: {
            type: 'string',
            description: 'The unique identifier of the book'
          }
        },
        required: ['book_id']
      }
    },
    handler: {
      methodName: 'getBookDetails',
      contextArgs: ['userId']
    }
  },
  {
    name: 'get_book_content',
    version: '1.0.0',
    category: 'books',
    intentKeywords: ['book', 'content', 'read', 'chapter', 'section'],
    schema: {
      description: 'Get the content of a specific section or chapter in a book.',
      parameters: {
        type: 'object',
        properties: {
          book_id: { type: 'string', description: 'The book ID' },
          section_id: { type: 'string', description: 'The section ID' },
          chapter_id: { type: 'string', description: 'Optional chapter ID within the section' }
        },
        required: ['book_id', 'section_id']
      }
    },
    handler: {
      methodName: 'getBookContent',
      contextArgs: ['userId']
    }
  },
  {
    name: 'update_book_content',
    version: '1.0.0',
    category: 'books',
    intentKeywords: ['book', 'update', 'edit', 'content', 'replace'],
    schema: {
      description: 'Update the content of a specific section or chapter using replacement instructions.',
      parameters: {
        type: 'object',
        properties: {
          book_id: { type: 'string', description: 'The book ID' },
          section_id: { type: 'string', description: 'The section ID' },
          chapter_id: { type: 'string', description: 'Optional chapter ID' },
          replacement_json: {
            type: 'string',
            description: 'JSON string containing replacement instructions with old_content and new_content'
          }
        },
        required: ['book_id', 'section_id', 'replacement_json']
      }
    },
    handler: {
      methodName: 'updateBookContent',
      specialHandler: true  // Uses special handler
    }
  },
  {
    name: 'generate_book_content',
    version: '1.0.0',
    category: 'books',
    intentKeywords: ['book', 'generate', 'write', 'content', 'chapter'],
    schema: {
      description: 'Generate content for a section or chapter using AI.',
      parameters: {
        type: 'object',
        properties: {
          book_id: { type: 'string', description: 'The book ID' },
          section_id: { type: 'string', description: 'The section ID' },
          chapter_id: { type: 'string', description: 'Optional chapter ID' },
          content_description: {
            type: 'string',
            description: 'Brief instructions for the content to generate'
          },
          length: {
            type: 'string',
            description: 'Desired length: "short" (~1 page), "medium" (~2 pages), "long" (~3 pages)',
            enum: ['short', 'medium', 'long'],
            default: 'medium'
          },
          imagine: {
            type: 'boolean',
            description: 'Whether to add creative details or stick to facts',
            default: true
          },
          research_url: {
            type: 'string',
            description: 'Optional S3 URL of research content to use as source'
          }
        },
        required: ['book_id', 'section_id', 'content_description']
      }
    },
    handler: {
      methodName: 'generateBookContent',
      customArgOrder: [
        'args.book_id', 'args.section_id', 'args.chapter_id',
        'args.content_description', 'args.length', 'args.imagine',
        'context.userId', 'args.research_url'
      ]
    }
  },
  {
    name: 'create_book',
    version: '1.0.0',
    category: 'books',
    intentKeywords: ['book', 'create', 'new', 'whitepaper'],
    schema: {
      description: 'Create a new book or whitepaper.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Book title' },
          description: { type: 'string', description: 'Book description' },
          type: {
            type: 'string',
            description: 'Type of book',
            enum: ['book', 'whitepaper', 'ebook', 'report']
          },
          author: { type: 'string', description: 'Author name' },
          language: { type: 'string', description: 'Language of the book', default: 'English' },
          genre: { type: 'string', description: 'Optional genre' },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional tags for categorization'
          }
        },
        required: ['title', 'description', 'type', 'author']
      }
    },
    handler: {
      methodName: 'createBook',
      customArgOrder: [
        'args.title', 'args.description', 'args.type', 'args.author',
        'args.language', 'args.genre', 'args.tags', 'context.userId'
      ]
    }
  },
  {
    name: 'create_book_outline',
    version: '1.0.0',
    category: 'books',
    intentKeywords: ['book', 'outline', 'create', 'structure'],
    schema: {
      description: 'Create an outline for a book with sections and optional chapters.',
      parameters: {
        type: 'object',
        properties: {
          book_id: { type: 'string', description: 'The book ID' },
          outline_json: {
            type: 'string',
            description: 'JSON string containing the outline structure with sections and chapters'
          }
        },
        required: ['book_id', 'outline_json']
      }
    },
    handler: {
      methodName: 'createBookOutline',
      contextArgs: ['userId']
    }
  },
  {
    name: 'add_characters',
    version: '1.0.0',
    category: 'books',
    intentKeywords: ['book', 'characters', 'add', 'personas'],
    schema: {
      description: 'Add characters to a book (for fiction or case studies).',
      parameters: {
        type: 'object',
        properties: {
          book_id: { type: 'string', description: 'The book ID' },
          characters_json: {
            type: 'string',
            description: 'JSON string containing character definitions'
          }
        },
        required: ['book_id', 'characters_json']
      }
    },
    handler: {
      methodName: 'addCharacters',
      contextArgs: ['userId']
    }
  }
];
