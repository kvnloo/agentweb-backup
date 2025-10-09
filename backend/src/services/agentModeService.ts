import axios from 'axios';
import OpenAI from 'openai';
import { google } from 'googleapis';
import { createHash } from 'crypto';
import { chatbotDb, ChatMessage } from './chatbotService';
import { taskDb, taskTemplateDb } from './db';
import { settingsService } from './settingsService';
import { getSecret } from '../utils/secretsManager';

// Type declaration for pdf-parse module
interface PDFData {
  text: string;
  numpages: number;
  numrender: number;
  info: any;
  metadata: any;
  version: string;
}

export class AgentModeService {
  private openai: OpenAI;
  private fileContentCache: Map<string, { file_url: string; file_name: string; file_size: number }> = new Map();
  
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
    messageContent: string,
    sessionHistory: ChatMessage[],
    userId: string,
    sessionId: string,
    mockMode: boolean = false
  ): Promise<{ content: string; toolCalls: any[]; knowledgeBaseQueries: string[]; sources: string[]; responseMessages: any[] }> {
    try {
      
      const systemPrompt = await this.getMarketingSystemPrompt();
      const currentTaskStatuses = this.getCurrentTaskStatusesInSession(sessionHistory);
      const availableTemplates = await this.getAvailableTemplates();
      const marketingMessages = this.buildMarketingContext(messageContent, sessionHistory, currentTaskStatuses);
      
      // Build templates context message
      const templatesContext = this.buildTemplatesContext(availableTemplates);
      
      // Build initial messages array (preserve structured history and tool messages)
      const messages: any[] = [
        { role: 'system', content: systemPrompt },
        { role: 'assistant', content: templatesContext },
        ...marketingMessages
      ];

      let content = '';
      const toolCalls: any[] = [];
      const knowledgeBaseQueries: string[] = [];
      const sources: string[] = [];
      
      // Remember initial message count to slice response messages later
      const initialMessageCount = messages.length;

      // Single loop for LLM calls and tool execution
      let maxIterations = 20; // Prevent infinite loops
      let iteration = 0;
      let responseMessage: any = null;
      
      while (iteration < maxIterations) {
        iteration++;
        
        // Make LLM call
        const response = await this.openai.chat.completions.create({
          model: process.env.AZURE_OPENAI_DEPLOYMENT_AGENT_MODE || 'gpt-5-chat-2',
          messages: messages,
          tools: this.getAvailableTools(),
          tool_choice: 'auto',
          max_completion_tokens: 12384
        });
        
        responseMessage = response.choices[0].message;
        const responseContent = responseMessage.content || '';
        
        // Update content with LLM's response
        if (responseContent) {
          content = responseContent;
        }
        
        // Append the model's message to conversation before handling tool calls
        (messages as any[]).push(responseMessage);
        
        // If no tool calls, break the loop
        if (!responseMessage.tool_calls || responseMessage.tool_calls.length === 0) {
          break;
        }
        
        
        // Execute tool calls
        for (const toolCall of responseMessage.tool_calls) {
          try {
            const functionArgs = JSON.parse(toolCall.function.arguments);
            
            const result = await this.executeTool(toolCall.function.name, functionArgs, userId, sessionId, mockMode);
            
            // Store only the necessary data for the frontend
            const minimalResult = this.extractMinimalToolResult(result, toolCall.function.name);
            
            toolCalls.push({
              id: toolCall.id,
              name: toolCall.function.name,
              arguments: functionArgs,
              result: minimalResult
            });

            // Append the tool call result as a tool message for the model to consume next
            const toolContent = result.formattedContent || (typeof result === 'string' ? result : JSON.stringify(result));
            (messages as any[]).push({
              tool_call_id: toolCall.id,
              role: 'tool',
              name: toolCall.function.name,
              content: toolContent
            });

            // Tool results are now included in the tool message content above
          } catch (error) {
            console.error(`AgentMode: Tool execution error for ${toolCall.function.name}:`, error);
            toolCalls.push({
              id: toolCall.id,
              name: toolCall.function.name,
              arguments: JSON.parse(toolCall.function.arguments),
              error: error instanceof Error ? error.message : 'Unknown error'
            });
            // Ensure LLM receives the error to adjust its plan
            const errMsg = error instanceof Error ? error.message : String(error);
            const errorContent = this.formatToolError(toolCall.function.name, errMsg);
            
            // Append error as tool message
            messages.push({
              tool_call_id: toolCall.id,
              role: 'tool',
              name: toolCall.function.name,
              content: errorContent
            });
          }
        }
        
        // Do not append an assistant message; tool messages above are sufficient for model continuation
      }
      
      if (iteration >= maxIterations) {
        console.warn('AgentMode: Reached maximum tool execution iterations');
      }

      // Add tool calls data to the last message for frontend display
      if (toolCalls.length > 0 && messages.length > 0) {
        const lastMessage = messages[messages.length - 1];
        if (lastMessage.role === 'assistant') {
          lastMessage.metadata = {
            ...lastMessage.metadata,
            toolCalls: toolCalls,
            timestamp: new Date().toISOString(),
          };
        }
      }

      return {
        content,
        toolCalls,
        knowledgeBaseQueries,
        sources,
        responseMessages: messages.slice(initialMessageCount)
      };
    } catch (error) {
      console.error('AgentMode: Response generation failed:', error);
      throw new Error('Failed to generate response');
    }
  }

  async getMarketingSystemPrompt(): Promise<string> {
    // Try to get custom system prompt from settings
    try {
      const setting = await settingsService.getSetting('agent_mode_system_prompt');
      if (setting && setting.settingValue) {
        return setting.settingValue;
      }
    } catch (error) {
      console.error('Error getting custom system prompt:', error);
    }
    
    // Fallback to default system prompt
    return `You are Emma, an AI-powered assistant from AgentWeb. You help users execute marketing campaigns through natural conversation and task creation.

## Your Capabilities
You can help with various marketing tasks including:
- Market research and competitive analysis
- SWOT analysis for businesses
- Marketing strategy development
- Ad creative generation and campaign management
- Performance analysis and optimization
- Meta ads metrics analysis and insights
- Social media listening and brand monitoring
- Web search for current information and real-time data
- Analysis of attached files and documents

## File Attachments
When users attach files to their messages, you will receive:
- **Attached Files**: Clickable markdown links in the format \`[filename](url)\`
- You can reference these files by their URLs and analyze their content
- Use the file URLs to understand what the user has shared and provide relevant assistance
- **IMPORTANT**: When creating tasks that are related to the attached files, you MUST include the attachment details (URLs and filenames) in the task prompt, otherwise the task execution won't have access to the files

## HTML File Updates
When updating HTML files, follow this process:
1. **First, read the original file**: Use the \`read_file\` tool to get the complete HTML content from the file URL
2. **Analyze the content**: Review the full HTML structure to understand what needs to be modified
3. **Make targeted changes**: Update only the specific parts that need modification while preserving the rest
4. **Save as new file**: Use the \`save_file\` tool to save the updated content to a new file
5. **Never truncate or use placeholders**: Always include the complete, updated HTML content in the save_file call
6. **Preserve structure**: Maintain the original HTML structure, DOCTYPE, head, body, and styling
7. **Complete content only**: Do not use "...", "[content continues]", or any truncation indicators

## Task Creation Approach
- **IMPORTANT**: Always confirm with the user before creating any task, as tasks can take a few minutes to complete
- **Confirmation required**: Explain what the task will do and get explicit approval before proceeding
- **Primary Method**: Use the 'create_task_from_template' tool with a specific template_id and parameters_json string
- All available templates are provided in the context above - select the most appropriate one based on the user's request
- Extract the required parameters from the user's message and pass them as a JSON string where keys are parameter names and values are the actual values
- Example: {"site_url": "example.com", "business_area": "e-commerce"}
- Templates provide structured, proven approaches to common marketing tasks
- **Fallback Method**: If no suitable template is available, use 'create_task_from_prompt' to create a task with a raw prompt
- The 'create_task_from_prompt' tool allows you to create custom tasks with specific instructions when templates don't fit
 - **Image Generation**: For real-time (~30s) image generation, use 'generate_image'. For longer-running, fully tracked jobs that may take a couple of minutes, use 'create_image_task_from_prompt' to create an image generation task (ad creatives, social media images, marketing visuals).
 - **Blog Articles**: When creating blog articles, prefer using the 'create_blog_article' tool. It generates the article content, creates a high-quality hero image via imageService, formats the article into clean HTML, uploads it to S3, and returns the final HTML URL. Avoid ad-hoc content + image flows when this tool fits the request.
 - **Meta Ads Metrics**: Use 'get_meta_ads_metrics' to fetch and analyze Meta ad performance data
- When metrics data is loaded, provide contextual analysis based on the conversation history and user's business goals
- Don't just repeat the numbers - provide meaningful insights, strategic recommendations, and actionable next steps
- Consider the user's industry, business stage, and previous conversation context when analyzing performance
- Compare metrics against industry benchmarks and identify specific optimization opportunities
- If a user asks about a specific ad that doesn't appear in the metrics data, explain that the ad may be disabled, paused, or have no activity in the selected timeframe
- **Important**: You cannot pull metrics for individual ads by name - the metrics function returns all active ads in the timeframe. If a user asks for specific ad metrics, explain that you can only analyze the ads that appear in the current data set
- **Web Search**: Use 'search_web' proactively to gather current information before asking users for clarification
- **Automatic and fast**: Web search does NOT require user confirmation - use it automatically to improve your responses
- **When to search**: Before asking users for more details, search for current market data, industry trends, competitor information, or recent developments
- **Search first, ask second**: Use web search to gather background information and context before requesting additional details from users
- **Search topics include**: Market trends, industry benchmarks, competitor analysis, recent news, regulatory changes, technology updates, or any current information that would help provide better recommendations
- **Search strategy**: Use specific, targeted search queries to find the most relevant and recent information
- **Integration**: Incorporate search results into your analysis and recommendations to provide data-driven insights
- **Search result presentation**: Always provide a tailored summary of search results that directly answers the user's question
- **Synthesize findings**: Analyze and synthesize search results to provide actionable insights relevant to the user's specific needs

- **Previous Task Results**: Previous task results are automatically attached by default to provide context
- This includes the latest HTML results from previous completed tasks in the same conversation
- Set attach_previous_task_results to false only if you don't want previous results included
- **Revision Method**: Use 'create_revision' tool to revise existing completed task executions
- Supports both HTML reports and images for revision
- Provide the task_id, execution_id, and detailed revision_prompt
- Use the execution_id from the Current Task Statuses context above
- If execution has multiple results, specify target_result_name to choose which one to revise
- If multiple results exist and no target specified, the tool will return available options
- This creates a new execution with the revision instructions
- Only completed executions can be revised

## Task Execution
- When you create tasks, they will show execution status in the UI (pending, running, completed, failed)
- The tool call results will include the current status of any running tasks
- You can reference the status information provided in the tool call results
- If a user asks about task status, use the current status from the tool call results

## Communication Style
- Be helpful, professional, and conversational
- **Research before asking**: Use web search to gather current information before asking users for clarification
- **Proactive information gathering**: Search for market data, trends, and context to provide more informed recommendations
- **Data-driven approach**: Base your advice on current, real-world data rather than general knowledge
- Ask clarifying questions only after you've searched for available information
- **Web search is automatic**: Use web search proactively without asking for permission - it's fast and helps provide better answers
- **Task confirmation required**: Always explain what a task will do and ask for confirmation before creating it (tasks take time to complete)
- **Example confirmation**: "I'd like to create a market research task that will analyze your competitors and industry trends. This task may take a few minutes to complete. Would you like me to proceed?"
- Provide clear explanations of what you're doing and what information you've found
- Keep responses concise but informative
- Always confirm task creation and provide relevant details
- When using templates, explain which template was selected and why
- When analyzing metrics data, provide insights and recommendations rather than just repeating the numbers
- Focus on actionable insights and strategic guidance based on current data and conversation context
- If a user asks about a specific ad that doesn't appear in the metrics data, simply explain that the ad may be disabled, paused, or have no activity in the selected timeframe
- **Never offer to pull metrics for individual ads by name** - you can only analyze the ads that appear in the current metrics data set

## Response Formatting
Format your responses in HTML5 for direct rendering. Use:
- <strong> for important points
- <em> for emphasis
- <code> for technical terms and commands
- <ul> and <li> for lists
- <pre> for code blocks
- <a href="url" target="_blank"> for links
- <table> for structured data

Important formatting rules:
1. Use minimal spacing - no extra blank lines
2. Keep lists compact with minimal spacing
3. Use single line breaks between list items
4. Keep responses concise and well-structured
5. Always include target="_blank" for links
6. Use proper HTML5 semantic elements
7. The chat window has a fixed width of 384px. Format your responses to fit within this constraint

Use the available tools to create tasks in the agent-engine when complex work is required. Guide users through marketing flows naturally through conversation.`;
  }

  async getWelcomeMessage(): Promise<string> {
    // Try to get custom welcome message from settings
    try {
      const setting = await settingsService.getSetting('agent_mode_welcome_message');
      if (setting && setting.settingValue) {
        return setting.settingValue;
      }
    } catch (error) {
      console.error('Error getting custom welcome message:', error);
    }
    
    // Fallback to default welcome message
    return "I'm Emma, your team's new CMO 😎. I'll help you research, build, deploy, and measure Meta campaign insights in a blink of an eye.<br><br><strong>To get started, can you share your website URL?</strong>";
  }

  async getConversationStarters(): Promise<string[]> {
    // Try to get custom conversation starters from settings
    try {
      const setting = await settingsService.getSetting('agent_mode_conversation_starters');
      if (setting && setting.settingValue) {
        return JSON.parse(setting.settingValue);
      }
    } catch (error) {
      console.error('Error getting custom conversation starters:', error);
    }
    
    // Fallback to default conversation starters
    return [
      "Formulate marketing strategy for my product",
      "Create social media content calendar",
      "Develop my personal brand on Linkedin or x.com",
      "Create automated newsletter for my company"
    ];
  }

  private getStatusMessage(toolName: string, status: string): string {
    const statusEmoji: Record<string, string> = {
      'pending': '⏳',
      'running': '🔄',
      'completed': '✅',
      'failed': '❌'
    };
    const emoji = statusEmoji[status] || '⏳';

    const toolDescriptions: Record<string, string> = {
      'create_task_from_template': 'template-based task',
      'create_task_from_prompt': 'custom prompt task',
      'create_image_task_from_prompt': 'image generation task',
      'get_meta_ads_metrics': 'Meta ads metrics analysis',
      'search_web': 'web search',
      'create_revision': 'task revision',
      'save_file': 'file save'
    };

    const toolDescription = toolDescriptions[toolName] || 'task';
    
    switch (status) {
      case 'pending':
        return `${emoji} **${toolDescription}** is queued and will start shortly.`;
      case 'running':
        return `${emoji} **${toolDescription}** is currently running. This may take a few minutes.`;
      case 'completed':
        return `${emoji} **${toolDescription}** has completed successfully!`;
      case 'failed':
        return `${emoji} **${toolDescription}** failed to complete. Please check the task details for more information.`;
      default:
        return `${emoji} **${toolDescription}** status: ${status}`;
    }
  }

  private buildMarketingContext(messageContent: string, sessionHistory: ChatMessage[], currentTaskStatuses: any[] = []): any[] {
    // Build structured messages preserving roles (assume the first is system) and including tool messages
    const messages: any[] = [];
    
    // Determine slice starting at the 10th most recent user message over full history
    let userCount = 0;
    let startIdx = 1; // Assume the first message is the system message
    for (let i = sessionHistory.length - 1; i >= 0; i--) {
      if (sessionHistory[i].role === 'user') {
        userCount++;
        if (userCount === 10) {
          startIdx = i;
          break;
        }
      }
    }
    const sliced = sessionHistory.slice(startIdx);
    
    // Copy all sliced messages as-is
    for (const msg of sliced) {
      const messageObj: any = { role: msg.role, content: msg.content };
      
      // Add optional properties based on message type
      if ((msg as any).name) {
        messageObj.name = (msg as any).name;
      }
      if ((msg as any).tool_call_id) {
        messageObj.tool_call_id = (msg as any).tool_call_id;
      }
      if ((msg as any).tool_calls) {
        messageObj.tool_calls = (msg as any).tool_calls;
      }
      
      messages.push(messageObj);
    }
    
    // Insert current task statuses as an assistant message before the final user message
    const statusEmoji: Record<string, string> = {
      pending: '⏳',
      running: '🔄',
      completed: '✅',
      failed: '❌'
    };
    let statusesContent = '';
    if (currentTaskStatuses && currentTaskStatuses.length > 0) {
      statusesContent += 'Current Task Statuses:\n';
      currentTaskStatuses.forEach(task => {
        const emoji = statusEmoji[task.status] || '⏳';
        statusesContent += `${emoji} ${task.taskName} (${task.status}) - Task ID: ${task.taskId}, Execution ID: ${task.executionId}\n`;
      });
    } else {
      statusesContent = '📋 **Task Status**: No tasks have been run in this session yet.';
    }
    messages.push({ role: 'assistant', content: statusesContent });

    // Append the current user message at the end
    messages.push({ role: 'user', content: messageContent });
    
    return messages;
  }

  private buildTemplatesContext(templates: any[]): string {
    if (templates.length === 0) {
      return 'No templates are currently available.';
    }

    let context = 'Available Templates:\n\n';
    
    // Group templates by category
    const groupedTemplates: Record<string, any[]> = {};
    templates.forEach(template => {
      const category = template.category || 'General';
      if (!groupedTemplates[category]) {
        groupedTemplates[category] = [];
      }
      groupedTemplates[category].push(template);
    });

    // Build context for each category
    Object.entries(groupedTemplates).forEach(([category, categoryTemplates]) => {
      context += `## ${category}\n`;
      categoryTemplates.forEach(template => {
        context += `**${template.name}** (ID: ${template.templateId})\n`;
        context += `Description: ${template.description}\n`;
        if (template.parameters && template.parameters.length > 0) {
          const paramNames = template.parameters.map((p: any) => typeof p === 'string' ? p : p.name || p.id);
          context += `Parameters: ${paramNames.join(', ')}\n`;
        }
        context += `\n`;
      });
    });

    context += `\nTo use a template, call the 'create_task_from_template' tool with the template_id and parameters_json string (JSON format where keys are parameter names and values are the actual values).`;
    
    return context;
  }

  public getAvailableTools() {
    return [
      {
        type: 'function' as const,
        function: {
          name: 'create_task_from_template',
          description: 'Create a task using a specific template with the provided parameters',
          parameters: {
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
                description: 'Whether to attach previous task results to this task. Set to true for follow-up tasks that need to reference previous work.',
                default: true
              },
              attached_file_urls: {
                type: 'array',
                items: { type: 'string' },
                description: 'Array of file URLs to attach to this task. These should be URLs from files uploaded in the current conversation.',
                default: []
              }
            },
            required: ['template_id', 'parameters_json']
          }
        }
      },
      {
        type: 'function' as const,
        function: {
          name: 'read_brand_guidelines',
          description: 'Read the current user\'s brand guidelines (brand data and attachments). Returns exists=false if not set.',
          parameters: {
            type: 'object',
            properties: {},
            required: []
          }
        }
      },
      {
        type: 'function' as const,
        function: {
          name: 'update_brand_guidelines',
          description: 'Update the user\'s brand guidelines. IMPORTANT: Use read_brand_guidelines first to fetch the latest data, then only update the fields that need to be changed. Can update both brand data and brand assets (logos, brand guides, etc.).',
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
        }
      },
      {
        type: 'function' as const,
        function: {
          name: 'read_market_strategy',
          description: 'Read the current user\'s market strategy (business overview, competitors, and ideal customer profiles). Returns exists=false if not set.',
          parameters: {
            type: 'object',
            properties: {},
            required: []
          }
        }
      },
      {
        type: 'function' as const,
        function: {
          name: 'update_market_strategy',
          description: 'Update the user\'s market strategy. IMPORTANT: Use read_market_strategy first to fetch the latest data, then only update the fields that need to be changed. Can update business overview, competitors, and ideal customer profiles.',
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
                description: 'Array of Ideal Customer Profile objects with title, description, and value proposition',
                items: {
                  type: 'object',
                  properties: {
                    title: { type: 'string', description: 'ICP title or name' },
                    description: { type: 'string', description: 'ICP description or characteristics' },
                    valueProposition: { type: 'string', description: 'Value proposition for this customer type' }
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
        type: 'function' as const,
        function: {
          name: 'create_task_from_prompt',
          description: 'Create a task using a raw prompt when no suitable template is available',
          parameters: {
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
              }
            },
            required: ['task_name', 'prompt', 'category']
          }
        }
      },
      {
        type: 'function' as const,
        function: {
          name: 'create_image_task_from_prompt',
          description: 'Create an image generation task using a raw prompt for creating visual content',
          parameters: {
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
        }
      },
      {
        type: 'function' as const,
        function: {
          name: 'get_meta_ads_metrics',
          description: 'Get Meta ad performance metrics and campaign data',
          parameters: {
            type: 'object',
            properties: {
              timeframe: {
                type: 'string',
                description: 'Time period for metrics (7d, 14d, 30d, 90d)',
                enum: ['7d', '14d', '30d', '90d'],
                default: '7d'
              }
            },
            required: []
          }
        }
      },
      {
        type: 'function' as const,
        function: {
          name: 'create_revision',
          description: 'Create a revision of an existing completed task execution (supports both reports and images)',
          parameters: {
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
        }
      },
      {
        type: 'function' as const,
        function: {
          name: 'search_web',
          description: 'Search the web for current information when you need up-to-date data or real-time information',
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
        type: 'function' as const,
        function: {
          name: 'save_file',
          description: 'Create and save a file with the provided content to S3, then return the file URL for sharing or reference',
          parameters: {
            type: 'object',
            properties: {
              file_name: {
                type: 'string',
                description: 'Name of the file to create (include appropriate extension like .txt, .md, .json, .csv, etc.)'
              },
              file_content: {
                type: 'string',
                description: 'Content of the file to save.'
              }
            },
            required: ['file_name', 'file_content']
          }
        }
      },
      {
        type: 'function' as const,
        function: {
          name: 'read_file_content',
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
        type: 'function' as const,
        function: {
          name: 'read_page_source',
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
          type: 'function' as const,
          function: {
            name: 'generate_image',
            description: 'Generate or edit images using AI image generation models. Supports both text-to-image generation and image editing with input images.',
            parameters: {
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
                  description: 'Image size in pixels (1024x1024, 1536x1024, 1024x1536, or auto)',
                  enum: ['1024x1024', '1536x1024', '1024x1536', 'auto'],
                  default: '1024x1024'
                },
                quality: {
                  type: 'string',
                  description: 'Image quality setting (low, medium, high, or auto)',
                  enum: ['low', 'medium', 'high', 'auto'],
                  default: 'medium'
                },
                inputImages: {
                  type: 'array',
                  description: 'List of input image URLs to use for image editing. Leave empty for text-to-image generation.',
                  items: {
                    type: 'string'
                  }
                }
              },
              required: ['prompt', 'filename']
            }
          }
        },
      {
        type: 'function' as const,
        function: {
          name: 'create_blog_article',
          description: 'Create a complete blog article with content, images, and HTML file. Generates blog content using AI, creates a hero image, and produces a complete HTML file uploaded to S3.',
          parameters: {
            type: 'object',
            properties: {
              topic: {
                type: 'string',
                description: 'The main topic or subject of the blog article'
              },
              keywords: {
                type: 'string',
                description: 'Comma-separated keywords to include in the article for SEO',
                default: ''
              },
              tone: {
                type: 'string',
                description: 'The tone of voice for the article',
                enum: ['professional', 'casual', 'friendly', 'authoritative', 'conversational'],
                default: 'professional'
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
                }
            },
            required: ['topic']
          }
        }
      }
    ];
  }

  // Extract only the necessary data for the frontend to reduce storage size
  private extractMinimalToolResult(result: any, toolName: string): any {
    // For task creation tools, only keep the essential fields for TaskExecutionStatus
    if (toolName === 'create_task_from_template' || toolName === 'create_task_from_prompt' || toolName === 'create_image_task_from_prompt') {
      return {
        taskId: result.taskId,
        executionId: result.executionId,
        status: result.status || 'pending',
        message: result.message || 'Task created'
      };
    }
    
    // For image generation, return the essential fields
    if (toolName === 'generate_image') {
      return {
        success: result.success,
        message: result.message,
        imageUrl: result.imageUrl,
        filename: result.filename
      };
    }
    
    // For other tools, return empty object to minimize storage
    return {};
  }

  private getMockToolResult(toolName: string, args: any): any {
    // Return realistic mock data for different tool types
    switch (toolName) {
      case 'create_task_from_template':
        return {
          success: true,
          taskId: `mock-task-${Date.now()}`,
          message: `Mock task created from template ${args.template_id}`,
          status: 'created'
        };
      
      case 'create_task_from_prompt':
        return {
          success: true,
          taskId: `mock-task-${Date.now()}`,
          message: `Mock task created: ${args.task_name}`,
          status: 'created'
        };
      
      case 'create_image_task_from_prompt':
        return {
          success: true,
          taskId: `mock-image-task-${Date.now()}`,
          message: `Mock image task created: ${args.task_name}`,
          status: 'created'
        };
      
      case 'generate_image':
        return {
          success: true,
          message: `Mock image "${args.filename}" generated successfully!`,
          imageUrl: `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==`,
          filename: args.filename
        };
      
      case 'get_meta_ads_metrics':
        // Calculate attribution window based on timeframe
        const timeframe = args.timeframe || '7d';
        const now = new Date();
        const endDate = new Date(now);
        let startDate = new Date(now);
        let days = 7;
        
        // Parse timeframe - only valid values are 7d, 14d, 30d, 90d
        switch (timeframe) {
          case '7d':
            days = 7;
            startDate.setDate(now.getDate() - 7);
            break;
          case '14d':
            days = 14;
            startDate.setDate(now.getDate() - 14);
            break;
          case '30d':
            days = 30;
            startDate.setDate(now.getDate() - 30);
            break;
          case '90d':
            days = 90;
            startDate.setDate(now.getDate() - 90);
            break;
          default:
            // Fallback to 7d if invalid timeframe provided
            days = 7;
            startDate.setDate(now.getDate() - 7);
            break;
        }
        
        // Format dates as YYYY-MM-DD
        const formatDate = (date: Date) => date.toISOString().split('T')[0];
        
        return {
          success: true,
          data: {
            attributionWindow: {
              start: formatDate(startDate),
              end: formatDate(endDate),
              days: days
            },
            campaignSummary: {
              totalCampaigns: 3,
              totalSpend: 1250.75,
              totalImpressions: 125000,
              totalClicks: 4500,
              averageCtr: 3.6,
              averageCpc: 0.28,
              totalWebsiteLeads: 23,
              averageCostPerWebsiteLead: 54.38
            },
            adPerformance: [
              {
                name: 'Holiday Campaign 2023',
                spend: 750.25,
                impressions: 75000,
                clicks: 2700,
                ctr: 3.6,
                cpc: 0.28,
                websiteLeads: 14,
                costPerWebsiteLead: 53.59
              },
              {
                name: 'Brand Awareness Campaign',
                spend: 350.50,
                impressions: 35000,
                clicks: 1260,
                ctr: 3.6,
                cpc: 0.28,
                websiteLeads: 6,
                costPerWebsiteLead: 58.42
              },
              {
                name: 'Retargeting Campaign',
                spend: 150.00,
                impressions: 15000,
                clicks: 540,
                ctr: 3.6,
                cpc: 0.28,
                websiteLeads: 3,
                costPerWebsiteLead: 50.00
              }
            ],
            adSetsData: [
              {
                name: 'Holiday - Lookalike Audience',
                campaignName: 'Holiday Campaign 2023',
                spend: 450.15,
                impressions: 45000,
                clicks: 1620,
                ctr: 3.6,
                cpc: 0.28,
                websiteLeads: 8,
                costPerWebsiteLead: 56.27
              },
              {
                name: 'Holiday - Interest Targeting',
                campaignName: 'Holiday Campaign 2023',
                spend: 300.10,
                impressions: 30000,
                clicks: 1080,
                ctr: 3.6,
                cpc: 0.28,
                websiteLeads: 6,
                costPerWebsiteLead: 50.02
              },
              {
                name: 'Brand - Broad Targeting',
                campaignName: 'Brand Awareness Campaign',
                spend: 350.50,
                impressions: 35000,
                clicks: 1260,
                ctr: 3.6,
                cpc: 0.28,
                websiteLeads: 6,
                costPerWebsiteLead: 58.42
              },
              {
                name: 'Retargeting - Website Visitors',
                campaignName: 'Retargeting Campaign',
                spend: 150.00,
                impressions: 15000,
                clicks: 540,
                ctr: 3.6,
                cpc: 0.28,
                websiteLeads: 3,
                costPerWebsiteLead: 50.00
              }
            ],
            adsData: [
              {
                name: 'Holiday Sale - Creative A',
                adSetName: 'Holiday - Lookalike Audience',
                campaignName: 'Holiday Campaign 2023',
                spend: 225.08,
                impressions: 22500,
                clicks: 810,
                ctr: 3.6,
                cpc: 0.28,
                websiteLeads: 4,
                costPerWebsiteLead: 56.27
              },
              {
                name: 'Holiday Sale - Creative B',
                adSetName: 'Holiday - Lookalike Audience',
                campaignName: 'Holiday Campaign 2023',
                spend: 225.07,
                impressions: 22500,
                clicks: 810,
                ctr: 3.6,
                cpc: 0.28,
                websiteLeads: 4,
                costPerWebsiteLead: 56.27
              },
              {
                name: 'Brand Awareness - Video',
                adSetName: 'Brand - Broad Targeting',
                campaignName: 'Brand Awareness Campaign',
                spend: 350.50,
                impressions: 35000,
                clicks: 1260,
                ctr: 3.6,
                cpc: 0.28,
                websiteLeads: 6,
                costPerWebsiteLead: 58.42
              },
              {
                name: 'Retargeting - Special Offer',
                adSetName: 'Retargeting - Website Visitors',
                campaignName: 'Retargeting Campaign',
                spend: 150.00,
                impressions: 15000,
                clicks: 540,
                ctr: 3.6,
                cpc: 0.28,
                websiteLeads: 3,
                costPerWebsiteLead: 50.00
              }
            ],
            demographicsBreakdown: [
              { age: '25-34', gender: 'female', impressions: '45000', clicks: '1620', spend: '450.15', websiteLeads: '8' },
              { age: '35-44', gender: 'male', impressions: '35000', clicks: '1260', spend: '350.10', websiteLeads: '6' },
              { age: '25-34', gender: 'male', impressions: '30000', clicks: '1080', spend: '300.10', websiteLeads: '5' },
              { age: '45-54', gender: 'female', impressions: '15000', clicks: '540', spend: '150.40', websiteLeads: '4' }
            ],
            placementBreakdown: [
              { publisher_platform: 'facebook', platform_position: 'feed', impressions: '75000', clicks: '2700', spend: '750.25', websiteLeads: '14' },
              { publisher_platform: 'instagram', platform_position: 'feed', impressions: '35000', clicks: '1260', spend: '350.50', websiteLeads: '6' },
              { publisher_platform: 'facebook', platform_position: 'stories', impressions: '15000', clicks: '540', spend: '150.00', websiteLeads: '3' }
            ],
            deviceBreakdown: [
              { device_platform: 'mobile', impressions: '80000', clicks: '2880', spend: '800.40', websiteLeads: '15' },
              { device_platform: 'desktop', impressions: '30000', clicks: '1080', spend: '300.20', websiteLeads: '6' },
              { device_platform: 'tablet', impressions: '15000', clicks: '540', spend: '150.15', websiteLeads: '2' }
            ]
          },
          timeframe: args.timeframe || '7d'
        };
      
      case 'search_web':
        return {
          success: true,
          results: [
            {
              title: `Mock search result for "${args.query}"`,
              url: 'https://example.com/mock-result-1',
              snippet: 'This is a mock search result snippet that would contain relevant information.'
            },
            {
              title: `Another mock result for "${args.query}"`,
              url: 'https://example.com/mock-result-2',
              snippet: 'Another mock search result with different information.'
            }
          ]
        };
      
      case 'read_brand_guidelines':
        return {
          success: true,
          exists: true,
          brandData: {
            brandName: 'Mock Brand',
            tagline: 'Mock tagline for testing',
            primaryColor: '#FF6B6B',
            toneOfVoice: 'Professional and friendly'
          },
          brandAssets: []
        };
      
      case 'update_brand_guidelines':
        return {
          success: true,
          message: 'Mock brand guidelines updated successfully'
        };
      
      case 'read_market_strategy':
        return {
          success: true,
          exists: true,
          businessOverview: 'Mock business overview for testing purposes',
          competitors: [
            { name: 'Mock Competitor 1', description: 'A mock competitor description' }
          ],
          icp: [
            { title: 'Mock ICP', description: 'Mock ideal customer profile', valueProposition: 'Mock value prop' }
          ]
        };
      
      case 'update_market_strategy':
        return {
          success: true,
          message: 'Mock market strategy updated successfully'
        };
      
      case 'create_revision':
        return {
          success: true,
          revisionId: `mock-revision-${Date.now()}`,
          message: 'Mock revision created successfully'
        };
      
      case 'save_file':
        return {
          success: true,
          message: `File "${args.file_name}" has been saved successfully.`,
          file_url: `https://agentweb-files.s3.us-east-1.amazonaws.com/files/${Date.now()}-${args.file_name}`,
          file_name: args.file_name,
          file_size: args.file_content.length
        };
      
      case 'read_file_content':
        return {
          success: true,
          content: `Mock file content for ${args.file_url}. This would be the actual content of the file in a real scenario.`,
          filename: 'mock-file.txt'
        };
      
      case 'read_page_source':
        return {
          success: true,
          content: `Mock page source for ${args.url}. This would be the actual HTML source of the webpage in a real scenario.`,
          file_type: 'html',
          file_url: args.url
        };
      
      default:
        return {
          success: true,
          message: `Mock result for unknown tool: ${toolName}`,
          data: args
        };
    }
  }

  private async executeTool(toolName: string, args: any, userId: string, sessionId: string, mockMode: boolean = false): Promise<any> {
    const argsStr = JSON.stringify(args, null, 2);
    const truncatedArgs = argsStr.length > 500 ? argsStr.substring(0, 500) + '...' : argsStr;
    
    // Return mock data if in mock mode
    if (mockMode) {
      return this.getMockToolResult(toolName, args);
    }
    
    switch (toolName) {
      case 'create_task_from_template':
        try {
          const parameters = JSON.parse(args.parameters_json || '{}');
          const attachPreviousTaskResults = args.attach_previous_task_results !== false;
          const attachedFileUrls = args.attached_file_urls || [];
          return await this.createTaskFromTemplate(args.template_id, parameters, userId, sessionId, attachPreviousTaskResults, attachedFileUrls);
        } catch (parseError) {
          console.error('AgentMode: Error parsing parameters JSON:', parseError);
          return {
            success: false,
            message: 'Invalid parameters JSON format. Please provide a valid JSON string.',
            status: 'invalid_json'
          };
        }
      case 'create_task_from_prompt':
        const attachPreviousTaskResults = args.attach_previous_task_results !== false;
        const attachedFileUrls = args.attached_file_urls || [];
        return await this.createTaskFromPrompt(args.task_name, args.prompt, args.category, userId, sessionId, attachPreviousTaskResults, attachedFileUrls);
      case 'create_image_task_from_prompt':
        const attachPreviousTaskResultsForImage = args.attach_previous_task_results !== false;
        return await this.createImageTaskFromPrompt(args.task_name, args.prompt, args.category || 'Creatives', userId, sessionId, attachPreviousTaskResultsForImage);
      case 'get_meta_ads_metrics':
        return await this.getMetaAdsMetrics(args.timeframe || '7d', userId);
      case 'create_revision':
        return await this.createRevision(args.task_id, args.execution_id, args.revision_prompt, userId, args.target_result_name);
      case 'search_web':
        return await this.searchWeb(args.query, args.max_results || 10);
      case 'read_brand_guidelines':
        return await this.readBrandGuidelines(userId);
      case 'update_brand_guidelines':
        return await this.updateBrandGuidelines(args, userId);
      case 'read_market_strategy':
        return await this.readMarketStrategy(userId);
      case 'update_market_strategy':
        return await this.updateMarketStrategy(args, userId);
      case 'save_file':
        return await this.saveFile(args.file_name, args.file_content, userId, sessionId);
      case 'read_file_content':
        return await this.readFileContent(args.file_url);
      case 'read_page_source':
        return await this.readFileContent(args.url);
      case 'generate_image':
        return await this.generateImage(args.prompt, args.filename, args.size || '1024x1024', args.quality || 'medium', args.inputImages || [], userId, sessionId);
        case 'create_blog_article':
          return await this.createBlogArticle(args.topic, args.keywords || '', args.tone || 'professional', args.length || 'medium', args.researchContext || '', args.requirements || '', userId, sessionId);
      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  }

  private async getPreviousTaskResults(userId: string, sessionId: string): Promise<string> {
    try {
      // Get the current conversation to find previous task executions
      const session = await chatbotDb.getChatSession(sessionId);
      if (!session || !session.messages) {
        return '';
      }

      // Extract task IDs from previous tool calls in this conversation
      const taskIds = new Set<string>();
      session.messages.forEach((message: ChatMessage) => {
        if (message.metadata?.toolCalls) {
          message.metadata.toolCalls.forEach((toolCall: any) => {
            if (toolCall.name === 'create_task_from_template' || toolCall.name === 'create_task_from_prompt' || toolCall.name === 'create_image_task_from_prompt') {
              if (toolCall.result?.taskId) {
                taskIds.add(toolCall.result.taskId);
              }
            }
          });
        }
      });

      if (taskIds.size === 0) {
        return '';
      }

      // Get executions for each specific task
      const completedExecutions: any[] = [];
      
      for (const taskId of taskIds) {
        const taskExecutions = await taskDb.getTaskExecutions(taskId);
        if (taskExecutions && taskExecutions.length > 0) {
          // Find the latest completed execution with HTML results
          const latestCompleted = taskExecutions
            .filter(execution => 
              execution.status === 'completed' && 
              execution.result_files && 
              execution.result_files.length > 0
            )
            .sort((a, b) => new Date(b.createdAt || b.startTime).getTime() - new Date(a.createdAt || a.startTime).getTime())[0];
          
          if (latestCompleted) {
            // Fetch task details to get the task name
            const task = await taskDb.getTaskById(taskId);
            if (task) {
              latestCompleted.taskName = task.name;
            }
            completedExecutions.push(latestCompleted);
          }
        }
      }

      if (completedExecutions.length === 0) {
        return '';
      }

      // Build context with HTML result URLs
      let context = '\n\n## Previous Task Results\n';
      context += 'The following are results from your previous completed tasks that you can reference:\n\n';

      completedExecutions.forEach(execution => {
        const htmlFiles = execution.result_files.filter((file: any) => 
          file.is_html || file.view_type === 'html' || file.filename.toLowerCase().endsWith('.html')
        );
        
        if (htmlFiles.length > 0) {
          context += `**Task ${execution.taskId}** (${execution.taskName || 'Unknown Task'}):\n`;
          htmlFiles.forEach((file: any) => {
            context += `- Result: ${file.url}\n`;
          });
          context += '\n';
        }
      });

      return context;
    } catch (error) {
      console.error('Error fetching previous task results:', error);
      return '';
    }
  }

  // Read current user's brand guidelines
  private async readBrandGuidelines(userId: string): Promise<any> {
    try {
      const { userDb } = await import('./db');
      const user = await userDb.getUserById(userId);
      if (!user) {
        return { 
          success: false, 
          message: 'User not found', 
          exists: false,
          error: 'User not found'
        };
      }

      const brand = user.brandGuidelines;
      if (!brand) {
        return { 
          success: true, 
          exists: false, 
          message: 'No brand guidelines found',
          brandData: {},
          attachments: []
        };
      }

      // Format the brand guidelines for LLM consumption
      const formattedContent = this.formatBrandGuidelines({
        exists: true,
        brandData: brand.brandData || {},
        attachments: brand.attachments || []
      });

      // Return structured response similar to web_search
      return {
        success: true,
        message: `Brand guidelines retrieved successfully`,
        exists: true,
        brandData: brand.brandData || {},
        attachments: brand.attachments || [],
        createdAt: brand.createdAt,
        updatedAt: brand.updatedAt,
        formattedContent
      };
    } catch (error) {
      console.error('AgentMode: Error reading brand guidelines:', error);
      return { 
        success: false, 
        message: 'Failed to read brand guidelines',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  // Read current user's market strategy
  private async readMarketStrategy(userId: string): Promise<any> {
    try {
      const { userDb } = await import('./db');
      const user = await userDb.getUserById(userId);
      if (!user) {
        return { 
          success: false, 
          message: 'User not found', 
          exists: false,
          error: 'User not found'
        };
      }

      const marketStrategy = user.marketStrategy;
      if (!marketStrategy) {
        return { 
          success: true, 
          exists: false, 
          message: 'No market strategy found',
          marketData: {
            businessOverview: '',
            competitors: [],
            icp: []
          }
        };
      }

      // Format the market strategy for LLM consumption
      const formattedContent = this.formatMarketStrategy({
        exists: true,
        marketData: marketStrategy
      });

      // Return structured response similar to readBrandGuidelines
      return {
        success: true,
        message: `Market strategy retrieved successfully`,
        exists: true,
        marketData: marketStrategy,
        createdAt: marketStrategy.createdAt,
        updatedAt: marketStrategy.updatedAt,
        formattedContent
      };
    } catch (error) {
      console.error('AgentMode: Error reading market strategy:', error);
      return { 
        success: false, 
        message: 'Failed to read market strategy',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  // Update user's market strategy
  private async updateMarketStrategy(updateData: any, userId: string): Promise<any> {
    try {
      const { userDb } = await import('./db');
      const user = await userDb.getUserById(userId);
      if (!user) {
        return {
          success: false,
          message: 'User not found',
          error: 'User not found'
        };
      }

      // Get existing market strategy
      const existingMarketStrategy = user.marketStrategy;
      
      // Extract market strategy fields from updateData
      const { businessOverview, competitors, icp, ...otherFields } = updateData;
      
      // Merge competitors by name - preserve existing entries, update or add new ones
      let mergedCompetitors = [...(existingMarketStrategy?.competitors || [])];
      if (competitors !== undefined && Array.isArray(competitors)) {
        competitors.forEach(newCompetitor => {
          const existingIndex = mergedCompetitors.findIndex(existing => 
            existing.name === newCompetitor.name
          );
          if (existingIndex >= 0) {
            // Update existing competitor
            mergedCompetitors[existingIndex] = {
              ...mergedCompetitors[existingIndex],
              ...newCompetitor
            };
          } else {
            // Add new competitor
            mergedCompetitors.push(newCompetitor);
          }
        });
      }
      
      // Merge ICPs by title - preserve existing entries, update or add new ones
      let mergedICP = [...(existingMarketStrategy?.icp || [])];
      if (icp !== undefined && Array.isArray(icp)) {
        icp.forEach(newICP => {
          const existingIndex = mergedICP.findIndex(existing => 
            existing.title === newICP.title
          );
          if (existingIndex >= 0) {
            // Update existing ICP
            mergedICP[existingIndex] = {
              ...mergedICP[existingIndex],
              ...newICP
            };
          } else {
            // Add new ICP
            mergedICP.push(newICP);
          }
        });
      }
      
      // Prepare market strategy data - merge with existing if available
      const marketStrategyData = {
        businessOverview: businessOverview !== undefined ? businessOverview : (existingMarketStrategy?.businessOverview || ''),
        competitors: mergedCompetitors,
        icp: mergedICP,
        createdAt: existingMarketStrategy?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      // Update user record with market strategy data
      await userDb.updateUser(userId, {
        marketStrategy: marketStrategyData
      });

      // Track what was updated vs added
      const updatedEntries: string[] = [];
      const addedEntries: string[] = [];
      
      if (competitors !== undefined && Array.isArray(competitors)) {
        competitors.forEach(competitor => {
          const wasExisting = existingMarketStrategy?.competitors?.some((existing: any) => 
            existing.name === competitor.name
          );
          if (wasExisting) {
            updatedEntries.push(`Competitor: ${competitor.name}`);
          } else {
            addedEntries.push(`Competitor: ${competitor.name}`);
          }
        });
      }
      
      if (icp !== undefined && Array.isArray(icp)) {
        icp.forEach(profile => {
          const wasExisting = existingMarketStrategy?.icp?.some((existing: any) => 
            existing.title === profile.title
          );
          if (wasExisting) {
            updatedEntries.push(`ICP: ${profile.title}`);
          } else {
            addedEntries.push(`ICP: ${profile.title}`);
          }
        });
      }

      // Format the update result for LLM consumption
      const formattedContent = this.formatMarketStrategyUpdate({
        success: true,
        message: 'Market strategy updated successfully',
        marketData: marketStrategyData,
        updatedFields: Object.keys(updateData).filter(key => updateData[key] !== undefined),
        updatedEntries,
        addedEntries,
        totalCompetitors: mergedCompetitors.length,
        totalICPs: mergedICP.length
      });

      return {
        success: true,
        message: 'Market strategy updated successfully',
        marketData: marketStrategyData,
        updatedFields: Object.keys(updateData).filter(key => updateData[key] !== undefined),
        updatedEntries,
        addedEntries,
        totalCompetitors: mergedCompetitors.length,
        totalICPs: mergedICP.length,
        formattedContent
      };
    } catch (error) {
      console.error('AgentMode: Error updating market strategy:', error);
      return {
        success: false,
        message: 'Failed to update market strategy',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  // Update user's brand guidelines (supports both brandData and attachments)
  private async updateBrandGuidelines(updateData: any, userId: string): Promise<any> {
    try {
      const { userDb } = await import('./db');
      const user = await userDb.getUserById(userId);
      if (!user) {
        return {
          success: false,
          message: 'User not found',
          error: 'User not found'
        };
      }

      // Get existing brand guidelines
      const existingBrand = user.brandGuidelines;
      if (!existingBrand) {
        return {
          success: false,
          message: 'No existing brand guidelines found. Please create brand guidelines first.',
          error: 'No existing brand guidelines'
        };
      }

      // Extract brandData and brandAssets from updateData
      const { brandData, brandAssets, ...otherFields } = updateData;
      
      // Merge with existing brandData - only update provided fields
      const updatedBrandData = {
        ...existingBrand.brandData,
        ...brandData
      } as any;

      // Special merge logic for founder profiles (merge by normalized founder name)
      if (brandData && Array.isArray((brandData as any).founders)) {
        const normalize = (name: any) =>
          typeof name === 'string' ? name.trim().toLowerCase() : '';

        const existingFounders: any[] = Array.isArray((existingBrand.brandData as any)?.founders)
          ? (existingBrand.brandData as any).founders
          : [];
        const incomingFounders: any[] = (brandData as any).founders || [];

        const mergedFounders: any[] = [...existingFounders];
        for (const newFounder of incomingFounders) {
          if (!newFounder || !newFounder.name) continue;
          const key = normalize(newFounder.name);
          if (!key) continue;

          const idx = mergedFounders.findIndex(
            f => f && normalize(f.name) === key
          );
          if (idx >= 0) {
            // Replace the entire object for that founder name
            mergedFounders[idx] = newFounder;
          } else {
            // Append as new founder
            mergedFounders.push(newFounder);
          }
        }

        // Assign the merged array back
        updatedBrandData.founders = mergedFounders;
      }

      // Handle brandAssets update - merge by type to preserve existing assets
      let updatedAttachments = [...(existingBrand.attachments || [])];
      const updatedAssets: any[] = []; // Track which assets were actually updated
      
      if (brandAssets !== undefined) {
        if (Array.isArray(brandAssets)) {
          // Merge by type: replace assets of the same type, keep others
          brandAssets.forEach(newAsset => {
            const existingIndex = updatedAttachments.findIndex(existing => existing.type === newAsset.type);
            if (existingIndex >= 0) {
              // Replace existing asset of the same type
              updatedAttachments[existingIndex] = newAsset;
              updatedAssets.push(newAsset); // Track as updated
            } else {
              // Add new asset type
              updatedAttachments.push(newAsset);
              updatedAssets.push(newAsset); // Track as added
            }
          });
        } else if (typeof brandAssets === 'object' && brandAssets !== null) {
          // Single asset - merge by type
          const existingIndex = updatedAttachments.findIndex(existing => existing.type === brandAssets.type);
          if (existingIndex >= 0) {
            // Replace existing asset of the same type
            updatedAttachments[existingIndex] = brandAssets;
            updatedAssets.push(brandAssets); // Track as updated
          } else {
            // Add new asset type
            updatedAttachments.push(brandAssets);
            updatedAssets.push(brandAssets); // Track as added
          }
        }
      }

      // Update the user's brand guidelines
      await userDb.updateUser(userId, {
        brandGuidelines: {
          ...existingBrand,
          brandData: updatedBrandData,
          attachments: updatedAttachments,
          updatedAt: new Date().toISOString()
        }
      });

      const updatedFields = [];
      if (brandData) updatedFields.push(...Object.keys(brandData));
      if (brandAssets !== undefined) updatedFields.push('brandAssets');
      updatedFields.push(...Object.keys(otherFields));

      // Format the update result for LLM consumption
      const formattedContent = this.formatBrandGuidelinesUpdate({
        success: true,
        message: 'Brand guidelines updated successfully',
        updatedFields,
        brandData: updatedBrandData,
        attachments: updatedAttachments,
        updatedAssets: updatedAssets
      });

      return {
        success: true,
        message: 'Brand guidelines updated successfully',
        updatedFields,
        brandData: updatedBrandData,
        attachments: updatedAttachments,
        updatedAssets: updatedAssets, // Only the assets that were actually updated
        formattedContent
      };
    } catch (error) {
      console.error('AgentMode: Error updating brand guidelines:', error);
      return {
        success: false,
        message: 'Failed to update brand guidelines',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  private getCurrentTaskStatusesInSession(sessionHistory: ChatMessage[]): any[] {
    try {
      const taskStatuses: any[] = [];
      
      // Extract task statuses from session history
      sessionHistory.forEach(message => {
        if (message.metadata?.toolCalls) {
          message.metadata.toolCalls.forEach((toolCall: any) => {
            // Check if this is a task creation tool call
            if ((toolCall.name === 'create_task_from_template' || toolCall.name === 'create_task_from_prompt' || toolCall.name === 'create_image_task_from_prompt') && toolCall.result) {
              const result = toolCall.result;
              if (result.taskId && result.executionId) {
                taskStatuses.push({
                  taskId: result.taskId,
                  executionId: result.executionId,
                  taskName: result.taskName || `Task ${result.taskId}`,
                  status: result.status || 'pending',
                  createdAt: new Date().toISOString()
                });
              }
            }
          });
        }
      });
      
      // Remove duplicates and return unique task statuses
      const uniqueTaskStatuses = new Map();
      taskStatuses.forEach(task => {
        const key = `${task.taskId}-${task.executionId}`;
        if (!uniqueTaskStatuses.has(key)) {
          uniqueTaskStatuses.set(key, task);
        }
      });
      
      return Array.from(uniqueTaskStatuses.values());
    } catch (error) {
      console.error('AgentMode: Error getting task statuses from session:', error);
      return [];
    }
  }

  private async getCurrentTaskStatuses(userId: string): Promise<any[]> {
    try {
      // Get recent task executions for this user
      const allExecutions = await taskDb.getAllTaskExecutionsByUserId(userId);
      // Get the 10 most recent executions
      const recentExecutions = (allExecutions || [])
        .sort((a, b) => new Date(b.createdAt || b.startTime).getTime() - new Date(a.createdAt || a.startTime).getTime())
        .slice(0, 10);
      
      return recentExecutions.map(execution => ({
        taskId: execution.taskId,
        executionId: execution.executionId,
        status: execution.status,
        taskName: execution.taskName || 'Unknown Task',
        createdAt: execution.createdAt || execution.startTime
      }));
    } catch (error) {
      console.error('Error fetching current task statuses:', error);
      return [];
    }
  }

  // Get available templates
  private async getAvailableTemplates(): Promise<any[]> {
    try {
      const templates = await taskTemplateDb.getPublishedTemplates();
      return templates
        .filter(template => {
          // Only include templates with valid categories
          const category = template.category;
          return category && category.trim() !== '';
        })
        .map(template => ({
          templateId: template.templateId,
          name: template.name,
          description: template.description,
          category: template.category,
          parameters: template.parameters || [],
          promptTemplate: template.prompt,
          isDeepResearch: template.isDeepResearch,
          isComplexTask: template.isComplexTask,
          outputAsJson: template.outputAsJson,
          outputAsHtml: template.outputAsHtml,
          selectedLLMs: template.selectedLLMs,
          useSharedBrowser: template.useSharedBrowser,
          turnOffHeadless: template.turnOffHeadless
        }));
    } catch (error) {
      console.error('Error fetching templates:', error);
      return [];
    }
  }



  // Helper method to convert file URLs to TaskAttachment objects
  private convertUrlsToAttachments(fileUrls: string[]): any[] {
    return fileUrls.map(url => {
      // Extract filename from URL (last part after the last slash)
      const filename = url.split('/').pop() || 'unknown_file';
      return {
        url: url,
        key: url, // Use URL as key for now
        filename: filename,
        uploadedAt: new Date().toISOString()
      };
    });
  }

  // Create task from template
  private async createTaskFromTemplate(templateId: string, parameters: Record<string, string>, userId: string, sessionId: string, attachPreviousTaskResults: boolean = true, attachedFileUrls: string[] = []): Promise<any> {
    try {

      // Validate parameters
      if (!parameters || typeof parameters !== 'object') {
        return {
          success: false,
          message: 'Invalid parameters provided. Parameters must be a dictionary with parameter IDs as keys.',
          status: 'invalid_parameters'
        };
      }

      // Load specific template by ID
      const template = await taskTemplateDb.getTemplateById(templateId);
      if (!template) {
        return {
          success: false,
          message: 'Template not found. Please check the template ID and try again.',
          status: 'template_not_found'
        };
      }

      // Check if user has access to the template (either owns it or it's published)
      if (template.userId !== userId && !template.published) {
        return {
          success: false,
          message: 'You do not have access to this template.',
          status: 'access_denied'
        };
      }


      // Map template to the expected format
      const templateData = {
        templateId: template.templateId,
        name: template.name,
        description: template.description,
        category: template.category,
        parameters: template.parameters || [],
        promptTemplate: template.prompt,
        isInteractive: template.isInteractive,
        isDeepResearch: template.isDeepResearch,
        isComplexTask: template.isComplexTask,
        outputAsJson: template.outputAsJson,
        outputAsHtml: template.outputAsHtml,
        selectedLLMs: template.selectedLLMs,
        useSharedBrowser: template.useSharedBrowser,
        turnOffHeadless: template.turnOffHeadless,
        nameParameter: template.nameParameter
      };

      // Check if required parameters are missing
      const missingRequired = (templateData.parameters || [])
        .filter((p: any) => {
          const paramName = typeof p === 'string' ? p : p.name || p.id;
          return !parameters[paramName];
        })
        .map((p: any) => typeof p === 'string' ? p : p.name || p.id);

      if (missingRequired.length > 0) {
        return {
          success: false,
          message: `I need more information to create this task. Please provide the following required details: ${missingRequired.join(', ')}`,
          status: 'missing_parameters',
          missingParameters: missingRequired
        };
      }

      // Generate final prompt by replacing parameters in template
      let finalPrompt = templateData.promptTemplate;
      if (templateData.parameters && templateData.parameters.length > 0) {
        templateData.parameters.forEach((param: any) => {
          // Use the parameter name directly as the key
          const paramName = typeof param === 'string' ? param : param.name || param.id;
          const value = parameters[paramName] || `[${paramName}]`;
          finalPrompt = finalPrompt?.replace(
            new RegExp(`\\[${paramName}\\]`, 'g'),
            value
          );
        });
      }

      // Attach previous task results if requested
      if (attachPreviousTaskResults) {
        const previousResults = await this.getPreviousTaskResults(userId, sessionId);
        if (previousResults) {
          finalPrompt += previousResults;
        }
      }

      // Generate task name
      let taskName = templateData.name;
      if (templateData.nameParameter && parameters[templateData.nameParameter]) {
        taskName = `${templateData.name} - ${parameters[templateData.nameParameter]}`;
      }

      // Convert file URLs to attachments
      const attachments = this.convertUrlsToAttachments(attachedFileUrls);

      // Create task using template
      const task = {
        taskId: Date.now().toString(),
        userId,
        name: taskName,
        prompt: finalPrompt,
        status: 'active',
        emailNotification: templateData.isDeepResearch || false,
        isInteractive: templateData.isInteractive || false,
        isDeepResearch: templateData.isDeepResearch || false,
        isComplexTask: templateData.isComplexTask || false,
        extractPageContent: false,
        outputAsJson: templateData.outputAsJson || false,
        outputAsHtml: templateData.outputAsHtml || false,
        selectedLLMs: templateData.selectedLLMs || undefined,
        useSharedBrowser: templateData.useSharedBrowser || false,
        turnOffHeadless: templateData.turnOffHeadless || true,
        useKnowledgeBase: false,
        updateKnowledgeBase: false,
        updateLeadList: false,
        createVideo: false,
        videoModel: undefined,
        imageModel: undefined,
        category: templateData.category || 'General',
        description: templateData.description,
        templateId: templateData.templateId,
        parameterValues: parameters,
        attachments: attachments,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      // Save task to database
      await taskDb.createTask(task);

      // Create task execution
      const execution = await taskDb.createTaskExecution({
        executionId: Date.now().toString(),
        taskId: task.taskId,
        userId: userId,
        status: 'pending',
        startTime: new Date().toISOString()
      });


      return {
        success: true,
        message: `Task "${taskName}" has been created successfully using the ${templateData.name} template. The task will start running shortly.`,
        status: 'pending',
        taskId: task.taskId,
        executionId: execution?.executionId,
        templateName: templateData.name,
        taskName: taskName
      };
    } catch (error) {
      console.error('AgentMode: Error creating task from template:', error);
      return {
        success: false,
        message: 'Failed to create task from template. Please try again.',
        status: 'error'
      };
    }
  }

  // Create task from raw prompt
  private async createTaskFromPrompt(taskName: string, prompt: string, category: string, userId: string, sessionId: string, attachPreviousTaskResults: boolean = true, attachedFileUrls: string[] = []): Promise<any> {
    try {

      // Attach previous task results if requested
      let finalPrompt = prompt;
      if (attachPreviousTaskResults) {
        const previousResults = await this.getPreviousTaskResults(userId, sessionId);
        if (previousResults) {
          finalPrompt += previousResults;
        }
      }

      // Convert file URLs to attachments
      const attachments = this.convertUrlsToAttachments(attachedFileUrls);

      // Create task using raw prompt
      const task = {
        taskId: Date.now().toString(),
        userId,
        name: taskName,
        prompt: finalPrompt,
        status: 'active',
        emailNotification: false,
        isInteractive: false,
        isDeepResearch: false,
        isComplexTask: false,
        extractPageContent: false,
        outputAsJson: false,
        outputAsHtml: true,
        useSharedBrowser: false,
        turnOffHeadless: true,
        useKnowledgeBase: false,
        updateKnowledgeBase: false,
        updateLeadList: false,
        createVideo: false,
        videoModel: undefined,
        imageModel: undefined,
        category: category,
        description: `Custom task created from prompt: ${taskName}`,
        attachments: attachments,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      // Save task to database
      await taskDb.createTask(task);

      // Create task execution
      const execution = await taskDb.createTaskExecution({
        executionId: Date.now().toString(),
        taskId: task.taskId,
        userId: userId,
        status: 'pending',
        startTime: new Date().toISOString()
      });


      return {
        success: true,
        message: `Task "${taskName}" has been created successfully using a custom prompt. The task will start running shortly.`,
        status: 'pending',
        taskId: task.taskId,
        executionId: execution?.executionId,
        taskName: taskName
      };
    } catch (error) {
      console.error('AgentMode: Error creating task from prompt:', error);
      return {
        success: false,
        message: 'Failed to create task from prompt. Please try again.',
        status: 'error'
      };
    }
  }

  // Create image generation task from raw prompt
  private async createImageTaskFromPrompt(taskName: string, prompt: string, category: string, userId: string, sessionId: string, attachPreviousTaskResults: boolean = true): Promise<any> {
    try {

      // Format the prompt using the same format as handleCreateAdImageTask
      let formattedPrompt = "Please create high-quality ad images that align with the below context and target the specified audience. The images should be professional, engaging, and suitable for various marketing channels. Use download_image to download reference images and generate_image to create the result images. Valid size values for generate_image include \"1024x1024\", \"1536x1024\", \"1024x1536\", \"auto\". Valid quality values for generate_image include \"low\", \"medium\", \"high\", \"auto\". DO NOT browse the internet for other images.\n\n";
      
      // Add the user's image prompt
      if (prompt.trim()) {
        formattedPrompt += `Image Prompt:\n${prompt.trim()}\n\n`;
      }

      // Attach previous task results if requested
      if (attachPreviousTaskResults) {
        const previousResults = await this.getPreviousTaskResults(userId, sessionId);
        if (previousResults) {
          formattedPrompt += previousResults;
        }
      }

      // Create image generation task with standard settings
      const task = {
        taskId: Date.now().toString(),
        userId,
        name: taskName,
        prompt: formattedPrompt,
        status: 'active',
        emailNotification: false,
        isInteractive: false,
        isDeepResearch: false,
        isComplexTask: false,
        extractPageContent: false,
        outputAsJson: false,
        outputAsHtml: false, // Images don't need HTML output
        useSharedBrowser: false,
        turnOffHeadless: true,
        useKnowledgeBase: false,
        updateKnowledgeBase: false,
        updateLeadList: false,
        createVideo: false,
        category: category,
        description: `Image generation task: ${taskName}`,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      // Save task to database
      await taskDb.createTask(task);

      // Create task execution
      const execution = await taskDb.createTaskExecution({
        executionId: Date.now().toString(),
        taskId: task.taskId,
        userId: userId,
        status: 'pending',
        startTime: new Date().toISOString()
      });


      return {
        success: true,
        message: `Image generation task "${taskName}" has been created successfully. The task will start running shortly.`,
        status: 'pending',
        taskId: task.taskId,
        executionId: execution?.executionId,
        taskName: taskName
      };
    } catch (error) {
      console.error('AgentMode: Error creating image task from prompt:', error);
      return {
        success: false,
        message: 'Failed to create image generation task. Please try again.',
        status: 'error'
      };
    }
  }

  async generateSessionTitle(userMessage: string): Promise<string> {
    try {
      
      const response = await this.openai.chat.completions.create({
        model: process.env.AZURE_OPENAI_DEPLOYMENT_AGENT_MODE || 'gpt-5-chat-2',
        messages: [
          { 
            role: 'system', 
            content: `You are a session title generator for AgentWeb's Agent Mode. Based on the user's first message, generate a concise, descriptive title (max 60 characters) that captures the main marketing topic or task. Return ONLY the title, nothing else.`
          },
          { role: 'user', content: userMessage }
        ],
        max_completion_tokens: 100
      });

      const title = response.choices[0]?.message?.content?.trim();
      
      return title || 'Marketing Task';
    } catch (error) {
      console.error('AgentMode: Failed to generate session title:', error);
      return 'Marketing Task';
    }
  }



  private async getMetaAdsMetrics(timeframe: string, userId: string): Promise<any> {
    try {
      
      // Import the Meta API functions directly to reuse the same logic
      const { getMetaAccessToken } = await import('../utils/secretsManager');
      const { userDb } = await import('./db');
      
      // Get user from database
      const user = await userDb.getUserById(userId);
      if (!user) {
        return {
          success: false,
          message: 'User not found',
          error: 'User not found'
        };
      }

      // Check if user has ad account configured
      if (!user.adAccount || user.adAccount.trim() === "") {
        return {
          success: false,
          message: 'Ad account not configured. Please configure your Meta ad account first.',
          error: 'Ad account not configured'
        };
      }

      // Get Meta API access token from Secrets Manager
      let accessToken: string;
      try {
        accessToken = await getMetaAccessToken();
      } catch (error: any) {
        console.error('AgentMode: Error fetching Meta access token:', error);
        return {
          success: false,
          message: 'Meta access token not configured. Please contact your administrator.',
          error: error.message || 'Failed to fetch access token from Secrets Manager'
        };
      }

      // Get API version from environment or default to v18.0
      const apiVersion = process.env.META_API_VERSION || 'v18.0';
      
      // Calculate date range based on timeframe
      const endDate = new Date();
      const startDate = new Date();
      if (timeframe === "7d") {
        startDate.setDate(endDate.getDate() - 7);
      } else if (timeframe === "14d") {
        startDate.setDate(endDate.getDate() - 14);
      } else if (timeframe === "30d") {
        startDate.setDate(endDate.getDate() - 30);
      } else if (timeframe === "90d") {
        startDate.setDate(endDate.getDate() - 90);
      }
      const sinceStr = startDate.toISOString().split('T')[0];
      const untilStr = endDate.toISOString().split('T')[0];
      const attributionDays = Math.max(1, Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)));

      // Get campaigns, ad sets, ads, and insights using Graph API - fetch at multiple levels
      const [campaignsResponse, adSetsResponse, adsResponse, adInsightsResponse, adSetInsightsResponse, campaignInsightsResponse, insightsDemographicsResponse, insightsPlacementResponse, insightsDeviceResponse] = await Promise.all([
        fetch(`https://graph.facebook.com/${apiVersion}/act_${user.adAccount}/campaigns?fields=id,name,status,objective&access_token=${accessToken}`),
        fetch(`https://graph.facebook.com/${apiVersion}/act_${user.adAccount}/adsets?fields=id,name,status,campaign_id,targeting&access_token=${accessToken}`),
        fetch(`https://graph.facebook.com/${apiVersion}/act_${user.adAccount}/ads?fields=id,name,status,adset_id,campaign_id,creative{thumbnail_url,title,body,image_url}&access_token=${accessToken}`),
        // Ad-level insights for ads processing
        fetch(`https://graph.facebook.com/${apiVersion}/act_${user.adAccount}/insights?fields=impressions,clicks,spend,ctr,cpc,reach,frequency,campaign_id,adset_id,ad_id,actions,cost_per_action_type&time_range={'since':'${sinceStr}','until':'${untilStr}'}&level=ad&access_token=${accessToken}`),
        // Adset-level insights for ad sets processing
        fetch(`https://graph.facebook.com/${apiVersion}/act_${user.adAccount}/insights?fields=impressions,clicks,spend,ctr,cpc,reach,frequency,campaign_id,adset_id,actions,cost_per_action_type&time_range={'since':'${sinceStr}','until':'${untilStr}'}&level=adset&access_token=${accessToken}`),
        // Campaign-level insights for campaigns processing
        fetch(`https://graph.facebook.com/${apiVersion}/act_${user.adAccount}/insights?fields=impressions,clicks,spend,ctr,cpc,reach,frequency,campaign_id,actions,cost_per_action_type&time_range={'since':'${sinceStr}','until':'${untilStr}'}&level=campaign&access_token=${accessToken}`),
        // Demographics breakdown (age/gender)
        fetch(`https://graph.facebook.com/${apiVersion}/act_${user.adAccount}/insights?fields=impressions,clicks,spend,ctr,cpc,reach,actions,cost_per_action_type&breakdowns=age,gender&time_range={'since':'${sinceStr}','until':'${untilStr}'}&level=ad&access_token=${accessToken}`),
        // Placement breakdown (publisher platform and position)
        fetch(`https://graph.facebook.com/${apiVersion}/act_${user.adAccount}/insights?fields=impressions,clicks,spend,ctr,cpc,reach,actions,cost_per_action_type&breakdowns=publisher_platform,platform_position&time_range={'since':'${sinceStr}','until':'${untilStr}'}&level=ad&access_token=${accessToken}`),
        // Device breakdown (mobile/desktop, etc.)
        fetch(`https://graph.facebook.com/${apiVersion}/act_${user.adAccount}/insights?fields=impressions,clicks,spend,ctr,cpc,reach,actions,cost_per_action_type&breakdowns=impression_device&time_range={'since':'${sinceStr}','until':'${untilStr}'}&level=ad&access_token=${accessToken}`)
      ]);

      const [campaignsData, adSetsData, adsData, adInsightsData, adSetInsightsData, campaignInsightsData, insightsDemographicsData, insightsPlacementData, insightsDeviceData] = await Promise.all([
        campaignsResponse.json(),
        adSetsResponse.json(),
        adsResponse.json(),
        adInsightsResponse.json(),
        adSetInsightsResponse.json(),
        campaignInsightsResponse.json(),
        insightsDemographicsResponse.json(),
        insightsPlacementResponse.json(),
        insightsDeviceResponse.json()
      ]);


      // Check for errors in any of the responses
      if (campaignsData.error) {
        console.error('AgentMode: Campaigns API Error:', campaignsData.error);
        throw new Error(`Campaigns API Error: ${campaignsData.error.message}`);
      }
      if (adSetsData.error) {
        console.error('AgentMode: Ad Sets API Error:', adSetsData.error);
        throw new Error(`Ad Sets API Error: ${adSetsData.error.message}`);
      }
      if (adsData.error) {
        console.error('AgentMode: Ads API Error:', adsData.error);
        throw new Error(`Ads API Error: ${adsData.error.message}`);
      }
      if (adInsightsData.error) {
        console.error('AgentMode: Ad-level Insights API Error:', adInsightsData.error);
        throw new Error(`Ad-level Insights API Error: ${adInsightsData.error.message}`);
      }
      if (adSetInsightsData.error) {
        console.error('AgentMode: Adset-level Insights API Error:', adSetInsightsData.error);
        throw new Error(`Adset-level Insights API Error: ${adSetInsightsData.error.message}`);
      }
      if (campaignInsightsData.error) {
        console.error('AgentMode: Campaign-level Insights API Error:', campaignInsightsData.error);
        throw new Error(`Campaign-level Insights API Error: ${campaignInsightsData.error.message}`);
      }
      if (insightsDemographicsData.error) {
        console.error('AgentMode: Demographics Insights API Error:', insightsDemographicsData.error);
        // Don't throw; proceed without demographics
      }
      if (insightsPlacementData.error) {
        console.error('AgentMode: Placement Insights API Error:', insightsPlacementData.error);
        // Don't throw; proceed without placements
      }
      if (insightsDeviceData.error) {
        console.error('AgentMode: Device Insights API Error:', insightsDeviceData.error);
        // Don't throw; proceed without devices
      }

      // Process the data using simplified logic
      const adPerformance = this.processCampaignData(campaignsData.data || [], campaignInsightsData.data || [], adSetsData.data || []);
      const processedAdSetsData = this.processAdSetsData(adSetsData.data || [], adSetInsightsData.data || [], campaignsData.data || []);
      const processedAdsData = this.processAdsData(adsData.data || [], adInsightsData.data || [], adSetsData.data || [], campaignsData.data || []);
      const campaignSummary = this.generateCampaignSummary(adPerformance);
      const processedDemographicsBreakdown = this.processBreakdownData(insightsDemographicsData?.data || []);
      const processedPlacementBreakdown = this.processBreakdownData(insightsPlacementData?.data || []);
      const processedDeviceBreakdown = this.processBreakdownData(insightsDeviceData?.data || []);
      
      // Format the data for LLM consumption
      const formattedContent = this.formatMetricsSummary({
        adPerformance,
        adSetsData: processedAdSetsData,
        adsData: processedAdsData,
        campaignSummary,
        demographicsBreakdown: processedDemographicsBreakdown,
        placementBreakdown: processedPlacementBreakdown,
        deviceBreakdown: processedDeviceBreakdown,
        attributionWindow: { start: sinceStr, end: untilStr, days: attributionDays },
        timeframe
      });

      const result = {
        success: true,
        message: `Meta ads metrics loaded for ${timeframe} timeframe`,
        timeframe,
        data: {
          adPerformance,
          adSetsData: processedAdSetsData,
          adsData: processedAdsData,
          campaignSummary,
          demographicsBreakdown: processedDemographicsBreakdown,
          placementBreakdown: processedPlacementBreakdown,
          deviceBreakdown: processedDeviceBreakdown,
          attributionWindow: { start: sinceStr, end: untilStr, days: attributionDays }
        },
        formattedContent
      };
      
      return result;
    } catch (error) {
      console.error('AgentMode: Error fetching Meta ads metrics:', error);
      console.error('AgentMode: Error stack:', error instanceof Error ? error.stack : 'No stack trace');
      return {
        success: false,
        message: 'Failed to fetch Meta ads metrics. Please ensure your Meta ad account is properly configured.',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  private async createRevision(taskId: string, executionId: string, revisionPrompt: string, userId: string, targetResultName?: string): Promise<any> {
    try {
      console.log('AgentMode: Creating revision for task:', taskId, 'execution:', executionId, 'targetResultName:', targetResultName);
      
      // Get the task to verify ownership
      const task = await taskDb.getTaskById(taskId);
      if (!task) {
        return {
          success: false,
          message: 'Task not found',
          status: 'error'
        };
      }

      // Get the execution to verify it exists and is completed
      const execution = await taskDb.getTaskExecutionById(executionId);
      if (!execution) {
        return {
          success: false,
          message: 'Execution not found',
          status: 'error'
        };
      }

      if (execution.status !== 'completed') {
        return {
          success: false,
          message: 'Can only revise completed executions',
          status: 'error'
        };
      }

      // Analyze result files to find available reports and images
      const resultFiles = execution.result_files || [];
      const htmlFiles = resultFiles.filter((file: any) => 
        file.is_html || file.view_type === 'html' || file.filename.toLowerCase().endsWith('.html')
      );
      const imageFiles = resultFiles.filter((file: any) => {
        const filename = file.filename.toLowerCase();
        return file.view_type === 'image' || 
               filename.endsWith('.jpg') || filename.endsWith('.jpeg') || 
               filename.endsWith('.png') || filename.endsWith('.gif') || 
               filename.endsWith('.webp') || filename.endsWith('.svg');
      });

      // If no results available, return error
      if (htmlFiles.length === 0 && imageFiles.length === 0) {
        return {
          success: false,
          message: 'No results found for revision. The execution must have completed HTML reports or images to create a revision.',
          status: 'error'
        };
      }

      // If multiple results and no target specified, return list of available results
      const totalResults = htmlFiles.length + imageFiles.length;
      if (totalResults > 1 && !targetResultName) {
        const availableResults = [
          ...htmlFiles.map((f: any) => ({ name: f.filename, type: 'report', url: f.url })),
          ...imageFiles.map((f: any) => ({ name: f.filename, type: 'image', url: f.url }))
        ];
        
        return {
          success: false,
          message: `Multiple results found. Please specify which result to revise by providing the target_result_name parameter. Available results: ${availableResults.map(r => `${r.name} (${r.type})`).join(', ')}`,
          availableResults,
          status: 'multiple_results'
        };
      }

      // Find the target result file
      let targetFile = null;
      let assetType = '';
      let originalAssetUrl = '';

      if (targetResultName) {
        // Look for the specific file by name
        targetFile = resultFiles.find((file: any) => file.filename === targetResultName);
        if (!targetFile) {
          return {
            success: false,
            message: `Target result file '${targetResultName}' not found. Available files: ${resultFiles.map((f: any) => f.filename).join(', ')}`,
            status: 'error'
          };
        }
      } else {
        // Use the first available result
        targetFile = htmlFiles[0] || imageFiles[0];
      }

      if (!targetFile) {
        return {
          success: false,
          message: 'No target result file found',
          status: 'error'
        };
      }

      // Determine asset type and URL
      if (targetFile.is_html || targetFile.view_type === 'html' || targetFile.filename.toLowerCase().endsWith('.html')) {
        assetType = 'report';
        originalAssetUrl = targetFile.url;
      } else {
        assetType = 'image';
        originalAssetUrl = targetFile.url;
      }

      // Format revision prompt based on asset type (similar to Ad Images page)
      let formattedRevisionPrompt = revisionPrompt;
      if (assetType === 'image') {
        // For images, add specific instructions similar to Ad Images page
        formattedRevisionPrompt = `Please create a revised version of the image based on the following feedback: ${revisionPrompt}. Use the original image as a reference and create a new version that addresses the requested changes.`;
      }

      // Create a new task execution with revision prompt
      const revisionExecution = {
        executionId: Date.now().toString(),
        taskId,
        userId: task.userId,
        run_user_id: userId !== task.userId ? userId : undefined,
        status: 'pending',
        startTime: new Date().toISOString(),
        revision_prompt: formattedRevisionPrompt,
        original_execution_id: executionId,
        original_report_url: assetType === 'report' ? originalAssetUrl : undefined,
        original_image_url: assetType === 'image' ? originalAssetUrl : undefined,
        variations: 1
      };

      await taskDb.createTaskExecution(revisionExecution);

      return {
        success: true,
        message: `Revision created successfully for ${assetType} '${targetFile.filename}'. New execution ID: ${revisionExecution.executionId}`,
        taskId: revisionExecution.taskId,
        executionId: revisionExecution.executionId,
        status: 'pending',
        assetType,
        targetFile: targetFile.filename
      };
    } catch (error) {
      console.error('AgentMode: Error creating revision:', error);
      return {
        success: false,
        message: 'Failed to create revision. Please try again.',
        status: 'error'
      };
    }
  }

  // Action type mappings (shared across all processing functions)
  private readonly FORM_ACTIONS = new Set([
    'leadgen',
    'on_facebook_lead',
    'onsite_conversion.lead_form',
    'offsite_conversion.fb_pixel_custom',
    'offsite_conversion.fb_pixel_lead'
  ]);
  private readonly WEBSITE_ACTIONS = new Set([
    'website_lead',
    'lead'
  ]);

  // Helper function to process campaign data from Meta API
  private processCampaignData(campaigns: any[], insights: any[], adSets: any[]): any[] {
    const campaignMap = new Map();
    
    // Create ad set to campaign mapping
    const adSetToCampaignMap = new Map();
    for (const adSet of adSets) {
      adSetToCampaignMap.set(adSet.id, adSet.campaign_id);
    }
    
    // Initialize campaigns with zero metrics
    for (const campaign of campaigns) {
      campaignMap.set(campaign.id, {
        id: campaign.id,
        name: campaign.name,
        status: campaign.status,
        objective: campaign.objective,
        impressions: 0,
        clicks: 0,
        spend: 0,
        ctr: 0,
        cpc: 0,
        reach: 0,
        frequency: 0,
        websiteLeads: 0,
        costPerWebsiteLead: 0,
        formLeads: 0,
        costPerFormLead: 0,
        totalLeads: 0,
        costPerLead: 0,
        lastUpdated: new Date().toISOString(),
      });
    }
    
    // Process campaign-level insights directly
    for (const insight of insights) {
      const campaignId = insight.campaign_id;
      
      if (campaignMap.has(campaignId)) {
        const campaign = campaignMap.get(campaignId);
        
        // Use campaign-level metrics directly
        campaign.impressions = parseInt(insight.impressions) || 0;
        campaign.clicks = parseInt(insight.clicks) || 0;
        campaign.spend = parseFloat(insight.spend) || 0;
        campaign.reach = parseInt(insight.reach) || 0;
        
        // Process lead generation metrics from actions and cost_per_action_type
        if (insight.actions && Array.isArray(insight.actions)) {
          for (const action of insight.actions) {
            if (this.WEBSITE_ACTIONS.has(action.action_type)) {
              campaign.websiteLeads += parseInt(action.value) || 0;
            }
            if (this.FORM_ACTIONS.has(action.action_type)) {
              campaign.formLeads += parseInt(action.value) || 0;
            }
          }
        }
        
        if (insight.cost_per_action_type && Array.isArray(insight.cost_per_action_type)) {
          for (const costAction of insight.cost_per_action_type) {
            if (this.WEBSITE_ACTIONS.has(costAction.action_type)) {
              campaign.costPerWebsiteLead = parseFloat(costAction.value) || 0;
            }
            if (this.FORM_ACTIONS.has(costAction.action_type)) {
              campaign.costPerFormLead = parseFloat(costAction.value) || 0;
            }
          }
        }
      }
    }
    
    // Calculate derived metrics (CTR, CPC, Cost per Lead) after aggregation
    for (const campaign of campaignMap.values()) {
      if (campaign.impressions > 0) {
        campaign.ctr = (campaign.clicks / campaign.impressions) * 100; // Convert to percentage
      }
      if (campaign.clicks > 0) {
        campaign.cpc = campaign.spend / campaign.clicks;
      }
      if (campaign.reach > 0) {
        campaign.frequency = campaign.impressions / campaign.reach;
      }
      
      // Apply same logic as Meta Campaigns page: prioritize website leads over form submissions
      if (campaign.websiteLeads > 0) {
        campaign.formLeads = 0; // Set form submissions to 0 when website leads exist
        campaign.costPerWebsiteLead = campaign.costPerWebsiteLead || (campaign.spend / campaign.websiteLeads);
        campaign.costPerFormLead = 0;
      } else if (campaign.formLeads > 0) {
        campaign.costPerFormLead = campaign.costPerFormLead || (campaign.spend / campaign.formLeads);
      }
      
      campaign.totalLeads = (campaign.websiteLeads || 0) + (campaign.formLeads || 0);
      if (campaign.totalLeads > 0) {
        campaign.costPerLead = campaign.spend / campaign.totalLeads;
      }
    }
    
    // Return all campaigns regardless of activity
    return Array.from(campaignMap.values());
  }

  // Helper function to process ad sets data
  private processAdSetsData(adSets: any[], insights: any[], campaigns: any[]): any[] {
    const adSetMap = new Map();
    const campaignMap = new Map();
    
    // Create campaign mapping
    for (const campaign of campaigns) {
      campaignMap.set(campaign.id, campaign);
    }
    
    // Initialize ad sets with zero metrics
    for (const adSet of adSets) {
      const campaign = campaignMap.get(adSet.campaign_id);
      adSetMap.set(adSet.id, {
        id: adSet.id,
        name: adSet.name,
        status: adSet.status,
        campaignId: adSet.campaign_id,
        campaignName: campaign ? campaign.name : 'Unknown Campaign',
        impressions: 0,
        clicks: 0,
        spend: 0,
        ctr: 0,
        cpc: 0,
        reach: 0,
        frequency: 0,
        websiteLeads: 0,
        costPerWebsiteLead: 0,
        formLeads: 0,
        costPerFormLead: 0,
        totalLeads: 0,
        costPerLead: 0,
        lastUpdated: new Date().toISOString(),
      });
    }
    
    // Process adset-level insights directly
    for (const insight of insights) {
      const adSetId = insight.adset_id;
      if (adSetMap.has(adSetId)) {
        const adSet = adSetMap.get(adSetId);
        adSet.impressions = parseInt(insight.impressions) || 0;
        adSet.clicks = parseInt(insight.clicks) || 0;
        adSet.spend = parseFloat(insight.spend) || 0;
        adSet.reach = parseInt(insight.reach) || 0;
        
        // Process lead generation metrics from actions and cost_per_action_type
        if (insight.actions && Array.isArray(insight.actions)) {
          for (const action of insight.actions) {
            if (this.WEBSITE_ACTIONS.has(action.action_type)) {
              adSet.websiteLeads += parseInt(action.value) || 0;
            }
            if (this.FORM_ACTIONS.has(action.action_type)) {
              adSet.formLeads += parseInt(action.value) || 0;
            }
          }
        }
        
        if (insight.cost_per_action_type && Array.isArray(insight.cost_per_action_type)) {
          for (const costAction of insight.cost_per_action_type) {
            if (this.WEBSITE_ACTIONS.has(costAction.action_type)) {
              adSet.costPerWebsiteLead = parseFloat(costAction.value) || 0;
            }
            if (this.FORM_ACTIONS.has(costAction.action_type)) {
              adSet.costPerFormLead = parseFloat(costAction.value) || 0;
            }
          }
        }
      }
    }
    
    // Calculate derived metrics
    for (const adSet of adSetMap.values()) {
      if (adSet.impressions > 0) {
        adSet.ctr = (adSet.clicks / adSet.impressions) * 100;
      }
      if (adSet.clicks > 0) {
        adSet.cpc = adSet.spend / adSet.clicks;
      }
      if (adSet.reach > 0) {
        adSet.frequency = adSet.impressions / adSet.reach;
      }
      
      // Apply same logic as Meta Campaigns page: prioritize website leads over form submissions
      if (adSet.websiteLeads > 0) {
        adSet.formLeads = 0; // Set form submissions to 0 when website leads exist
        adSet.costPerWebsiteLead = adSet.costPerWebsiteLead || (adSet.spend / adSet.websiteLeads);
        adSet.costPerFormLead = 0;
      } else if (adSet.formLeads > 0) {
        adSet.costPerFormLead = adSet.costPerFormLead || (adSet.spend / adSet.formLeads);
      }
      
      adSet.totalLeads = (adSet.websiteLeads || 0) + (adSet.formLeads || 0);
      if (adSet.totalLeads > 0) {
        adSet.costPerLead = adSet.spend / adSet.totalLeads;
      }
    }
    
    // Return all ad sets regardless of activity
    return Array.from(adSetMap.values());
  }

  // Helper function to process ads data
  private processAdsData(ads: any[], insights: any[], adSets: any[], campaigns: any[]): any[] {
    const adMap = new Map();
    const adSetMap = new Map();
    const campaignMap = new Map();
    
    // Create mappings
    for (const adSet of adSets) {
      adSetMap.set(adSet.id, adSet);
    }
    for (const campaign of campaigns) {
      campaignMap.set(campaign.id, campaign);
    }
    
    // Initialize ads with zero metrics
    for (const ad of ads) {
      const adSet = adSetMap.get(ad.adset_id);
      const campaign = campaignMap.get(ad.campaign_id);
      
      adMap.set(ad.id, {
        id: ad.id,
        name: ad.name,
        status: ad.status,
        adSetId: ad.adset_id,
        adSetName: adSet ? adSet.name : 'Unknown Ad Set',
        campaignId: ad.campaign_id,
        campaignName: campaign ? campaign.name : 'Unknown Campaign',
        creative: ad.creative,
        impressions: 0,
        clicks: 0,
        spend: 0,
        ctr: 0,
        cpc: 0,
        reach: 0,
        frequency: 0,
        websiteLeads: 0,
        costPerWebsiteLead: 0,
        formLeads: 0,
        costPerFormLead: 0,
        totalLeads: 0,
        costPerLead: 0,
        lastUpdated: new Date().toISOString(),
      });
    }
    
    // Aggregate insights data by ad
    for (const insight of insights) {
      const adId = insight.ad_id;
      if (adMap.has(adId)) {
        const ad = adMap.get(adId);
        ad.impressions += parseInt(insight.impressions) || 0;
        ad.clicks += parseInt(insight.clicks) || 0;
        ad.spend += parseFloat(insight.spend) || 0;
        ad.reach += parseInt(insight.reach) || 0;
        
        // Process lead generation metrics from actions and cost_per_action_type
        if (insight.actions && Array.isArray(insight.actions)) {
          for (const action of insight.actions) {
            if (this.WEBSITE_ACTIONS.has(action.action_type)) {
              ad.websiteLeads += parseInt(action.value) || 0;
            }
            if (this.FORM_ACTIONS.has(action.action_type)) {
              ad.formLeads += parseInt(action.value) || 0;
            }
          }
        }
        
        if (insight.cost_per_action_type && Array.isArray(insight.cost_per_action_type)) {
          for (const costAction of insight.cost_per_action_type) {
            if (this.WEBSITE_ACTIONS.has(costAction.action_type)) {
              ad.costPerWebsiteLead = parseFloat(costAction.value) || 0;
            }
            if (this.FORM_ACTIONS.has(costAction.action_type)) {
              ad.costPerFormLead = parseFloat(costAction.value) || 0;
            }
          }
        }
      }
    }
    
    // Calculate derived metrics
    for (const ad of adMap.values()) {
      if (ad.impressions > 0) {
        ad.ctr = (ad.clicks / ad.impressions) * 100;
      }
      if (ad.clicks > 0) {
        ad.cpc = ad.spend / ad.clicks;
      }
      if (ad.reach > 0) {
        ad.frequency = ad.impressions / ad.reach;
      }
      
      // Apply same logic as Meta Campaigns page: prioritize website leads over form submissions
      if (ad.websiteLeads > 0) {
        ad.formLeads = 0; // Set form submissions to 0 when website leads exist
        ad.costPerWebsiteLead = ad.costPerWebsiteLead || (ad.spend / ad.websiteLeads);
        ad.costPerFormLead = 0;
      } else if (ad.formLeads > 0) {
        ad.costPerFormLead = ad.costPerFormLead || (ad.spend / ad.formLeads);
      }
      
      ad.totalLeads = (ad.websiteLeads || 0) + (ad.formLeads || 0);
      if (ad.totalLeads > 0) {
        ad.costPerLead = ad.spend / ad.totalLeads;
      }
    }
    
    // Return all ads regardless of activity
    return Array.from(adMap.values());
  }

  // Helper function to generate campaign summary
  private generateCampaignSummary(adPerformance: any[]): any {
    const totalCampaigns = adPerformance.length;
    const activeCampaigns = adPerformance.filter(campaign => campaign.status === 'ACTIVE').length;
    
    const totalSpend = adPerformance.reduce((sum, campaign) => sum + campaign.spend, 0);
    const totalImpressions = adPerformance.reduce((sum, campaign) => sum + campaign.impressions, 0);
    const totalClicks = adPerformance.reduce((sum, campaign) => sum + campaign.clicks, 0);
    const totalWebsiteLeads = adPerformance.reduce((sum, campaign) => sum + (campaign.websiteLeads || 0), 0);
    const totalFormLeads = adPerformance.reduce((sum, campaign) => sum + (campaign.formLeads || 0), 0);
    const totalLeads = totalWebsiteLeads + totalFormLeads;
    
    const averageCtr = totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : 0;
    const averageCpc = totalClicks > 0 ? totalSpend / totalClicks : 0;
    const averageCostPerWebsiteLead = totalWebsiteLeads > 0 ? totalSpend / totalWebsiteLeads : 0;
    const averageCostPerFormLead = totalFormLeads > 0 ? totalSpend / totalFormLeads : 0;
    const averageCostPerLead = totalLeads > 0 ? totalSpend / totalLeads : 0;
    
    return {
      totalCampaigns,
      activeCampaigns,
      totalSpend,
      totalImpressions,
      totalClicks,
      totalWebsiteLeads,
      totalFormLeads,
      totalLeads,
      averageCtr,
      averageCpc,
      averageCostPerWebsiteLead,
      averageCostPerFormLead,
      averageCostPerLead
    };
  }

  // Helper function to process breakdown data with lead generation metrics
  private processBreakdownData(breakdownData: any[]): any[] {
    return breakdownData.map(item => {
      const processedItem = {
        ...item,
        websiteLeads: 0,
        costPerWebsiteLead: 0,
        formLeads: 0,
        costPerFormLead: 0,
        totalLeads: 0,
        costPerLead: 0
      };

      // Process lead generation metrics from actions and cost_per_action_type
      if (item.actions && Array.isArray(item.actions)) {
        for (const action of item.actions) {
          if (this.WEBSITE_ACTIONS.has(action.action_type)) {
            processedItem.websiteLeads += parseInt(action.value) || 0;
          }
          if (this.FORM_ACTIONS.has(action.action_type)) {
            processedItem.formLeads += parseInt(action.value) || 0;
          }
        }
      }
      
      if (item.cost_per_action_type && Array.isArray(item.cost_per_action_type)) {
        for (const costAction of item.cost_per_action_type) {
          if (this.WEBSITE_ACTIONS.has(costAction.action_type)) {
            processedItem.costPerWebsiteLead = parseFloat(costAction.value) || 0;
          }
          if (this.FORM_ACTIONS.has(costAction.action_type)) {
            processedItem.costPerFormLead = parseFloat(costAction.value) || 0;
          }
        }
      }
      
      // Apply same logic as Meta Campaigns page: prioritize website leads over form submissions
      if (processedItem.websiteLeads > 0) {
        processedItem.formLeads = 0; // Set form submissions to 0 when website leads exist
        processedItem.costPerFormLead = 0;
      }
      
      // Calculate totals
      processedItem.totalLeads = (processedItem.websiteLeads || 0) + (processedItem.formLeads || 0);
      if (processedItem.totalLeads > 0) {
        processedItem.costPerLead = (processedItem.spend || 0) / processedItem.totalLeads;
      }

      // Calculate cost per lead if we have leads but no cost_per_action_type data
      if (processedItem.websiteLeads > 0 && processedItem.costPerWebsiteLead === 0 && item.spend) {
        processedItem.costPerWebsiteLead = parseFloat(item.spend) / processedItem.websiteLeads;
      }

      return processedItem;
    });
  }

  // Helper function to format metrics summary for AI analysis
  private formatMetricsSummary(data: any): string {
    const { adPerformance, adSetsData, adsData, campaignSummary, demographicsBreakdown, placementBreakdown, deviceBreakdown, attributionWindow } = data;
    
    let summary = `📊 **Meta Ads Performance Data**\n\n`;
    
    // Attribution Window Information (start, end, number of days)
    if (attributionWindow && attributionWindow.start && attributionWindow.end) {
      summary += `**Attribution Window**\n`;
      summary += `| Start | End | Days |\n`;
      summary += `|-------|-----|------|\n`;
      summary += `| ${attributionWindow.start} | ${attributionWindow.end} | ${attributionWindow.days} |\n\n`;
    }
    
    // Campaign Summary Table
    if (campaignSummary) {
      summary += `**Campaign Summary**\n`;
      summary += `| Metric | Value |\n`;
      summary += `|--------|-------|\n`;
      summary += `| Total Campaigns | ${campaignSummary.totalCampaigns} |\n`;
      summary += `| Total Spend | $${campaignSummary.totalSpend.toFixed(2)} |\n`;
      summary += `| Impressions | ${campaignSummary.totalImpressions.toLocaleString()} |\n`;
      summary += `| Clicks | ${campaignSummary.totalClicks.toLocaleString()} |\n`;
      summary += `| CTR | ${campaignSummary.averageCtr.toFixed(2)}% |\n`;
      summary += `| CPC | $${campaignSummary.averageCpc.toFixed(2)} |\n`;
      summary += `| Website Leads | ${campaignSummary.totalWebsiteLeads.toLocaleString()} |\n`;
      summary += `| Form Submissions | ${campaignSummary.totalFormLeads.toLocaleString()} |\n`;
      summary += `| Total Leads | ${campaignSummary.totalLeads.toLocaleString()} |\n`;
      summary += `| Cost per Website Lead | $${campaignSummary.averageCostPerWebsiteLead.toFixed(2)} |\n`;
      summary += `| Cost per Form Lead | $${campaignSummary.averageCostPerFormLead.toFixed(2)} |\n`;
      summary += `| Cost per Lead | $${campaignSummary.averageCostPerLead.toFixed(2)} |\n\n`;
    }
    
    // Campaign Performance Table
    if (adPerformance && adPerformance.length > 0) {
      summary += `**Campaign Performance**\n`;
      summary += `| Campaign Name | Spend | Impressions | Clicks | CTR | CPC | Website Leads | Form Leads | Total Leads | Cost/Lead |\n`;
      summary += `|---------------|-------|-------------|--------|-----|-----|---------------|------------|-------------|----------|\n`;
      
      adPerformance.forEach((campaign: any) => {
        summary += `| ${campaign.name} | $${campaign.spend.toFixed(2)} | ${campaign.impressions.toLocaleString()} | ${campaign.clicks.toLocaleString()} | ${campaign.ctr.toFixed(2)}% | $${campaign.cpc.toFixed(2)} | ${(campaign.websiteLeads || 0).toLocaleString()} | ${(campaign.formLeads || 0).toLocaleString()} | ${(campaign.totalLeads || 0).toLocaleString()} | $${(campaign.costPerLead || 0).toFixed(2)} |\n`;
      });
      summary += `\n`;
    }
    
    // Ad Sets Performance Table
    if (adSetsData && adSetsData.length > 0) {
      summary += `**Ad Sets Performance**\n`;
      summary += `| Ad Set Name | Campaign | Spend | Impressions | Clicks | CTR | CPC | Website Leads | Form Leads | Total Leads | Cost/Lead |\n`;
      summary += `|-------------|----------|-------|-------------|--------|-----|-----|---------------|------------|-------------|----------|\n`;
      
      adSetsData.forEach((adSet: any) => {
        summary += `| ${adSet.name} | ${adSet.campaignName} | $${adSet.spend.toFixed(2)} | ${adSet.impressions.toLocaleString()} | ${adSet.clicks.toLocaleString()} | ${adSet.ctr.toFixed(2)}% | $${adSet.cpc.toFixed(2)} | ${(adSet.websiteLeads || 0).toLocaleString()} | ${(adSet.formLeads || 0).toLocaleString()} | ${(adSet.totalLeads || 0).toLocaleString()} | $${(adSet.costPerLead || 0).toFixed(2)} |\n`;
      });
      summary += `\n`;
    }
    
    // Individual Ads Performance Table
    if (adsData && adsData.length > 0) {
      summary += `**Individual Ads Performance**\n`;
      summary += `| Ad Name | Ad Set | Campaign | Spend | Impressions | Clicks | CTR | CPC | Website Leads | Form Leads | Total Leads | Cost/Lead |\n`;
      summary += `|---------|--------|----------|-------|-------------|--------|-----|-----|---------------|------------|-------------|----------|\n`;
      
      adsData.forEach((ad: any) => {
        summary += `| ${ad.name} | ${ad.adSetName} | ${ad.campaignName} | $${ad.spend.toFixed(2)} | ${ad.impressions.toLocaleString()} | ${ad.clicks.toLocaleString()} | ${ad.ctr.toFixed(2)}% | $${ad.cpc.toFixed(2)} | ${(ad.websiteLeads || 0).toLocaleString()} | ${(ad.formLeads || 0).toLocaleString()} | ${(ad.totalLeads || 0).toLocaleString()} | $${(ad.costPerLead || 0).toFixed(2)} |\n`;
      });
      summary += `\n`;
    }
    
    // Demographics Breakdown
    if (demographicsBreakdown && demographicsBreakdown.length > 0) {
      summary += `**Demographics Performance**\n`;
      summary += `| Age | Gender | Impressions | Clicks | Spend | CTR | CPC | Website Leads | Form Leads | Total Leads | Cost/Lead |\n`;
      summary += `|-----|--------|-------------|--------|-------|-----|-----|---------------|------------|-------------|----------|\n`;
      
      // Group by age and gender, then aggregate metrics
      const demographicsMap = new Map();
      demographicsBreakdown.forEach((item: any) => {
        const key = `${item.age || 'Unknown'}-${item.gender || 'Unknown'}`;
        if (!demographicsMap.has(key)) {
          demographicsMap.set(key, {
            age: item.age || 'Unknown',
            gender: item.gender || 'Unknown',
            impressions: 0,
            clicks: 0,
            spend: 0,
            websiteLeads: 0,
            formLeads: 0,
            totalLeads: 0
          });
        }
        const demo = demographicsMap.get(key);
        demo.impressions += parseInt(item.impressions) || 0;
        demo.clicks += parseInt(item.clicks) || 0;
        demo.spend += parseFloat(item.spend) || 0;
        demo.websiteLeads += parseInt(item.websiteLeads) || 0;
        demo.formLeads += parseInt(item.formLeads) || 0;
        demo.totalLeads = demo.websiteLeads + demo.formLeads;
      });
      
      // Sort by spend descending and show top 10
      const sortedDemographics = Array.from(demographicsMap.values())
        .sort((a, b) => b.spend - a.spend)
        .slice(0, 10);
      
      sortedDemographics.forEach((demo: any) => {
        const ctr = demo.impressions > 0 ? (demo.clicks / demo.impressions) * 100 : 0;
        const cpc = demo.clicks > 0 ? demo.spend / demo.clicks : 0;
        const costPerLead = demo.totalLeads > 0 ? demo.spend / demo.totalLeads : 0;
        summary += `| ${demo.age} | ${demo.gender} | ${demo.impressions.toLocaleString()} | ${demo.clicks.toLocaleString()} | $${demo.spend.toFixed(2)} | ${ctr.toFixed(2)}% | $${cpc.toFixed(2)} | ${demo.websiteLeads.toLocaleString()} | ${demo.formLeads.toLocaleString()} | ${demo.totalLeads.toLocaleString()} | $${costPerLead.toFixed(2)} |\n`;
      });
      summary += `\n`;
    }
    
    // Placement Breakdown
    if (placementBreakdown && placementBreakdown.length > 0) {
      summary += `**Placement Performance**\n`;
      summary += `| Platform | Position | Impressions | Clicks | Spend | CTR | CPC | Website Leads | Cost/Lead |\n`;
      summary += `|----------|----------|-------------|--------|-------|-----|-----|---------------|----------|\n`;
      
      // Group by platform and position, then aggregate metrics
      const placementMap = new Map();
      placementBreakdown.forEach((item: any) => {
        const key = `${item.publisher_platform || 'Unknown'}-${item.platform_position || 'Unknown'}`;
        if (!placementMap.has(key)) {
          placementMap.set(key, {
            platform: item.publisher_platform || 'Unknown',
            position: item.platform_position || 'Unknown',
            impressions: 0,
            clicks: 0,
            spend: 0,
            websiteLeads: 0
          });
        }
        const placement = placementMap.get(key);
        placement.impressions += parseInt(item.impressions) || 0;
        placement.clicks += parseInt(item.clicks) || 0;
        placement.spend += parseFloat(item.spend) || 0;
        placement.websiteLeads += parseInt(item.websiteLeads) || 0;
      });
      
      // Sort by spend descending and show top 10
      const sortedPlacements = Array.from(placementMap.values())
        .sort((a, b) => b.spend - a.spend)
        .slice(0, 10);
      
      sortedPlacements.forEach((placement: any) => {
        const ctr = placement.impressions > 0 ? (placement.clicks / placement.impressions) * 100 : 0;
        const cpc = placement.clicks > 0 ? placement.spend / placement.clicks : 0;
        const costPerLead = placement.websiteLeads > 0 ? placement.spend / placement.websiteLeads : 0;
        summary += `| ${placement.platform} | ${placement.position} | ${placement.impressions.toLocaleString()} | ${placement.clicks.toLocaleString()} | $${placement.spend.toFixed(2)} | ${ctr.toFixed(2)}% | $${cpc.toFixed(2)} | ${placement.websiteLeads.toLocaleString()} | $${costPerLead.toFixed(2)} |\n`;
      });
      summary += `\n`;
    }
    
    // Device Breakdown
    if (deviceBreakdown && deviceBreakdown.length > 0) {
      summary += `**Device Performance**\n`;
      summary += `| Device | Impressions | Clicks | Spend | CTR | CPC | Website Leads | Cost/Lead |\n`;
      summary += `|--------|-------------|--------|-------|-----|-----|---------------|----------|\n`;
      
      // Group by device, then aggregate metrics
      const deviceMap = new Map();
      deviceBreakdown.forEach((item: any) => {
        const device = item.impression_device || 'Unknown';
        if (!deviceMap.has(device)) {
          deviceMap.set(device, {
            device,
            impressions: 0,
            clicks: 0,
            spend: 0,
            websiteLeads: 0
          });
        }
        const deviceData = deviceMap.get(device);
        deviceData.impressions += parseInt(item.impressions) || 0;
        deviceData.clicks += parseInt(item.clicks) || 0;
        deviceData.spend += parseFloat(item.spend) || 0;
        deviceData.websiteLeads += parseInt(item.websiteLeads) || 0;
      });
      
      // Sort by spend descending
      const sortedDevices = Array.from(deviceMap.values())
        .sort((a, b) => b.spend - a.spend);
      
      sortedDevices.forEach((device: any) => {
        const ctr = device.impressions > 0 ? (device.clicks / device.impressions) * 100 : 0;
        const cpc = device.clicks > 0 ? device.spend / device.clicks : 0;
        const costPerLead = device.websiteLeads > 0 ? device.spend / device.websiteLeads : 0;
        summary += `| ${device.device} | ${device.impressions.toLocaleString()} | ${device.clicks.toLocaleString()} | $${device.spend.toFixed(2)} | ${ctr.toFixed(2)}% | $${cpc.toFixed(2)} | ${device.websiteLeads.toLocaleString()} | $${costPerLead.toFixed(2)} |\n`;
      });
      summary += `\n`;
    }
    
    summary += `*Data includes ${adPerformance?.length || 0} campaigns, ${adSetsData?.length || 0} ad sets, and ${adsData?.length || 0} individual ads.*\n`;
    
    return summary;
  }


  // Helper function to format web search results for AI analysis
  private formatWebSearchResults(searchResult: any): string {
    const { query, results, totalResults } = searchResult;
    
    if (!results || results.length === 0) {
      return `<strong>🔍 Web Search Results for "${query}"</strong><br>No results found for your search query.`;
    }
    
    let summary = `<strong>🔍 Web Search Results for "${query}"</strong><br>`;
    summary += `I found ${totalResults} relevant search results:<br><br>`;
    
    results.forEach((result: any, index: number) => {
      summary += `<strong>${index + 1}. ${result.title}</strong><br>`;
      summary += `🔗 <a href="${result.url}" target="_blank">${result.url}</a><br>`;
      summary += `<em>${result.snippet}</em><br>`;
      if (result.publishedDate) {
        const date = new Date(result.publishedDate);
        summary += `📅 Published: ${date.toLocaleDateString()}<br>`;
      }
      summary += `<br>`;
    });
    
    summary += `<em>💡 I've gathered this current information to provide you with data-driven insights and recommendations.</em>`;
    
    return summary;
  }

  // Helper to format tool error for LLM feedback
  private formatToolError(toolName: string, errorMessage: string): string {
    const safeMessage = typeof errorMessage === 'string' ? errorMessage : 'Unknown error';
    return `⚠️ Tool Error: ${toolName}\nReason: ${safeMessage}\nNext: Adjust the plan or ask the user for missing info.`;
  }

  // Web search functionality
  private async searchWeb(query: string, maxResults: number = 10): Promise<any> {
    try {
      console.log('AgentMode: Searching web for query:', query, 'maxResults:', maxResults);
      
      // Limit max results to 10
      const limitedMaxResults = Math.min(maxResults, 10);
      
      // Use a simple web search API - you can replace this with your preferred search service
      // For now, we'll use a mock implementation that returns structured results
      // In production, you might want to use Google Custom Search API, Bing Search API, or similar
      
      const searchResults = await this.performWebSearch(query, limitedMaxResults);
      
      // Format the results for LLM consumption
      const formattedContent = this.formatWebSearchResults({
        query,
        results: searchResults,
        totalResults: searchResults.length
      });
      
      return {
        success: true,
        message: `Found ${searchResults.length} web search results for "${query}"`,
        query,
        results: searchResults,
        totalResults: searchResults.length,
        formattedContent
      };
    } catch (error) {
      console.error('AgentMode: Error searching web:', error);
      return {
        success: false,
        message: 'Failed to search the web. Please try again.',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  // Get Google Search API credentials from AWS Secrets Manager
  private async getGoogleSearchCredentials(): Promise<{ apiKey: string; searchEngineId: string } | null> {
    try {
      const secretName = process.env.NODE_ENV === 'development' 
        ? 'dev/AgentWeb/Google/Search' 
        : 'prod/AgentWeb/Google/Search';
      
      const secretJson = await getSecret(secretName);
      const credentials = JSON.parse(secretJson);
      
      if (!credentials.apiKey || !credentials.searchEngineId) {
        console.error('Google Search API credentials missing required fields');
        return null;
      }
      
      return {
        apiKey: credentials.apiKey,
        searchEngineId: credentials.searchEngineId
      };
    } catch (error) {
      console.error('Error fetching Google Search API credentials from Secrets Manager:', error);
      return null;
    }
  }

  // Perform actual web search using Google Custom Search API
  private async performWebSearch(query: string, maxResults: number): Promise<any[]> {
    try {
      // Get credentials from Secrets Manager
      const credentials = await this.getGoogleSearchCredentials();
      
      if (!credentials) {
        throw new Error('Google Search API not configured in Secrets Manager');
      }
      
      // Initialize Google Custom Search API
      const customsearch = google.customsearch('v1');
      
      // Perform the search
      const response = await customsearch.cse.list({
        auth: credentials.apiKey,
        cx: credentials.searchEngineId,
        q: query,
        num: Math.min(maxResults, 10), // Google API max is 10
        safe: 'medium', // Safe search level
        fields: 'items(title,link,snippet,pagemap/metatags,pagemap/cse_thumbnail)'
      });
      
      if (!response.data.items || response.data.items.length === 0) {
        throw new Error('No search results found');
      }
      
      // Transform Google API results to our format
      const searchResults = response.data.items.map((item: any) => ({
        title: item.title || 'No title',
        url: item.link || '#',
        snippet: item.snippet || 'No description available',
        publishedDate: this.extractPublishedDate(item.pagemap?.metatags?.[0]) || new Date().toISOString(),
        thumbnail: item.pagemap?.cse_thumbnail?.[0]?.src || null
      }));
      
      console.log(`Google Search API returned ${searchResults.length} results for query: "${query}"`);
      return searchResults;
      
    } catch (error) {
      console.error('Error performing Google web search:', error);
      throw error;
    }
  }


  // Extract published date from page metadata
  private extractPublishedDate(metatags: any): string | null {
    if (!metatags) return null;
    
    // Try different common meta tag formats for publication date
    const dateFields = [
      'article:published_time',
      'pubdate',
      'date',
      'dc.date',
      'dc.date.issued',
      'og:article:published_time',
      'article:published',
      'publication_date'
    ];
    
    for (const field of dateFields) {
      if (metatags[field]) {
        try {
          const date = new Date(metatags[field]);
          if (!isNaN(date.getTime())) {
            return date.toISOString();
          }
        } catch (e) {
          // Continue to next field
        }
      }
    }
    
    return null;
  }

  // Helper function to format brand guidelines for AI analysis
  private formatBrandGuidelines(brandResult: any): string {
    if (!brandResult.exists) {
      return `<strong>🎨 Brand Guidelines</strong><br>No brand guidelines are currently configured. You can help the user set up their brand identity by asking about their brand name, colors, tone of voice, and other brand elements.`;
    }

    const { brandData, attachments } = brandResult;
    let formattedSummary = `<strong>🎨 Brand Guidelines Retrieved</strong><br>`;
    formattedSummary += `I've successfully retrieved your brand guidelines. Here's what I found:<br><br>`;

    // Brand Identity Section (matches UI structure)
    formattedSummary += `<strong>💖 Brand Identity</strong><br>`;
    formattedSummary += `• <strong>Brand Name:</strong> ${brandData.brandName || 'Not set'}<br>`;
    formattedSummary += `• <strong>Tagline:</strong> ${brandData.tagline || 'Not set'}<br>`;
    formattedSummary += `• <strong>Target Audience:</strong> ${brandData.targetAudience || 'Not set'}<br><br>`;

    // Brand Colors Section (matches UI structure)
    formattedSummary += `<strong>🎨 Brand Colors</strong><br>`;
    if (brandData.primaryColor) {
      if (brandData.isGradient && brandData.primaryColorEnd) {
        formattedSummary += `• <strong>Primary Color (Gradient):</strong> ${brandData.primaryColor} → ${brandData.primaryColorEnd}<br>`;
      } else {
        formattedSummary += `• <strong>Primary Color:</strong> ${brandData.primaryColor}<br>`;
      }
    }
    formattedSummary += `• <strong>Secondary Color:</strong> ${brandData.secondaryColor || 'Not set'}<br><br>`;

    // Typography Section (matches UI structure)
    formattedSummary += `<strong>🔤 Typography</strong><br>`;
    formattedSummary += `• <strong>Font Family:</strong> ${brandData.fontFamily || 'Not set'}<br><br>`;

    // Brand Voice & Messaging Section (matches UI structure)
    formattedSummary += `<strong>💬 Brand Voice & Messaging</strong><br>`;
    formattedSummary += `• <strong>Tone of Voice:</strong> ${brandData.toneOfVoice || 'Not set'}<br>`;
    formattedSummary += `• <strong>Brand Personality:</strong> ${brandData.brandPersonality || 'Not set'}<br><br>`;

    // Key Messages Section (matches UI structure)
    formattedSummary += `<strong>📝 Key Messages</strong><br>`;
    if (brandData.keyMessages && brandData.keyMessages.length > 0) {
      brandData.keyMessages.forEach((message: string, index: number) => {
        formattedSummary += `• ${index + 1}. ${message}<br>`;
      });
    } else {
      formattedSummary += `• No key messages set<br>`;
    }
    formattedSummary += `<br>`;

    // Brand Values Section (matches UI structure)
    formattedSummary += `<strong>💖 Brand Values</strong><br>`;
    if (brandData.brandValues && brandData.brandValues.length > 0) {
      brandData.brandValues.forEach((value: string) => {
        formattedSummary += `• ${value}<br>`;
      });
    } else {
      formattedSummary += `• No brand values set<br>`;
    }
    formattedSummary += `<br>`;

    // Founder Profile Section (matches UI structure)
    formattedSummary += `<strong>👥 Founder Profile</strong><br>`;
    if (brandData.founders && brandData.founders.length > 0) {
      brandData.founders.forEach((founder: any, index: number) => {
        formattedSummary += `• <strong>Founder ${index + 1}:</strong> ${founder.name}<br>`;
        if (founder.jobTitle) {
          formattedSummary += `  📋 <strong>Job Title:</strong> ${founder.jobTitle}<br>`;
        }
        if (founder.styleTone) {
          formattedSummary += `  🎭 <strong>Style & Tone:</strong> ${founder.styleTone}<br>`;
        }
        if (founder.signaturePosts) {
          formattedSummary += `  ✍️ <strong>Signature Posts:</strong> ${founder.signaturePosts}<br>`;
        }
        formattedSummary += `<br>`;
      });
    } else {
      formattedSummary += `• No founder profiles added<br>`;
    }
    formattedSummary += `<br>`;

    // Logo & Assets Section (matches UI structure)
    formattedSummary += `<strong>🖼️ Logo & Assets</strong><br>`;
    if (attachments && attachments.length > 0) {
      const logoAssets = attachments.filter((asset: any) => asset.type === 'logo' || asset.type === 'secondaryLogo');
      const brandGuideAssets = attachments.filter((asset: any) => asset.type === 'brandGuide');
      
      if (logoAssets.length > 0) {
        logoAssets.forEach((asset: any) => {
          const logoType = asset.type === 'logo' ? 'Primary Logo' : 'Secondary Logo';
          formattedSummary += `• <strong>${logoType}:</strong> ${asset.filename}<br>`;
          formattedSummary += `  🔗 <a href="${asset.url}" target="_blank">View ${logoType}</a><br>`;
        });
      } else {
        formattedSummary += `• No logos uploaded<br>`;
      }
      
      if (brandGuideAssets.length > 0) {
        brandGuideAssets.forEach((asset: any) => {
          formattedSummary += `• <strong>Brand Guide:</strong> ${asset.filename}<br>`;
          formattedSummary += `  🔗 <a href="${asset.url}" target="_blank">View Brand Guide</a><br>`;
        });
      } else {
        formattedSummary += `• No brand guide uploaded<br>`;
      }
    } else {
      formattedSummary += `• No assets uploaded<br>`;
    }

    formattedSummary += `<br><em>💡 I'll use this brand information to ensure all generated content aligns with your brand identity and guidelines.</em>`;
    formattedSummary += `<br><br><strong>⚠️ Note:</strong> This brand guidelines data is current and complete. Please do not call read_brand_guidelines again in this conversation as it will return the same information.`;

    return formattedSummary;
  }

  // Helper function to format brand guidelines update feedback for AI analysis
  private formatBrandGuidelinesUpdate(updateResult: any): string {
    if (!updateResult.success) {
      return `<strong>❌ Brand Guidelines Update Failed</strong><br>${updateResult.message || 'Unknown error occurred while updating brand guidelines.'}`;
    }

    const { updatedFields, brandData, updatedAssets } = updateResult;
    let formattedSummary = `<strong>✅ Brand Guidelines Updated Successfully</strong><br>`;
    formattedSummary += `Here's what was changed:<br><br>`;

    // Show only the updated fields
    if (updatedFields && updatedFields.length > 0) {
      formattedSummary += `<strong>📝 Updated Fields:</strong><br>`;
      updatedFields.forEach((field: string) => {
        let value;
        if (field === 'brandAssets') {
          // Handle brand assets separately - use only the updated assets
          value = updatedAssets;
        } else {
          // Handle brand data fields
          value = brandData[field];
        }
        
        if (value !== undefined && value !== null) {
          if (field === 'brandAssets' && Array.isArray(value) && value.length > 0) {
            formattedSummary += `• <strong>Brand Assets:</strong> Updated ${value.length} asset(s)<br>`;
            value.forEach((asset: any) => {
              const assetType = asset.type === 'logo' ? 'Primary Logo' : 
                              asset.type === 'secondaryLogo' ? 'Secondary Logo' :
                              asset.type === 'brandGuide' ? 'Brand Guide' : 
                              asset.type === 'additionalAsset' ? 'Additional Asset' : asset.type;
              formattedSummary += `  - ${assetType}: ${asset.filename}<br>`;
            });
          } else if (field === 'founders' && Array.isArray(value)) {
            formattedSummary += `• <strong>Founder Profiles:</strong> Updated ${value.length} founder(s)<br>`;
            value.forEach((founder: any, index: number) => {
              formattedSummary += `  - <strong>Founder ${index + 1}:</strong> ${founder.name}<br>`;
              if (founder.jobTitle) {
                formattedSummary += `    📋 Job Title: ${founder.jobTitle}<br>`;
              }
              if (founder.styleTone) {
                formattedSummary += `    🎭 Style & Tone: ${founder.styleTone}<br>`;
              }
              if (founder.signaturePosts) {
                formattedSummary += `    ✍️ Signature Posts: ${founder.signaturePosts}<br>`;
              }
            });
          } else if (Array.isArray(value)) {
            formattedSummary += `• <strong>${field}:</strong> ${value.join(', ')}<br>`;
          } else {
            formattedSummary += `• <strong>${field}:</strong> ${value}<br>`;
          }
        }
      });
    }

    formattedSummary += `<br><em>💡 You can view the latest brand guidelines at the <a href="/brand-guidelines">Brand Guidelines page</a>.</em>`;

    return formattedSummary;
  }

  // Helper function to format market strategy for AI analysis
  private formatMarketStrategy(marketResult: any): string {
    if (!marketResult.exists) {
      return `<strong>📊 Market Strategy</strong><br>No market strategy is currently configured. You can help the user set up their market strategy by asking about their business overview, competitors, and ideal customer profiles.`;
    }

    const { marketData } = marketResult;
    let formattedSummary = `<strong>📊 Market Strategy Retrieved</strong><br>`;
    formattedSummary += `I've successfully retrieved your market strategy. Here's what I found:<br><br>`;

    // Business Overview Section (matches UI structure)
    formattedSummary += `<strong>🏢 Business Overview</strong><br>`;
    if (marketData.businessOverview) {
      formattedSummary += `${marketData.businessOverview}<br><br>`;
    } else {
      formattedSummary += `No business overview provided yet.<br><br>`;
    }

    // Competitors Section (matches UI structure)
    formattedSummary += `<strong>🏆 Competitors</strong><br>`;
    if (marketData.competitors && marketData.competitors.length > 0) {
      marketData.competitors.forEach((competitor: any, index: number) => {
        if (typeof competitor === 'object' && competitor.name) {
          formattedSummary += `• <strong>${competitor.name}:</strong> ${competitor.description || 'No description provided'}<br>`;
        } else {
          formattedSummary += `• ${competitor}<br>`;
        }
      });
    } else {
      formattedSummary += `• No competitors identified yet<br>`;
    }
    formattedSummary += `<br>`;

    // Ideal Customer Profile (ICP) Section (matches UI structure)
    formattedSummary += `<strong>🎯 Ideal Customer Profile (ICP)</strong><br>`;
    if (marketData.icp && marketData.icp.length > 0) {
      marketData.icp.forEach((icp: any, index: number) => {
        if (typeof icp === 'object' && icp.title) {
          formattedSummary += `• <strong>${icp.title}:</strong> ${icp.description || 'No description provided'}<br>`;
          if (icp.valueProposition) {
            formattedSummary += `  <em>Value Proposition:</em> ${icp.valueProposition}<br>`;
          }
        } else {
          formattedSummary += `• ${icp}<br>`;
        }
      });
    } else {
      formattedSummary += `• No ideal customer profiles defined yet<br>`;
    }

    formattedSummary += `<br><em>💡 I'll use this market strategy information to inform marketing campaigns, content strategy, and business development decisions.</em>`;
    formattedSummary += `<br><br><strong>⚠️ Note:</strong> This market strategy data is current and complete. Please do not call read_market_strategy again in this conversation as it will return the same information.`;

    return formattedSummary;
  }

  // Helper function to format market strategy update feedback for AI analysis
  private formatMarketStrategyUpdate(updateResult: any): string {
    if (!updateResult.success) {
      return `<strong>❌ Market Strategy Update Failed</strong><br>${updateResult.message || 'Unknown error occurred while updating market strategy.'}`;
    }

    const { updatedFields, marketData, updatedEntries, addedEntries, totalCompetitors, totalICPs } = updateResult;
    let formattedSummary = `<strong>✅ Market Strategy Updated Successfully</strong><br>`;
    formattedSummary += `Here's what was changed:<br><br>`;

    // Show updated fields
    if (updatedFields && updatedFields.length > 0) {
      formattedSummary += `<strong>📝 Updated Fields:</strong><br>`;
      updatedFields.forEach((field: string) => {
        if (field === 'businessOverview') {
          formattedSummary += `• <strong>Business Overview:</strong> Updated<br>`;
        } else if (field === 'competitors') {
          const updatedCount = updatedEntries.filter((entry: string) => entry.startsWith('Competitor:')).length;
          const addedCount = addedEntries.filter((entry: string) => entry.startsWith('Competitor:')).length;
          formattedSummary += `• <strong>Competitors:</strong> ${updatedCount} updated, ${addedCount} added (${totalCompetitors} total)<br>`;
        } else if (field === 'icp') {
          const updatedCount = updatedEntries.filter((entry: string) => entry.startsWith('ICP:')).length;
          const addedCount = addedEntries.filter((entry: string) => entry.startsWith('ICP:')).length;
          formattedSummary += `• <strong>Ideal Customer Profiles:</strong> ${updatedCount} updated, ${addedCount} added (${totalICPs} total)<br>`;
        }
      });
    }

    // Show specific entries that were updated vs added
    if (updatedEntries && updatedEntries.length > 0) {
      formattedSummary += `<br><strong>🔄 Updated Entries:</strong><br>`;
      updatedEntries.forEach((entry: string) => {
        formattedSummary += `• ${entry}<br>`;
      });
    }

    if (addedEntries && addedEntries.length > 0) {
      formattedSummary += `<br><strong>➕ Added Entries:</strong><br>`;
      addedEntries.forEach((entry: string) => {
        formattedSummary += `• ${entry}<br>`;
      });
    }

    formattedSummary += `<br><em>💡 You can view the latest market strategy at the <a href="/market-strategy">Market Strategy page</a>.</em>`;

    return formattedSummary;
  }

  // Helper function to format file content for AI analysis
  private formatFileContent(fileResult: any): string {
    if (!fileResult.success) {
      return `❌ File Reading Failed: ${fileResult.message || 'Unknown error occurred while reading the file.'}`;
    }

    const { content, file_type, file_size, content_length, file_url } = fileResult;
    
    let formattedContent = `📄 File Content Read Successfully\n`;
    formattedContent += `File Type: ${file_type}\n`;
    formattedContent += `File Size: ${file_size} bytes\n`;
    formattedContent += `Content Length: ${content_length} characters\n`;
    formattedContent += `Source URL: ${file_url}\n\n`;
    
    // Add the actual content
    formattedContent += `📝 Extracted Content:\n`;
    formattedContent += `---\n`;
    formattedContent += content;
    formattedContent += `\n---`;
    
    return formattedContent;
  }

  // Save file to S3 and return URL with content-based deduplication
  private async saveFile(fileName: string, fileContent: string, userId: string, sessionId: string): Promise<any> {
    try {
      console.log('AgentMode: Saving file:', fileName, 'for user:', userId, 'session:', sessionId);
      
      // Generate content hash for deduplication
      const contentHash = createHash('sha256').update(fileContent).digest('hex');
      
      // Check if we already have this content cached
      const cachedFile = this.fileContentCache.get(contentHash);
      if (cachedFile) {
        console.log('AgentMode: File content already exists, returning cached URL:', cachedFile.file_url);
        // Format the save result for LLM consumption
        const formattedContent = `📁 **File Saved Successfully**\nFile: ${fileName}\nSize: ${fileContent.length} bytes\nURL: ${cachedFile.file_url}\n\nThe file has been uploaded to S3 and is ready for sharing or reference.`;

        return {
          success: true,
          message: `File "${fileName}" has been saved successfully.`,
          file_url: cachedFile.file_url,
          file_name: fileName,
          file_size: fileContent.length,
          formattedContent
        };
      }
      
      const { uploadFileToS3 } = await import('../utils/s3Utils');
      
      // Determine content type based on file extension
      const extension = fileName.split('.').pop()?.toLowerCase();
      const contentTypes: { [key: string]: string } = {
        'txt': 'text/plain',
        'md': 'text/markdown',
        'json': 'application/json',
        'csv': 'text/csv',
        'html': 'text/html',
        'xml': 'application/xml',
        'pdf': 'application/pdf',
        'doc': 'application/msword',
        'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'xls': 'application/vnd.ms-excel',
        'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'ppt': 'application/vnd.ms-powerpoint',
        'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
      };
      const contentType = contentTypes[extension || ''] || 'application/octet-stream';
      
      // Upload to S3 using common utility
      const uploadResult = await uploadFileToS3(
        fileContent,
        fileName,
        userId,
        contentType
      );
      
      if (uploadResult.success) {
        // Cache the file content hash to URL mapping
        this.fileContentCache.set(contentHash, {
          file_url: uploadResult.url || '',
          file_name: fileName || 'unknown',
          file_size: fileContent.length
        });
        
        console.log('AgentMode: File uploaded and cached with hash:', contentHash);
        
        // Format the save result for LLM consumption
        const formattedContent = `📁 **File Saved Successfully**\nFile: ${fileName}\nSize: ${fileContent.length} bytes\nURL: ${uploadResult.url}\n\nThe file has been uploaded to S3 and is ready for sharing or reference.`;

        return {
          success: true,
          message: `File "${fileName}" has been saved successfully.`,
          file_url: uploadResult.url,
          file_name: fileName,
          file_size: fileContent.length,
          formattedContent
        };
      } else {
        return {
          success: false,
          message: 'Failed to save file to S3. Please try again.',
          error: uploadResult.error
        };
      }
    } catch (error) {
      console.error('AgentMode: Error saving file:', error);
      return {
        success: false,
        message: 'Failed to save file. Please try again.',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  // Read file content from URL with support for various file types
  private async readFileContent(fileUrl: string): Promise<any> {
    try {
      console.log('AgentMode: Reading file content from URL:', fileUrl);
      
      // Validate URL format
      if (!fileUrl.startsWith('http://') && !fileUrl.startsWith('https://')) {
        return {
          success: false,
          message: 'Invalid URL format. Must be HTTP or HTTPS.',
          error: 'Invalid URL format'
        };
      }

      // Determine file type from URL
      const urlPath = new URL(fileUrl).pathname;
      const extension = urlPath.split('.').pop()?.toLowerCase() || '';
      
      // Fetch the file content
      const response = await axios.get(fileUrl, {
        timeout: 30000, // 30 seconds timeout for larger files
        responseType: 'arraybuffer', // Use arraybuffer to handle binary files
        headers: {
          'User-Agent': 'AgentWeb-Backend/1.0',
        },
      });

      const buffer = Buffer.from(response.data as ArrayBuffer);
      const contentType = response.headers['content-type'] || '';

      console.log(`AgentMode: Successfully fetched file, size: ${buffer.length} bytes, type: ${contentType}`);

      // Process content based on file type
      let extractedContent = '';
      let fileType = 'unknown';

      if (extension === 'pdf' || contentType.includes('application/pdf')) {
        // Handle PDF files
        try {
          // Use require for dynamic loading to avoid TypeScript module resolution issues
          const pdfParse = require('pdf-parse');
          const pdfData: PDFData = await pdfParse(buffer);
          extractedContent = pdfData.text;
          fileType = 'pdf';
          console.log(`AgentMode: Successfully parsed PDF, extracted ${extractedContent.length} characters`);
        } catch (pdfError) {
          console.error('AgentMode: Error parsing PDF:', pdfError);
          return {
            success: false,
            message: 'Failed to parse PDF file. The file may be corrupted or password-protected.',
            error: pdfError instanceof Error ? pdfError.message : 'PDF parsing failed'
          };
        }
      } else if (['txt', 'md', 'csv', 'json', 'xml', 'html', 'htm', 'js', 'css', 'log', 'yml', 'yaml'].includes(extension)) {
        // Handle text-based files
        try {
          extractedContent = buffer.toString('utf-8');
          fileType = 'text';
          console.log(`AgentMode: Successfully read text file, extracted ${extractedContent.length} characters`);
        } catch (textError) {
          console.error('AgentMode: Error reading text file:', textError);
          return {
            success: false,
            message: 'Failed to read text file. The file may contain invalid characters.',
            error: textError instanceof Error ? textError.message : 'Text file reading failed'
          };
        }
      } else {
        // For other file types, try to read as text but with a warning
        try {
          extractedContent = buffer.toString('utf-8');
          fileType = 'text';
          console.log(`AgentMode: Attempted to read unknown file type as text, extracted ${extractedContent.length} characters`);
        } catch (textError) {
          console.error('AgentMode: Error reading file as text:', textError);
          return {
            success: false,
            message: `Unsupported file type (${extension}). Only text files, PDFs, and common document formats are supported.`,
            error: 'Unsupported file type'
          };
        }
      }

      // Limit content size to prevent overwhelming the LLM and session storage
      const maxContentLength = 50000; // 50KB limit for tool results
      if (extractedContent.length > maxContentLength) {
        extractedContent = extractedContent.substring(0, maxContentLength) + '\n\n[Content truncated due to size limit]';
        console.log(`AgentMode: Content truncated to ${maxContentLength} characters`);
      }

      // Format the file content for LLM consumption
      const formattedContent = this.formatFileContent({
        success: true,
        content: extractedContent,
        file_type: fileType,
        file_size: buffer.length,
        content_length: extractedContent.length,
        file_url: fileUrl
      });

      return {
        success: true,
        content: extractedContent,
        file_type: fileType,
        file_size: buffer.length,
        content_length: extractedContent.length,
        file_url: fileUrl,
        message: `Successfully read ${fileType} file content (${extractedContent.length} characters)`
      };

    } catch (error: any) {
      console.error('AgentMode: Error reading file content:', error);
      
      let errorMessage = 'Failed to read file content';
      let statusCode = 500;

      if (error.response) {
        statusCode = error.response.status;
        errorMessage = `HTTP ${error.response.status}: ${error.response.statusText}`;
      } else if (error.code === 'ENOTFOUND') {
        statusCode = 404;
        errorMessage = 'File not found or URL is unreachable';
      } else if (error.code === 'ETIMEDOUT') {
        statusCode = 408;
        errorMessage = 'Request timeout while fetching file';
      }

      return {
        success: false,
        message: errorMessage,
        error: error.message,
        file_url: fileUrl
      };
    }
  }

  /**
   * Generate an image using AI image generation models
   */
  private async generateImage(
    prompt: string,
    filename: string,
    size: string,
    quality: string,
    inputImages: string[],
    userId: string,
    sessionId: string
  ): Promise<any> {
    try {
      console.log('AgentMode: Generating image with prompt:', prompt, 'filename:', filename, 'size:', size, 'quality:', quality, 'inputImages:', inputImages, 'userId:', userId, 'sessionId:', sessionId);
      
      // Import the image generation service
      const { imageService } = await import('./imageGeneration');
      
      // Check if the service is available
      const isAvailable = await imageService.isAvailable();
      if (!isAvailable) {
        return {
          success: false,
          message: 'Image generation service is not available. Please check API key configuration in AWS Secrets Manager.',
          error: 'Service unavailable'
        };
      }

      // Generate the image
      const result = await imageService.generateImage({
        prompt,
        filename,
        size,
        quality,
        inputImages: inputImages || [],
        userId
      });

      if (result.success && result.imageUrl) {
        // Save the image URL to the session for reference
        const imageData = {
          url: result.imageUrl,
          filename: result.filename,
          generatedAt: new Date().toISOString(),
          prompt: prompt,
          size: size,
          quality: quality
        };

        // Store image data in session metadata (optional)
        try {
          await chatbotDb.addMessageToSession(sessionId, {
            role: 'system',
            content: `Image generated: ${result.filename}`,
            metadata: {
              timestamp: new Date().toISOString()
            }
          });
        } catch (error) {
          console.warn('Failed to store image generation metadata:', error);
        }

        return {
          success: true,
          message: `✅ Image "${result.filename}" generated successfully!`,
          imageUrl: result.imageUrl,
          filename: result.filename,
          prompt: prompt,
          size: size,
          quality: quality
        };
      } else {
        return {
          success: false,
          message: result.error || 'Failed to generate image',
          error: result.error
        };
      }

    } catch (error: any) {
      console.error('AgentMode: Error generating image:', error);
      return {
        success: false,
        message: 'Failed to generate image',
        error: error.message
      };
    }
  }

  private async createBlogArticle(
    topic: string,
    keywords: string,
    tone: string,
    length: string,
    researchContext: string,
    requirements: string,
    userId: string,
    sessionId: string
  ): Promise<any> {
    try {
      console.log('AgentMode: Creating blog article for topic:', topic, 'tone:', tone, 'length:', length, 'userId:', userId);
      
      // Import required services
      const { uploadFileToS3 } = await import('../utils/s3Utils');

      // Step 1: Generate blog content using existing blog.ts utility function
      console.log('AgentMode: Generating blog content using existing blog service...');
      const { generateBlogContent } = await import('../controllers/blog');
      
      // Use the requirements passed from the LLM
      const blogData = await generateBlogContent(topic, keywords, tone, length, researchContext, requirements);

      if (!blogData.title || !blogData.content) {
        throw new Error("Blog content generation failed");
      }

      console.log('AgentMode: Blog content generated successfully');

      // Step 2: Generate hero image using existing blog.ts utility function
      console.log('AgentMode: Generating hero image using existing blog service...');
      const { generateBlogImage } = await import('../controllers/blog');
      const imageData = await generateBlogImage(blogData.imagePrompt, userId);

      if (!imageData.imageUrl) {
        throw new Error('Image generation failed');
      }

      console.log('AgentMode: Hero image generated successfully');

      // Step 3: Generate HTML file using existing blog.ts utility function
      console.log('AgentMode: Generating HTML file...');
      const { generateBlogHtml } = await import('../controllers/blog');
      const htmlContent = generateBlogHtml(blogData.title, blogData.description, blogData.content, imageData.imageUrl);
      
      // Step 4: Upload HTML file to S3
      console.log('AgentMode: Uploading HTML file to S3...');
      const htmlFilename = `blog-${Date.now()}.html`;
      
      const uploadResult = await uploadFileToS3(
        htmlContent,
        htmlFilename,
        userId,
        'text/html'
      );

      if (!uploadResult.success || !uploadResult.url) {
        throw new Error(uploadResult.error || 'Failed to upload HTML file to S3');
      }

      const htmlUrl = uploadResult.url;

      console.log('AgentMode: HTML file uploaded successfully to:', htmlUrl);

      return {
        success: true,
        message: 'Blog article created successfully',
        data: {
          title: blogData.title,
          description: blogData.description,
          imageUrl: imageData.imageUrl,
          htmlUrl: htmlUrl
        }
      };

    } catch (error: any) {
      console.error('AgentMode: Error creating blog article:', error);
      return {
        success: false,
        message: 'Failed to create blog article',
        error: error.message
      };
    }
  }


}

export const agentModeService = new AgentModeService();