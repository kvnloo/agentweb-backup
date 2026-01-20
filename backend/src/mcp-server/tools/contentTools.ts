import { agentModeService } from '../../services/agentModeService.js';
import { mcpToolRegistry } from '../registry.js';

mcpToolRegistry.register({
  name: 'list_books',
  definition: {
    name: 'list_books',
    description: 'List all books and white papers for the current user.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['book', 'whitepaper'] },
        status: { type: 'string', enum: ['draft', 'published', 'archived'] }
      }
    }
  },
  execute: async (args: any) => {
    return await agentModeService.listBooks(args.userId, args.type, args.status);
  }
});

mcpToolRegistry.register({
  name: 'get_book_details',
  definition: {
    name: 'get_book_details',
    description: 'Get detailed data for a book by ID.',
    inputSchema: {
      type: 'object',
      properties: {
        book_id: { type: 'string' }
      },
      required: ['book_id']
    }
  },
  execute: async (args: any) => {
    return await agentModeService.getBookDetails(args.book_id, args.userId);
  }
});

mcpToolRegistry.register({
  name: 'get_book_content',
  definition: {
    name: 'get_book_content',
    description: 'Retrieve content for a specific section or chapter.',
    inputSchema: {
      type: 'object',
      properties: {
        book_id: { type: 'string' },
        section_id: { type: 'string' },
        chapter_id: { type: 'string' }
      },
      required: ['book_id']
    }
  },
  execute: async (args: any) => {
    return await agentModeService.getBookContent(args.book_id, args.section_id, args.chapter_id, args.userId);
  }
});

mcpToolRegistry.register({
  name: 'update_book_content',
  definition: {
    name: 'update_book_content',
    description: 'Update content of a book section or chapter.',
    inputSchema: {
      type: 'object',
      properties: {
        book_id: { type: 'string' },
        section_id: { type: 'string' },
        chapter_id: { type: 'string' },
        replacement_json: { type: 'string', description: 'JSON array of { targetContent, replacementContent }' }
      },
      required: ['book_id', 'replacement_json']
    }
  },
  execute: async (args: any) => {
    let replacements = [];
    try {
      replacements = JSON.parse(args.replacement_json);
    } catch (e) { throw new Error('Invalid replacement_json'); }
    return await agentModeService.updateBookContent(args.book_id, args.section_id, args.chapter_id, replacements, args.userId);
  }
});

mcpToolRegistry.register({
  name: 'generate_book_content',
  definition: {
    name: 'generate_book_content',
    description: 'Generate new text content for a book chapter.',
    inputSchema: {
      type: 'object',
      properties: {
        book_id: { type: 'string' },
        section_id: { type: 'string' },
        chapter_id: { type: 'string' },
        content_description: { type: 'string' },
        length: { type: 'string', enum: ['short', 'medium', 'long'], default: 'medium' },
        imagine: { type: 'boolean', default: true },
        research_url: { type: 'string' }
      },
      required: ['book_id', 'section_id', 'chapter_id', 'content_description']
    }
  },
  execute: async (args: any) => {
    return await agentModeService.generateBookContent(args.book_id, args.section_id, args.chapter_id, args.content_description, args.length, args.imagine, args.userId, args.research_url);
  }
});

mcpToolRegistry.register({
  name: 'create_book',
  definition: {
    name: 'create_book',
    description: 'Create a new book or whitepaper.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        description: { type: 'string' },
        type: { type: 'string', enum: ['book', 'whitepaper'] },
        author: { type: 'string' },
        language: { type: 'string', default: 'English' },
        genre: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } }
      },
      required: ['title', 'description', 'type', 'author']
    }
  },
  execute: async (args: any) => {
    return await agentModeService.createBook(args.title, args.description, args.type, args.author, args.language, args.genre, args.tags || [], args.userId);
  }
});

mcpToolRegistry.register({
  name: 'create_book_outline',
  definition: {
    name: 'create_book_outline',
    description: 'Create or replace the table of contents for a book.',
    inputSchema: {
      type: 'object',
      properties: {
        book_id: { type: 'string' },
        outline_json: { type: 'string' }
      },
      required: ['book_id', 'outline_json']
    }
  },
  execute: async (args: any) => {
    return await agentModeService.createBookOutline(args.book_id, args.outline_json, args.userId);
  }
});

