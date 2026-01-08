/**
 * Analytics Tools Definitions
 * 
 * Tools for metrics, campaign performance, and analytics.
 * 
 * UNIFIED DEFINITION: Includes schema, handler config, and intent keywords.
 */

import { ToolDefinition, CategoryConfig } from '../types';
import { registerCategoryConfig } from './utils';

/**
 * Analytics category configuration
 */
export const analyticsCategory: CategoryConfig = {
  name: 'analytics',
  intentPatterns: [
    /\b(metrics|performance|ads|campaign|stats|meta\s*ads|facebook\s*ads|analytics|engagement|impressions|clicks|ctr)\b/i
  ],
  categoryKeywords: [
    'metrics', 'performance', 'ads', 'campaign', 'stats', 'meta',
    'analytics', 'engagement', 'impressions', 'clicks', 'ctr',
    'roi', 'conversion', 'tracking'
  ]
};

// Register the category config for aggregation
registerCategoryConfig(analyticsCategory);

/**
 * Analytics tools with unified definitions
 */
export const analyticsTools: ToolDefinition[] = [
  {
    name: 'get_meta_ads_metrics',
    version: '1.0.0',
    category: 'analytics',
    intentKeywords: ['meta', 'ads', 'facebook', 'metrics', 'campaign', 'performance'],
    schema: {
      description: 'Get Meta ad performance metrics and campaign data',
      parameters: {
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
            description: 'Optional campaign name to filter metrics by. If provided, only data from campaigns matching this name will be returned.',
            default: null
          }
        },
        required: []
      }
    },
    handler: {
      methodName: 'getMetaAdsMetrics',
      customArgOrder: ['args.timeframe', 'context.userId', 'args.campaign_name']
    }
  },
  {
    name: 'get_task_subscriber_metrics',
    version: '1.0.0',
    category: 'analytics',
    intentKeywords: ['subscriber', 'email', 'metrics', 'open', 'rate', 'click'],
    schema: {
      description: 'Get comprehensive email metrics for all subscribers of a specific task, including open rates, click-through rates, and engagement data',
      parameters: {
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
    handler: {
      methodName: 'getTaskSubscriberMetrics',
      contextArgs: ['userId']
    }
  },
  {
    name: 'get_task_subscriber_engagement_events',
    version: '1.0.0',
    category: 'analytics',
    intentKeywords: ['engagement', 'events', 'email', 'opened', 'clicked', 'bounced'],
    schema: {
      description: 'Get email engagement events for a specific task and email subject, showing detailed event history like delivered, opened, clicked, bounced, etc.',
      parameters: {
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
    handler: {
      methodName: 'getTaskSubscriberEngagementEvents',
      contextArgs: ['userId']
    }
  },
  {
    name: 'list_connected_accounts',
    version: '1.0.0',
    category: 'analytics',
    intentKeywords: ['connected', 'accounts', 'social', 'list', 'platforms'],
    schema: {
      description: 'Returns list of social media accounts connected by the user',
      parameters: {
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
    handler: {
      methodName: 'listConnectedAccounts',
      customArgOrder: ['context.userId', 'args.platform']
    }
  },
  {
    name: 'load_connected_account_metrics',
    version: '1.0.0',
    category: 'analytics',
    intentKeywords: ['account', 'metrics', 'followers', 'engagement', 'statistics'],
    schema: {
      description: 'Load performance metrics for a specific connected account (e.g., page statistics, follower counts, engagement).',
      parameters: {
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
    handler: {
      methodName: 'loadConnectedAccountMetrics',
      customArgOrder: ['context.userId', 'args.account_id']
    }
  },
  {
    name: 'list_connected_account_posts',
    version: '1.0.0',
    category: 'analytics',
    intentKeywords: ['posts', 'account', 'social', 'list', 'history'],
    schema: {
      description: 'List posts from a connected social media account with optional metrics',
      parameters: {
        type: 'object',
        properties: {
          account_id: { type: 'string', description: 'The connected account ID' },
          limit: { type: 'number', description: 'Maximum number of posts to return', default: 10 },
          include_metrics: { type: 'boolean', description: 'Whether to include per-post metrics (likes, comments, etc.)', default: false }
        },
        required: ['account_id']
      }
    },
    handler: {
      methodName: 'loadConnectedAccountPosts',
      // Special case: passes full args object
      customArgOrder: ['context.userId', 'args.account_id', 'args']
    }
  }
];
