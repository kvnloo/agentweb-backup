/**
 * Core Tools Definitions
 * 
 * Essential tools that are always included in every request.
 * These provide basic functionality like web search, file operations, etc.
 */

import { ToolDefinition } from '../types';

export const coreTools: ToolDefinition[] = [
  {
    name: 'search_web',
    version: '1.0.0',
    category: 'core',
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
    }
  },
  {
    name: 'read_file_content',
    version: '1.0.0',
    category: 'core',
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
    }
  },
  {
    name: 'read_page_source',
    version: '1.0.0',
    category: 'core',
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
    }
  },
  {
    name: 'save_file',
    version: '1.0.0',
    category: 'core',
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
    }
  },
  {
    name: 'describe_image',
    version: '1.0.0',
    category: 'core',
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
    }
  }
];