mcpToolRegistry.register({
  name: 'add_characters',
  definition: {
    name: 'add_characters',
    description: 'Add character profiles to a book project.',
    inputSchema: {
      type: 'object',
      properties: {
        book_id: { type: 'string' },
        characters_json: { type: 'string', description: 'JSON array of character objects' }
      },
      required: ['book_id', 'characters_json']
    }
  },
  execute: async (args: any) => {
    return await agentModeService.addCharacters(args.book_id, args.characters_json, args.userId);
  }
});

mcpToolRegistry.register({
  name: 'create_blog_article',
  definition: {
    name: 'create_blog_article',
    description: 'Create a full blog article.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        content_description: { type: 'string' },
        category: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        deep_research: { type: 'boolean', default: false },
        generate_images: { type: 'boolean', default: true }
      },
      required: ['title', 'content_description']
    }
  },
  execute: async (args: any) => {
    return await agentModeService.createBlogArticle(
      args.title,
      args.content_description,
      args.length || 'medium',
      '', // researchContext
      '', // requirements
      args.userId,
      args.sessionId,
      'default',
      args.deep_research || false
    );
  }
});

mcpToolRegistry.register({
  name: 'publish_blog_article',
  definition: {
    name: 'publish_blog_article',
    description: 'Publish a blog article to CMS.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        description: { type: 'string' },
        hero_image_url: { type: 'string' },
        blog_html_url: { type: 'string' }
      },
      required: ['title', 'description', 'hero_image_url', 'blog_html_url']
    }
  },
  execute: async (args: any) => {
    return await agentModeService.publishBlogArticle(args.title, args.description, args.hero_image_url, args.blog_html_url, args.userId, args.sessionId);
  }
});

mcpToolRegistry.register({
  name: 'create_social_media_posts',
  definition: {
    name: 'create_social_media_posts',
    description: 'Generate suggested social media posts.',
    inputSchema: {
      type: 'object',
      properties: {
        source_content: { type: 'string' },
        platforms: { type: 'array', items: { type: 'string' } },
        target_audience: { type: 'string' }
      },
      required: ['source_content']
    }
  },
  execute: async (args: any) => {
    // Note: The backend createSocialMediaPosts currently expects an array of posts.
    // If the tool is supposed to generate them first, we might need a middle layer.
    // For now, mirroring the existing (buggy?) behavior but ensuring we pass sessionId.
    return await agentModeService.createSocialMediaPosts(args as any, args.userId, args.sessionId);
  }
});

mcpToolRegistry.register({
  name: 'list_html_templates',
  definition: {
    name: 'list_html_templates',
    description: 'Get a list of available HTML templates.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  execute: async (args: any) => {
    return await agentModeService.listHtmlTemplates(args.userId);
  }
});

mcpToolRegistry.register({
  name: 'create_html_from_template',
  definition: {
    name: 'create_html_from_template',
    description: 'Create final HTML from a template.',
    inputSchema: {
      type: 'object',
      properties: {
        template_name: { type: 'string' },
        variable_values_json: { type: 'string' },
        array_variable_values_json: { type: 'string' }
      },
      required: ['template_name', 'variable_values_json']
    }
  },
  execute: async (args: any) => {
    let variableValues = args.variable_values_json;
    if (typeof variableValues === 'string') {
      try { variableValues = JSON.parse(variableValues); } catch (e) {}
    }
    let arrayVariableValues = args.array_variable_values_json;
    if (typeof arrayVariableValues === 'string') {
      try { arrayVariableValues = JSON.parse(arrayVariableValues); } catch (e) {}
    }
    // Use llmModel from args (injected by McpClientService)
    return await agentModeService.createHtmlFromTemplate(args.llmModel || 'gemini-3-flash-preview', args.template_name, variableValues, arrayVariableValues, args.userId, args.sessionId);
  }
});

mcpToolRegistry.register({
  name: 'update_html_file',
  definition: {
    name: 'update_html_file',
    description: 'Update an existing HTML file on S3.',
    inputSchema: {
      type: 'object',
      properties: {
        s3_url: { type: 'string' },
        update_type: { type: 'string', enum: ['replace', 'append'], default: 'replace' },
        replacement_json: { type: 'string' }
      },
      required: ['s3_url', 'replacement_json']
    }
  },
  execute: async (args: any) => {
    let replacements = args.replacement_json;
    if (typeof replacements === 'string') {
      try { replacements = JSON.parse(replacements); } catch (e) {}
    }
    return await agentModeService.updateHtmlFile(args.s3_url, args.update_type, replacements, args.userId, args.sessionId);
  }
});
