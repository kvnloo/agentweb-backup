/**
 * Tool Handler Configurations
 * 
 * Maps tool names to agentModeService methods with argument mappings.
 * This enables the ToolExecutor to delegate to existing implementations.
 */

import { SimpleHandlerConfig } from '../HandlerFactory';

/**
 * Core tool handler configs
 */
export const coreHandlerConfigs: SimpleHandlerConfig[] = [
  {
    name: 'search_web',
    serviceName: 'web_search',
    methodName: 'searchWeb',
    argOrder: ['args.query', 'args.max_results']
  },
  {
    name: 'read_file_content',
    serviceName: 'file',
    methodName: 'readFileContent',
    argOrder: ['args.file_url']
  },
  {
    name: 'read_page_source',
    serviceName: 'file',
    methodName: 'readFileContent', // Same implementation as read_file_content
    argOrder: ['args.url']
  },
  {
    name: 'save_file',
    serviceName: 'file',
    methodName: 'saveFile',
    argOrder: ['args.file_name', 'args.file_content', 'context.userId', 'context.sessionId']
  },
  {
    name: 'describe_image',
    serviceName: 'image',
    methodName: 'describeImage',
    argOrder: ['context.llmModel', 'args.image_url', 'args.prompt']
  }
];

/**
 * Content tool handler configs
 */
export const contentHandlerConfigs: SimpleHandlerConfig[] = [
  {
    name: 'create_blog_article',
    serviceName: 'blog',
    methodName: 'createBlogArticle',
    argOrder: [
      'args.topic', 'args.keywords', 'args.tone', 'args.length',
      'args.researchContext', 'args.requirements', 'context.userId',
      'context.sessionId', 'args.style', 'args.deep_research'
    ]
  },
  {
    name: 'publish_blog_article',
    serviceName: 'blog',
    methodName: 'publishBlogArticle',
    argOrder: [
      'args.title', 'args.description', 'args.hero_image_url',
      'args.blog_html_url', 'context.userId', 'context.sessionId'
    ]
  },
  {
    name: 'generate_image',
    serviceName: 'image',
    methodName: 'generateImage',
    argOrder: [
      'args.prompt', 'args.filename', 'args.size', 'args.quality',
      'args.inputImages', 'context.userId', 'context.sessionId', 'args.imageModel'
    ]
  },
  {
    name: 'generate_video',
    serviceName: 'video',
    methodName: 'generateVideo',
    argOrder: [
      'args.prompt', 'args.filename', 'context.userId', 'context.sessionId',
      'args.videoModel', 'args.startFrame', 'args.endFrame'
    ]
  },
  {
    name: 'create_social_media_posts',
    serviceName: 'social_media',
    methodName: 'createSocialMediaPosts',
    argOrder: ['args.posts', 'context.userId', 'context.sessionId']
  },
  {
    name: 'post_on_connected_account',
    serviceName: 'social_media',
    methodName: 'postOnConnectedAccount',
    argOrder: ['context.userId', 'args.account_id', 'args.content', 'args.media_urls']
  },
  {
    name: 'remove_c2pa_from_image',
    serviceName: 'image',
    methodName: 'removeC2PAFromImage',
    argOrder: ['args.image_url', 'args.filename', 'context.userId']
  },
  {
    name: 'describe_video',
    serviceName: 'video',
    methodName: 'describeVideo',
    argOrder: ['args.video_file_url', 'args.prompt']
  }
];

/**
 * Research tool handler configs
 */
export const researchHandlerConfigs: SimpleHandlerConfig[] = [
  {
    name: 'search_knowledge_base',
    serviceName: 'knowledge_base',
    methodName: 'searchKnowledgeBase',
    argOrder: ['args.query', 'args.max_results', 'context.userId']
  },
  {
    name: 'list_knowledge_base_files',
    serviceName: 'knowledge_base',
    methodName: 'listKnowledgeBaseFiles',
    argOrder: ['context.userId']
  },
  {
    name: 'read_knowledge_base_file',
    serviceName: 'knowledge_base',
    methodName: 'readKnowledgeBaseFile',
    argOrder: ['args.file_identifier', 'context.userId']
  },
  {
    name: 'read_knowledge_base_files',
    serviceName: 'knowledge_base',
    methodName: 'readKnowledgeBaseFiles',
    argOrder: ['args.files', 'context.userId']
  },
  {
    name: 'perform_deep_research',
    serviceName: 'deep_research',
    methodName: 'performDeepResearchTool',
    argOrder: ['args.topic', 'args.prompt', 'args.tone', 'args.depth', 'args.focus_areas', 'context.userId']
  },
  {
    name: 'perform_data_analysis',
    serviceName: 'deep_research',
    methodName: 'performDataAnalysis',
    argOrder: ['args.file_urls', 'args.analysis_instruction', 'context.userId']
  }
];

/**
 * CRM tool handler configs
 */
