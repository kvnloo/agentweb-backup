import OpenAI from 'openai';
import { chatbotDb, ChatMessage } from './chatbotService';
import { taskDb, taskTemplateDb } from './db';
import { settingsService } from './settingsService';

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
    userId: string,
    sessionId: string
  ): Promise<{ content: string; toolCalls: any[]; knowledgeBaseQueries: string[]; sources: string[] }> {
    try {
      console.log('AgentMode: Generating marketing response');
      
      const systemPrompt = await this.getMarketingSystemPrompt();
      const currentTaskStatuses = await this.getCurrentTaskStatuses(userId);
      const availableTemplates = await this.getAvailableTemplates();
      const context = this.buildMarketingContext(userMessage, sessionHistory, currentTaskStatuses);
      
      // Build templates context message
      const templatesContext = this.buildTemplatesContext(availableTemplates);
      
      const response = await this.openai.chat.completions.create({
        model: process.env.AZURE_OPENAI_DEPLOYMENT_AGENT_MODE || 'gpt-5-chat-2',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'assistant', content: templatesContext },
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
            
            const result = await this.executeTool(toolCall.function.name, functionArgs, userId, sessionId);
            
            toolCalls.push({
              id: toolCall.id,
              name: toolCall.function.name,
              arguments: functionArgs,
              result: result
            });

            // Add status information to the content for the AI to see
            if (result.taskId && result.executionId) {
              const statusMessage = this.getStatusMessage(toolCall.function.name, result.status);
              content += `\n\n${statusMessage}`;
            } else if (toolCall.function.name === 'get_meta_ads_metrics' && result.success) {
              // Special handling for metrics data - provide summary for AI analysis
              const metricsSummary = this.formatMetricsSummary(result.data);
              content += `\n\n${metricsSummary}`;
            }
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

## Task Creation Approach
- **Primary Method**: Use the 'create_task_from_template' tool with a specific template_id and parameters_json string
- All available templates are provided in the context above - select the most appropriate one based on the user's request
- Extract the required parameters from the user's message and pass them as a JSON string where keys are parameter names and values are the actual values
- Example: {"site_url": "example.com", "business_area": "e-commerce"}
- Templates provide structured, proven approaches to common marketing tasks
- **Fallback Method**: If no suitable template is available, use 'create_task_from_prompt' to create a task with a raw prompt
- The 'create_task_from_prompt' tool allows you to create custom tasks with specific instructions when templates don't fit
- **Image Generation**: Use 'create_image_task_from_prompt' to create image generation tasks for visual content like ad creatives, social media images, or marketing visuals
- **Meta Ads Metrics**: Use 'get_meta_ads_metrics' to fetch and analyze Meta ad performance data
- When metrics data is loaded, provide contextual analysis based on the conversation history and user's business goals
- Don't just repeat the numbers - provide meaningful insights, strategic recommendations, and actionable next steps
- Consider the user's industry, business stage, and previous conversation context when analyzing performance
- Compare metrics against industry benchmarks and identify specific optimization opportunities
- If a user asks about a specific ad that doesn't appear in the metrics data, explain that the ad may be disabled, paused, or have no activity in the selected timeframe
- **Important**: You cannot pull metrics for individual ads by name - the metrics function returns all active ads in the timeframe. If a user asks for specific ad metrics, explain that you can only analyze the ads that appear in the current data set
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
- Ask clarifying questions when needed
- Provide clear explanations of what you're doing
- Keep responses concise but informative
- Always confirm task creation and provide relevant details
- When using templates, explain which template was selected and why
- When analyzing metrics data, provide insights and recommendations rather than just repeating the numbers
- Focus on actionable insights and strategic guidance based on the conversation context
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
      'get_meta_ads_metrics': 'Meta ads metrics analysis'
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

  private buildMarketingContext(userMessage: string, sessionHistory: ChatMessage[], currentTaskStatuses: any[] = []): string {
    let context = `User Message: ${userMessage}\n\n`;
    
    // Add current task statuses if any
    if (currentTaskStatuses.length > 0) {
      context += 'Current Task Statuses:\n';
      currentTaskStatuses.forEach(task => {
        const statusEmoji: Record<string, string> = {
          'pending': '⏳',
          'running': '🔄',
          'completed': '✅',
          'failed': '❌'
        };
        const emoji = statusEmoji[task.status] || '⏳';
        context += `${emoji} ${task.taskName} (${task.status}) - Task ID: ${task.taskId}, Execution ID: ${task.executionId}\n`;
      });
      context += '\n';
    }
    
    // Add recent conversation history (excluding system messages)
    if (sessionHistory.length > 0) {
      const nonSystemMessages = sessionHistory.filter(msg => msg.role !== 'system');
      const recentHistory = nonSystemMessages.slice(-5);
      context += 'Recent Conversation:\n';
      recentHistory.forEach(msg => {
        context += `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}\n`;
      });
      context += '\n';
    }
    
    return context;
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

  private getAvailableTools() {
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
              }
            },
            required: ['template_id', 'parameters_json']
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
                description: 'Time period for metrics (7d, 30d, 90d)',
                enum: ['7d', '30d', '90d'],
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
      }
    ];
  }

  private async executeTool(toolName: string, args: any, userId: string, sessionId: string): Promise<any> {
    console.log('AgentMode: Executing tool:', toolName, 'with args:', JSON.stringify(args, null, 2));
    switch (toolName) {
      case 'create_task_from_template':
        try {
          const parameters = JSON.parse(args.parameters_json || '{}');
          const attachPreviousTaskResults = args.attach_previous_task_results !== false;
          return await this.createTaskFromTemplate(args.template_id, parameters, userId, sessionId, attachPreviousTaskResults);
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
        return await this.createTaskFromPrompt(args.task_name, args.prompt, args.category, userId, sessionId, attachPreviousTaskResults);
      case 'create_image_task_from_prompt':
        const attachPreviousTaskResultsForImage = args.attach_previous_task_results !== false;
        return await this.createImageTaskFromPrompt(args.task_name, args.prompt, args.category || 'Creatives', userId, sessionId, attachPreviousTaskResultsForImage);
      case 'get_meta_ads_metrics':
        return await this.getMetaAdsMetrics(args.timeframe || '7d', userId);
      case 'create_revision':
        return await this.createRevision(args.task_id, args.execution_id, args.revision_prompt, userId, args.target_result_name);
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



  // Create task from template
  private async createTaskFromTemplate(templateId: string, parameters: Record<string, string>, userId: string, sessionId: string, attachPreviousTaskResults: boolean = true): Promise<any> {
    try {
      console.log('AgentMode: Creating task from template ID:', templateId, 'with parameters:', parameters);

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

      console.log('AgentMode: Using template:', template.name);

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

      console.log('AgentMode: Task created successfully:', task.taskId);

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
  private async createTaskFromPrompt(taskName: string, prompt: string, category: string, userId: string, sessionId: string, attachPreviousTaskResults: boolean = true): Promise<any> {
    try {
      console.log('AgentMode: Creating task from prompt:', taskName);

      // Attach previous task results if requested
      let finalPrompt = prompt;
      if (attachPreviousTaskResults) {
        const previousResults = await this.getPreviousTaskResults(userId, sessionId);
        if (previousResults) {
          finalPrompt += previousResults;
        }
      }

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

      console.log('AgentMode: Task created successfully:', task.taskId);

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
      console.log('AgentMode: Creating image task from prompt:', taskName);

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

      console.log('AgentMode: Image task created successfully:', task.taskId);

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
      console.log('AgentMode: Generating session title for message:', userMessage);
      
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
      console.log('AgentMode: Generated title:', title);
      
      return title || 'Marketing Task';
    } catch (error) {
      console.error('AgentMode: Failed to generate session title:', error);
      return 'Marketing Task';
    }
  }



  private async getMetaAdsMetrics(timeframe: string, userId: string): Promise<any> {
    try {
      console.log('AgentMode: Getting Meta ads metrics for timeframe:', timeframe, 'userId:', userId);
      
      // Import the Meta API functions directly to reuse the same logic
      const { getMetaAccessToken } = await import('../utils/secretsManager');
      const { userDb } = await import('./db');
      
      // Get user from database
      console.log('AgentMode: Fetching user from database...');
      const user = await userDb.getUserById(userId);
      if (!user) {
        console.log('AgentMode: User not found in database');
        return {
          success: false,
          message: 'User not found',
          error: 'User not found'
        };
      }
      console.log('AgentMode: User found, adAccount:', user.adAccount);

      // Check if user has ad account configured
      if (!user.adAccount || user.adAccount.trim() === "") {
        console.log('AgentMode: User ad account not configured');
        return {
          success: false,
          message: 'Ad account not configured. Please configure your Meta ad account first.',
          error: 'Ad account not configured'
        };
      }

      // Get Meta API access token from Secrets Manager
      let accessToken: string;
      try {
        console.log('AgentMode: Fetching Meta access token from Secrets Manager...');
        accessToken = await getMetaAccessToken();
        console.log('AgentMode: Meta access token retrieved successfully from Secrets Manager');
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
      console.log('AgentMode: Using Meta API version:', apiVersion);
      
      // Calculate date range based on timeframe
      const endDate = new Date();
      const startDate = new Date();
      if (timeframe === "7d") {
        startDate.setDate(endDate.getDate() - 7);
      } else if (timeframe === "30d") {
        startDate.setDate(endDate.getDate() - 30);
      } else if (timeframe === "90d") {
        startDate.setDate(endDate.getDate() - 90);
      }
      console.log('AgentMode: Date range:', startDate.toISOString().split('T')[0], 'to', endDate.toISOString().split('T')[0]);

      // Get campaigns, ad sets, ads, and insights using Graph API
      console.log('AgentMode: Making parallel API calls to Meta Graph API...');
      const [campaignsResponse, adSetsResponse, adsResponse, insightsResponse] = await Promise.all([
        fetch(`https://graph.facebook.com/${apiVersion}/act_${user.adAccount}/campaigns?fields=id,name,status,objective&access_token=${accessToken}`),
        fetch(`https://graph.facebook.com/${apiVersion}/act_${user.adAccount}/adsets?fields=id,name,status,campaign_id,targeting&access_token=${accessToken}`),
        fetch(`https://graph.facebook.com/${apiVersion}/act_${user.adAccount}/ads?fields=id,name,status,adset_id,campaign_id,creative{thumbnail_url,title,body,image_url}&access_token=${accessToken}`),
        fetch(`https://graph.facebook.com/${apiVersion}/act_${user.adAccount}/insights?fields=impressions,clicks,spend,ctr,cpc,reach,frequency,campaign_id,adset_id,ad_id&time_range={'since':'${startDate.toISOString().split('T')[0]}','until':'${endDate.toISOString().split('T')[0]}'}&level=ad&access_token=${accessToken}`)
      ]);

      console.log('AgentMode: API calls completed, parsing responses...');
      const [campaignsData, adSetsData, adsData, insightsData] = await Promise.all([
        campaignsResponse.json(),
        adSetsResponse.json(),
        adsResponse.json(),
        insightsResponse.json()
      ]);

      console.log('AgentMode: API responses parsed:');
      console.log('- Campaigns response status:', campaignsResponse.status, 'data length:', campaignsData.data?.length || 0);
      console.log('- Ad Sets response status:', adSetsResponse.status, 'data length:', adSetsData.data?.length || 0);
      console.log('- Ads response status:', adsResponse.status, 'data length:', adsData.data?.length || 0);
      console.log('- Insights response status:', insightsResponse.status, 'data length:', insightsData.data?.length || 0);

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
      if (insightsData.error) {
        console.error('AgentMode: Insights API Error:', insightsData.error);
        throw new Error(`Insights API Error: ${insightsData.error.message}`);
      }

      // Process the data using simplified logic
      console.log('AgentMode: Processing campaign data...');
      const adPerformance = this.processCampaignData(campaignsData.data || [], insightsData.data || [], adSetsData.data || []);
      console.log('AgentMode: Processed campaigns:', adPerformance.length);
      
      console.log('AgentMode: Processing ad sets data...');
      const processedAdSetsData = this.processAdSetsData(adSetsData.data || [], insightsData.data || [], campaignsData.data || []);
      console.log('AgentMode: Processed ad sets:', processedAdSetsData.length);
      
      console.log('AgentMode: Processing ads data...');
      const processedAdsData = this.processAdsData(adsData.data || [], insightsData.data || [], adSetsData.data || [], campaignsData.data || []);
      console.log('AgentMode: Processed ads:', processedAdsData.length);
      
      console.log('AgentMode: Generating campaign summary...');
      const campaignSummary = this.generateCampaignSummary(adPerformance);
      console.log('AgentMode: Campaign summary:', campaignSummary);
      
      const result = {
        success: true,
        message: `Meta ads metrics loaded for ${timeframe} timeframe`,
        timeframe,
        data: {
          adPerformance,
          adSetsData: processedAdSetsData,
          adsData: processedAdsData,
          campaignSummary
        }
      };
      
      console.log('AgentMode: Returning result with', adPerformance.length, 'campaigns,', processedAdSetsData.length, 'ad sets,', processedAdsData.length, 'ads');
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
        lastUpdated: new Date().toISOString(),
      });
    }
    
    // Aggregate insights data by campaign
    for (const insight of insights) {
      const adSetId = insight.adset_id;
      const campaignId = adSetToCampaignMap.get(adSetId);
      
      if (campaignId && campaignMap.has(campaignId)) {
        const campaign = campaignMap.get(campaignId);
        
        // Sum up metrics from all ad sets in this campaign
        campaign.impressions += parseInt(insight.impressions) || 0;
        campaign.clicks += parseInt(insight.clicks) || 0;
        campaign.spend += parseFloat(insight.spend) || 0;
        campaign.reach += parseInt(insight.reach) || 0;
      }
    }
    
    // Calculate derived metrics (CTR, CPC) after aggregation
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
    }
    
    // Filter out campaigns with no activity in the selected timeframe
    return Array.from(campaignMap.values()).filter(campaign => 
      campaign.impressions > 0 || campaign.clicks > 0 || campaign.spend > 0
    );
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
        lastUpdated: new Date().toISOString(),
      });
    }
    
    // Aggregate insights data by ad set
    for (const insight of insights) {
      const adSetId = insight.adset_id;
      if (adSetMap.has(adSetId)) {
        const adSet = adSetMap.get(adSetId);
        adSet.impressions += parseInt(insight.impressions) || 0;
        adSet.clicks += parseInt(insight.clicks) || 0;
        adSet.spend += parseFloat(insight.spend) || 0;
        adSet.reach += parseInt(insight.reach) || 0;
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
    }
    
    return Array.from(adSetMap.values()).filter(adSet => 
      adSet.impressions > 0 || adSet.clicks > 0 || adSet.spend > 0
    );
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
    }
    
    return Array.from(adMap.values()).filter(ad => 
      ad.impressions > 0 || ad.clicks > 0 || ad.spend > 0
    );
  }

  // Helper function to generate campaign summary
  private generateCampaignSummary(adPerformance: any[]): any {
    const totalCampaigns = adPerformance.length;
    const activeCampaigns = adPerformance.filter(campaign => campaign.status === 'ACTIVE').length;
    
    const totalSpend = adPerformance.reduce((sum, campaign) => sum + campaign.spend, 0);
    const totalImpressions = adPerformance.reduce((sum, campaign) => sum + campaign.impressions, 0);
    const totalClicks = adPerformance.reduce((sum, campaign) => sum + campaign.clicks, 0);
    
    const averageCtr = totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : 0;
    const averageCpc = totalClicks > 0 ? totalSpend / totalClicks : 0;
    
    return {
      totalCampaigns,
      activeCampaigns,
      totalSpend,
      totalImpressions,
      totalClicks,
      averageCtr,
      averageCpc
    };
  }

  // Helper function to format metrics summary for AI analysis
  private formatMetricsSummary(data: any): string {
    const { adPerformance, adSetsData, adsData, campaignSummary } = data;
    
    // Create a structured data summary for the AI to analyze contextually
    let summary = `📊 **Meta Ads Performance Data Retrieved**\n\n`;
    summary += `I've successfully pulled your latest Meta ads performance data. Here's what I found:\n\n`;
    
    // Provide key metrics in a conversational format
    if (campaignSummary) {
      summary += `**Performance Summary:**\n`;
      summary += `• You have ${campaignSummary.totalCampaigns} active campaign${campaignSummary.totalCampaigns > 1 ? 's' : ''} running\n`;
      summary += `• Total investment: $${campaignSummary.totalSpend.toFixed(2)}\n`;
      summary += `• Reached ${campaignSummary.totalImpressions.toLocaleString()} people with ${campaignSummary.totalClicks.toLocaleString()} clicks\n`;
      summary += `• Your CTR is ${campaignSummary.averageCtr.toFixed(2)}% (industry average is ~1-2%)\n`;
      summary += `• Cost per click: $${campaignSummary.averageCpc.toFixed(2)}\n\n`;
    }
    
    // Highlight top performers
    if (adsData && adsData.length > 0) {
      const topAds = adsData
        .sort((a: any, b: any) => b.clicks - a.clicks)
        .slice(0, 3);
      
      summary += `**Top Performing Ads:**\n`;
      topAds.forEach((ad: any, index: number) => {
        summary += `${index + 1}. "${ad.name}" - ${ad.clicks} clicks (${ad.ctr.toFixed(2)}% CTR, $${ad.cpc.toFixed(2)} CPC)\n`;
      });
      summary += `\n`;
    }
    
    // Add performance context
    if (campaignSummary) {
      summary += `**Performance Context:**\n`;
      if (campaignSummary.averageCtr > 2.0) {
        summary += `• Your CTR of ${campaignSummary.averageCtr.toFixed(2)}% is performing well above industry standards\n`;
      } else if (campaignSummary.averageCtr < 1.0) {
        summary += `• Your CTR of ${campaignSummary.averageCtr.toFixed(2)}% is below industry average and could be improved\n`;
      } else {
        summary += `• Your CTR of ${campaignSummary.averageCtr.toFixed(2)}% is performing at industry standard levels\n`;
      }
      
      if (campaignSummary.averageCpc < 0.50) {
        summary += `• Your CPC of $${campaignSummary.averageCpc.toFixed(2)} is excellent - very cost efficient\n`;
      } else if (campaignSummary.averageCpc > 2.0) {
        summary += `• Your CPC of $${campaignSummary.averageCpc.toFixed(2)} is high and may need optimization\n`;
      } else {
        summary += `• Your CPC of $${campaignSummary.averageCpc.toFixed(2)} is reasonable for your industry\n`;
      }
    }
    
    summary += `\n*Based on ${adPerformance?.length || 0} campaigns, ${adSetsData?.length || 0} ad sets, and ${adsData?.length || 0} individual ads.*\n`;
    summary += `*Note: Only ads with activity in the selected timeframe are included. Disabled, paused, or inactive ads won't appear in this data.*\n\n`;
    summary += `**Please provide your analysis and recommendations based on this performance data and our conversation context.**`;
    
    return summary;
  }
}

export const agentModeService = new AgentModeService();