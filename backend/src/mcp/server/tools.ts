import { agentModeService } from '../../services/agentModeService';
import { mcpToolRegistry } from './registry';

// --- Tools from marketingTools.ts ---
mcpToolRegistry.register({
  name: 'list_meta_ads_campaigns',
  definition: {
    name: 'list_meta_ads_campaigns',
    description: 'List all Meta ad campaigns for the current user. Returns campaign names, IDs, statuses, and objectives. Use this to show users available campaigns before fetching metrics with get_meta_ads_metrics.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  execute: async (args, context) => {
    return await agentModeService.listMetaAdsCampaigns(context?.userId);
  }
});

mcpToolRegistry.register({
  name: 'get_meta_ads_metrics',
  definition: {
    name: 'get_meta_ads_metrics',
    description: 'Get Meta ad performance metrics and campaign data for specific campaigns. Requires campaign_ids (array of campaign IDs). Use list_meta_ads_campaigns first to get available IDs.',
    inputSchema: {
      type: 'object',
      properties: {
        timeframe: {
          type: 'string',
          description: 'Time period for metrics (7d, 14d, 30d, 90d)',
          enum: ['7d', '14d', '30d', '90d'],
          default: '7d'
        },
        campaign_ids: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description: 'Required list of campaign IDs to filter metrics by. Use list_meta_ads_campaigns to get available campaign IDs.'
        }
      },
      required: ['campaign_ids']
    }
  },
  execute: async (args, context) => {
    // Backward-compatible normalization: accept legacy campaign_id or string campaign_ids.
    const normalizedCampaignIds = Array.isArray(args.campaign_ids)
      ? args.campaign_ids
      : (typeof args.campaign_ids === 'string' && args.campaign_ids.trim())
        ? [args.campaign_ids.trim()]
        : (typeof args.campaign_id === 'string' && args.campaign_id.trim())
          ? [args.campaign_id.trim()]
          : [];

    return await agentModeService.getMetaAdsMetrics(args.timeframe || '7d', context?.userId, normalizedCampaignIds);
  }
});

mcpToolRegistry.register({
  name: 'get_post_analytics',
  definition: {
    name: 'get_post_analytics',
    description: 'Get detailed analytics for specific posts from a connected social media account. Returns engagement metrics including likes, comments, shares, impressions, and clicks.',
    inputSchema: {
            type: 'object',
            properties: {
              account_id: { 
                type: 'string', 
                description: 'The connected account ID (must belong to the authenticated user)' 
              },
              post_ids: { 
                type: 'array', 
                items: { type: 'string' },
                description: 'Array of post IDs to fetch analytics for (e.g., LinkedIn URNs like "urn:li:share:123")'
              }
            },
            required: ['account_id', 'post_ids']
          }
        },
    execute: async (args, context) => {
      return await agentModeService.getPostAnalytics(context?.userId, args.account_id, args.post_ids);
    }
  }
);

mcpToolRegistry.register({
  name: 'read_brand_guidelines',
  definition: {
    name: 'read_brand_guidelines',
    description: 'Read the current user\'s brand guidelines (brand data and attachments). Returns exists=false if not set.',
    inputSchema: {
      type: 'object',
      properties: {
      },
      required: []
    }
  },
  execute: async (args, context) => {
    return await agentModeService.readBrandGuidelines(context?.userId);
  }
});

mcpToolRegistry.register({
  name: 'update_brand_guidelines',
  definition: {
    name: 'update_brand_guidelines',
    description: 'Update the user\'s brand guidelines. IMPORTANT: Use read_brand_guidelines first to fetch the latest data, then only update the fields that need to be changed. Can update both brand data and brand assets (logos, brand guides, etc.). NOTE: SVG files are NOT allowed for logo or secondaryLogo uploads. If the user provides an SVG file, ask them to convert it to PNG or another raster format first.',
    inputSchema: {
      type: 'object',
      properties: {
        brandData: {
          type: 'object',
          description: 'Brand data object with only the fields that need to be updated',
          properties: {
            brandName: { type: 'string', description: 'Brand name' },
            tagline: { type: 'string', description: 'Brand tagline or slogan' },
            primaryColor: { type: 'string', description: 'Primary brand color (hex code)' },
            primaryColorEnd: { type: 'string', description: 'End color for gradient (hex code)' },
            secondaryColor: { type: 'string', description: 'Secondary brand color (hex code)' },
            fontFamily: { type: 'string', description: 'Primary font family' },
            toneOfVoice: { type: 'string', description: 'Brand tone of voice' },
            brandPersonality: { type: 'string', description: 'Brand personality description' },
            targetAudience: { type: 'string', description: 'Target audience description' },
            keyMessages: {
              type: 'array',
              items: { type: 'string' },
              description: 'Array of key brand messages'
            },
            brandValues: {
              type: 'array',
              items: { type: 'string' },
              description: 'Array of brand values'
            },
            isGradient: { type: 'boolean', description: 'Whether primary color uses gradient' },
            founders: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string', description: 'Founder name' },
                  jobTitle: { type: 'string', description: 'Founder job title' },
                  styleTone: { type: 'string', description: 'Founder communication style and tone' },
                  signaturePosts: { type: 'string', description: 'Notable posts or content the founder is known for' }
                },
                required: ['name']
              },
              description: 'Array of founder profiles'
            }
          }
        },
        brandAssets: {
          type: 'array',
          description: 'Brand assets to update (logos, brand guides, etc.) - array of asset objects with type, url, filename',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['logo', 'secondaryLogo', 'brandGuide', 'additionalAsset'], description: 'Type of brand asset' },
              url: { type: 'string', description: 'URL of the brand asset' },
              filename: { type: 'string', description: 'Original filename of the brand asset' }
            }
          }
        }
      },
      required: []
    }
  },
  execute: async (args, context) => {
    return await agentModeService.updateBrandGuidelines(args, context?.userId);
  }
});

mcpToolRegistry.register({
  name: 'read_market_strategy',
  definition: {
    name: 'read_market_strategy',
    description: 'Read the current user\'s market strategy (business overview, competitors, and ideal customer profiles). Returns exists=false if not set.',
    inputSchema: {
      type: 'object',
      properties: {
      },
      required: []
    }
  },
  execute: async (args, context) => {
    return await agentModeService.readMarketStrategy(context?.userId);
  }
});

mcpToolRegistry.register({
  name: 'update_market_strategy',
  definition: {
    name: 'update_market_strategy',
    description: 'Update the user\'s market strategy. IMPORTANT: Use read_market_strategy first to fetch the latest data, then only update the fields that need to be changed. Can update business overview, competitors, and ideal customer profiles.',
    inputSchema: {
      type: 'object',
      properties: {
        businessOverview: {
          type: 'string',
          description: 'Comprehensive business overview including mission, vision, and value propositions'
        },
        competitors: {
          type: 'array',
          description: 'Array of competitor objects with name and description',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Competitor name' },
              description: { type: 'string', description: 'Competitor description or analysis' }
            },
            required: ['name']
          }
        },
        icp: {
          type: 'array',
          description: 'Array of Ideal Customer Profile objects with title, description, value proposition, and buyer personas',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'ICP title or name' },
              description: { type: 'string', description: 'ICP description or characteristics' },
              valueProposition: { type: 'string', description: 'Value proposition for this customer type' },
              buyerPersonas: { type: 'array', description: 'List of buyer personas for this customer type', items: { type: 'string' } }
            },
            required: ['title']
          }
        }
      },
      required: []
    }
  },
  execute: async (args, context) => {
    return await agentModeService.updateMarketStrategy(args, context?.userId);
  }
});