export const crmHandlerConfigs: SimpleHandlerConfig[] = [
  {
    name: 'read_brand_guidelines',
    serviceName: 'brand',
    methodName: 'readBrandGuidelines',
    argOrder: ['context.userId']
  },
  {
    name: 'update_brand_guidelines',
    serviceName: 'brand',
    methodName: 'updateBrandGuidelines',
    argOrder: ['args', 'context.userId']
  },
  {
    name: 'read_market_strategy',
    serviceName: 'market_strategy',
    methodName: 'readMarketStrategy',
    argOrder: ['context.userId']
  },
  {
    name: 'update_market_strategy',
    serviceName: 'market_strategy',
    methodName: 'updateMarketStrategy',
    argOrder: ['args', 'context.userId']
  },
  {
    name: 'get_lead_lists',
    serviceName: 'lead',
    methodName: 'getLeadLists',
    argOrder: ['context.userId']
  },
  {
    name: 'create_lead_list',
    serviceName: 'lead',
    methodName: 'createLeadList',
    argOrder: ['args.name', 'args.description', 'context.userId']
  },
  {
    name: 'add_leads_to_list',
    serviceName: 'lead',
    methodName: 'addLeadsToList',
    argOrder: ['args.list_id', 'args.leads', 'context.userId']
  },
  {
    name: 'update_email_draft_for_lead',
    serviceName: 'lead',
    methodName: 'updateEmailDraftForLead',
    argOrder: ['args.list_id', 'args.lead_id', 'args.instruction', 'context.sessionId', 'context.userId', 'args.email_format']
  }
];

/**
 * GTM tool handler configs
 */
export const gtmHandlerConfigs: SimpleHandlerConfig[] = [
  {
    name: 'list_gtm_plans',
    methodName: 'listGTMPlans',
    argOrder: ['context.userId']
  },
  {
    name: 'read_gtm_plan',
    methodName: 'readGTMPlan',
    argOrder: ['args.plan_id', 'context.userId']
  },
  {
    name: 'create_gtm_plan',
    methodName: 'createGTMPlan',
    argOrder: ['args.title', 'args.description', 'args.dri', 'args.phases', 'context.userId']
  }
];

/**
 * Analytics tool handler configs
 */
export const analyticsHandlerConfigs: SimpleHandlerConfig[] = [
  {
    name: 'get_meta_ads_metrics',
    methodName: 'getMetaAdsMetrics',
    argOrder: ['args.timeframe', 'context.userId', 'args.campaign_name']
  },
  {
    name: 'get_task_subscriber_metrics',
    methodName: 'getTaskSubscriberMetrics',
    argOrder: ['args.task_id', 'context.userId']
  },
  {
    name: 'get_task_subscriber_engagement_events',
    methodName: 'getTaskSubscriberEngagementEvents',
    argOrder: ['args.task_id', 'args.email_subject', 'context.userId']
  },
  {
    name: 'list_connected_accounts',
    methodName: 'listConnectedAccounts',
    argOrder: ['context.userId', 'args.platform']
  },
  {
    name: 'load_connected_account_metrics',
    methodName: 'loadConnectedAccountMetrics',
    argOrder: ['context.userId', 'args.account_id']
  },
  {
    name: 'list_connected_account_posts',
    methodName: 'loadConnectedAccountPosts',
    argOrder: ['context.userId', 'args.account_id', 'args']
  }
];

/**
 * Automation tool handler configs
 */
export const automationHandlerConfigs: SimpleHandlerConfig[] = [
  {
    name: 'create_work_plan',
    methodName: 'createWorkPlan',
    argOrder: ['args.title', 'args.steps', 'context.sessionId']
  },
  {
    name: 'modify_work_plan',
    methodName: 'modifyWorkPlan',
    argOrder: ['args.steps', 'args.removeStepCounts', 'context.sessionId']
  },
  {
    name: 'set_work_plan_status',
    methodName: 'setWorkPlanStatus',
    argOrder: ['args.updates', 'context.sessionId']
  }
];

/**
 * Book tool handler configs
 */
export const bookHandlerConfigs: SimpleHandlerConfig[] = [
  {
    name: 'list_books',
    methodName: 'listBooks',
    argOrder: ['context.userId', 'args.type', 'args.status']
  },
  {
    name: 'get_book_details',
    methodName: 'getBookDetails',
    argOrder: ['args.book_id', 'context.userId']
  },
  {
    name: 'get_book_content',
    methodName: 'getBookContent',
    argOrder: ['args.book_id', 'args.section_id', 'args.chapter_id', 'context.userId']
  },
  {
    name: 'generate_book_content',
    methodName: 'generateBookContent',
    argOrder: [
      'args.book_id', 'args.section_id', 'args.chapter_id',
      'args.content_description', 'args.length', 'args.imagine',
      'context.userId', 'args.research_url'
    ]
  },
  {
    name: 'create_book',
    methodName: 'createBook',
    argOrder: [
      'args.title', 'args.description', 'args.type', 'args.author',
      'args.language', 'args.genre', 'args.tags', 'context.userId'
    ]
  },
  {
    name: 'create_book_outline',
    methodName: 'createBookOutline',
    argOrder: ['args.book_id', 'args.outline_json', 'context.userId']
  },
  {
    name: 'add_characters',
    methodName: 'addCharacters',
    argOrder: ['args.book_id', 'args.characters_json', 'context.userId']
  }
];

/**
 * Template tool handler configs
 */
export const templateHandlerConfigs: SimpleHandlerConfig[] = [
  {
    name: 'list_html_templates',
    methodName: 'listHtmlTemplates',
    argOrder: ['context.userId']
  }
];

/**
 * All handler configs combined
 */
export const allHandlerConfigs: SimpleHandlerConfig[] = [
  ...coreHandlerConfigs,
  ...contentHandlerConfigs,
  ...researchHandlerConfigs,
  ...crmHandlerConfigs,
  ...gtmHandlerConfigs,
  ...analyticsHandlerConfigs,
  ...automationHandlerConfigs,
  ...bookHandlerConfigs,
  ...templateHandlerConfigs
];
