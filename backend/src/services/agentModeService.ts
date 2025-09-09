import OpenAI from 'openai';
import { chatbotDb, ChatMessage } from './chatbotService';
import { taskDb } from './db';
import { v4 as uuidv4 } from 'uuid';

export class AgentModeService {
  private openai: OpenAI;
  
  constructor() {
    this.openai = new OpenAI({
      apiKey: process.env.AZURE_OPENAI_API_KEY,
      baseURL: `${process.env.AZURE_OPENAI_ENDPOINT}/openai/deployments/${process.env.AZURE_OPENAI_DEPLOYMENT_AGENT_MODE || 'gpt-5-chat-2'}`,
      defaultQuery: {
        "api-version": process.env.AZURE_OPENAI_API_VERSION_AGENT_MODE || "2025-01-01-preview",
      },
      defaultHeaders: { "api-key": process.env.AZURE_OPENAI_API_KEY },
    });
  }

  // Generate AI response for marketing conversation
  async generateMarketingResponse(
    userMessage: string,
    sessionHistory: ChatMessage[],
    userId: string
  ): Promise<{ content: string; toolCalls: any[]; knowledgeBaseQueries: string[]; sources: string[] }> {
    try {
      console.log('AgentMode: Generating marketing response');
      
      const systemPrompt = this.getMarketingSystemPrompt();
      const context = this.buildMarketingContext(userMessage, sessionHistory);
      
      const response = await this.openai.chat.completions.create({
        model: process.env.AZURE_OPENAI_DEPLOYMENT_AGENT_MODE || 'gpt-5-chat-2',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: context }
        ],
        tools: this.getAvailableTools(),
        tool_choice: 'auto',
        max_completion_tokens: 2000
      });

      const responseMessage = response.choices[0].message;
      let content = responseMessage.content || '';
      const toolCalls: any[] = [];
      const knowledgeBaseQueries: string[] = [];
      const sources: string[] = [];

      // Execute tool calls if any
      if (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
        for (const toolCall of responseMessage.tool_calls) {
          try {
            const functionArgs = JSON.parse(toolCall.function.arguments);
            console.log(`AgentMode: Executing tool ${toolCall.function.name}`);
            
            const result = await this.executeTool(toolCall.function.name, functionArgs, userId);
            
            toolCalls.push({
              id: toolCall.id,
              name: toolCall.function.name,
              arguments: functionArgs,
              result: result
            });

            // Add tool result to content
            content += `\n\n**Tool Result:** ${JSON.stringify(result, null, 2)}`;
          } catch (error) {
            console.error(`AgentMode: Tool execution error for ${toolCall.function.name}:`, error);
            toolCalls.push({
              id: toolCall.id,
              name: toolCall.function.name,
              arguments: JSON.parse(toolCall.function.arguments),
              error: error instanceof Error ? error.message : 'Unknown error'
            });
          }
        }
      }

