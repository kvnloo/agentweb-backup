/**
 * Core Tools Definitions
 * 
 * Essential tools that are always included in every request.
 * These provide basic functionality like web search, file operations, etc.
 * 
 * UNIFIED DEFINITION: Includes schema, handler config, and intent keywords.
 * Core tools don't need intent patterns as they're always loaded.
 */

import { ToolDefinition, CategoryConfig } from '../types';
import { registerCategoryConfig } from './utils';

/**
 * Core category configuration
 * Core tools are always included, so patterns are empty
 */
export const coreCategory: CategoryConfig = {
  name: 'core',
  intentPatterns: [
    // Core tools are always included, no pattern needed
  ],
  categoryKeywords: [
    // Core tools are always loaded, keywords are optional
    'search', 'web', 'read', 'file', 'save', 'describe', 'image', 'page'
  ]
};

// Register the category config for aggregation
registerCategoryConfig(coreCategory);

/**
 * Core tools with unified definitions
 */
export const coreTools: ToolDefinition[] = [
  {
    name: 'search_web',
    version: '1.0.0',
    category: 'core',
    intentKeywords: ['search', 'web', 'internet', 'find', 'look up', 'google'],
    schema: {
      description: 'Search the web for information from the internet',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query to find relevant information on the web'
          },
          max_results: {
            type: 'number',
            description: 'Maximum number of search results to return (default: 5, max: 10)',
            default: 5
          }
        },
        required: ['query']
      }
    },
    handler: {
      serviceName: 'web_search',
      methodName: 'searchWeb',
      // Simple: schema args only, no context needed
      contextArgs: []
    }
  },
  {
    name: 'read_file_content',
    version: '1.0.0',
    category: 'core',
    intentKeywords: ['read', 'file', 'content', 'extract', 'pdf', 'document'],
    schema: {
      description: 'Read and extract content from a file URL. Supports text files, PDFs, HTML, Markdown, CSV, and other common formats. Returns the raw text content for analysis.',
      parameters: {
        type: 'object',
        properties: {
          file_url: {
            type: 'string',
            description: 'The URL of the file to read and extract content from'
          }
        },
        required: ['file_url']
      }
    },
    handler: {
      serviceName: 'file',
      methodName: 'readFileContent',
      contextArgs: []
    }
  },
  {
    name: 'read_page_source',
    version: '1.0.0',
    category: 'core',
    intentKeywords: ['read', 'page', 'html', 'source', 'webpage', 'website'],
    schema: {
      description: 'Read and extract the HTML source code from any webpage URL. This is an alternative to read_file_content but specifically designed for web pages. Returns the raw HTML source for analysis.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The URL of the webpage to read and extract HTML source from'
          }
        },
        required: ['url']
      }
    },
    handler: {
      serviceName: 'file',
      methodName: 'readFileContent', // Same implementation as read_file_content
      contextArgs: []
    }
  },
  {
    name: 'save_file',
    version: '1.0.0',
    category: 'core',
    intentKeywords: ['save', 'file', 'upload', 'store', 's3'],
    schema: {
      description: 'Save content to a file and upload to S3. Returns the URL of the saved file.',
      parameters: {
        type: 'object',
        properties: {
          file_name: {
            type: 'string',
            description: 'Name for the file to save'
          },
          file_content: {
            type: 'string',
            description: 'Content to save in the file'
          }
        },
        required: ['file_name', 'file_content']
      }
    },
    handler: {
      serviceName: 'file',
      methodName: 'saveFile',
      contextArgs: ['userId', 'sessionId']
    }
  },
  {
    name: 'describe_image',
    version: '1.0.0',
    category: 'core',
    intentKeywords: ['describe', 'image', 'analyze', 'picture', 'photo', 'visual'],
    schema: {
      description: 'Analyze and describe an image from a URL. Use this when the user mentions an image or when you need to understand visual content.',
      parameters: {
        type: 'object',
        properties: {
          image_url: {
            type: 'string',
            description: 'Image URL to analyze and describe. Include the complete file URL in request.'
          },
          prompt: {
            type: 'string',
            description: 'Custom prompt/instructions for analyzing the image. Specify what aspects to focus on (e.g., colors, composition, text, branding, marketing elements, etc.)',
            default: 'Please analyze and describe this image in detail. Focus on visual elements, composition, colors, text, and any marketing or branding elements you can identify.'
          }
        },
        required: ['image_url']
      }
    },
    handler: {
      serviceName: 'image',
      methodName: 'describeImage',
      // Custom order: context.llmModel comes first
      customArgOrder: ['context.llmModel', 'args.image_url', 'args.prompt']
    }
  }
];
