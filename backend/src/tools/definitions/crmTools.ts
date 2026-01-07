/**
 * CRM Tools Definitions
 * 
 * Tools for brand guidelines, market strategy, and lead management.
 */

import { ToolDefinition } from '../types';

export const crmTools: ToolDefinition[] = [
  {
    name: 'read_brand_guidelines',
    version: '1.0.0',
    category: 'crm',
    schema: {
      description: "Read the current user's brand guidelines (brand data and attachments). Returns exists=false if not set.",
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    }
  },
  {
    name: 'update_brand_guidelines',
    version: '1.0.0',
    category: 'crm',
    schema: {
      description: "Update the user's brand guidelines. IMPORTANT: Use read_brand_guidelines first to fetch the latest data, then only update the fields that need to be changed.",
      parameters: {
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
                    signaturePosts: { type: 'string', description: 'Notable posts or content' }
                  },
                  required: ['name']
                },
                description: 'Array of founder profiles'
              }
            }
          },
          brandAssets: {
            type: 'array',
            description: 'Brand assets to update (logos, brand guides, etc.)',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['logo', 'secondaryLogo', 'brandGuide', 'additionalAsset'] },
                url: { type: 'string', description: 'URL of the brand asset' },
                filename: { type: 'string', description: 'Original filename of the brand asset' }
              }
            }
          }
        },
        required: []
      }
    }
  },
  {
    name: 'read_market_strategy',
    version: '1.0.0',
    category: 'crm',
    schema: {
      description: "Read the current user's market strategy (business overview, competitors, and ideal customer profiles). Returns exists=false if not set.",
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    }
  },
  {
    name: 'update_market_strategy',
    version: '1.0.0',
    category: 'crm',
    schema: {
      description: "Update the user's market strategy. IMPORTANT: Use read_market_strategy first to fetch the latest data, then only update the fields that need to be changed.",
      parameters: {
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
            description: 'Array of Ideal Customer Profile objects',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string', description: 'ICP title or name' },
                description: { type: 'string', description: 'ICP description or characteristics' },
                valueProposition: { type: 'string', description: 'Value proposition for this customer type' },
                buyerPersonas: { type: 'array', items: { type: 'string' }, description: 'List of buyer personas' }
              },
              required: ['title']
            }
          }
        },
        required: []
      }
    }
  },
  {
    name: 'get_lead_lists',
    version: '1.0.0',
    category: 'crm',
    schema: {
      description: 'Get all lead lists for the current user. Returns a list of lead lists with their IDs, names, descriptions, lead counts, and creation dates.',
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    }
  },
  {
    name: 'create_lead_list',
    version: '1.0.0',
    category: 'crm',
    schema: {
      description: 'Create a new lead list with a name and optional description. Returns the created lead list with its ID.',
      parameters: {
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
    }
  },
  {
    name: 'add_leads_to_list',
    version: '1.0.0',
    category: 'crm',
    schema: {
      description: 'Add one or more leads to an existing lead list. Each lead is a flexible object that can contain any fields. The email field is used for deduplication and merging.',
      parameters: {
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
              description: 'A lead object with any fields you want to store.',
              additionalProperties: true,
              properties: {
                email: {
                  type: 'string',
                  description: 'Email address (optional, but recommended for deduplication)'
                }
              }
            },
            description: 'Array of lead objects to add to the list'
          }
        },
        required: ['list_id', 'leads']
      }
    }
  },
  {
    name: 'update_email_draft_for_lead',
    version: '1.0.0',
    category: 'crm',
    schema: {
      description: 'Create or update an email draft for a specific lead. Uses AI to generate a personalized email draft based on the instruction, lead data, engagement history, brand guidelines, and market strategy.',
      parameters: {
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
            description: 'Instructions for creating the email draft (e.g., "welcome email", "follow-up on their interest in our product")'
          },
          email_format: {
            type: 'string',
            enum: ['text', 'html'],
            description: 'Optional. The format for the email draft: "text" for plain text or "html" for HTML.'
          }
        },
        required: ['list_id', 'lead_id', 'instruction']
      }
    }
  }
];