mcpToolRegistry.register({
  name: 'perform_deep_research',
  definition: {
    name: 'perform_deep_research',
    description: 'Perform comprehensive deep research on any topic using Gemini Deep Research. Uploads the research content to S3 and returns a URL to the markdown file. Use this for whitepapers, reports, executive summaries, or research documents. NOT for blog articles - use create_blog_article with deep_research=true instead. Takes several minutes to complete. The response includes research_url (S3 URL), title, summary, and word_count.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          description: 'The main topic or subject to research'
        },
        prompt: {
          type: 'string',
          description: 'Additional instructions for the research (e.g., "Include executive summary", "Focus on competitive analysis", "Structure as a whitepaper")'
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
          description: 'Specific areas to focus on in the research (e.g., ["market trends", "competitor analysis", "implementation strategies"])'
        }
      },
      required: ['topic']
    }
  },
  execute: async (args, context) => {
    return await agentModeService.performDeepResearchTool(
      args.topic, 
      args.prompt, 
      args.tone || 'professional', 
      args.depth || 'detailed', 
      args.focus_areas, 
      context?.userId
    );
  }
});

// --- Tools from contentTools.ts ---
mcpToolRegistry.register({
  name: 'list_books',
  definition: {
    name: 'list_books',
    description: 'List all books and white papers for the current user. Returns a list of books with their IDs, titles, types, authors, status, and creation dates.',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['book', 'whitepaper'],
          description: 'Optional filter by type: "book" or "whitepaper". If not provided, returns all types.'
        },
        status: {
          type: 'string',
          enum: ['draft', 'published', 'archived'],
          description: 'Optional filter by status: "draft", "published", or "archived". If not provided, returns all statuses.'
        }
      },
      required: []
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.listBooks(context?.userId, args.type, args.status);
  }
});

