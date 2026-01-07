/**
 * Research Tools Definitions
 * 
 * Tools for web search, knowledge base, deep research, and data analysis.
 */

import { ToolDefinition } from '../types';

export const researchTools: ToolDefinition[] = [
  {
    name: 'search_knowledge_base',
    version: '1.0.0',
    category: 'research',
    schema: {
      description: 'Search the knowledge base for stored information. The knowledge base contains private knowledge (user-specific) and public knowledge (shared by all users).',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query to find relevant information in the knowledge base'
          },
          max_results: {
            type: 'number',
            description: 'Maximum number of results to return (default: 5)',
            default: 5
          }
        },
        required: ['query']
      }
    }
  },
  {
    name: 'list_knowledge_base_files',
    version: '1.0.0',
    category: 'research',
    schema: {
      description: 'List all files stored in the knowledge base for the current user.',
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    }
  },
  {
    name: 'read_knowledge_base_file',
    version: '1.0.0',
    category: 'research',
    schema: {
      description: 'Read a single file from the knowledge base by its identifier.',
      parameters: {
        type: 'object',
        properties: {
          file_identifier: {
            type: 'string',
            description: 'File identifier in format "kb_identifier::file_name" or an object with kb_identifier and file_name'
          }
        },
        required: ['file_identifier']
      }
    }
  },
  {
    name: 'read_knowledge_base_files',
    version: '1.0.0',
    category: 'research',
    schema: {
      description: 'Read multiple files from the knowledge base. Each entry must include kb_identifier (taskId) and file_name.',
      parameters: {
        type: 'object',
        properties: {
          files: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                kb_identifier: { type: 'string', description: 'Knowledge base identifier (taskId)' },
                file_name: { type: 'string', description: 'Name of the file to read' }
              },
              required: ['kb_identifier', 'file_name']
            },
            description: 'Array of file references to read'
          }
        },
        required: ['files']
      }
    }
  },
  {
    name: 'perform_deep_research',
    version: '1.0.0',
    category: 'research',
    schema: {
      description: 'Perform comprehensive deep research on any topic using Gemini Deep Research. Uploads the research content to S3 and returns a URL to the markdown file. Use this for whitepapers, reports, executive summaries, or research documents. NOT for blog articles. Takes several minutes to complete.',
      parameters: {
        type: 'object',
        properties: {
          topic: {
            type: 'string',
            description: 'The main topic or subject to research'
          },
          prompt: {
            type: 'string',
            description: 'Additional instructions for the research (e.g., "Include executive summary", "Focus on competitive analysis")'
          },
          tone: {
            type: 'string',
            description: 'The tone of the research output',
            enum: ['professional', 'casual', 'technical', 'executive'],
            default: 'professional'
          },
          depth: {
            type: 'string',
            description: 'How thorough the research should be. "overview" for 1-2 pages, "detailed" for 3-5 pages, "comprehensive" for 5-10 pages.',
            enum: ['overview', 'detailed', 'comprehensive'],
            default: 'detailed'
          },
          focus_areas: {
            type: 'array',
            items: { type: 'string' },
            description: 'Specific areas to focus on in the research (e.g., ["market trends", "competitor analysis"])'
          }
        },
        required: ['topic']
      }
    }
  },
  {
    name: 'perform_data_analysis',
    version: '1.0.0',
    category: 'research',
    schema: {
      description: 'Perform data analysis with code execution on files from URLs. If no files are attached, treat the information in the instruction as the complete dataset.',
      parameters: {
        type: 'object',
        properties: {
          file_urls: {
            type: 'array',
            items: { type: 'string' },
            description: 'List of file URLs to analyze (URLs from uploaded files or previous task results)'
          },
          analysis_instruction: {
            type: 'string',
            description: 'Description of the analysis task to perform on the provided files'
          }
        },
        required: ['file_urls', 'analysis_instruction']
      }
    }
  }
];
