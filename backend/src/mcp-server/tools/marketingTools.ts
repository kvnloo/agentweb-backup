import { agentModeService } from '../../services/agentModeService.js';
import { mcpToolRegistry } from '../registry.js';

mcpToolRegistry.register({
  name: 'get_meta_ads_metrics',
  definition: {
    name: 'get_meta_ads_metrics',
    description: 'Get Meta ad performance metrics and campaign data',
    inputSchema: {
      type: 'object',
      properties: {
        timeframe: {
          type: 'string',
          description: 'Time period for metrics (7d, 14d, 30d, 90d)',
          enum: ['7d', '14d', '30d', '90d'],
          default: '7d'
        },
        campaign_name: {
          type: 'string',
          description: 'Optional campaign name to filter metrics by.',
          default: null
        },
        userId: {
          type: 'string',
          description: 'The unique identifier for the user'
        }
      },
      required: ['userId']
    }
  },
  execute: async (args) => {
    return await agentModeService.getMetaAdsMetrics(args.timeframe || '7d', args.userId, args.campaign_name);
  }
});

mcpToolRegistry.register({
  name: 'read_brand_guidelines',
  definition: {
    name: 'read_brand_guidelines',
    description: 'Read the current user\'s brand guidelines (brand data and attachments). Returns exists=false if not set.',
    inputSchema: {
      type: 'object',
      properties: {
        userId: {
          type: 'string',
          description: 'The unique identifier for the user'
        }
      },
      required: ['userId']
    }
  },
  execute: async (args) => {
    return await agentModeService.readBrandGuidelines(args.userId);
  }
});

mcpToolRegistry.register({
  name: 'update_brand_guidelines',
  definition: {
    name: 'update_brand_guidelines',
    description: 'Update the user\'s brand guidelines. IMPORTANT: Use read_brand_guidelines first.',
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string' },
        brandData: { type: 'object' },
        brandAssets: { type: 'array', items: { type: 'object' } }
      },
      required: ['userId']
    }
  },
  execute: async (args) => {
    const { userId, ...data } = args;
    return await agentModeService.updateBrandGuidelines(data, userId);
  }
});

mcpToolRegistry.register({
  name: 'read_market_strategy',
  definition: {
    name: 'read_market_strategy',
    description: 'Read the user\'s current market strategy, ICP, and target audience data.',
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string' }
      },
      required: ['userId']
    }
  },
  execute: async (args) => {
    return await agentModeService.readMarketStrategy(args.userId);
  }
});

mcpToolRegistry.register({
  name: 'update_market_strategy',
  definition: {
    name: 'update_market_strategy',
    description: 'Update the user\'s market strategy, ICP, and target audience data.',
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string' },
        businessOverview: { type: 'string' },
        competitors: { type: 'array', items: { type: 'object' } },
        icp: { type: 'array', items: { type: 'object' } }
      },
      required: ['userId']
    }
  },
  execute: async (args) => {
    const { userId, ...data } = args;
    return await agentModeService.updateMarketStrategy(data, userId);
  }
});

mcpToolRegistry.register({
  name: 'perform_deep_research',
  definition: {
    name: 'perform_deep_research',
    description: 'Perform comprehensive deep research on any topic using Gemini Deep Research.',
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string' },
        topic: { type: 'string' },
        prompt: { type: 'string' },
        tone: { type: 'string', enum: ['professional', 'casual', 'technical', 'executive'], default: 'professional' },
        depth: { type: 'string', enum: ['overview', 'detailed', 'comprehensive'], default: 'detailed' },
        focus_areas: { type: 'array', items: { type: 'string' } }
      },
      required: ['userId', 'topic']
    }
  },
  execute: async (args) => {
    return await agentModeService.performDeepResearchTool(args.topic, args.prompt, args.tone, args.depth, args.focus_areas, args.userId);
  }
});