mcpToolRegistry.register({
  name: 'get_book_details',
  definition: {
    name: 'get_book_details',
    description: 'Get detailed information about a specific book or white paper including its outline (sections and chapters structure), characters (for books), and other metadata. Returns book metadata, characters, and the complete outline hierarchy.',
    inputSchema: {
      type: 'object',
      properties: {
        book_id: {
          type: 'string',
          description: 'The unique identifier (bookId) of the book to retrieve'
        }
      },
      required: ['book_id']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.getBookDetails(args.book_id, context?.userId);
  }
});

mcpToolRegistry.register({
  name: 'get_book_content',
  definition: {
    name: 'get_book_content',
    description: 'Get the markdown content for a specific section or chapter in a book. If chapter_id is provided, returns chapter content. Otherwise, returns section content.',
    inputSchema: {
      type: 'object',
      properties: {
        book_id: {
          type: 'string',
          description: 'The unique identifier (bookId) of the book'
        },
        section_id: {
          type: 'string',
          description: 'The unique identifier (sectionId) of the section'
        },
        chapter_id: {
          type: 'string',
          description: 'Optional: The unique identifier (chapterId) of the chapter. If provided, returns chapter content. If not provided, returns section content.'
        }
      },
      required: ['book_id', 'section_id']
    }
  },
  execute: async (args: any, context?: any) => {
    const result = await agentModeService.getBookContent(args.book_id, args.section_id, args.chapter_id, context?.userId);
    if (result.success === false) {
      return {
        content: [
          {
            type: "text",
            text: `Error: ${result.message}\n${result.error || ''}`
          }
        ],
        isError: true
      };
    }
    return {
      content: [
        {
          type: "text",
          text: result.content
        }
      ]
    };
  }
});

mcpToolRegistry.register({
  name: 'update_book_content',
  definition: {
    name: 'update_book_content',
    description: 'Update the markdown content for a specific section or chapter in a book using partial replacements. This function performs partial content updates only. For generating full content, use generate_book_content instead. IMPORTANT: Always use get_book_content first to retrieve the current content, then provide the exact old_content to replace. Note: Full content replacement will not work if the current content is empty - use generate_book_content to create new content instead.',
    inputSchema: {
      type: 'object',
      properties: {
        book_id: {
          type: 'string',
          description: 'The unique identifier (bookId) of the book'
        },
        section_id: {
          type: 'string',
          description: 'The unique identifier (sectionId) of the section'
        },
        chapter_id: {
          type: 'string',
          description: 'Optional: The unique identifier (chapterId) of the chapter. If provided, updates chapter content. If not provided, updates section content.'
        },
        replacement_json: {
          type: 'string',
          description: 'JSON string containing a list of replacement instructions: [{"old_content": "## Old Heading\\n\\nOld text...", "new_content": "## New Heading\\n\\nNew text...", "expected_count": 1}]. Use empty string for new_content to delete the specified content.'
        }
      },
      required: ['book_id', 'section_id', 'replacement_json']
    }
  },
  execute: async (args: any, context?: any) => {
    // Parse replacement_json
    let bookReplacementInstructions = [];
    try {
      if (args.replacement_json) {
        bookReplacementInstructions = JSON.parse(args.replacement_json);
      }
    } catch (error) {
      return {
        success: false,
        message: 'Invalid JSON in replacement_json',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
    return await agentModeService.updateBookContent(
      args.book_id,
      args.section_id,
      args.chapter_id,
      bookReplacementInstructions,
      context?.userId
    );
  }
});

mcpToolRegistry.register({
  name: 'generate_book_content',
  definition: {
    name: 'generate_book_content',
    description: 'Generate content for a book section/chapter. For BOOKS: short (1000-2000 words), medium (2000-3000 words), long (3000-4000 words). For WHITEPAPERS: short (300-600 words, ~1 page), medium (600-1000 words, ~2 pages), long (1000-1500 words, ~3 pages). IMPORTANT for whitepapers: Pass the relevant deep research content in content_description - the AI will reformat it for that section rather than generating new content. If existing content exists, it will be used as a base.',
    inputSchema: {
      type: 'object',
      properties: {
        book_id: {
          type: 'string',
          description: 'The unique identifier (bookId) of the book'
        },
        section_id: {
          type: 'string',
          description: 'The unique identifier (sectionId) of the section'
        },
        chapter_id: {
          type: 'string',
          description: 'Optional: The unique identifier (chapterId) of the chapter. If provided, generates chapter content. If not provided, generates section content.'
        },
        content_description: {
          type: 'string',
          description: 'Detailed description of what content should be generated for this section or chapter. Be as detailed as possible about the topics, themes, key points, and structure that should be included. IMPORTANT: Content from other sections of the book is not available to this function, so any relevant context, information, or details from other sections that should be referenced or built upon must be explicitly included in this description.'
        },
        length: {
          type: 'string',
          enum: ['short', 'medium', 'long'],
          description: 'Desired length of the content: short (1000-2000 words), medium (2000-3000 words), long (3000-4000 words)',
          default: 'medium'
        },
        imagine: {
          type: 'boolean',
          description: 'Whether to allow creative imagination and details that do not exist. Defaults to true. When false, the AI will stick strictly to facts and avoid inventing details.',
          default: true
        },
        research_url: {
          type: 'string',
          description: 'Optional S3 URL to deep research content (from perform_deep_research). For WHITEPAPERS: pass the research_url here instead of copying full content into content_description. The function will fetch the research and use it as context. When using this, content_description should focus on section-specific instructions (e.g., "Write the Executive Summary focusing on key strategic implications").'
        }
      },
      required: ['book_id', 'section_id', 'chapter_id', 'content_description']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.generateBookContent(
      args.book_id,
      args.section_id,
      args.chapter_id,
      args.content_description,
      args.length || 'medium',
      args.imagine !== undefined ? args.imagine : true,
      context?.userId,
      args.research_url
    );
  }
});

mcpToolRegistry.register({
  name: 'create_book',
  definition: {
    name: 'create_book',
    description: 'Create a new book or white paper with metadata. Returns the created book with bookId for use in other operations.',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Title of the book or white paper'
        },
        description: {
          type: 'string',
          description: 'Description or summary of the book'
        },
        type: {
          type: 'string',
          enum: ['book', 'whitepaper'],
          description: 'Type: "book" or "whitepaper"'
        },
        author: {
          type: 'string',
          description: 'Author name'
        },
        language: {
          type: 'string',
          description: 'Language of the book (e.g., "English", "中文")',
          default: 'English'
        },
        genre: {
          type: 'string',
          description: 'Genre of the book (only applicable when type is "book"). Can be one of the predefined genres (Fiction, Non-Fiction, Science Fiction, Fantasy, Mystery, Thriller, Romance, Horror, Biography, Autobiography, History, Self-Help, Business, Technology, Science, Philosophy, Religion, Health & Fitness, Travel, Cooking, Art, Music, Poetry, Drama, Comedy, Education, Reference, Children\'s, Young Adult, Other) or a custom genre string. If not provided and type is "book", defaults to "Other".'
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional array of tags for categorization',
          default: []
        }
      },
      required: ['title', 'description', 'type', 'author']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.createBook(args.title, args.description, args.type, args.author, args.language, args.genre, args.tags || [], context?.userId);
  }
});

mcpToolRegistry.register({
  name: 'create_book_outline',
  definition: {
    name: 'create_book_outline',
    description: 'Create the complete outline structure (sections and chapters) for a book. This replaces any existing outline. Each section can have multiple chapters. Sections and chapters will be ordered by their order field.',
    inputSchema: {
      type: 'object',
      properties: {
        book_id: {
          type: 'string',
          description: 'The unique identifier (bookId) of the book to create outline for'
        },
        outline_json: {
          type: 'string',
          description: 'JSON string containing the outline structure: [{"title": "Section Title", "description": "Optional section description", "order": 1, "chapters": [{"title": "Chapter Title", "description": "Optional chapter description", "order": 1}]}]'
        }
      },
      required: ['book_id', 'outline_json']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.createBookOutline(args.book_id, args.outline_json, context?.userId);
  }
});

mcpToolRegistry.register({
  name: 'add_characters',
  definition: {
    name: 'add_characters',
    description: 'Add one or more characters to a book. Each character must have a name and description. Characters are appended to the existing list of characters for the book.',
    inputSchema: {
      type: 'object',
      properties: {
        book_id: {
          type: 'string',
          description: 'The unique identifier (bookId) of the book to add characters to'
        },
        characters_json: {
          type: 'string',
          description: 'JSON string containing an array of characters: [{"name": "Character Name", "description": "Character description"}]'
        }
      },
      required: ['book_id', 'characters_json']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.addCharacters(args.book_id, args.characters_json, context?.userId);
  }
});

mcpToolRegistry.register({
  name: 'create_blog_article',
  definition: {
    name: 'create_blog_article',
    description: 'Create a complete blog article with content, images, and HTML file. Takes a title draft and content draft in markdown format, creates a hero image, and produces a complete HTML file uploaded to S3. The final title will be generated from the drafts.',
    inputSchema: {
      type: 'object',
      properties: {
        title_draft: {
          type: 'string',
          description: 'A draft title for the blog article. The final title will be generated and optimized from this draft.'
        },
        content_draft: {
          type: 'string',
          description: 'The blog article content in markdown format'
        },
        length: {
          type: 'string',
          description: 'The desired length of the article',
          enum: ['short', 'medium', 'long'],
          default: 'medium'
        },
        researchContext: {
          type: 'string',
          description: 'Optional research context or background information to include in the article',
          default: ''
        },
        requirements: {
          type: 'string',
          description: 'Specific requirements for the blog article (e.g., internal links, CTAs, branding guidelines)',
          default: ''
        },
        style: {
          type: 'string',
          description: 'The writing style of the blog article. Use "substack" for a personal, newsletter-like writing style with first-person perspective, engaging hooks, and conversational tone. Use "default" for standard blog post style.',
          enum: ['default', 'substack'],
          default: 'default'
        },
        deep_research: {
          type: 'boolean',
          description: 'When true, performs Gemini Deep Research for comprehensive information and includes 3-5 inline images. When false, uses standard content generation with hero image only. Takes several minutes when enabled.',
          default: false
        }
      },
      required: ['title_draft', 'content_draft']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.createBlogArticle(
      args.title_draft, 
      args.content_draft, 
      args.length || 'medium', 
      args.researchContext || '', 
      args.requirements || '', 
      context?.userId, 
      context?.sessionId, 
      args.style || 'default', 
      args.deep_research || false
    );
  }
});

mcpToolRegistry.register({
  name: 'publish_blog_article',
  definition: {
    name: 'publish_blog_article',
    description: 'Publish a blog article to CMS (Basehub or Webflow) based on the user\'s configured CMS type. Takes the title, description, hero image URL, and blog HTML URL from a previously created blog article (via create_blog_article), extracts the HTML body content, then publishes to the appropriate CMS. Articles are published as draft by default unless status is set to "published". IMPORTANT: When status is "published", at least one category must be provided. CRITICAL: Always review the article content with the user and get explicit approval before publishing, especially when status is "published" for live publication.',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'The title of the blog article'
        },
        description: {
          type: 'string',
          description: 'The description/meta description of the blog article'
        },
        hero_image_url: {
          type: 'string',
          description: 'The URL of the hero image for the blog article'
        },
        blog_html_url: {
          type: 'string',
          description: 'The URL of the HTML file created by create_blog_article function'
        },
        status: {
          type: 'string',
          description: 'Publication status of the article. Default is "draft". Set to "published" to publish immediately.',
          enum: ['draft', 'published'],
          default: 'draft'
        },
        author: {
          type: 'string',
          description: 'Optional author name or ID for the article'
        },
        categories: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional array of category names. Category names will be mapped to Webflow IDs using the "categories" mapping in secrets manager. Maps to multi-reference field "categories" by default. Defaults to empty array. REQUIRED when status is "published" - must provide at least one category.',
          default: []
        }
      },
      required: ['title', 'description', 'hero_image_url', 'blog_html_url']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.publishBlogArticle(
      args.title,
      args.description,
      args.hero_image_url,
      args.blog_html_url,
      context?.userId,
      context?.sessionId,
      args.status,
      args.author,
      args.categories
    );
  }
});

mcpToolRegistry.register({
  name: 'repair_blog_article',
  definition: {
    name: 'repair_blog_article',
    description: 'Repairs a blog article by creating a new version with optimized images. Automatically finds and resizes all images (including hero images with class="hero-image") that exceed file size limits. Creates a new HTML file with updated image URLs without modifying the original. Call this function when publish_blog_article fails due to image size errors. Returns a new article URL and hero image URL that can be used to retry publishing.',
    inputSchema: {
      type: 'object',
      properties: {
        article_url: {
          type: 'string',
          description: 'The URL of the HTML file created by create_blog_article function'
        }
      },
      required: ['article_url']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.repairBlogArticle(
      args.article_url, 
      context?.userId, 
      context?.sessionId
    );
  }
});

mcpToolRegistry.register({
  name: 'create_social_media_posts',
  definition: {
    name: 'create_social_media_posts',
    description: 'Create a list of social media posts and generate an HTML file containing all posts. Each post includes type (linkedin, x/twitter, instagram, facebook, or custom), rich text content that can be transformed to HTML for display and copied for use, and optional image URL. The output is an HTML file stored in S3 with all posts formatted for easy viewing and copying.',
    inputSchema: {
      type: 'object',
      properties: {
        posts: {
          type: 'array',
          description: 'Array of social media posts to create',
          items: {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                enum: ['linkedin', 'x/twitter', 'instagram', 'facebook', 'custom'],
                description: 'The social media platform type for this post'
              },
              content: {
                type: 'string',
                description: 'Rich text content for the post (supports markdown formatting). IMPORTANT: Do not include image URLs in the content text as the format will not look good. Use the image_url parameter separately for images.'
              },
              image_url: {
                type: 'string',
                description: 'Optional image URL for posts that include images'
              }
            },
            required: ['type', 'content']
          }
        }
      },
      required: ['posts']
    }
  },
  execute: async (args: any, context?: any) => {
    // Note: The backend createSocialMediaPosts currently expects an array of posts.
    // If the tool is supposed to generate them first, we might need a middle layer.
    // For now, mirroring the existing (buggy?) behavior but ensuring we pass sessionId.
    return await agentModeService.createSocialMediaPosts(args.posts, context?.userId, context?.sessionId);
  }
});

mcpToolRegistry.register({
  name: 'list_html_templates',
  definition: {
    name: 'list_html_templates',
    description: 'Get a list of all available HTML templates for the user (including email templates)',
    inputSchema: {
      type: 'object',
      properties: {
      },
      required: []
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.listHtmlTemplates(context?.userId);
  }
});

mcpToolRegistry.register({
  name: 'create_html_from_template',
  definition: {
    name: 'create_html_from_template',
    description: 'Create final HTML from a template by providing variable values and array variable values as JSON strings, then upload to S3',
    inputSchema: {
      type: 'object',
      properties: {
        template_name: {
          type: 'string',
          description: 'Name of the HTML template to use'
        },
        variable_values_json: {
          type: 'string',
          description: 'JSON string containing regular variable values where keys are variable names and values are the actual values. Example: {"title": "Hello", "company_name": "Acme Corp"}'
        },
        array_variable_values_json: {
          type: 'string',
          description: 'JSON string containing array variable values where keys are array variable names and values are arrays of strings. If there is no data for an array variable, provide an empty array for that variable. Example: {"features_n": ["Feature 1", "Feature 2"], "links_n": []} for when links_n has no data.'
        }
      },
      required: ['template_name', 'variable_values_json', 'array_variable_values_json']
    }
  },
  execute: async (args: any, context?: any) => {
    if (!args.template_name) {
      return {
        success: false,
        message: 'template_name is required'
      };
    }

    // Parse JSON strings
    let variableValues = {};
    let arrayVariableValues = {};

    try {
      if (args.variable_values_json) {
        variableValues = JSON.parse(args.variable_values_json);
      }
    } catch (error) {
      return {
        success: false,
        message: 'Invalid JSON in variable_values_json',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }

    try {
      if (args.array_variable_values_json) {
        arrayVariableValues = JSON.parse(args.array_variable_values_json);
      }
    } catch (error) {
      return {
        success: false,
        message: 'Invalid JSON in array_variable_values_json',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }

    return await agentModeService.createHtmlFromTemplate(args.llmModel, args.template_name, variableValues, arrayVariableValues, context?.userId, context?.sessionId);
  }
});

mcpToolRegistry.register({
  name: 'update_html_file',
  definition: {
    name: 'update_html_file',
    description: 'Update an HTML file by replacing specific content with new content. Use update_type="full" with old_content_hash for entire file replacement, or update_type="part" with old_content for partial replacements',
    inputSchema: {
      type: 'object',
      properties: {
        file_url: {
          type: 'string',
          description: 'URL of the HTML file to update (S3 URL or file path)'
        },
        update_type: {
          type: 'string',
          enum: ['part', 'full'],
          description: 'Type of update: "part" for partial content replacement using old_content, "full" for entire file replacement using old_content_hash'
        },
        replacement_json: {
          type: 'string',
          description: 'JSON string containing a list of replacement instructions. For full replacement: [{"old_content_hash": "abc123...", "new_content": "<!DOCTYPE html>...", "expected_count": 1}]. For part replacement: [{"old_content": "<h1>Old Title</h1>", "new_content": "<h1>New Title</h1>", "expected_count": 1}]. Use empty string for new_content to delete the specified content.'
        }
      },
      required: ['file_url', 'update_type', 'replacement_json']
    }
  },
  execute: async (args: any, context?: any) => {
    // Ensure we have the required parameters
    if (!args.file_url) {
      return {
        success: false,
        message: 'file_url is required'
      };
    }

    if (!args.update_type) {
      return {
        success: false,
        message: 'update_type is required'
      };
    }

    if (!args.replacement_json) {
      return {
        success: false,
        message: 'replacement_json is required'
      };
    }

    // Parse replacement instructions
    let replacementInstructions;
    try {
      replacementInstructions = JSON.parse(args.replacement_json);
    } catch (error) {
      return {
        success: false,
        message: 'Invalid JSON in replacement_json',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }

    return await agentModeService.updateHtmlFile(args.file_url, args.update_type, replacementInstructions, context?.userId, context?.sessionId);
  }
});

// --- Tools from leadGtmTools.ts ---
mcpToolRegistry.register({
  name: 'list_gtm_plans',
  definition: {
    name: 'list_gtm_plans',
    description: 'List all Go-To-Market (GTM) plans for the current user. Returns a list of plans with their IDs, titles, descriptions, phase counts, and creation dates.',
    inputSchema: { 
      type: 'object',
      properties: {
      },
      required: [] 
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.listGTMPlans(context?.userId);
  }
});

mcpToolRegistry.register({
  name: 'read_gtm_plan',
  definition: {
    name: 'read_gtm_plan',
    description: 'Read a specific GTM plan by its plan ID. Returns the complete plan details including all phases and work items with their statuses, durations, and completion times.',
    inputSchema: {
      type: 'object',
      properties: { 
        plan_id: {
          type: 'string',
          description: 'The unique identifier (planId) of the GTM plan to read'
        }
      },
      required: ['plan_id']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.readGTMPlan(args.plan_id, context?.userId);
  }
});

mcpToolRegistry.register({
  name: 'create_gtm_plan',
  definition: {
    name: 'create_gtm_plan',
    description: 'Create a new Go-To-Market (GTM) plan with a title, optional description, optional DRI (Directly Responsible Individual) email, and optional phases with work items. Each phase can have multiple work items. DRI can be specified at plan level, phase level, or item level. Returns the created plan with its unique identifier.',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'The title of the GTM plan (e.g., "Q1 2024 Launch Plan")'
        },
        description: {
          type: 'string',
          description: 'Optional description of the GTM plan'
        },
        dri: {
          type: 'string',
          description: 'Optional DRI (Directly Responsible Individual) email address at the plan level'
        },
        phases: {
          type: 'array',
          description: 'Optional array of phases to include in the plan. Each phase should have a title, description, duration (in days), optional DRI email, and workItems array.',
          items: {
            type: 'object',
            properties: {
              title: {
                type: 'string',
                description: 'The title of the phase (e.g., "Pre-Launch", "Launch", "Post-Launch")'
              },
              description: {
                type: 'string',
                description: 'Optional description of the phase'
              },
              duration: {
                type: 'number',
                description: 'Duration of the phase in days'
              },
              dri: {
                type: 'string',
                description: 'Optional DRI (Directly Responsible Individual) email address at the phase level'
              },
              workItems: {
                type: 'array',
                description: 'Array of work items for this phase',
                items: {
                  type: 'object',
                  properties: {
                    title: {
                      type: 'string',
                      description: 'Title of the work item'
                    },
                    description: {
                      type: 'string',
                      description: 'Optional description of the work item'
                    },
                    duration: {
                      type: 'number',
                      description: 'Optional duration of the work item in days'
                    },
                    dri: {
                      type: 'string',
                      description: 'Optional DRI (Directly Responsible Individual) email address at the work item level'
                    }
                  },
                  required: ['title']
                }
              }
            },
            required: ['title', 'duration']
          }
        }
      },
      required: ['title']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.createGTMPlan(
      args.title, args.description || '', args.dri || undefined, args.phases || [], context?.userId, context?.sessionId
    );
  }
});

mcpToolRegistry.register({
  name: 'get_lead_lists',
  definition: {
    name: 'get_lead_lists',
    description: 'Get all lead lists for the current user. Returns a list of lead lists with their IDs, names, descriptions, lead counts, and creation dates.',
    inputSchema: { 
      type: 'object', 
      properties: {
      } 
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.getLeadLists(context?.userId);
  }
});

mcpToolRegistry.register({
  name: 'create_lead_list',
  definition: {
    name: 'create_lead_list',
    description: 'Create a new lead list with a name and optional description. Returns the created lead list with its ID.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Name of the lead list'
        },
        description: {
          type: 'string',
          description: 'Optional description of the lead list'
        }
      },
      required: ['name']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.createLeadList(args.name, args.description || '', context?.userId);
  }
});

mcpToolRegistry.register({
  name: 'add_leads_to_list',
  definition: {
    name: 'add_leads_to_list',
    description: 'Add one or more leads to an existing lead list. Each lead is a flexible object that can contain any fields you want to store. Common fields include: email (used for deduplication and merging), firstName, lastName, phone, company, title, notes, linkedin, and any custom fields. You can use any field names that make sense for your data. If a lead with the same email already exists, it will be merged with the new data. Returns counts of new and merged leads, plus any errors.',
    inputSchema: {
      type: 'object',
      properties: {
        list_id: {
          type: 'string',
          description: 'The ID of the lead list to add leads to'
        },
        leads: {
          type: 'array',
          items: {
            type: 'object',
            description: 'A lead object with any fields you want to store. Use field names that make sense for your data. The email field (if provided) is used for deduplication and merging.',
            additionalProperties: true,
            properties: {
              email: {
                type: 'string',
                description: 'Email address (optional, but recommended for deduplication and merging existing leads)'
              }
            }
          },
          description: 'Array of lead objects to add to the list. Each lead can have any fields you want to store.'
        }
      },
      required: ['list_id', 'leads']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.addLeadsToList(args.list_id, args.leads || [], context?.userId);
  }
});

mcpToolRegistry.register({
  name: 'update_email_draft_for_lead',
  definition: {
    name: 'update_email_draft_for_lead',
    description: 'Create or update an email draft for a specific lead. This function loads the lead record, engagement history, brand guidelines, and market strategy, then uses AI to generate a personalized email draft (subject and HTML content) based on the instruction provided. If a draft already exists, it will be included in the prompt for refinement. The draft is saved to the lead record along with the current session ID for future updates.',
    inputSchema: {
      type: 'object',
      properties: {
        list_id: {
          type: 'string',
          description: 'The ID of the lead list containing the lead'
        },
        lead_id: {
          type: 'string',
          description: 'The ID of the lead to create/update email draft for'
        },
        instruction: {
          type: 'string',
          description: 'Instructions for creating the email draft (e.g., "welcome email", "follow-up on their interest in our product", "introduce our new feature"). The AI will use this along with lead data, engagement history, brand guidelines, and market strategy to create a personalized email.'
        },
        email_format: {
          type: 'string',
          enum: ['text', 'html'],
          description: 'Optional. The format for the email draft: "text" for plain text or "html" for HTML. If not provided, uses the lead\'s saved format preference (defaults to "text").'
        }
      },
      required: ['list_id', 'lead_id', 'instruction']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.updateEmailDraftForLead(
      args.list_id, 
      args.lead_id, 
      args.instruction, 
      context?.sessionId, 
      context?.userId, 
      args.email_format
    );
  }
});

mcpToolRegistry.register({
  name: 'list_connected_accounts',
  definition: {
    name: 'list_connected_accounts',
    description: 'Returns list of social media accounts connected by the user',
    inputSchema: {
      type: 'object',
      properties: {
        platform: {
          type: 'string',
          description: 'Filter by platform (e.g., "linkedin", "facebook", "twitter"), or "all" for all platforms',
          default: 'all'
        }
      },
      required: []
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.listConnectedAccounts(context?.userId, args.platform);
  }
});

mcpToolRegistry.register({
  name: 'list_connected_account_posts',
  definition: {
    name: 'list_connected_account_posts',
    description: 'List posts from a connected social media account with optional metrics',
    inputSchema: {
      type: 'object',
      properties: {
        account_id: { type: 'string', description: 'The connected account ID' },
        limit: { type: 'number', description: 'Maximum number of posts to return', default: 10 },
        include_metrics: { type: 'boolean', description: 'Whether to include per-post metrics (likes, comments, etc.)', default: false }
      },
      required: ['account_id']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.loadConnectedAccountPosts(
      context?.userId, 
      args.account_id, 
      {
        limit: args.limit,
        include_metrics: args.include_metrics
       }
    );
  }
});

mcpToolRegistry.register({
  name: 'load_connected_account_metrics',
  definition: {
    name: 'load_connected_account_metrics',
    description: 'Load performance metrics for a specific connected account (e.g., page statistics, follower counts, engagement).',
    inputSchema: {
      type: 'object',
      properties: { 
        account_id: {
          type: 'string',
          description: 'The unique identifier (id) of the connected account to load metrics for'
        } 
      },
      required: ['account_id']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.loadConnectedAccountMetrics(context?.userId, args.account_id);
  }
});

mcpToolRegistry.register({
  name: 'post_on_connected_account',
  definition: {
    name: 'post_on_connected_account',
    description: 'Create a post on a connected social media account. CRITICAL: Always review the post content with the user and get explicit approval before publishing to social media. IMPORTANT: The content parameter must contain the COMPLETE, FULL post text exactly as approved by the user. Never truncate, abbreviate, summarize, or use placeholders like "..." in the content.',
    inputSchema: {
      type: 'object',
      properties: {
        account_id: { type: 'string', description: 'The connected account ID' },
        content: { type: 'string', description: 'The COMPLETE post text content. MUST include the full, untruncated text exactly as approved by the user. Do NOT abbreviate, summarize, or omit any part of the content. Include all paragraphs, hashtags, emojis, and formatting. Length limits depend on the specific platform.' },
        media_urls: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional URLs of images/videos to attach'
        }
      },
      required: ['account_id', 'content']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.postOnConnectedAccount(context?.userId, args.account_id, args.content, args.media_urls);
  }
});

mcpToolRegistry.register({
  name: 'comment_on_linkedin_post',
  definition: {
    name: 'comment_on_linkedin_post',
    description: 'Create a comment on a LinkedIn post using a connected LinkedIn account. CRITICAL: Always review the comment content with the user and get explicit approval before posting comments on LinkedIn.',
    inputSchema: {
      type: 'object',
      properties: {
        account_id: {
          type: 'string',
          description: 'The connected LinkedIn account ID to comment from'
        },
        post_urn: {
          type: 'string',
          description: 'The LinkedIn post URN to comment on (e.g., "urn:li:ugcPost:123456789" or "urn:li:share:987654321")'
        },
        comment_text: {
          type: 'string',
          description: 'The comment text content. Should be concise and relevant to the post.'
        }
      },
      required: ['account_id', 'post_urn', 'comment_text']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.commentOnLinkedInPost(context?.userId, args.account_id, args.post_urn, args.comment_text);
  }
});

mcpToolRegistry.register({
  name: 'react_to_linkedin_post',
  definition: {
    name: 'react_to_linkedin_post',
    description: 'React to a LinkedIn post using a connected LinkedIn account. Supports various reaction types: LIKE (thumbs up), PRAISE (celebrate), EMPATHY (love), INTEREST (insightful), APPRECIATION (support), ENTERTAINMENT (funny). CRITICAL: Always review the reaction with the user and get explicit approval before posting reactions on LinkedIn.',
    inputSchema: {
      type: 'object',
      properties: {
        account_id: {
          type: 'string',
          description: 'The connected LinkedIn account ID to react from'
        },
        post_urn: {
          type: 'string',
          description: 'The LinkedIn post URN to react to (e.g., "urn:li:ugcPost:123456789" or "urn:li:share:987654321")'
        },
        reaction_type: {
          type: 'string',
          enum: ['LIKE', 'PRAISE', 'EMPATHY', 'INTEREST', 'APPRECIATION', 'ENTERTAINMENT'],
          description: 'The type of reaction. LIKE = Like (👍), PRAISE = Celebrate (👏), EMPATHY = Love (❤️), INTEREST = Insightful (💡), APPRECIATION = Support (🙌), ENTERTAINMENT = Funny (😂)',
          default: 'LIKE'
        }
      },
      required: ['account_id', 'post_urn']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.reactToLinkedInPost(context?.userId, args.account_id, args.post_urn, args.reaction_type || 'LIKE');
  }
});

// --- Tools from taskTools.ts ---
mcpToolRegistry.register({
  name: 'create_task_from_template',
  definition: {
    name: 'create_task_from_template',
    description: 'Create a web automation task using a specific template with the provided parameters',
    inputSchema: {
      type: 'object',
      properties: {
        template_id: { 
          type: 'string', 
          description: 'The ID of the template to use for creating the task' 
        },
        parameters_json: { 
          type: 'string', 
          description: 'JSON string containing parameter values where keys are parameter names and values are the actual values. Example: {"site_url": "example.com", "business_area": "e-commerce"}' 
        },
        attach_previous_task_results: { 
          type: 'boolean', 
          default: true, 
          description: 'Whether to attach previous task results to this task. Set to true for follow-up tasks that need to reference previous work.', 
        },
        attached_file_urls: { 
          type: 'array',
          items: { type: 'string' },
          description: 'Array of file URLs to attach to this task. These should be URLs from files uploaded in the current conversation.',
          default: [] 
        },
        async: { 
          type: 'boolean',
          description: 'Whether to execute the task asynchronously. If false, the function will wait for task completion before returning the final result.',
          default: false 
        }
      },
      required: ['template_id', 'parameters_json']
    }
  },
  execute: async (args: any, context?: any) => {
    let parameters = args.parameters_json;
    if (typeof parameters === 'string') {
      try { parameters = JSON.parse(args.parameters_json); } catch (e) {}
    }
    return await agentModeService.createTaskFromTemplate(
      args.template_id,
      parameters,
      context?.userId,
      context?.sessionId,
      args.attach_previous_task_results,
      args.attached_file_urls || [],
      args.async ?? false
    );
  }
});

mcpToolRegistry.register({
  name: 'create_task_from_prompt',
  definition: {
    name: 'create_task_from_prompt',
    description: 'Create a web automation task using a raw prompt when no suitable template is available',
    inputSchema: {
      type: 'object',
      properties: {
        task_name: {
          type: 'string',
          description: 'Name for the task'
        },
        prompt: {
          type: 'string',
          description: 'The raw prompt/instructions for the task'
        },
        category: {
          type: 'string',
          description: 'Category for the task (e.g., Research, Marketing, Analysis)'
        },
        attach_previous_task_results: {
          type: 'boolean',
          description: 'Whether to attach previous task results to this task. Set to true for follow-up tasks that need to reference previous work.',
          default: true
        },
        attached_file_urls: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of file URLs to attach to this task. These should be URLs from files uploaded in the current conversation.',
          default: []
        },
        async: {
          type: 'boolean',
          description: 'Whether to execute the task asynchronously. If false, the function will wait for task completion before returning the final result.',
          default: false
        }
      },
      required: ['task_name', 'prompt', 'category']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.createTaskFromPrompt(
      args.task_name,
      args.prompt,
      args.category,
      context?.userId,
      context?.sessionId,
      args.attach_previous_task_results,
      args.attached_file_urls || [],
      args.async ?? false
    );
  }
});

mcpToolRegistry.register({
  name: 'create_image_task_from_prompt',
  definition: {
    name: 'create_image_task_from_prompt',
    description: '[DEPRECATED] Create an image generation task using a raw prompt for creating visual content. Use \'generate_image\' instead for creating and revising images.',
    inputSchema: {
      type: 'object',
      properties: {
        task_name: {
          type: 'string',
          description: 'Name for the image generation task'
        },
        prompt: {
          type: 'string',
          description: 'The detailed prompt describing what images to generate, including style, content, and specifications'
        },
        category: {
          type: 'string',
          description: 'Category for the task (e.g., Creatives, Marketing, Social Media)',
          default: 'Creatives'
        },
        attach_previous_task_results: {
          type: 'boolean',
          description: 'Whether to attach previous task results to this task. Set to true for follow-up tasks that need to reference previous work.',
          default: true
        }
      },
      required: ['task_name', 'prompt']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.createImageTaskFromPrompt(
      args.task_name,
      args.prompt,
      args.category,
      context?.userId,
      context?.sessionId,
      args.attach_previous_task_results
    );
  }
});

mcpToolRegistry.register({
  name: 'create_revision',
  definition: {
    name: 'create_revision',
    description: '[DEPRECATED] Create a revision of an existing completed task execution (supports both reports and images). For image revision, use \'generate_image\' instead. For HTML report revision, use \'update_html_file\' instead.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'The ID of the task to revise'
        },
        execution_id: {
          type: 'string',
          description: 'The ID of the execution to revise'
        },
        revision_prompt: {
          type: 'string',
          description: 'Detailed instructions for the revision'
        },
        target_result_name: {
          type: 'string',
          description: 'Name of the specific result file to revise (if execution has multiple results). If not provided, will use the first available result.',
          default: null
        }
      },
      required: ['task_id', 'execution_id', 'revision_prompt']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.createRevision(
      args.task_id,
      args.execution_id,
      args.revision_prompt,
      context?.userId,
      args.target_result_name
    );
  }
});

mcpToolRegistry.register({
  name: 'get_task_subscriber_metrics',
  definition: {
    name: 'get_task_subscriber_metrics',
    description: 'Get comprehensive email metrics for all subscribers of a specific task, including open rates, click-through rates, and engagement data',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'The ID of the task to get subscriber metrics for'
        }
      },
      required: ['task_id']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.getTaskSubscriberMetrics(args.task_id, context?.userId);
  }
});

mcpToolRegistry.register({
  name: 'get_task_subscriber_engagement_events',
  definition: {
    name: 'get_task_subscriber_engagement_events',
    description: 'Get email engagement events for a specific task and email subject, showing detailed event history like delivered, opened, clicked, bounced, etc.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'The ID of the task to get engagement events for'
        },
        email_subject: {
          type: 'string',
          description: 'The email subject line to filter events by'
        }
      },
      required: ['task_id', 'email_subject']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.getTaskSubscriberEngagementEvents(args.task_id, args.email_subject, context?.userId);
  }
});

// --- Tools from mediaTools.ts ---
mcpToolRegistry.register({
  name: "describe_image",
  definition: {
    name: "describe_image",
    description: 'Analyze and describe an image from a URL. Use this when the user mentions an image or when you need to understand visual content.',
    inputSchema: {
      type: "object",
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
      required: ["image_url"]
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.describeImage(args.llmModel, args.image_url, args.prompt);
  }
});

mcpToolRegistry.register({
  name: "describe_video",
  definition: {
    name: "describe_video",
    description: 'Analyze and describe a video from a URL using Gemini. Use this when the user mentions a video or when you need to understand video content.',
    inputSchema: {
      type: "object",
      properties: {
        video_file_url: {
          type: 'string',
          description: 'Video URL to analyze and describe. Include the complete file URL in request.'
        },
        prompt: {
          type: 'string',
          description: 'Custom prompt/instructions for analyzing the video. Specify what aspects to focus on (e.g., key events, narration, visual details, or timing).',
          default: 'Please describe this video in detail. Focus on key events, visual elements, and any spoken content.'
        }
      },
      required: ["video_file_url"]
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.describeVideo(args.video_file_url, args.prompt);
  }
});

mcpToolRegistry.register({
  name: "remove_c2pa_from_image",
  definition: {
    name: "remove_c2pa_from_image",
    description: 'Remove C2PA metadata from an image by downloading it from a URL, stripping metadata, and uploading the cleaned image to S3. Returns the new S3 URL.',
    inputSchema: {
      type: "object",
      properties: {
        image_url: {
          type: 'string',
          description: 'URL of the image to process (can be S3 URL, data URL, or any accessible image URL)'
        },
        filename: {
          type: 'string',
          description: 'Optional filename for the cleaned image. If not provided, will generate a filename based on the original URL'
        }
      },
      required: ["image_url"]
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.removeC2PAFromImage(args.image_url, args.filename, context?.userId);
  }
});

mcpToolRegistry.register({
  name: 'generate_image',
  definition: {
    name: 'generate_image',
    description: 'Generate or edit images using AI image generation models. Supports both text-to-image generation and image editing with input images.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Detailed description of the image to generate or edit, including style, content, and visual specifications'
        },
        filename: {
          type: 'string',
          description: 'Name for the generated image file (should include .png extension)'
        },
        size: {
          type: 'string',
          description: 'Image size or ratio. For GPT models: 1024x1024, 1536x1024, 1024x1536, or auto. For Runway models: use ratio format like 1344:768, 768:1344, 1024:1024, 832x1248, etc. For Gemini 3 Pro Image (gemini-3-pro-image-preview): use ratio format like 1:1, 9:16, 16:9, 3:4, 4:3, 3:2, 2:3, 5:4, 4:5, 21:9, or auto. Use "auto" for automatic sizing.',
          default: 'auto'
        },
        quality: {
          type: 'string',
          description: 'Image quality setting (low, medium, high). Defaults to medium if not specified.',
          enum: ['low', 'medium', 'high'],
          default: 'medium'
        },
        inputImages: {
          type: 'array',
          description: 'List of input image URLs to use for image editing. Leave empty for text-to-image generation.',
          items: {
            type: 'string'
          }
        },
        imageModel: {
          type: 'string',
          description: 'Optional: Specific image generation model to use. Must be one of: gpt-image-1 (by Azure), gemini-2.5-flash-image-preview (by Google), gemini-3-pro-image-preview (by Google), gen4_image (by Runway), gemini_2.5_flash (by Runway).',
          enum: ['gpt-image-1', 'gemini-2.5-flash-image-preview', 'gemini-3-pro-image-preview', 'gen4_image', 'gemini_2.5_flash']
        }
      },
      required: ['prompt', 'filename']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.generateImage(
      args.prompt, 
      args.filename, 
      args.size || '1024x1024', 
      args.quality || 'medium', 
      args.inputImages || [], 
      context?.userId, 
      context?.sessionId, 
      args.imageModel
    );
  }
});

mcpToolRegistry.register({
  name: 'generate_video',
  definition: {
    name: 'generate_video',
    description: 'Generate videos using AI video generation models. Supports text-to-video generation and video generation with optional start and end frames for interpolation.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Detailed description of the video to generate, including style, content, motion, and visual specifications'
        },
        filename: {
          type: 'string',
          description: 'Name for the generated video file (should include .mp4 extension, will be added automatically if missing)'
        },
        videoModel: {
          type: 'string',
          description: 'Optional: Specific video generation model to use. Currently supports: veo-3.1-generate-preview (by Google). Defaults to veo-3.1-generate-preview if not specified.',
          enum: ['veo-3.1-generate-preview']
        },
        startFrame: {
          type: 'string',
          description: 'Optional: URL of the first frame image to use as the starting point for video generation. If provided, the video will start from this frame.'
        },
        endFrame: {
          type: 'string',
          description: 'Optional: URL of the last frame image to use as the ending point for video generation. If provided, the video will end at this frame. Can be used together with startFrame for interpolation between two frames.'
        }
      },
      required: ['prompt', 'filename']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.generateVideo(args.prompt, args.filename, context?.userId, context?.sessionId, args.videoModel, args.startFrame, args.endFrame);
  }
});

// --- Tools from searchTools.ts ---
mcpToolRegistry.register({
  name: "search_web",
  definition: {
    name: "search_web",
    description: 'Search the web for information from the internet',
    inputSchema: {
      type: "object",
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
      required: ["query"]
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.searchWeb(args.query, args.max_results || 10);
  }
});

mcpToolRegistry.register({
  name: "search_knowledge_base",
  definition: {
    name: "search_knowledge_base",
    description: 'Search the knowledge base for relevant information. The knowledge base contains private knowledge (user-specific) and public knowledge (shared by all users and the platform). This is complementary to web search - use knowledge base for stored information and web search for information from the internet.',
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: 'string',
          description: 'The search query to find relevant information in the knowledge base'
        },
        max_results: {
          type: 'number',
          description: 'Maximum number of search results to return (default: 5, max: 10)',
          default: 5
        }
      },
      required: ["query"]
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.searchKnowledgeBase(args.query, args.max_results || 5, context?.userId);
  }
});

mcpToolRegistry.register({
  name: "list_knowledge_base_files",
  definition: {
    name: "list_knowledge_base_files",
    description: 'List all available knowledge base files for the current user, including private (user-specific) and public (shared by all users) knowledge bases. Returns a list of files with their unique identifiers, names, sizes, URLs, types (public/private), and last updated timestamps.',
    inputSchema: {
      type: "object",
      properties: {},
      required: []
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.listKnowledgeBaseFiles(context?.userId);
  }
});

mcpToolRegistry.register({
  name: "read_knowledge_base_files",
  definition: {
    name: "read_knowledge_base_files",
    description: 'Read one or more knowledge base files. Each entry requires a knowledge base identifier (kb_identifier) and a file name (file_name). Public knowledge base files can be accessed by any user, while private files require ownership. Returns the content for each requested file.',
    inputSchema: {
      type: "object",
      properties: {
        files: {
          type: 'array',
          description: 'List of files to read',
          items: {
            type: 'object',
            properties: {
              kb_identifier: {
                type: 'string',
                description: 'Knowledge base identifier (taskId)'
              },
              file_name: {
                type: 'string',
                description: 'Name of the file to read (e.g., knowledge-base.txt or uploaded filename)'
              }
            },
            required: ['kb_identifier', 'file_name']
          }
        }
      },
      required: ["files"]
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.readKnowledgeBaseFiles(args.files, context?.userId);
  }
});

mcpToolRegistry.register({
  name: "read_file_content",
  definition: {
    name: "read_file_content",
    description: 'Read and extract content from a file URL. Supports text files, PDFs, HTML, Markdown, CSV, and other common formats. Returns the raw text content for analysis.',
    inputSchema: {
      type: "object",
      properties: {
        file_url: {
          type: 'string',
          description: 'The URL of the file to read and extract content from'
        }
      },
      required: ["file_url"]
    }
  },
  execute: async (args: any, context?: any) => {
    const result = await agentModeService.readFileContent(args.file_url);
    if (result.success === false) {
      return {
        content: [
          {
            type: "text",
            text: `Error: ${result.message}\n${result.error || ''}`
          }
        ],
        isError: true
      };
    }
    return {
      content: [
        {
          type: "text",
          text: result.content
        }
      ]
    };
  }
});

mcpToolRegistry.register({
  name: "read_page_source",
  definition: {
    name: "read_page_source",
    description: 'Read and extract the HTML source code from any webpage URL. This is an alternative to read_file_content but specifically designed for web pages. Returns the raw HTML source for analysis.',
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: 'string',
          description: 'The URL of the webpage to read and extract HTML source from'
        }
      },
      required: ["url"]
    }
  },
  execute: async (args: any, context?: any) => {
    const result = await agentModeService.readFileContent(args.url);
    if (result.success === false) {
      return {
        content: [
          {
            type: "text",
            text: `Error: ${result.message}\n${result.error || ''}`
          }
        ],
        isError: true
      };
    }
    return {
      content: [
        {
          type: "text",
          text: result.content
        }
      ]
    };
  }
});

// --- Tools from utilityTools.ts ---
mcpToolRegistry.register({
  name: "perform_data_analysis",
  definition: {
    name: "perform_data_analysis",
    description: 'Perform data analysis with code execution on files from URLs. If no files are attached, treat the information in the instruction as the complete dataset.',
    inputSchema: {
      type: "object",
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
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.performDataAnalysis(args.file_urls, args.analysis_instruction, context?.userId);
  }
});

mcpToolRegistry.register({
  name: "create_html_file",
  definition: {
    name: "create_html_file",
    description: "Create a well-formatted HTML file from a title, content draft, and format requirements.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        content_draft: { type: "string" },
        format_requirements: { type: "string" }
      },
      required: ["title", "content_draft"]
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.createHtmlFile(args.title, args.content_draft, args.format_requirements || '', context?.userId, context?.sessionId);
  }
});

mcpToolRegistry.register({
  name: "create_html_template",
  definition: {
    name: "create_html_template",
    description: "Create an email template from an existing HTML file or HTML content. The template will be saved to the Email Templates section where it can be edited and previewed. Use this when you want to convert HTML into a reusable email template with variables like {{user_name}} or {{items_n}} for dynamic content.",
    inputSchema: {
      type: "object",
      properties: {
        html_source: {
          type: "string",
          description: "Either an S3 URL to an HTML file, or raw HTML content string"
        },
        template_name: {
          type: "string",
          description: "Unique name for this email template (e.g., 'welcome_email', 'monthly_newsletter')"
        },
        subject: {
          type: "string",
          description: "Email subject line. Can include variables like {{user_name}}"
        },
        additional_instructions: {
          type: "string",
          description: "Optional instructions for how to process the HTML (e.g., 'Add variables for company name and logo', 'Make it more professional', 'Convert product list to array variables')"
        }
      },
      required: ["html_source", "template_name", "subject"]
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.createHtmlTemplate(
      args.html_source,
      args.template_name,
      args.subject,
      args.additional_instructions || '',
      context?.userId,
      context?.sessionId
    );
  }
});

mcpToolRegistry.register({
  name: "save_file",
  definition: {
    name: "save_file",
    description: 'Create and save a file with the provided content to S3, then return the file URL for sharing or reference. IMPORTANT: You must provide the COMPLETE file content as a string in the file_content parameter. This tool does NOT retrieve previously generated content - you must include the full content in this call.',
    inputSchema: {
      type: "object",
      properties: {
        file_name: {
          type: 'string',
          description: 'Name of the file to create (include appropriate extension like .txt, .md, .json, .csv, etc.)'
        },
        file_content: {
          type: 'string',
          description: 'REQUIRED: The complete content of the file to save as a string. You must provide the full file content - this tool cannot retrieve content from previous operations.'
        }
      },
      required: ["file_name", "file_content"]
    }
  },
  execute: async (args: any, context?: any) => {
    // Log parameters for debugging
    console.log('save_file tool called with args:', {
      file_name: args.file_name,
      file_content_type: typeof args.file_content,
      file_content_length: args.file_content?.length,
      has_file_content: args.file_content !== undefined,
      all_arg_keys: Object.keys(args)
    });

    return await agentModeService.saveFile(args.file_name, args.file_content, context?.userId, context?.sessionId);
  }
});

// --- Tools from workflowTools.ts ---
mcpToolRegistry.register({
  name: 'create_work_plan',
  definition: {
    name: 'create_work_plan',
    description: 'Create a multi-step work plan for the current chat session. Use this to organize complex projects like client onboarding, campaign planning, or content creation workflows. IMPORTANT: Check if a work plan already exists in the session context before creating a new one. If a work plan already exists, use modify_work_plan instead to add or update steps.',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Title of the work plan (e.g., "Client Onboarding", "Q1 Campaign")'
        },
        steps: {
          type: 'array',
          description: 'Array of steps in the plan, each with stepCount (starting from 1), title, and optional description',
          items: {
            type: 'object',
            properties: {
              stepCount: {
                type: 'number',
                description: 'Step number starting from 1'
              },
              title: {
                type: 'string',
                description: 'Step title'
              },
              description: {
                type: 'string',
                description: 'Optional detailed description of the step'
              },
              requiredFunctionCalls: {
                type: 'array',
                description: 'Optional array of function names that must be called before marking this step as completed',
                items: {
                  type: 'string'
                }
              }
            },
            required: ['stepCount', 'title']
          }
        }
      },
      required: ['title', 'steps']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.createWorkPlan(args.title, args.steps, context?.sessionId);
  }
});

mcpToolRegistry.register({
  name: 'modify_work_plan',
  definition: {
    name: 'modify_work_plan',
    description: 'Add new steps or modify existing step details in the current work plan. Does not change step status - use set_work_plan_status for that.',
    inputSchema: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          description: 'Array of steps to add or update',
          items: {
            type: 'object',
            properties: {
              stepCount: {
                type: 'number',
                description: 'Step number'
              },
              title: {
                type: 'string',
                description: 'Step title'
              },
              description: {
                type: 'string',
                description: 'Optional detailed description'
              },
              requiredFunctionCalls: {
                type: 'array',
                description: 'Optional array of function names that must be called before marking this step as completed',
                items: {
                  type: 'string'
                }
              }
            },
            required: ['stepCount', 'title']
          }
        },
        removeStepCounts: {
          type: 'array',
          description: 'Optional array of step numbers to remove',
          items: {
            type: 'number'
          }
        }
      },
      required: ['steps']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.modifyWorkPlan(args.steps, args.removeStepCounts || [], context?.sessionId);
  }
});

mcpToolRegistry.register({
  name: 'set_work_plan_status',
  definition: {
    name: 'set_work_plan_status',
    description: 'Update the status of one or more steps in the work plan. Use this to track progress as you complete steps. You can update multiple steps at once.',
    inputSchema: {
      type: 'object',
      properties: {
        updates: {
          type: 'array',
          description: 'Array of step status updates',
          items: {
            type: 'object',
            properties: {
              stepCount: {
                type: 'number',
                description: 'Step number to update (1, 2, 3, etc.)'
              },
              status: {
                type: 'string',
                enum: ['pending', 'completed', 'skipped'],
                description: 'New status for the step'
              },
              notes: {
                type: 'string',
                description: 'Optional notes about what was accomplished or why the step was skipped'
              }
            },
            required: ['stepCount', 'status']
          }
        }
      },
      required: ['updates']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.setWorkPlanStatus(args.updates, context?.sessionId);
  }
});
