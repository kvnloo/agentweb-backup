import OpenAI from 'openai';
import { chatbotDb, ChatMessage } from './chatbotService';
import { taskDb, taskTemplateDb } from './db';

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
            
            const result = await this.executeTool(toolCall.function.name, functionArgs, userId);
            
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

  private getMarketingSystemPrompt(): string {
    return `You are Emma, an AI-powered assistant from AgentWeb. You help users execute marketing campaigns through natural conversation and task creation.

## Your Capabilities
You can help with various marketing tasks including:
- Market research and competitive analysis
- SWOT analysis for businesses
- Marketing strategy development
- Ad creative generation and campaign management
- Performance analysis and optimization
- Social media listening and brand monitoring

## Task Creation Approach
- **Primary Method**: Use the 'create_task_from_template' tool with a specific template_id and parameters_json string
- All available templates are provided in the context above - select the most appropriate one based on the user's request
- Extract the required parameters from the user's message and pass them as a JSON string where keys are parameter names and values are the actual values
- Example: {"site_url": "example.com", "business_area": "e-commerce"}
- Templates provide structured, proven approaches to common marketing tasks
- **Fallback Method**: If no suitable template is available, use 'create_task_from_prompt' to create a task with a raw prompt
- The 'create_task_from_prompt' tool allows you to create custom tasks with specific instructions when templates don't fit
- **Revision Method**: Use 'create_revision' tool to revise existing completed task executions
- Provide the task_id, execution_id, and detailed revision_prompt
- Use the execution_id from the Current Task Statuses context above
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

## Response Formatting
Format your responses in HTML5 for direct rendering. Use:
- <strong> for important points
- <em> for emphasis
- <code> for technical terms and commands
- <ul> and <li> for lists
- <pre> for code blocks (max width 360px)
- <a href="url" target="_blank"> for links
- <table> for structured data (max width 360px)

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
      'publish_meta_ads': 'Meta ads campaign',
      'analyze_ad_performance': 'ad performance analysis'
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
              }
            },
            required: ['task_name', 'prompt', 'category']
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
      },
      {
        type: 'function' as const,
        function: {
          name: 'create_revision',
          description: 'Create a revision of an existing completed task execution',
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
                description: 'Detailed instructions for how to revise the report'
              }
            },
            required: ['task_id', 'execution_id', 'revision_prompt']
          }
        }
      }
    ];
  }

  private async executeTool(toolName: string, args: any, userId: string): Promise<any> {
    console.log('AgentMode: Executing tool:', toolName, 'with args:', JSON.stringify(args, null, 2));
    switch (toolName) {
      case 'create_task_from_template':
        try {
          const parameters = JSON.parse(args.parameters_json || '{}');
          return await this.createTaskFromTemplate(args.template_id, parameters, userId);
        } catch (parseError) {
          console.error('AgentMode: Error parsing parameters JSON:', parseError);
          return {
            success: false,
            message: 'Invalid parameters JSON format. Please provide a valid JSON string.',
            status: 'invalid_json'
          };
        }
      case 'create_task_from_prompt':
        return await this.createTaskFromPrompt(args.task_name, args.prompt, args.category, userId);
      case 'publish_meta_ads':
        return await this.publishMetaAds(args.campaign_name, args.budget, args.targeting, args.creatives, userId);
      case 'analyze_ad_performance':
        return await this.analyzeAdPerformance(args.campaign_id, args.date_range, args.creatives, userId);
      case 'create_revision':
        return await this.createRevision(args.task_id, args.execution_id, args.revision_prompt, userId);
      default:
        throw new Error(`Unknown tool: ${toolName}`);
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
      return templates.map(template => ({
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
  private async createTaskFromTemplate(templateId: string, parameters: Record<string, string>, userId: string): Promise<any> {
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
  private async createTaskFromPrompt(taskName: string, prompt: string, category: string, userId: string): Promise<any> {
    try {
      console.log('AgentMode: Creating task from prompt:', taskName);

      // Create task using raw prompt
      const task = {
        taskId: Date.now().toString(),
        userId,
        name: taskName,
        prompt: prompt,
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

  private async createRevision(taskId: string, executionId: string, revisionPrompt: string, userId: string): Promise<any> {
    try {
      console.log('AgentMode: Creating revision for task:', taskId, 'execution:', executionId);
      
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

      // Find the original report URL from the execution's result files
      let originalReportUrl = undefined;
      if (execution.result_files && execution.result_files.length > 0) {
        const htmlFile = execution.result_files.find((file: any) => 
          file.is_html || file.view_type === 'html' || file.filename.toLowerCase().endsWith('.html')
        );
        if (htmlFile) {
          originalReportUrl = htmlFile.url;
        }
      }

      // Check if original report URL exists
      if (!originalReportUrl) {
        return {
          success: false,
          message: 'Original report not found for revision. The execution must have a completed HTML report to create a revision.',
          status: 'error'
        };
      }

      // Create a new task execution with revision prompt
      const revisionExecution = {
        executionId: Date.now().toString(),
        taskId,
        userId: task.userId,
        run_user_id: userId !== task.userId ? userId : undefined,
        status: 'pending',
        startTime: new Date().toISOString(),
        revision_prompt: revisionPrompt,
        original_execution_id: executionId,
        original_report_url: originalReportUrl,
        variations: 1
      };

      await taskDb.createTaskExecution(revisionExecution);

      return {
        success: true,
        message: `Revision created successfully. New execution ID: ${revisionExecution.executionId}`,
        taskId: revisionExecution.taskId,
        executionId: revisionExecution.executionId,
        status: 'pending'
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
}

export const agentModeService = new AgentModeService();