      return {
        content,
        toolCalls,
        knowledgeBaseQueries,
        sources
      };
    } catch (error) {
      console.error('AgentMode: Response generation failed:', error);
      throw new Error('Failed to generate response');
    }
  }

  private getMarketingSystemPrompt(): string {
    return `You are Emma, an AI-powered assistant from AgentWeb. You help users execute marketing campaigns through natural conversation and task creation.

You can execute various marketing tasks including:
- SWOT analysis of landing pages
- Marketing strategy generation
- Ad creative creation
- Campaign publishing
- Performance analysis

Use the available tools to create tasks in the agent-engine when complex work is required. Guide users through marketing flows naturally through conversation.`;
  }

  private buildMarketingContext(userMessage: string, sessionHistory: ChatMessage[]): string {
    let context = `User Message: ${userMessage}\n\n`;
    
    // Add recent conversation history
    if (sessionHistory.length > 0) {
      const recentHistory = sessionHistory.slice(-5);
      context += 'Recent Conversation:\n';
      recentHistory.forEach(msg => {
        context += `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}\n`;
      });
      context += '\n';
    }
    
    return context;
  }

  private getAvailableTools() {
    return [
      {
        type: 'function' as const,
        function: {
          name: 'perform_swot_analysis',
          description: 'Perform a comprehensive SWOT analysis for a business or website',
          parameters: {
            type: 'object',
            properties: {
              url: {
                type: 'string',
                description: 'The website URL to analyze'
              },
              business_context: {
                type: 'string',
                description: 'Additional business context or information'
              }
            },
            required: ['url']
          }
        }
      },
      {
        type: 'function' as const,
        function: {
          name: 'generate_marketing_strategy',
          description: 'Generate a comprehensive marketing strategy based on analysis data',
          parameters: {
            type: 'object',
            properties: {
              swot_data: {
                type: 'string',
                description: 'SWOT analysis results to base strategy on'
              },
              business_goals: {
                type: 'string',
                description: 'Specific business goals and objectives'
              }
            },
            required: ['swot_data']
          }
        }
      },
      {
        type: 'function' as const,
        function: {
          name: 'create_ad_creatives',
          description: 'Create ad creatives including images and copy',
          parameters: {
            type: 'object',
            properties: {
              campaign_theme: {
                type: 'string',
                description: 'The theme or concept for the ad creatives'
              },
              target_audience: {
                type: 'string',
                description: 'Target audience description'
              },
              count: {
                type: 'number',
                description: 'Number of creatives to generate (default: 5)'
              }
            },
            required: ['campaign_theme']
          }
        }
      },
      {
        type: 'function' as const,
        function: {
          name: 'publish_meta_ads',
          description: 'Publish ad creatives to Meta advertising platform',
          parameters: {
            type: 'object',
            properties: {
              campaign_name: {
                type: 'string',
                description: 'Name for the Meta ad campaign'
              },
              budget: {
                type: 'number',
                description: 'Daily budget for the campaign'
              },
              targeting: {
                type: 'object',
                description: 'Targeting parameters for the ads',
                properties: {
                  age_range: { type: 'string' },
                  interests: { type: 'array', items: { type: 'string' } },
                  locations: { type: 'array', items: { type: 'string' } }
                }
              },
              creatives: {
                type: 'array',
                description: 'The creatives to publish',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    headline: { type: 'string' },
                    description: { type: 'string' },
                    cta: { type: 'string' },
                    image_prompt: { type: 'string' }
                  }
                }
              }
            },
            required: ['campaign_name', 'budget', 'creatives']
          }
        }
      },
      {
        type: 'function' as const,
        function: {
          name: 'analyze_ad_performance',
          description: 'Analyze performance metrics for Meta ad campaigns',
          parameters: {
            type: 'object',
            properties: {
              campaign_id: {
                type: 'string',
                description: 'Meta campaign ID to analyze'
              },
              date_range: {
                type: 'object',
                description: 'Date range for analysis',
                properties: {
                  start_date: { type: 'string' },
                  end_date: { type: 'string' }
                }
              },
              creatives: {
                type: 'array',
                description: 'Specific creatives to analyze',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    headline: { type: 'string' },
                    description: { type: 'string' },
                    cta: { type: 'string' },
                    image_prompt: { type: 'string' }
                  }
                }
              }
            },
            required: ['campaign_id']
          }
        }
      }
    ];
  }

  private async executeTool(toolName: string, args: any, userId: string): Promise<any> {
    switch (toolName) {
      case 'perform_swot_analysis':
        return await this.performSwotAnalysis(args.url, args.business_context, userId);
      case 'generate_marketing_strategy':
        return await this.generateMarketingStrategy(args.swot_data, args.business_goals, userId);
      case 'create_ad_creatives':
        return await this.createAdCreatives(args.campaign_theme, args.target_audience, args.count, userId);
      case 'publish_meta_ads':
        return await this.publishMetaAds(args.campaign_name, args.budget, args.targeting, args.creatives, userId);
      case 'analyze_ad_performance':
        return await this.analyzeAdPerformance(args.campaign_id, args.date_range, args.creatives, userId);
      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  }

  private async performSwotAnalysis(url: string, businessContext: string | undefined, userId: string): Promise<any> {
    try {
      const taskData = {
        name: `SWOT Analysis - ${url}`,
        prompt: `Perform a comprehensive SWOT analysis for the website: ${url}\n\n${businessContext ? `Business Context: ${businessContext}` : ''}\n\nPlease analyze the website and provide:\n1. Strengths - What the website does well\n2. Weaknesses - Areas for improvement\n3. Opportunities - Potential growth areas\n4. Threats - Competitive challenges\n\nUse web scraping to gather information about the website, its content, design, functionality, and user experience. Provide specific, actionable insights based on your analysis.`,
        category: 'Research',
        description: 'SWOT analysis for marketing strategy development',
        outputAsHtml: true,
        useKnowledgeBase: true
      };

      const task = await taskDb.createTask({
        taskId: uuidv4(),
        userId: userId,
        name: taskData.name,
        prompt: taskData.prompt,
        status: 'active',
        createdAt: new Date().toISOString(),
        category: taskData.category,
        description: taskData.description,
        outputAsHtml: taskData.outputAsHtml,
        extractPageContent: false,
        useSharedBrowser: false,
        turnOffHeadless: true,
        createVideo: false,
        requireApproval: false
      });

      if (!task) { throw new Error('Failed to create task'); }

      const execution = await taskDb.createTaskExecution({
        executionId: uuidv4(),
        taskId: task.taskId,
        userId: userId,
        status: 'pending',
        startTime: new Date().toISOString()
      });

      if (!execution) { throw new Error('Failed to create task execution'); }

      return {
        taskId: task.taskId,
        executionId: execution.executionId,
        status: 'running',
        message: 'SWOT analysis task created and started. The analysis will be completed shortly.'
      };
    } catch (error) {
      console.error('Error creating SWOT analysis task:', error);
      throw new Error('Failed to create SWOT analysis task');
    }
  }

  private async generateMarketingStrategy(swotData: string, businessGoals: string | undefined, userId: string): Promise<any> {
    // This would create a task for strategy generation
    return {
      message: 'Marketing strategy generation is not yet implemented as a task. Please provide more details about your business goals.',
      swotData,
      businessGoals
    };
  }

  private async createAdCreatives(campaignTheme: string, targetAudience: string | undefined, count: number | undefined, userId: string): Promise<any> {
    // This would create a task for creative generation
    return {
      message: 'Ad creative generation is not yet implemented as a task. Please provide more details about your campaign theme.',
      campaignTheme,
      targetAudience,
      count: count || 5
    };
  }

  private async publishMetaAds(campaignName: string, budget: number, targeting: any, creatives: any[], userId: string): Promise<any> {
    // This would integrate with Meta API
    return {
      message: 'Meta ads publishing is not yet implemented. Please provide your Meta API credentials.',
      campaignName,
      budget,
      targeting,
      creatives
    };
  }

  private async analyzeAdPerformance(campaignId: string, dateRange: any, creatives: any[], userId: string): Promise<any> {
    // This would integrate with Meta API
    return {
      message: 'Ad performance analysis is not yet implemented. Please provide your Meta API credentials.',
      campaignId,
      dateRange,
      creatives
    };
  }
}

export const agentModeService = new AgentModeService();