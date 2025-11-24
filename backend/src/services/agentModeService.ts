import axios from 'axios';
import OpenAI from 'openai';
import { google } from 'googleapis';
import { createHash } from 'crypto';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { Storage } from '@google-cloud/storage';
import { chatbotDb, ChatMessage, searchPlatformKnowledgeBase } from './chatbotService';
import { taskDb, taskTemplateDb } from './db';
import { settingsService } from './settingsService';
import { getSecret, getGCSPPrivateKey } from '../utils/secretsManager';

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
      
      // Get session to check for work plan
      const session = await chatbotDb.getChatSession(sessionId);
      const workPlan = session?.workPlan;
      
      const marketingMessages = this.buildMarketingContext(messageContent, sessionHistory, currentTaskStatuses, workPlan);
      
      // Build templates context message
      const templatesContext = this.buildTemplatesContext(availableTemplates);
      
      // Build initial messages array (preserve structured history and tool messages)
      const messages: any[] = [
        { role: 'system', content: `${systemPrompt}\n\nCurrent time: ${new Date().toISOString()}` },
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
        
        // Yield control back to event loop after LLM call to allow health checks and other requests
        // This prevents blocking the main thread during long-running generateResponse operations
        await new Promise(resolve => setImmediate(resolve));
        
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
            
            // Yield control before starting tool execution to allow health checks to be processed
            await new Promise(resolve => setImmediate(resolve));
            
            const result = await this.executeTool(toolCall.function.name, functionArgs, userId, sessionId, mockMode);
            
            // Yield control after tool execution to allow health checks during long-running tool operations
            // This is critical for tools like generate_image which can take 30-60+ seconds
            await new Promise(resolve => setImmediate(resolve));
            
            // Store only the necessary data for the frontend
            const minimalResult = this.extractMinimalToolResult(result, toolCall.function.name);
            
            toolCalls.push({
              id: toolCall.id,
              name: toolCall.function.name,
              arguments: functionArgs,
              result: minimalResult
            });

            // Update the calledFunctions counter immediately after successful tool call
            try {
              await chatbotDb.incrementCalledFunctions(sessionId, { [toolCall.function.name]: 1 });
            } catch (counterError) {
              console.error('AgentMode: Failed to update function call counter:', counterError);
              // Don't fail the whole tool call if counter update fails
            }

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
            
            // Yield control after error handling as well
            await new Promise(resolve => setImmediate(resolve));
          }
        }
        
        // Yield control before next iteration to allow health checks to be processed
        // This ensures the event loop can handle other requests between LLM call iterations
        await new Promise(resolve => setImmediate(resolve));
        
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
    } catch (error: any) {
      console.error('AgentMode: Response generation failed:', error);
      
      // Handle Azure OpenAI content filtering errors specifically
      if (error?.code === 'content_filter' || error?.error?.code === 'ResponsibleAIPolicyViolation') {
        throw new Error('I apologize, but I cannot respond to that request as it may violate content policies. Please try rephrasing your question or asking about something else.');
      }
      
      // Handle other OpenAI API errors
      if (error?.status === 400) {
        throw new Error('I encountered an issue processing your request. Please try rephrasing your question.');
      }
      
      // Handle rate limiting
      if (error?.status === 429) {
        throw new Error('I\'m currently experiencing high demand. Please wait a moment and try again.');
      }
      
      // Generic error fallback
      throw new Error('I apologize, but I encountered an error processing your request. Please try again.');
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

## Page Content Extraction
- **read_page_source**: Use this tool to read HTML source code from webpages. However, if the result contains mostly JavaScript code or script tags instead of actual page content, the page likely requires browser rendering.
- **Fallback for JavaScript-rendered pages**: If \`read_page_source\` returns script code instead of content, use \`create_task_from_template\` with template \`__extract_page_content__\` and the page url to fetch the page content using browser automation. This will take about 30 seconds but can handle JavaScript-rendered content.

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
- **Web Automation Tasks Only**: The 'create_task_from_template' and 'create_task_from_prompt' tools are ONLY for web automation tasks that require browser interaction (e.g., logging into websites, scraping data, filling forms). These tools cannot run generic tasks that don't involve web browsing.
- **Primary Method**: Use the 'create_task_from_template' tool with a specific template_id and parameters_json string
- All available templates are provided in the context above - select the most appropriate one based on the user's request
- Extract the required parameters from the user's message and pass them as a JSON string where keys are parameter names and values are the actual values
- Example: {"site_url": "example.com", "business_area": "e-commerce"}
- Templates provide structured, proven approaches to common web automation marketing tasks
- **Fallback Method**: If no suitable template is available, use 'create_task_from_prompt' to create a web automation task with a raw prompt
- The 'create_task_from_prompt' tool allows you to create custom web automation tasks with specific instructions when templates don't fit
 - **Image Generation**: Use 'generate_image' for creating and revising images. This provides real-time (~30s) image generation. [DEPRECATED: 'create_image_task_from_prompt' is deprecated - use 'generate_image' instead]
 - **Image Editing Tips**: When using 'generate_image' with inputImages, you can include multiple image URLs to create combined images. For example, to add a logo to an existing image, include both the current image URL and the logo image URL in the inputImages array. The AI will combine elements from all provided images based on your prompt. This is useful for tasks like adding logos, combining multiple images, or creating composite visuals.
 - **Blog Articles**: When creating blog articles, prefer using the 'create_blog_article' tool. It generates the article content, creates a high-quality hero image via imageService, formats the article into clean HTML, uploads it to S3, and returns the final HTML URL. Avoid ad-hoc content + image flows when this tool fits the request.
 - **Meta Ads Metrics**: Use 'get_meta_ads_metrics' to fetch and analyze Meta ad performance data
- When metrics data is loaded, provide contextual analysis based on the conversation history and user's business goals
- Don't just repeat the numbers - provide meaningful insights, strategic recommendations, and actionable next steps
- Consider the user's industry, business stage, and previous conversation context when analyzing performance
- Compare metrics against industry benchmarks and identify specific optimization opportunities
- If a user asks about a specific ad that doesn't appear in the metrics data, explain that the ad may be disabled, paused, or have no activity in the selected timeframe
- **Important**: You cannot pull metrics for individual ads by name - the metrics function returns all active ads in the timeframe. If a user asks for specific ad metrics, explain that you can only analyze the ads that appear in the current data set
- **Web Search**: Use 'search_web' proactively to gather information from the internet before asking users for clarification
- **Automatic and fast**: Web search does NOT require user confirmation - use it automatically to improve your responses
- **When to search**: Before asking users for more details, search for market data, industry trends, competitor information, or other information available on the internet
- **Search first, ask second**: Use web search to gather background information and context from the internet before requesting additional details from users
- **Search topics include**: Market trends, industry benchmarks, competitor analysis, news, regulatory information, technology updates, or any information from the internet that would help provide better recommendations
- **Search strategy**: Use specific, targeted search queries to find the most relevant information
- **Integration**: Incorporate search results into your analysis and recommendations to provide data-driven insights
- **Search result presentation**: Always provide a tailored summary of search results that directly answers the user's question
- **Synthesize findings**: Analyze and synthesize search results to provide actionable insights relevant to the user's specific needs
- **Knowledge Base Search**: Use 'search_knowledge_base' to find information stored in the knowledge base. The knowledge base contains private knowledge (user-specific) and public knowledge (shared by all users and the platform). This is complementary to web search - use knowledge base for stored information and web search for information from the internet
- **When to use knowledge base**: Search the knowledge base when you need stored information that may have been added manually by users or captured from past work
- **Knowledge base vs web search**: Use knowledge base search for stored information (private or public), and web search for information from the internet

- **Previous Task Results**: Previous task results are automatically attached by default to provide context
- This includes the latest HTML results from previous completed tasks in the same conversation
- Set attach_previous_task_results to false only if you don't want previous results included
- **Revision Method**: [DEPRECATED: 'create_revision' is deprecated] For image revision, use 'generate_image' with the original image as an input image. For HTML report revision, use 'update_html_file' to update the HTML file content.

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

## Work Plan Capabilities
You can create and manage multi-step work plans using these tools:
- **create_work_plan**: Create a structured plan with a title and numbered steps. Each step can include optional requiredFunctionCalls to enforce validation. **CRITICAL: Always check your context messages for an existing work plan before creating a new one. If a work plan already exists (you'll see a message starting with "⚠️ IMPORTANT: A WORK PLAN ALREADY EXISTS"), DO NOT create a new plan - use modify_work_plan instead.**
- **modify_work_plan**: Add new steps or modify existing step details (does not change status). Can also add or modify requiredFunctionCalls for steps. Use this when a work plan already exists and you need to make changes.
- **set_work_plan_status**: Update step status (pending/completed/skipped) with optional notes. **IMPORTANT**: If a step has requiredFunctionCalls defined, you MUST have called those functions before marking it as completed, or you'll get an error.

Work plans help organize complex multi-step projects like client onboarding, campaign planning, or content creation workflows. The current work plan status (if any) is automatically provided in your context. **If you see a work plan in your context, you MUST continue working with that existing plan - never create a duplicate.**

### Required Function Calls
You can specify required function calls for any step to ensure proper validation:
- Add requiredFunctionCalls array when creating or modifying steps
- Example: \`requiredFunctionCalls: ["create_blog_article", "generate_image"]\`
- When marking a step as completed, the system will validate that all required functions were actually called
- If any required functions are missing, you'll get an error message listing what's missing
- This ensures you don't skip important work before marking steps complete

### Client Onboarding Workflow
When a user requests client onboarding or says "onboard new client" or similar:
1. **Ask for website URL**: Request their business website URL first
2. **Create the work plan**: Use create_work_plan with title "Client Onboarding" and these steps with required function calls:
   - Step 1: Analyze website and business (requiredFunctionCalls: ["search_web"])
   - Step 2: Create/update brand guidelines (requiredFunctionCalls: ["update_brand_guidelines"])
   - Step 3: Create/update marketing strategy (requiredFunctionCalls: ["update_marketing_strategy"])
   - Step 4: Generate 3 blog articles (requiredFunctionCalls: ["create_blog_article"])
   - Step 5: Generate social media posts (requiredFunctionCalls: ["generate_image"])

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

  private buildMarketingContext(messageContent: string, sessionHistory: ChatMessage[], currentTaskStatuses: any[] = [], workPlan?: any): any[] {
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
      let content = msg.content;
      
      // For user messages with attachments, reconstruct content to include attachment URLs
      // This matches how generateSessionResponse processes attachments (lines 495-502 in agentModeController)
      if (msg.role === 'user' && (msg as any).metadata?.attachments?.length > 0) {
        const attachments = (msg as any).metadata.attachments;
        const attachmentUrls = attachments.map((attachment: any) => {
          return `[${attachment.filename || 'Attachment'}](${attachment.url})`;
        }).join('\n');
        content = `${msg.content}\n\n**Attached Files:**\n${attachmentUrls}`;
      }
      
      const messageObj: any = { role: msg.role, content: content };
      
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

    // Insert work plan status as an assistant message if exists
    if (workPlan) {
      const statusIcons = {
        completed: '✓',
        pending: '○',
        skipped: '⊘'
      };
      let workPlanContent = `⚠️ IMPORTANT: A WORK PLAN ALREADY EXISTS FOR THIS SESSION ⚠️\n\n`;
      workPlanContent += `[Current Active Work Plan: "${workPlan.title}"]\n\n`;
      workPlanContent += `You MUST continue working with this existing plan. DO NOT create a new work plan. Use modify_work_plan if you need to add or change steps.\n\n`;
      
      // If autocomplete is enabled, add instruction to auto-complete steps
      if (workPlan.autocomplete) {
        workPlanContent += `⚠️ AUTOCOMPLETE MODE: After performing the work of a step, DO NOT ask the user whether you should complete the step. Simply call set_work_plan_status to complete the step.\n\n`;
      }
      
      workPlan.steps.forEach((step: any) => {
        const icon = statusIcons[step.status as keyof typeof statusIcons];
        workPlanContent += `${step.stepCount}. ${icon} ${step.title} (${step.status})\n`;
        
        // Include step description if available
        if (step.description) {
          workPlanContent += `   Description: ${step.description}\n`;
        }
        
        // Include required function calls if available
        if (step.requiredFunctionCalls && step.requiredFunctionCalls.length > 0) {
          workPlanContent += `   Required Functions: ${step.requiredFunctionCalls.join(', ')}\n`;
        }
        
        workPlanContent += '\n';
      });

      console.log('workPlanContent', workPlanContent);
      
      messages.push({ role: 'assistant', content: workPlanContent.trim() });
    }

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
          description: 'Create a web automation task using a specific template with the provided parameters',
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
              },
              async: {
                type: 'boolean',
                description: 'Whether to execute the task asynchronously. If false, the function will wait for task completion before returning the final result.',
                default: false
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
        }
      },
      {
        type: 'function' as const,
        function: {
          name: 'create_task_from_prompt',
          description: 'Create a web automation task using a raw prompt when no suitable template is available',
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
              },
              async: {
                type: 'boolean',
                description: 'Whether to execute the task asynchronously. If false, the function will wait for task completion before returning the final result.',
                default: false
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
          description: '[DEPRECATED] Create an image generation task using a raw prompt for creating visual content. Use \'generate_image\' instead for creating and revising images.',
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
              },
              campaign_name: {
                type: 'string',
                description: 'Optional campaign name to filter metrics by. If provided, only data from campaigns matching this name will be returned.',
                default: null
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
          description: '[DEPRECATED] Create a revision of an existing completed task execution (supports both reports and images). For image revision, use \'generate_image\' instead. For HTML report revision, use \'update_html_file\' instead.',
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
          description: 'Search the web for information from the internet',
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
          name: 'search_knowledge_base',
          description: 'Search the knowledge base for relevant information. The knowledge base contains private knowledge (user-specific) and public knowledge (shared by all users and the platform). This is complementary to web search - use knowledge base for stored information and web search for information from the internet.',
          parameters: {
            type: 'object',
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
            required: ['query']
          }
        }
      },
      {
        type: 'function' as const,
        function: {
          name: 'list_knowledge_base_files',
          description: 'List all available knowledge base files for the current user. Returns a list of files with their unique identifiers, names, sizes, types (public/private), and last updated timestamps.',
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
          name: 'read_knowledge_base_file',
          description: 'Read a knowledge base file based on its unique identifier. Returns the full content of the knowledge base file.',
          parameters: {
            type: 'object',
            properties: {
              file_identifier: {
                type: 'string',
                description: 'The unique identifier of the knowledge base file to read'
              }
            },
            required: ['file_identifier']
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
          }
        },
      {
        type: 'function' as const,
        function: {
          name: 'remove_c2pa_from_image',
          description: 'Remove C2PA metadata from an image by downloading it from a URL, stripping metadata, and uploading the cleaned image to S3. Returns the new S3 URL.',
          parameters: {
            type: 'object',
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
            required: ['image_url']
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
                },
                style: {
                  type: 'string',
                  description: 'The writing style of the blog article. Use "substack" for a personal, newsletter-like writing style with first-person perspective, engaging hooks, and conversational tone. Use "default" for standard blog post style.',
                  enum: ['default', 'substack'],
                  default: 'default'
                }
            },
            required: ['topic']
          }
        }
      },
      {
        type: 'function' as const,
        function: {
          name: 'create_social_media_posts',
          description: 'Create a list of social media posts and generate an HTML file containing all posts. Each post includes type (linkedin, x/twitter, instagram, facebook, or custom), rich text content that can be transformed to HTML for display and copied for use, and optional image URL. The output is an HTML file stored in S3 with all posts formatted for easy viewing and copying.',
          parameters: {
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
                      description: 'Rich text content for the post (supports markdown formatting)'
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
        }
      },
      {
        type: 'function' as const,
        function: {
          name: 'get_task_subscriber_metrics',
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
        }
      },
      {
        type: 'function' as const,
        function: {
          name: 'get_task_subscriber_engagement_events',
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
        }
      },
      {
        type: 'function' as const,
        function: {
          name: 'describe_image',
          description: 'Analyze and describe an image from a URL. Use this when the user mentions an image or when you need to understand visual content.',
          parameters: {
            type: 'object',
            properties: {
              image_url: {
                type: 'string',
                description: 'Image URL to analyze and describe'
              },
              prompt: {
                type: 'string',
                description: 'Custom prompt/instructions for analyzing the image. Specify what aspects to focus on (e.g., colors, composition, text, branding, marketing elements, etc.)',
                default: 'Please analyze and describe this image in detail. Focus on visual elements, composition, colors, text, and any marketing or branding elements you can identify.'
              }
            },
            required: ['image_url']
          }
        }
      },
      {
        type: 'function' as const,
        function: {
          name: 'perform_data_analysis',
          description: 'Perform data analysis with code execution on files from URLs. If no files are attached, treat the information in the instruction as the complete dataset.',
          parameters: {
            type: 'object',
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
        }
      },
      {
        type: 'function' as const,
        function: {
          name: 'list_html_templates',
          description: 'Get a list of all available HTML templates for the user (including email templates)',
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
            name: 'create_html_from_template',
            description: 'Create final HTML from a template by providing variable values and array variable values as JSON strings, then upload to S3',
            parameters: {
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
          }
        },
        {
          type: 'function' as const,
          function: {
            name: 'update_html_file',
            description: 'Update an HTML file by replacing specific content with new content. Use update_type="full" with old_file_hash for entire file replacement, or update_type="part" with old_content for partial replacements',
            parameters: {
              type: 'object',
              properties: {
                file_url: {
                  type: 'string',
                  description: 'URL of the HTML file to update (S3 URL or file path)'
                },
                update_type: {
                  type: 'string',
                  enum: ['part', 'full'],
                  description: 'Type of update: "part" for partial content replacement using old_content, "full" for entire file replacement using old_file_hash'
                },
                replacement_json: {
                  type: 'string',
                  description: 'JSON string containing a list of replacement instructions. For full replacement: [{"old_file_hash": "abc123...", "new_content": "<!DOCTYPE html>...", "expected_count": 1}]. For part replacement: [{"old_content": "<h1>Old Title</h1>", "new_content": "<h1>New Title</h1>", "expected_count": 1}]. Use empty string for new_content to delete the specified content.'
                }
              },
              required: ['file_url', 'update_type', 'replacement_json']
            }
          }
        },
        {
        type: 'function' as const,
        function: {
          name: 'create_work_plan',
          description: 'Create a multi-step work plan for the current chat session. Use this to organize complex projects like client onboarding, campaign planning, or content creation workflows. IMPORTANT: Check if a work plan already exists in the session context before creating a new one. If a work plan already exists, use modify_work_plan instead to add or update steps.',
          parameters: {
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
        }
      },
      {
        type: 'function' as const,
        function: {
          name: 'modify_work_plan',
          description: 'Add new steps or modify existing step details in the current work plan. Does not change step status - use set_work_plan_status for that.',
          parameters: {
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
        }
      },
      {
        type: 'function' as const,
        function: {
          name: 'set_work_plan_status',
          description: 'Update the status of one or more steps in the work plan. Use this to track progress as you complete steps. You can update multiple steps at once.',
          parameters: {
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
        }
      }
    ];
  }

  // Extract only the necessary data for the frontend to reduce storage size
  private extractMinimalToolResult(result: any, toolName: string): any {
    // For task creation tools, only keep the essential fields for TaskExecutionStatus
    if (toolName === 'create_task_from_template' || toolName === 'create_task_from_prompt' || toolName === 'create_image_task_from_prompt' || toolName === 'create_revision') {
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
          executionId: `mock-execution-${Date.now()}`,
          message: `Mock task created from template ${args.template_id}`,
          status: 'pending'
        };
      
      case 'create_task_from_prompt':
        return {
          success: true,
          taskId: `mock-task-${Date.now()}`,
          executionId: `mock-execution-${Date.now()}`,
          message: `Mock task created: ${args.task_name}`,
          status: 'pending'
        };
      
      case 'create_image_task_from_prompt':
        return {
          success: true,
          taskId: `mock-image-task-${Date.now()}`,
          executionId: `mock-execution-${Date.now()}`,
          message: `Mock image task created: ${args.task_name}`,
          status: 'pending'
        };
      
      case 'generate_image':
        return {
          success: true,
          message: `Mock image "${args.filename}" generated successfully!`,
          imageUrl: `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==`,
          filename: args.filename
        };
      
      case 'remove_c2pa_from_image':
        return {
          success: true,
          message: `✅ C2PA metadata removed successfully! Image uploaded to S3.`,
          imageUrl: `https://mock-s3-bucket.s3.amazonaws.com/${args.filename || `image_no_c2pa_${Date.now()}.png`}`,
          filename: args.filename || `image_no_c2pa_${Date.now()}.png`,
          originalUrl: args.image_url
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
      
      case 'search_knowledge_base':
        return {
          success: true,
          message: `Found 2 mock knowledge base results for "${args.query}"`,
          query: args.query,
          results: [
            {
              content: `This is a mock knowledge base result for "${args.query}". It contains information that was previously stored from a task execution.`,
              source: 'public-knowledge-base'
            },
            {
              content: `Another mock knowledge base result for "${args.query}". This information comes from a private knowledge base entry.`,
              source: 'private-knowledge-base'
            }
          ],
          totalResults: 2
        };
      
      case 'list_knowledge_base_files':
        return {
          success: true,
          message: 'Found 2 mock knowledge base file(s)',
          files: [
            {
              file_identifier: 'mock-task-1',
              name: 'Mock Product Specifications',
              size: 1024,
              type: 'private',
              updatedAt: new Date().toISOString()
            },
            {
              file_identifier: 'mock-task-2',
              name: 'Mock Company Guidelines',
              size: 2048,
              type: 'public',
              updatedAt: new Date(Date.now() - 86400000).toISOString()
            }
          ],
          totalFiles: 2
        };
      
      case 'read_knowledge_base_file':
        return {
          success: true,
          message: `Successfully read knowledge base file "Mock Product Specifications"`,
          file_identifier: args.file_identifier || 'mock-task-1',
          name: 'Mock Product Specifications',
          content: `This is mock knowledge base content for file identifier "${args.file_identifier}".\n\nIt contains information that was previously stored from a task execution.\n\nThis content can include:\n- Product specifications\n- Company guidelines\n- Process documentation\n- Any other relevant information stored in the knowledge base.`,
          size: 1024,
          type: 'private',
          updatedAt: new Date().toISOString()
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
            { title: 'Mock ICP', description: 'Mock ideal customer profile', valueProposition: 'Mock value prop', buyerPersonas: ['Mock persona 1', 'Mock persona 2'] }
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
          message: 'Mock revision created successfully',
          taskId: `mock-task-${Date.now()}`,
          executionId: `mock-execution-${Date.now()}`,
          status: 'pending',
          assetType: 'report',
          targetFile: 'mock-report.html'
        };
      
      case 'create_social_media_posts':
        return {
          success: true,
          message: `Successfully created ${args.posts?.length || 0} social media post(s)`,
          htmlUrl: `https://agentweb-files.s3.us-east-1.amazonaws.com/mock-social-media-posts-${Date.now()}.html`,
          postsCount: args.posts?.length || 0
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
      
      case 'describe_image':
        return {
          success: true,
          description: `Mock image analysis for ${args.image_url}${args.prompt ? ` with custom prompt: "${args.prompt}"` : ''}. This would contain detailed visual analysis including colors, composition, text content, and marketing elements in a real scenario.`,
          imageUrl: args.image_url
        };
      
      case 'perform_data_analysis':
        return {
          success: true,
          message: 'Mock data analysis completed successfully',
          analysis: `**Analysis:** Mock analysis results for ${args.file_urls?.length || 0} file(s).\n\nAnalysis task: ${args.analysis_instruction}\n\n**Code Executed:**\n\`\`\`python\n# Mock analysis code\nimport pandas as pd\nimport numpy as np\n\n# Analyze the data\nprint("Data analysis completed")\n\`\`\`\n\n**Code Output:**\n\`\`\`\nData analysis completed\nMock results would appear here in a real scenario.\n\`\`\``,
          codeExecuted: true
        };
      
      case 'list_html_templates':
        return {
          success: true,
          email_templates: [
            {
              template_name: 'welcome_email',
              subject: 'Welcome to {{company_name}}!',
              variables: ['company_name', 'user_name'],
              arrayVariables: ['features_n'],
              created_at: '2024-01-15T10:00:00Z',
              updated_at: '2024-01-15T10:00:00Z'
            },
            {
              template_name: 'newsletter',
              subject: 'Weekly Update: {{news_title}}',
              variables: ['news_title', 'company_name'],
              arrayVariables: ['news_n_category', 'links_n'],
              created_at: '2024-01-20T14:30:00Z',
              updated_at: '2024-01-20T14:30:00Z'
            }
          ]
        };
      
      case 'create_html_from_template':
        // Mock validation - check if required variables are provided
        const mockTemplate = {
          variables: ['title', 'company_name'],
          arrayVariables: ['features_n']
        };
        
        // Parse JSON strings for mock validation
        let mockVariableValues = {};
        let mockArrayVariableValues = {};
        
        try {
          if (args.variable_values_json) {
            mockVariableValues = JSON.parse(args.variable_values_json);
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
            mockArrayVariableValues = JSON.parse(args.array_variable_values_json);
          }
        } catch (error) {
          return {
            success: false,
            message: 'Invalid JSON in array_variable_values_json',
            error: error instanceof Error ? error.message : 'Unknown error'
          };
        }
        
        const missingVars = mockTemplate.variables.filter(v => !(v in mockVariableValues));
        const missingArrayVars = mockTemplate.arrayVariables.filter(v => !(v in mockArrayVariableValues));
        
        if (missingVars.length > 0 || missingArrayVars.length > 0) {
          return {
            success: false,
            message: 'Variable validation failed',
            errors: [
              ...(missingVars.length > 0 ? [`Missing required variables: ${missingVars.join(', ')}`] : []),
              ...(missingArrayVars.length > 0 ? [`Missing required array variables: ${missingArrayVars.join(', ')}`] : [])
            ],
            template_variables: mockTemplate.variables,
            template_array_variables: mockTemplate.arrayVariables
          };
        }
        
        return {
          success: true,
          s3_url: `https://mock-s3-bucket.s3.amazonaws.com/html_${args.template_name}_${Date.now()}.html`,
          subject: `Mock subject with variables substituted for ${args.template_name}`,
          template_name: args.template_name,
          filename: `html_${args.template_name}_${Date.now()}.html`,
          message: 'Mock HTML generated using LLM variable substitution'
        };
      
      case 'update_html_file':
        // Mock validation for update_html_file
        try {
          const instructions = JSON.parse(args.replacement_json);
          
          // Validate that it's an array
          if (!Array.isArray(instructions)) {
            return {
              success: false,
              message: 'replacement_json must be an array of replacement instructions'
            };
          }
          
          if (instructions.length === 0) {
            return {
              success: false,
              message: 'At least one replacement instruction is required'
            };
          }
          
          // Validate each instruction based on update_type
          for (let i = 0; i < instructions.length; i++) {
            const instruction = instructions[i];
            
            if (!instruction.new_content || instruction.expected_count === undefined) {
              return {
                success: false,
                message: `Missing required fields in replacement instruction ${i + 1}: new_content and expected_count are required`
              };
            }
            
            if (args.update_type === 'full') {
              // For full replacement, require old_file_hash
              if (!instruction.old_file_hash) {
                return {
                  success: false,
                  message: `Replacement instruction ${i + 1} missing old_file_hash. For update_type="full", old_file_hash is required`
                };
              }
              if (instruction.old_content !== undefined) {
                return {
                  success: false,
                  message: `Replacement instruction ${i + 1} should not have old_content when update_type="full". Use old_file_hash instead`
                };
              }
            } else if (args.update_type === 'part') {
              // For part replacement, require old_content
              if (!instruction.old_content) {
                return {
                  success: false,
                  message: `Replacement instruction ${i + 1} missing old_content. For update_type="part", old_content is required`
                };
              }
              if (instruction.old_file_hash !== undefined) {
                return {
                  success: false,
                  message: `Replacement instruction ${i + 1} should not have old_file_hash when update_type="part". Use old_content instead`
                };
              }
            }
          }
          
          // Mock successful replacement
          const replacementResults = instructions.map((instruction, index) => {
            const result: any = {
              index: index + 1,
              new_content: instruction.new_content,
              expected_count: instruction.expected_count,
              actual_count: instruction.expected_count, // Mock: assume count matches
              success: true
            };
            
            if (args.update_type === 'full') {
              result.old_file_hash = instruction.old_file_hash;
            } else {
              result.old_content = instruction.old_content;
            }
            
            return result;
          });
          
          // Mock versioned filename
          const mockVersionedFilename = `updated_file_v2.html`;
          
          return {
            success: true,
            s3_url: `https://mock-s3-bucket.s3.amazonaws.com/${mockVersionedFilename}`,
            message: `File updated successfully with ${replacementResults.length} replacements`,
            method: 'mixed_replacement',
            replacements: replacementResults,
            versioned_filename: mockVersionedFilename
          };
        } catch (error) {
          return {
            success: false,
            message: 'Invalid JSON in replacement_json',
            error: error instanceof Error ? error.message : 'Unknown error'
          };
        }
      
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
          const async = args.async ?? false; // Default to false
          return await this.createTaskFromTemplate(args.template_id, parameters, userId, sessionId, attachPreviousTaskResults, attachedFileUrls, async);
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
        const async = args.async ?? false; // Default to false
        return await this.createTaskFromPrompt(args.task_name, args.prompt, args.category, userId, sessionId, attachPreviousTaskResults, attachedFileUrls, async);
      case 'create_image_task_from_prompt':
        const attachPreviousTaskResultsForImage = args.attach_previous_task_results !== false;
        return await this.createImageTaskFromPrompt(args.task_name, args.prompt, args.category || 'Creatives', userId, sessionId, attachPreviousTaskResultsForImage);
      case 'get_meta_ads_metrics':
        return await this.getMetaAdsMetrics(args.timeframe || '7d', userId, args.campaign_name);
      case 'create_revision':
        return await this.createRevision(args.task_id, args.execution_id, args.revision_prompt, userId, args.target_result_name);
      case 'search_web':
        return await this.searchWeb(args.query, args.max_results || 10);
      case 'search_knowledge_base':
        return await this.searchKnowledgeBase(args.query, args.max_results || 5, userId);
      case 'list_knowledge_base_files':
        return await this.listKnowledgeBaseFiles(userId);
      case 'read_knowledge_base_file':
        return await this.readKnowledgeBaseFile(args.file_identifier, userId);
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
        return await this.generateImage(args.prompt, args.filename, args.size || '1024x1024', args.quality || 'medium', args.inputImages || [], userId, sessionId, args.imageModel);
      case 'remove_c2pa_from_image':
        return await this.removeC2PAFromImage(args.image_url, args.filename, userId);
      case 'create_blog_article':
          return await this.createBlogArticle(args.topic, args.keywords || '', args.tone || 'professional', args.length || 'medium', args.researchContext || '', args.requirements || '', userId, sessionId, args.style || 'default');
      case 'create_social_media_posts':
        return await this.createSocialMediaPosts(args.posts, userId, sessionId);
      case 'get_task_subscriber_metrics':
        return await this.getTaskSubscriberMetrics(args.task_id, userId);
      case 'get_task_subscriber_engagement_events':
        return await this.getTaskSubscriberEngagementEvents(args.task_id, args.email_subject, userId);
      case 'describe_image':
        return await this.describeImage(args.image_url, args.prompt);
      case 'perform_data_analysis':
        return await this.performDataAnalysis(args.file_urls, args.analysis_instruction, userId);
      case 'list_html_templates':
        return await this.listHtmlTemplates(userId);
      case 'create_html_from_template':
        // Ensure we have the required parameters
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
        
        return await this.createHtmlFromTemplate(args.template_name, variableValues, arrayVariableValues, userId, sessionId);
        case 'update_html_file':
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
        
        return await this.updateHtmlFile(args.file_url, args.update_type, replacementInstructions, userId, sessionId);
      case 'create_work_plan':
        return await this.createWorkPlan(args.title, args.steps, sessionId);
      case 'modify_work_plan':
        return await this.modifyWorkPlan(args.steps, args.removeStepCounts || [], sessionId);
      case 'set_work_plan_status':
        return await this.setWorkPlanStatus(args.updates, sessionId);
      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  }

  private async describeImage(imageUrl: string, prompt?: string): Promise<any> {
    try {
      if (!imageUrl) {
        return {
          success: false,
          message: 'No image URL provided'
        };
      }

      // Use custom prompt or default
      const analysisPrompt = prompt || 'Please analyze and describe this image in detail. Focus on visual elements, composition, colors, text, and any marketing or branding elements you can identify.';

      // Create messages for vision API
      const messages = [
        {
          role: 'user' as const,
          content: [
            {
              type: 'text' as const,
              text: analysisPrompt
            },
            {
              type: 'image_url' as const,
              image_url: { url: imageUrl }
            }
          ]
        }
      ];

      // Call OpenAI Vision API using the same model as agent mode
      const response = await this.openai.chat.completions.create({
        model: process.env.AZURE_OPENAI_DEPLOYMENT_AGENT_MODE || 'gpt-5-chat-2',
        messages: messages,
        max_completion_tokens: 2000
      });

      const description = response.choices[0]?.message?.content || 'Unable to analyze image';

      return {
        success: true,
        description: description,
        imageUrl: imageUrl
      };

    } catch (error) {
      console.error('AgentMode: Error describing image:', error);
      return {
        success: false,
        message: 'Failed to analyze image. Please check that the URL is accessible and contains a valid image.',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  private async performDataAnalysis(fileUrls: string[], analysisInstruction: string, userId: string): Promise<any> {
    try {
      const urlsToProcess = Array.isArray(fileUrls) ? fileUrls.filter(url => !!url) : [];

      if (!analysisInstruction) {
        return {
          success: false,
          message: 'Analysis instruction is required'
        };
      }

      // Get Gemini API key from Secrets Manager
      const environment = process.env.NODE_ENV === 'production' ? 'prod' : 'dev';
      const geminiSecretName = environment === 'prod'
        ? 'prod/AgentWeb/GeminiAPIKey'
        : 'dev/AgentWeb/GeminiAPIKey';
      let geminiApiKey: string;
      try {
        geminiApiKey = await getSecret(geminiSecretName);
      } catch (error) {
        console.error('AgentMode: Failed to retrieve Gemini API key from Secrets Manager:', error);
        return {
          success: false,
          message: 'Failed to retrieve Gemini API key from Secrets Manager'
        };
      }

      geminiApiKey = geminiApiKey.trim();
      if (!geminiApiKey) {
        return {
          success: false,
          message: 'Gemini API key is empty'
        };
      }

      // Initialize Google Generative AI client
      const genAI = new GoogleGenerativeAI(geminiApiKey);

      // Get the model name from environment or use default
      const modelName = process.env.DATA_ANALYSIS_LLM_NAME || 'gemini-2.5-flash';
      
      // Get file size limit from environment or use default (50MB)
      const maxTotalSize = parseInt(process.env.DATA_ANALYSIS_FILE_SIZE || '52428800'); // 50MB in bytes

      // Prepare file data for analysis
      const fileParts: any[] = [];
      let totalSize = 0;

      for (const fileUrl of urlsToProcess) {
        try {
          // Download the file
          const response = await axios.get(fileUrl, {
            responseType: 'arraybuffer',
            timeout: 30000
          });

          // Check file size
          const fileData = response.data as ArrayBuffer;
          totalSize += fileData.byteLength;
          if (totalSize > maxTotalSize) {
            return {
              success: false,
              message: `Total file size (${totalSize} bytes) exceeds the ${maxTotalSize} bytes limit. Please reduce the number or size of files.`
            };
          }

          // Determine MIME type from URL or response headers
          const contentType = response.headers['content-type'];
          const url = fileUrl.toLowerCase();
          
          let mimeType = 'text/plain';
          if (contentType) {
            mimeType = contentType;
          } else if (url.includes('.csv')) {
            mimeType = 'text/csv';
          } else if (url.includes('.json')) {
            mimeType = 'application/json';
          } else if (url.includes('.jsonl')) {
            mimeType = 'application/jsonl';
          } else if (url.includes('.xml')) {
            mimeType = 'application/xml';
          } else if (url.includes('.yaml') || url.includes('.yml')) {
            mimeType = 'application/x-yaml';
          } else if (url.includes('.html') || url.includes('.htm')) {
            mimeType = 'text/html';
          } else if (url.includes('.md')) {
            mimeType = 'text/markdown';
          } else if (url.includes('.py')) {
            mimeType = 'text/x-python';
          } else if (url.includes('.js')) {
            mimeType = 'text/javascript';
          } else if (url.includes('.ts')) {
            mimeType = 'text/typescript';
          }

          // Upload file to Gemini
          const base64Content = Buffer.from(fileData).toString('base64');
          
          fileParts.push({
            inline_data: {
              data: base64Content,
              mime_type: mimeType
            }
          });

        } catch (error) {
          console.error(`Error processing file ${fileUrl}:`, error);
          return {
            success: false,
            message: `Failed to download or process file: ${fileUrl}`,
            error: error instanceof Error ? error.message : 'Unknown error'
          };
        }
      }

      // Prepare content parts
      const parts: any[] = [];
      
      // Add file parts
      fileParts.forEach(part => parts.push(part));
      
      // Add text part with analysis instruction so the model knows how to proceed with or without files
      parts.push({
        text: `Please perform the following analysis task. ${urlsToProcess.length > 0 ? 'Use the attached files as primary data sources and incorporate any structured data included in the instruction text.' : 'No external files are attached; treat the information in the instruction as the complete dataset for this task.'}\n\n${analysisInstruction}\n\nUse Python code execution to analyze the data and provide detailed insights. Do not ask questions as the user is not present.`
      });

      // Call Gemini API directly via REST to enable code execution
      const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent`;
      const apiResponse = await axios.post(apiUrl, 
        {
          tools: [{ code_execution: {} }],
          contents: [
            {
              parts: parts
            }
          ]
        },
        {
          headers: {
            'x-goog-api-key': geminiApiKey,
            'Content-Type': 'application/json'
          }
        }
      );

      // Extract and format the response
      const candidates = (apiResponse.data as any).candidates;
      
      if (!candidates || candidates.length === 0) {
        return {
          success: false,
          message: 'No response received from Gemini API'
        };
      }

      const resultParts: string[] = [];
      let codeExecuted = false;

      // Extract parts from response
      const responseParts = candidates[0].content.parts || [];
      
      for (const part of responseParts) {
        if (part.text) {
          resultParts.push(`**Analysis:** ${part.text}`);
        }
        // Handle inline data (images/charts from code execution) (handle both camelCase and snake_case)
        if ((part as any).inlineData && (part as any).inlineData.data) {
          try {
            const imageData = (part as any).inlineData.data;
            const mimeType = (part as any).inlineData.mimeType || 'image/png';
            
            // Convert base64 string to Buffer for S3 upload
            const imageBuffer = Buffer.from(imageData, 'base64');
            
            // Upload image to S3
            const { uploadFileToS3 } = await import('../utils/s3Utils');
            const imageFilename = `analysis_chart_${Date.now()}.png`;
            const uploadResult = await uploadFileToS3(
              imageBuffer,
              imageFilename,
              userId,
              mimeType
            );
            
            if (uploadResult.success && uploadResult.url) {
              resultParts.push(`**Chart/Image Generated:**\n![Analysis Result](${uploadResult.url})`);
            }
          } catch (error) {
            console.error('Error uploading inline data to S3:', error);
            resultParts.push(`**Chart/Image Generated:** (Failed to upload to S3)`);
          }
        } else if ((part as any).inline_data && (part as any).inline_data.data) {
          // Handle snake_case format
          try {
            const imageData = (part as any).inline_data.data;
            const mimeType = (part as any).inline_data.mimeType || (part as any).inline_data.mime_type || 'image/png';
            
            // Convert base64 string to Buffer for S3 upload
            const imageBuffer = Buffer.from(imageData, 'base64');
            
            // Upload image to S3
            const { uploadFileToS3 } = await import('../utils/s3Utils');
            const imageFilename = `analysis_chart_${Date.now()}.png`;
            const uploadResult = await uploadFileToS3(
              imageBuffer,
              imageFilename,
              userId,
              mimeType
            );
            
            if (uploadResult.success && uploadResult.url) {
              resultParts.push(`**Chart/Image Generated:**\n![Analysis Result](${uploadResult.url})`);
            }
          } catch (error) {
            console.error('Error uploading inline_data (snake_case) to S3:', error);
            resultParts.push(`**Chart/Image Generated:** (Failed to upload to S3)`);
          }
        }
      }

      if (resultParts.length === 0) {
        return {
          success: false,
          message: 'No analysis results received from Gemini'
        };
      }

      // Combine all results
      const analysisResult = resultParts.join('\n\n');
      
      return {
        success: true,
        message: 'Data analysis completed successfully',
        analysis: analysisResult,
        codeExecuted: codeExecuted,
        formattedContent: analysisResult
      };

    } catch (error) {
      console.error('AgentMode: Error performing data analysis:', error);
      return {
        success: false,
        message: 'Failed to perform data analysis. Please check that the file URLs are accessible.',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
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
            if (toolCall.name === 'create_task_from_template' || toolCall.name === 'create_task_from_prompt' || toolCall.name === 'create_image_task_from_prompt' || toolCall.name === 'create_revision') {
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
      let existingBrand = user.brandGuidelines;
      
      // If no existing brand guidelines, create a new structure
      if (!existingBrand) {
        // Create initial brand guidelines structure
        const initialBrandGuidelines = {
          brandData: {
            brandName: "",
            tagline: "",
            primaryColor: "",
            primaryColorEnd: "",
            secondaryColor: "",
            fontFamily: "",
            toneOfVoice: "",
            keyMessages: [],
            brandValues: [],
            targetAudience: "",
            brandPersonality: "",
            isGradient: false,
            founders: [],
          },
          attachments: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        
        // Update the user with initial brand guidelines
        await userDb.updateUser(userId, {
          brandGuidelines: initialBrandGuidelines
        });
        
        // Use the initial structure as the base for updates
        existingBrand = initialBrandGuidelines;
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
            if ((toolCall.name === 'create_task_from_template' || toolCall.name === 'create_task_from_prompt' || toolCall.name === 'create_image_task_from_prompt' || toolCall.name === 'create_revision') && toolCall.result) {
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

  // Helper function to wait for task completion
  private async waitForTaskCompletion(taskId: string, executionId: string, userId: string, maxWaitTime: number = 300000, additionalFields: any = {}, pollInterval: number = 2000): Promise<any> {
    const startTime = Date.now();
    
    while (Date.now() - startTime < maxWaitTime) {
      try {
        const execution = await taskDb.getTaskExecutionById(executionId);
        if (execution && (execution.status === 'completed' || execution.status === 'failed')) {
          return {
            success: execution.status === 'completed',
            message: execution.status === 'completed' 
              ? 'Task completed successfully' 
              : `Task failed: ${execution.error || 'Unknown error'}`,
            status: execution.status,
            taskId: taskId,
            executionId: executionId,
            result: execution.result,
            error: execution.error,
            ...additionalFields
          };
        }
        
        // Wait before next poll
        await new Promise(resolve => setTimeout(resolve, pollInterval));
      } catch (error) {
        console.error('AgentMode: Error polling task execution:', error);
        await new Promise(resolve => setTimeout(resolve, pollInterval));
      }
    }
    
    // Timeout reached - return async format
    return {
      success: true,
      message: `Task "${additionalFields.taskName || 'Unknown'}" has been created successfully. The task is still running and may complete later.`,
      status: 'pending',
      taskId: taskId,
      executionId: executionId,
      ...additionalFields
    };
  }

  // Create task from template
  private async createTaskFromTemplate(templateId: string, parameters: Record<string, string>, userId: string, sessionId: string, attachPreviousTaskResults: boolean = true, attachedFileUrls: string[] = [], async: boolean = true): Promise<any> {
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
        isAgenticDevMode: template.isAgenticDevMode,
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
        turnOffHeadless: templateData.turnOffHeadless !== undefined ? templateData.turnOffHeadless : true,
        isAgenticDevMode: templateData.isAgenticDevMode || false,
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

      // If async is false, wait for task completion
      if (!async && execution?.executionId) {
        return await this.waitForTaskCompletion(task.taskId, execution.executionId, userId, 3600000, {
          templateName: templateData.name,
          taskName: taskName
        });
      }

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
  private async createTaskFromPrompt(taskName: string, prompt: string, category: string, userId: string, sessionId: string, attachPreviousTaskResults: boolean = true, attachedFileUrls: string[] = [], async: boolean = true): Promise<any> {
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

      // If async is false, wait for task completion
      if (!async && execution?.executionId) {
        return await this.waitForTaskCompletion(task.taskId, execution.executionId, userId, 3600000, {
          taskName: taskName
        });
      }

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
      let formattedPrompt = "Please create high-quality ad images that align with the below context and target the specified audience. The images should be professional, engaging, and suitable for various marketing channels. Use download_image to download reference images and generate_image to create the result images. Valid size values for generate_image include \"1024x1024\", \"1536x1024\", \"1024x1536\", \"auto\". Valid quality values for generate_image include \"low\", \"medium\", \"high\" (defaults to medium if not specified). DO NOT browse the internet for other images.\n\n";
      
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



  private async getMetaAdsMetrics(timeframe: string, userId: string, campaign_name?: string): Promise<any> {
    try {
      
      // Import the Meta API functions directly to reuse the same logic
      const { getMetaAccessToken } = await import('../utils/secretsManager');
      const { userDb } = await import('./db');
      const { fetchWithRetryAndPaging } = await import('../utils/metaApiFetch');
      
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
      // Exclude today since it's not fully complete - use yesterday as end date
      const endDate = new Date();
      endDate.setDate(endDate.getDate() - 1); // Set to yesterday
      const startDate = new Date(endDate); // Copy endDate
      if (timeframe === "7d") {
        startDate.setDate(endDate.getDate() - 6); // 7 days total (yesterday - 6 = 7 days)
      } else if (timeframe === "14d") {
        startDate.setDate(endDate.getDate() - 13); // 14 days total
      } else if (timeframe === "30d") {
        startDate.setDate(endDate.getDate() - 29); // 30 days total
      } else if (timeframe === "90d") {
        startDate.setDate(endDate.getDate() - 89); // 90 days total
      }
      const sinceStr = startDate.toISOString().split('T')[0];
      const untilStr = endDate.toISOString().split('T')[0];
      const attributionDays = Math.max(1, Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24))) + 1; // +1 to include both start and end dates

      // First, get campaigns to find matching campaign IDs if filtering by campaign name
      let campaignFilterIds: string[] = [];
      if (campaign_name) {
        console.log('AgentMode: Getting campaigns to find matching IDs for:', campaign_name);
        const campaignsData = await fetchWithRetryAndPaging(`https://graph.facebook.com/${apiVersion}/act_${user.adAccount}/campaigns?fields=id,name,status,objective&access_token=${accessToken}`);
        
        if (campaignsData.error) {
          console.error('AgentMode: Campaigns API Error:', campaignsData.error);
          throw new Error(`Campaigns API Error: ${campaignsData.error.message}`);
        }
        
        const matchingCampaigns = (campaignsData.data || []).filter((campaign: any) => 
          campaign.name && campaign.name.toLowerCase().includes(campaign_name.toLowerCase())
        );
        
        if (matchingCampaigns.length === 0) {
          return {
            success: false,
            message: `No campaigns found matching the name "${campaign_name}"`,
            error: 'Campaign not found'
          };
        }
        
        campaignFilterIds = matchingCampaigns.map((c: any) => c.id);
        console.log('AgentMode: Found matching campaign IDs:', campaignFilterIds);
      }

      // Build filtering parameter for API calls
      const filteringParam = campaignFilterIds.length > 0 
        ? `&filtering=[{"field":"campaign.id","operator":"IN","value":["${campaignFilterIds.join('","')}"]}]`
        : '';
      

      // Get campaigns, ad sets, ads, and insights using Graph API - fetch at multiple levels
      // Using fetchWithRetryAndPaging to automatically handle pagination if there are multiple pages
      const [campaignsData, adSetsData, adsData, adInsightsData, adSetInsightsData, campaignInsightsData, insightsDemographicsData, insightsPlacementData, insightsDeviceData] = await Promise.all([
        fetchWithRetryAndPaging(`https://graph.facebook.com/${apiVersion}/act_${user.adAccount}/campaigns?fields=id,name,status,objective${filteringParam}&access_token=${accessToken}`),
        fetchWithRetryAndPaging(`https://graph.facebook.com/${apiVersion}/act_${user.adAccount}/adsets?fields=id,name,status,campaign_id,targeting${filteringParam}&access_token=${accessToken}`),
        fetchWithRetryAndPaging(`https://graph.facebook.com/${apiVersion}/act_${user.adAccount}/ads?fields=id,name,status,adset_id,campaign_id,creative{thumbnail_url,title,body,image_url}${filteringParam}&access_token=${accessToken}`),
        // Ad-level insights for ads processing
        fetchWithRetryAndPaging(`https://graph.facebook.com/${apiVersion}/act_${user.adAccount}/insights?fields=impressions,clicks,spend,ctr,cpc,reach,frequency,campaign_id,adset_id,ad_id,actions,cost_per_action_type&time_range={'since':'${sinceStr}','until':'${untilStr}'}&level=ad${filteringParam}&access_token=${accessToken}`),
        // Adset-level insights for ad sets processing
        fetchWithRetryAndPaging(`https://graph.facebook.com/${apiVersion}/act_${user.adAccount}/insights?fields=impressions,clicks,spend,ctr,cpc,reach,frequency,campaign_id,adset_id,actions,cost_per_action_type&time_range={'since':'${sinceStr}','until':'${untilStr}'}&level=adset${filteringParam}&access_token=${accessToken}`),
        // Campaign-level insights for campaigns processing
        fetchWithRetryAndPaging(`https://graph.facebook.com/${apiVersion}/act_${user.adAccount}/insights?fields=impressions,clicks,spend,ctr,cpc,reach,frequency,campaign_id,actions,cost_per_action_type&time_range={'since':'${sinceStr}','until':'${untilStr}'}&level=campaign${filteringParam}&access_token=${accessToken}`),
        // Demographics breakdown (age/gender)
        fetchWithRetryAndPaging(`https://graph.facebook.com/${apiVersion}/act_${user.adAccount}/insights?fields=impressions,clicks,spend,ctr,cpc,reach,actions,cost_per_action_type,campaign_id&breakdowns=age,gender&time_range={'since':'${sinceStr}','until':'${untilStr}'}&level=campaign${filteringParam}&access_token=${accessToken}`),
        // Placement breakdown (publisher platform and position)
        fetchWithRetryAndPaging(`https://graph.facebook.com/${apiVersion}/act_${user.adAccount}/insights?fields=impressions,clicks,spend,ctr,cpc,reach,actions,cost_per_action_type,campaign_id&breakdowns=publisher_platform,platform_position&time_range={'since':'${sinceStr}','until':'${untilStr}'}&level=campaign${filteringParam}&access_token=${accessToken}`),
        // Device breakdown (mobile/desktop, etc.)
        fetchWithRetryAndPaging(`https://graph.facebook.com/${apiVersion}/act_${user.adAccount}/insights?fields=impressions,clicks,spend,ctr,cpc,reach,actions,cost_per_action_type,campaign_id&breakdowns=impression_device&time_range={'since':'${sinceStr}','until':'${untilStr}'}&level=campaign${filteringParam}&access_token=${accessToken}`)
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

      // Process the data using simplified logic (filtering is now done at API level)
      const adPerformance = this.processCampaignData(campaignsData.data || [], campaignInsightsData.data || [], adSetsData.data || []);
      const processedAdSetsData = this.processAdSetsData(adSetsData.data || [], adSetInsightsData.data || [], campaignsData.data || []);
      const processedAdsData = this.processAdsData(adsData.data || [], adInsightsData.data || [], adSetsData.data || [], campaignsData.data || []);
      const campaignSummary = this.generateCampaignSummary(adPerformance);
      // Filter breakdown data by campaign if filtering is applied
      let demographicsBreakdown = insightsDemographicsData?.data || [];
      let placementBreakdown = insightsPlacementData?.data || [];
      let deviceBreakdown = insightsDeviceData?.data || [];
      
      if (campaignFilterIds.length > 0) {
        demographicsBreakdown = demographicsBreakdown.filter((item: any) => 
          item.campaign_id && campaignFilterIds.includes(item.campaign_id)
        );
        placementBreakdown = placementBreakdown.filter((item: any) => 
          item.campaign_id && campaignFilterIds.includes(item.campaign_id)
        );
        deviceBreakdown = deviceBreakdown.filter((item: any) => 
          item.campaign_id && campaignFilterIds.includes(item.campaign_id)
        );
      }
      
      const processedDemographicsBreakdown = this.processBreakdownData(demographicsBreakdown);
      const processedPlacementBreakdown = this.processBreakdownData(placementBreakdown);
      const processedDeviceBreakdown = this.processBreakdownData(deviceBreakdown);
      
      // Format the data for LLM consumption
      const formattedContent = await this.formatMetricsSummary({
        adPerformance,
        adSetsData: processedAdSetsData,
        adsData: processedAdsData,
        campaignSummary,
        demographicsBreakdown: processedDemographicsBreakdown,
        placementBreakdown: processedPlacementBreakdown,
        deviceBreakdown: processedDeviceBreakdown,
        attributionWindow: { start: sinceStr, end: untilStr, days: attributionDays },
        timeframe
      }, userId);

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
  private async formatMetricsSummary(data: any, userId: string): Promise<string> {
    const { adPerformance, adSetsData, adsData, campaignSummary, demographicsBreakdown, placementBreakdown, deviceBreakdown, attributionWindow } = data;
    
    try {
      const { uploadFileToS3 } = await import('../utils/s3Utils');
      const fileUrls: { url: string; name: string }[] = [];
      
      // Create date range string for filenames
      const startDate = attributionWindow?.start || 'unknown';
      const endDate = attributionWindow?.end || 'unknown';
      const dateRange = `${startDate}_${endDate}`;
      
      // Helper function to convert array to CSV
      const arrayToCSV = (headers: string[], rows: string[][]): string => {
        const csvRows = [headers.join(',')];
        rows.forEach(row => {
          csvRows.push(row.map(cell => {
            // Escape quotes and wrap in quotes if contains comma or quote
            const cellStr = String(cell);
            if (cellStr.includes(',') || cellStr.includes('"') || cellStr.includes('\n')) {
              return `"${cellStr.replace(/"/g, '""')}"`;
            }
            return cellStr;
          }).join(','));
        });
        return csvRows.join('\n');
      };
      
      // 1. Ad-Level Data CSV
      if (adsData && adsData.length > 0) {
        const adRows = adsData.map((ad: any) => [
          ad.name,
          ad.adSetName,
          ad.campaignName,
          String(ad.impressions),
          String(ad.clicks),
          `$${ad.spend.toFixed(2)}`,
          `${ad.ctr.toFixed(2)}%`,
          `$${ad.cpc.toFixed(2)}`,
          String(ad.websiteLeads || 0),
          String(ad.formLeads || 0),
          String(ad.totalLeads || 0),
          `$${(ad.costPerLead || 0).toFixed(2)}`
        ]);
        
        const adCSV = arrayToCSV(
          ['Ad Name', 'Ad Set', 'Campaign', 'Impressions', 'Clicks', 'Spend', 'CTR', 'CPC', 'Website Leads', 'Form Leads', 'Total Leads', 'Cost/Lead'],
          adRows
        );
        const adResult = await uploadFileToS3(
          Buffer.from(adCSV, 'utf-8'),
          `meta-ads-ad-level-data-${dateRange}.csv`,
          userId,
          'text/csv'
        );
        if (adResult.success && adResult.url) {
          fileUrls.push({ url: adResult.url, name: 'Ad-Level Data (all individual ads)' });
        }
      }
      
      // 2. Demographics Breakdown CSV
      if (demographicsBreakdown && demographicsBreakdown.length > 0) {
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
        
        // Sort by spend descending
        const sortedDemographics = Array.from(demographicsMap.values())
          .sort((a, b) => b.spend - a.spend);
        
        const demoRows = sortedDemographics.map((demo: any) => {
          const ctr = demo.impressions > 0 ? (demo.clicks / demo.impressions) * 100 : 0;
          const cpc = demo.clicks > 0 ? demo.spend / demo.clicks : 0;
          const costPerLead = demo.totalLeads > 0 ? demo.spend / demo.totalLeads : 0;
          return [
            demo.age,
            demo.gender,
            String(demo.impressions),
            String(demo.clicks),
            `$${demo.spend.toFixed(2)}`,
            `${ctr.toFixed(2)}%`,
            `$${cpc.toFixed(2)}`,
            String(demo.websiteLeads),
            String(demo.formLeads),
            String(demo.totalLeads),
            `$${costPerLead.toFixed(2)}`
          ];
        });
        
        const demoCSV = arrayToCSV(
          ['Age', 'Gender', 'Impressions', 'Clicks', 'Spend', 'CTR', 'CPC', 'Website Leads', 'Form Leads', 'Total Leads', 'Cost/Lead'],
          demoRows
        );
        const demoResult = await uploadFileToS3(
          Buffer.from(demoCSV, 'utf-8'),
          `meta-ads-demographics-breakdown-${dateRange}.csv`,
          userId,
          'text/csv'
        );
        if (demoResult.success && demoResult.url) {
          fileUrls.push({ url: demoResult.url, name: 'Demographics Breakdown' });
        }
      }
      
      // 3. Placement Breakdown CSV
      if (placementBreakdown && placementBreakdown.length > 0) {
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
              websiteLeads: 0,
              formLeads: 0,
              totalLeads: 0
            });
          }
          const placement = placementMap.get(key);
          placement.impressions += parseInt(item.impressions) || 0;
          placement.clicks += parseInt(item.clicks) || 0;
          placement.spend += parseFloat(item.spend) || 0;
          placement.websiteLeads += parseInt(item.websiteLeads) || 0;
          placement.formLeads += parseInt(item.formLeads) || 0;
          placement.totalLeads = placement.websiteLeads + placement.formLeads;
        });
        
        // Sort by spend descending
        const sortedPlacements = Array.from(placementMap.values())
          .sort((a, b) => b.spend - a.spend);
        
        const placementRows = sortedPlacements.map((placement: any) => {
          const ctr = placement.impressions > 0 ? (placement.clicks / placement.impressions) * 100 : 0;
          const cpc = placement.clicks > 0 ? placement.spend / placement.clicks : 0;
          const costPerLead = placement.totalLeads > 0 ? placement.spend / placement.totalLeads : 0;
          return [
            placement.platform,
            placement.position,
            String(placement.impressions),
            String(placement.clicks),
            `$${placement.spend.toFixed(2)}`,
            `${ctr.toFixed(2)}%`,
            `$${cpc.toFixed(2)}`,
            String(placement.websiteLeads),
            String(placement.formLeads),
            String(placement.totalLeads),
            `$${costPerLead.toFixed(2)}`
          ];
        });
        
        const placementCSV = arrayToCSV(
          ['Platform', 'Position', 'Impressions', 'Clicks', 'Spend', 'CTR', 'CPC', 'Website Leads', 'Form Leads', 'Total Leads', 'Cost/Lead'],
          placementRows
        );
        const placementResult = await uploadFileToS3(
          Buffer.from(placementCSV, 'utf-8'),
          `meta-ads-placement-breakdown-${dateRange}.csv`,
          userId,
          'text/csv'
        );
        if (placementResult.success && placementResult.url) {
          fileUrls.push({ url: placementResult.url, name: 'Placement Breakdown' });
        }
      }
      
      // 4. Device Breakdown CSV
      if (deviceBreakdown && deviceBreakdown.length > 0) {
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
              websiteLeads: 0,
              formLeads: 0,
              totalLeads: 0
            });
          }
          const deviceData = deviceMap.get(device);
          deviceData.impressions += parseInt(item.impressions) || 0;
          deviceData.clicks += parseInt(item.clicks) || 0;
          deviceData.spend += parseFloat(item.spend) || 0;
          deviceData.websiteLeads += parseInt(item.websiteLeads) || 0;
          deviceData.formLeads += parseInt(item.formLeads) || 0;
          deviceData.totalLeads = deviceData.websiteLeads + deviceData.formLeads;
        });
        
        // Sort by spend descending
        const sortedDevices = Array.from(deviceMap.values())
          .sort((a, b) => b.spend - a.spend);
        
        const deviceRows = sortedDevices.map((device: any) => {
          const ctr = device.impressions > 0 ? (device.clicks / device.impressions) * 100 : 0;
          const cpc = device.clicks > 0 ? device.spend / device.clicks : 0;
          const costPerLead = device.totalLeads > 0 ? device.spend / device.totalLeads : 0;
          return [
            device.device,
            String(device.impressions),
            String(device.clicks),
            `$${device.spend.toFixed(2)}`,
            `${ctr.toFixed(2)}%`,
            `$${cpc.toFixed(2)}`,
            String(device.websiteLeads),
            String(device.formLeads),
            String(device.totalLeads),
            `$${costPerLead.toFixed(2)}`
          ];
        });
        
        const deviceCSV = arrayToCSV(
          ['Device', 'Impressions', 'Clicks', 'Spend', 'CTR', 'CPC', 'Website Leads', 'Form Leads', 'Total Leads', 'Cost/Lead'],
          deviceRows
        );
        const deviceResult = await uploadFileToS3(
          Buffer.from(deviceCSV, 'utf-8'),
          `meta-ads-device-breakdown-${dateRange}.csv`,
          userId,
          'text/csv'
        );
        if (deviceResult.success && deviceResult.url) {
          fileUrls.push({ url: deviceResult.url, name: 'Device Breakdown' });
        }
      }
      
      // Build summary with campaign and ad set data, plus file URLs
      let summary = `📊 **Meta Ads Performance Data**\n\n`;
      
      // Attribution Window
      if (attributionWindow && attributionWindow.start && attributionWindow.end) {
        summary += `**Attribution Window:** ${attributionWindow.start} to ${attributionWindow.end} (${attributionWindow.days} days)\n\n`;
      }
      
      // Campaign Summary
      if (campaignSummary) {
        summary += `**📈 Campaign Summary**\n\n`;
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
      
      // Campaign Performance (top 10 by spend)
      if (adPerformance && adPerformance.length > 0) {
        const topCampaigns = adPerformance.slice(0, 10);
        summary += `**🎯 Campaign Performance** (Top ${topCampaigns.length} by Spend)\n\n`;
        summary += `| Campaign Name | Spend | Impressions | Clicks | CTR | CPC | Website Leads | Form Leads | Total Leads | Cost/Lead |\n`;
        summary += `|---------------|-------|-------------|--------|-----|-----|---------------|------------|-------------|----------|\n`;
        
        topCampaigns.forEach((campaign: any) => {
          summary += `| ${campaign.name} | $${campaign.spend.toFixed(2)} | ${campaign.impressions.toLocaleString()} | ${campaign.clicks.toLocaleString()} | ${campaign.ctr.toFixed(2)}% | $${campaign.cpc.toFixed(2)} | ${(campaign.websiteLeads || 0).toLocaleString()} | ${(campaign.formLeads || 0).toLocaleString()} | ${(campaign.totalLeads || 0).toLocaleString()} | $${(campaign.costPerLead || 0).toFixed(2)} |\n`;
        });
        summary += `\n`;
      }
      
      // Ad Sets Performance (top 10 by spend)
      if (adSetsData && adSetsData.length > 0) {
        const topAdSets = adSetsData.slice(0, 10);
        summary += `**📦 Ad Sets Performance** (Top ${topAdSets.length} by Spend)\n\n`;
        summary += `| Ad Set Name | Campaign | Spend | Impressions | Clicks | CTR | CPC | Website Leads | Form Leads | Total Leads | Cost/Lead |\n`;
        summary += `|-------------|----------|-------|-------------|--------|-----|-----|---------------|------------|-------------|----------|\n`;
        
        topAdSets.forEach((adSet: any) => {
          summary += `| ${adSet.name} | ${adSet.campaignName} | $${adSet.spend.toFixed(2)} | ${adSet.impressions.toLocaleString()} | ${adSet.clicks.toLocaleString()} | ${adSet.ctr.toFixed(2)}% | $${adSet.cpc.toFixed(2)} | ${(adSet.websiteLeads || 0).toLocaleString()} | ${(adSet.formLeads || 0).toLocaleString()} | ${(adSet.totalLeads || 0).toLocaleString()} | $${(adSet.costPerLead || 0).toFixed(2)} |\n`;
        });
        summary += `\n`;
      }
      
      // CSV Files Section
      if (fileUrls.length > 0) {
        summary += `**📥 Detailed Data Files**\n\n`;
        summary += `The following CSV files contain detailed ad-level and breakdown data:\n\n`;
        
        fileUrls.forEach((file, index) => {
          summary += `${index + 1}. **${file.name}**\n   📥 [Download CSV](${file.url})\n\n`;
        });
      }
      
      summary += `*Data includes ${adPerformance?.length || 0} campaigns, ${adSetsData?.length || 0} ad sets, and ${adsData?.length || 0} individual ads.*\n`;
      summary += `*Note: Breakdown data (demographics, placement, device) only includes spend from ads with sufficient data for those breakdowns. Breakdown totals may not match campaign totals due to this limitation.*\n`;
      
      return summary;
    } catch (error) {
      console.error('Error generating CSV files for Meta ads metrics:', error);
      // Fallback to text summary if CSV generation fails
      return `📊 **Meta Ads Performance Data**\n\nError generating CSV files: ${error instanceof Error ? error.message : 'Unknown error'}. Please try again.`;
    }
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

  // Knowledge base search functionality
  private async searchKnowledgeBase(query: string, maxResults: number = 5, userId?: string): Promise<any> {
    try {
      console.log('AgentMode: Searching knowledge base for query:', query, 'maxResults:', maxResults);
      
      // Limit max results to 10
      const limitedMaxResults = Math.min(maxResults, 10);
      
      // Search platform knowledge base (both public and private)
      const searchResults = await searchPlatformKnowledgeBase(query, limitedMaxResults, userId);
      
      if (!searchResults || searchResults.length === 0) {
        return {
          success: true,
          message: `No knowledge base results found for "${query}"`,
          query,
          results: [],
          totalResults: 0
        };
      }
      
      return {
        success: true,
        message: `Found ${searchResults.length} knowledge base results for "${query}"`,
        query,
        results: searchResults.map(result => ({
          content: result.content,
          source: result.metadata?.source || 'unknown'
        })),
        totalResults: searchResults.length
      };
    } catch (error) {
      console.error('AgentMode: Error searching knowledge base:', error);
      return {
        success: false,
        message: 'Failed to search the knowledge base. Please try again.',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  // List all knowledge base files for a user
  private async listKnowledgeBaseFiles(userId: string): Promise<any> {
    try {
      console.log('AgentMode: Listing knowledge base files for user:', userId);
      
      // Use the common function to get tasks with knowledge base
      const knowledgeBaseTasks = await taskDb.getTasksWithKnowledgeBase(userId);
      
      if (!knowledgeBaseTasks || knowledgeBaseTasks.length === 0) {
        return {
          success: true,
          message: 'No knowledge base files found',
          files: [],
          totalFiles: 0
        };
      }

      // Map to return file information in the format expected by Agent Mode
      const files = knowledgeBaseTasks.map((task: any) => ({
        file_identifier: task.taskId,
        name: task.name,
        size: task.knowledgeBaseSize,
        type: task.knowledgeBaseType,
        updatedAt: task.knowledgeBaseUpdatedAt
      }));

      return {
        success: true,
        message: `Found ${files.length} knowledge base file(s)`,
        files,
        totalFiles: files.length
      };
    } catch (error) {
      console.error('AgentMode: Error listing knowledge base files:', error);
      return {
        success: false,
        message: 'Failed to list knowledge base files. Please try again.',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  // Read a knowledge base file by its unique identifier
  private async readKnowledgeBaseFile(fileIdentifier: string, userId: string): Promise<any> {
    try {
      console.log('AgentMode: Reading knowledge base file:', fileIdentifier, 'for user:', userId);
      
      if (!fileIdentifier) {
        return {
          success: false,
          message: 'File identifier is required'
        };
      }

      // Get the task
      const task = await taskDb.getTaskById(fileIdentifier);
      
      if (!task) {
        return {
          success: false,
          message: `Knowledge base file with identifier "${fileIdentifier}" not found`
        };
      }

      // Check authorization
      if (task.userId !== userId) {
        return {
          success: false,
          message: 'Not authorized to access this knowledge base file'
        };
      }

      // Check if knowledge base exists
      const size = typeof task.knowledgeBaseSize === 'string' 
        ? parseInt(task.knowledgeBaseSize) 
        : task.knowledgeBaseSize || 0;
      
      if (size === 0) {
        return {
          success: false,
          message: `Knowledge base file "${task.name}" is empty or does not exist`
        };
      }

      // Initialize storage
      const privateKey = await getGCSPPrivateKey();
      const storage = new Storage({
        projectId: process.env.GCS_PROJECT_ID,
        credentials: {
          client_email: process.env.GCS_CLIENT_EMAIL,
          private_key: privateKey
        }
      });

      const BUCKET_NAME = process.env.GCS_BUCKET_NAME || 'agentweb-knowledge-base-dev';
      const PRIVATE_BUCKET_NAME = process.env.GCS_BUCKET_NAME_PRIVATE || 'agentweb-knowledge-base-private-dev';

      // Determine which bucket to use
      const bucketType = task.knowledgeBaseType || 'private';
      const bucket = storage.bucket(bucketType === 'public' ? BUCKET_NAME : PRIVATE_BUCKET_NAME);
      const filePath = `tasks/${fileIdentifier}/knowledge-base.txt`;
      const file = bucket.file(filePath);

      // Check if file exists
      const [exists] = await file.exists();
      
      if (!exists) {
        return {
          success: false,
          message: `Knowledge base file "${task.name}" not found in storage`
        };
      }

      // Download and read the file content
      const [content] = await file.download();
      let contentStr = content.toString();

      // Limit content size to prevent overwhelming the LLM and session storage
      const maxContentLength = 50000; // 50KB limit for tool results
      if (contentStr.length > maxContentLength) {
        contentStr = contentStr.substring(0, maxContentLength) + '\n\n[Content truncated due to size limit]';
        console.log(`AgentMode: Knowledge base content truncated to ${maxContentLength} characters`);
      }

      return {
        success: true,
        message: `Successfully read knowledge base file "${task.name}"`,
        file_identifier: fileIdentifier,
        name: task.name,
        content: contentStr,
        size: size,
        type: bucketType,
        updatedAt: task.knowledgeBaseUpdatedAt || task.updatedAt || task.createdAt
      };
    } catch (error) {
      console.error('AgentMode: Error reading knowledge base file:', error);
      return {
        success: false,
        message: 'Failed to read knowledge base file. Please try again.',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
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
          if (icp.buyerPersonas && Array.isArray(icp.buyerPersonas) && icp.buyerPersonas.length > 0) {
            formattedSummary += `  <em>Buyer Personas:</em> ${icp.buyerPersonas.join(', ')}<br>`;
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

      // Compute content hash for integrity verification
      const contentHash = createHash('sha256').update(extractedContent).digest('hex');
      console.log(`AgentMode: Computed content hash: ${contentHash}`);

      return {
        success: true,
        content: extractedContent,
        content_hash: contentHash,
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
    sessionId: string,
    imageModel?: string
  ): Promise<any> {
    try {
      console.log('AgentMode: Generating image with prompt:', prompt, 'filename:', filename, 'size:', size, 'quality:', quality, 'inputImages:', inputImages, 'imageModel:', imageModel, 'userId:', userId, 'sessionId:', sessionId);
      
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

      // Yield control before starting long-running image generation
      // This allows health checks to be processed even during the image generation API call
      await new Promise(resolve => setImmediate(resolve));
      
      // Generate the image
      const result = await imageService.generateImage({
        prompt,
        filename,
        size,
        quality,
        inputImages: inputImages || [],
        userId,
        imageModel
      });
      
      // Yield control after image generation completes
      await new Promise(resolve => setImmediate(resolve));

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

  /**
   * Remove C2PA metadata from an image by downloading it, stripping metadata, and uploading to S3
   */
  private async removeC2PAFromImage(
    imageUrl: string,
    filename?: string,
    userId?: string
  ): Promise<any> {
    try {
      console.log('AgentMode: Removing C2PA metadata from image:', imageUrl);
      
      if (!imageUrl) {
        return {
          success: false,
          message: 'Image URL is required',
          error: 'missing_image_url'
        };
      }

      // Import required services
      const axios = require('axios');
      const { uploadFileToS3 } = await import('../utils/s3Utils');
      const { imageService } = await import('./imageGeneration');

      // Download the image
      let imageBuffer: Buffer;
      if (imageUrl.startsWith('data:image/')) {
        // Handle data URL
        const base64Data = imageUrl.split(',')[1];
        imageBuffer = Buffer.from(base64Data, 'base64');
      } else {
        // Download from URL
        const response = await axios.get(imageUrl, {
          responseType: 'arraybuffer',
          timeout: 30000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; AgentWeb/1.0)'
          }
        });
        imageBuffer = Buffer.from(response.data);
      }

      // Remove C2PA metadata using the imageService's method
      const cleanedBuffer = await imageService.removeC2PAMetadata(imageBuffer);

      // Generate filename if not provided
      let finalFilename = filename;
      if (!finalFilename) {
        // Extract filename from URL or generate one
        try {
          const urlObj = new URL(imageUrl);
          const pathParts = urlObj.pathname.split('/');
          const urlFilename = pathParts[pathParts.length - 1];
          if (urlFilename && urlFilename.includes('.')) {
            // Replace extension with .png
            const nameWithoutExt = urlFilename.substring(0, urlFilename.lastIndexOf('.'));
            finalFilename = `${nameWithoutExt}_no_c2pa.png`;
          } else {
            finalFilename = `image_no_c2pa_${Date.now()}.png`;
          }
        } catch {
          finalFilename = `image_no_c2pa_${Date.now()}.png`;
        }
      } else if (!finalFilename.endsWith('.png')) {
        // Ensure .png extension
        const nameWithoutExt = finalFilename.substring(0, finalFilename.lastIndexOf('.') || finalFilename.length);
        finalFilename = `${nameWithoutExt}.png`;
      }

      // Upload to S3
      if (!userId) {
        return {
          success: false,
          message: 'User ID is required for S3 upload',
          error: 'missing_user_id'
        };
      }

      const uploadResult = await uploadFileToS3(
        cleanedBuffer,
        finalFilename,
        userId,
        'image/png'
      );

      if (!uploadResult.success || !uploadResult.url) {
        return {
          success: false,
          message: uploadResult.error || 'Failed to upload cleaned image to S3',
          error: uploadResult.error || 's3_upload_failed'
        };
      }

      return {
        success: true,
        message: `✅ C2PA metadata removed successfully! Image uploaded to S3.`,
        imageUrl: uploadResult.url,
        filename: finalFilename,
        originalUrl: imageUrl
      };

    } catch (error: any) {
      console.error('AgentMode: Error removing C2PA metadata:', error);
      return {
        success: false,
        message: 'Failed to remove C2PA metadata from image',
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
    sessionId: string,
    style: string = 'default'
  ): Promise<any> {
    try {
      console.log('AgentMode: Creating blog article for topic:', topic, 'tone:', tone, 'length:', length, 'userId:', userId);
      
      // Import required services
      const { uploadFileToS3 } = await import('../utils/s3Utils');

      // Step 1: Generate blog content using existing blog.ts utility function
      console.log('AgentMode: Generating blog content using existing blog service...');
      const { generateBlogContent } = await import('../controllers/blog');
      
      // Use the requirements passed from the LLM, and include style for Substack-style writing
      const blogData = await generateBlogContent(topic, keywords, tone, length, researchContext, requirements, style);

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
      console.log('AgentMode: Generating HTML file with style:', style);
      const { generateBlogHtml } = await import('../controllers/blog');
      const htmlContent = generateBlogHtml(blogData.title, blogData.description, blogData.content, imageData.imageUrl, style);
      
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

  private async createSocialMediaPosts(
    posts: Array<{ type: string; content: string; image_url?: string }>,
    userId: string,
    sessionId: string
  ): Promise<any> {
    try {
      console.log('AgentMode: Creating social media posts, count:', posts?.length || 0);
      
      if (!posts || !Array.isArray(posts) || posts.length === 0) {
        return {
          success: false,
          message: 'No posts provided. Please provide an array of posts.',
          error: 'invalid_input'
        };
      }

      // Import required utilities
      const { uploadFileToS3 } = await import('../utils/s3Utils');

      // Dynamically import remark modules (ES modules)
      const { remark } = await import('remark');
      const remarkHtml = (await import('remark-html')).default;
      const remarkGfm = (await import('remark-gfm')).default;
      const remarkBreaks = (await import('remark-breaks')).default;

      // Convert markdown to HTML processor
      const processor = remark()
        .use(remarkGfm) // GitHub Flavored Markdown support
        .use(remarkBreaks) // Convert line breaks to <br> tags
        .use(remarkHtml, { sanitize: false }); // Convert to HTML

      // Generate HTML for each post
      const postsHtml = posts.map((post, index) => {
        const postNumber = index + 1;
        // Map post types to display labels
        const typeLabelMap: Record<string, string> = {
          'linkedin': 'LinkedIn',
          'x/twitter': 'X (Twitter)',
          'instagram': 'Instagram',
          'facebook': 'Facebook',
          'custom': 'Custom'
        };
        const typeLabel = typeLabelMap[post.type] || post.type.charAt(0).toUpperCase() + post.type.slice(1);
        
        // Convert markdown content to HTML
        const htmlContent = processor.processSync(post.content || '').toString();
        
        // Build post HTML
        let postHtml = `
      <div class="post" data-type="${post.type}">
        <div class="post-header">
          <span class="post-number">Post ${postNumber}</span>
          <span class="post-type">${typeLabel}</span>
        </div>
        <div class="post-content">
          ${htmlContent}
        </div>`;

        // Add image if provided
        if (post.image_url) {
          postHtml += `
        <div class="post-image">
          <img src="${post.image_url}" alt="Post image" />
        </div>`;
        }

        // Add copy button
        postHtml += `
        <div class="post-actions">
          <button class="copy-button" onclick="copyPostContent(${index})">Copy Content</button>
        </div>
        <div class="post-raw-content" id="post-${index}-raw" style="display: none;">${post.content}</div>
      </div>`;

        return postHtml;
      }).join('\n');

      // Generate complete HTML file
      const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Social Media Posts</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            line-height: 1.6;
            color: #333;
            background-color: #f5f5f5;
            padding: 20px;
        }
        .container {
            max-width: 800px;
            margin: 0 auto;
            background-color: #ffffff;
            border-radius: 8px;
            box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
            padding: 30px;
        }
        h1 {
            font-size: 28px;
            font-weight: 700;
            margin-bottom: 10px;
            color: #1a1a1a;
        }
        .subtitle {
            color: #666;
            margin-bottom: 30px;
            font-size: 14px;
        }
        .post {
            border: 1px solid #e0e0e0;
            border-radius: 8px;
            padding: 20px;
            margin-bottom: 30px;
            background-color: #fafafa;
        }
        .post-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 15px;
            padding-bottom: 10px;
            border-bottom: 2px solid #e0e0e0;
        }
        .post-number {
            font-weight: 600;
            color: #666;
            font-size: 14px;
        }
        .post-type {
            background-color: #0077b5;
            color: white;
            padding: 4px 12px;
            border-radius: 4px;
            font-size: 12px;
            font-weight: 600;
            text-transform: uppercase;
        }
        .post[data-type="x/twitter"] .post-type {
            background-color: #1da1f2;
        }
        .post[data-type="instagram"] .post-type {
            background: linear-gradient(45deg, #f09433 0%, #e6683c 25%, #dc2743 50%, #cc2366 75%, #bc1888 100%);
        }
        .post[data-type="facebook"] .post-type {
            background-color: #1877f2;
        }
        .post[data-type="custom"] .post-type {
            background-color: #666;
        }
        .post-content {
            margin: 15px 0;
            font-size: 16px;
            line-height: 1.6;
            color: #333;
        }
        .post-content p {
            margin-bottom: 12px;
        }
        .post-content h1, .post-content h2, .post-content h3 {
            margin-top: 20px;
            margin-bottom: 12px;
        }
        .post-content ul, .post-content ol {
            margin-left: 20px;
            margin-bottom: 12px;
        }
        .post-content a {
            color: #0077b5;
            text-decoration: none;
        }
        .post-content a:hover {
            text-decoration: underline;
        }
        .post-image {
            margin: 15px 0;
        }
        .post-image img {
            max-width: 100%;
            height: auto;
            border-radius: 4px;
            box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
        }
        .post-actions {
            margin-top: 15px;
            padding-top: 15px;
            border-top: 1px solid #e0e0e0;
        }
        .copy-button {
            background-color: #0077b5;
            color: white;
            border: none;
            padding: 8px 16px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
            font-weight: 500;
            transition: background-color 0.2s;
        }
        .copy-button:hover {
            background-color: #005885;
        }
        .copy-button:active {
            transform: scale(0.98);
        }
        .post-raw-content {
            display: none;
        }
        @media (max-width: 600px) {
            .container {
                padding: 15px;
            }
            .post {
                padding: 15px;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>Social Media Posts</h1>
        <p class="subtitle">${posts.length} post${posts.length !== 1 ? 's' : ''} created</p>
        ${postsHtml}
    </div>
    <script>
        function copyPostContent(index) {
            const rawContentElement = document.getElementById('post-' + index + '-raw');
            if (!rawContentElement) return;
            
            const content = rawContentElement.textContent || rawContentElement.innerText;
            
            // Create a temporary textarea to copy text
            const textarea = document.createElement('textarea');
            textarea.value = content;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.select();
            
            try {
                document.execCommand('copy');
                const button = event.target;
                const originalText = button.textContent;
                button.textContent = 'Copied!';
                button.style.backgroundColor = '#28a745';
                setTimeout(() => {
                    button.textContent = originalText;
                    button.style.backgroundColor = '#0077b5';
                }, 2000);
            } catch (err) {
                console.error('Failed to copy:', err);
                alert('Failed to copy content. Please select and copy manually.');
            }
            
            document.body.removeChild(textarea);
        }
    </script>
</body>
</html>`;

      // Upload HTML file to S3
      console.log('AgentMode: Uploading social media posts HTML file to S3...');
      const htmlFilename = `social-media-posts-${Date.now()}.html`;
      
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

      console.log('AgentMode: Social media posts HTML file uploaded successfully to:', htmlUrl);

      return {
        success: true,
        message: `Successfully created ${posts.length} social media post${posts.length !== 1 ? 's' : ''}`,
        htmlUrl: htmlUrl,
        postsCount: posts.length
      };

    } catch (error: any) {
      console.error('AgentMode: Error creating social media posts:', error);
      return {
        success: false,
        message: 'Failed to create social media posts',
        error: error.message
      };
    }
  }

  /**
   * Get task subscriber metrics for Agent Mode function calls
   */
  private async getTaskSubscriberMetrics(taskId: string, userId: string): Promise<any> {
    try {
      const { TaskSubscriberMetricsService } = await import('./taskSubscriberMetricsService');
      const metrics = await TaskSubscriberMetricsService.getTaskSubscriberMetrics(taskId, userId);
      
      // Strip engagedEmails from subject metrics to reduce data for agent processing
      const cleanedMetrics = {
        ...metrics,
        metrics: {
          ...metrics.metrics,
          subjectMetrics: Object.fromEntries(
            Object.entries(metrics.metrics.subjectMetrics).map(([subject, subjectData]) => [
              subject,
              Object.fromEntries(
                Object.entries(subjectData).filter(([key]) => key !== 'engagedEmails')
              )
            ])
          )
        }
      };
      
      return {
        success: true,
        message: 'Task subscriber metrics retrieved successfully',
        data: cleanedMetrics
      };
    } catch (error: any) {
      console.error('AgentMode: Error getting task subscriber metrics:', error);
      return {
        success: false,
        message: 'Failed to get task subscriber metrics',
        error: error.message
      };
    }
  }

  /**
   * Get task subscriber engagement events for Agent Mode function calls
   * Returns engagement metrics instead of raw events for better agent processing
   */
  private async getTaskSubscriberEngagementEvents(taskId: string, emailSubject: string, userId: string): Promise<any> {
    try {
      const { TaskSubscriberMetricsService } = await import('./taskSubscriberMetricsService');
      const events = await TaskSubscriberMetricsService.getTaskSubscriberEngagementEvents(taskId, emailSubject, userId);
      
      // Transform raw events into meaningful engagement metrics
      const engagementMetrics = this.calculateEngagementMetrics(events);
      
      return {
        success: true,
        message: 'Task subscriber engagement metrics retrieved successfully',
        data: engagementMetrics
      };
    } catch (error: any) {
      console.error('AgentMode: Error getting task subscriber engagement events:', error);
      return {
        success: false,
        message: 'Failed to get task subscriber engagement events',
        error: error.message
      };
    }
  }

  /**
   * Calculate engagement metrics from raw events data
   */
  private calculateEngagementMetrics(events: any) {
    const { eventsByUser, totalEngagedUsers, taskId, emailSubject } = events;
    
    if (totalEngagedUsers === 0) {
      return {
        taskId,
        emailSubject,
        engagementPatterns: {
          immediateEngagement: 0,
          delayedEngagement: 0,
          multiTouchEngagement: 0,
          singleTouchEngagement: 0
        },
        timingMetrics: {
          averageTimeToOpen: null,
          averageTimeToClick: null,
          fastestEngagement: null,
          slowestEngagement: null
        },
        linkAnalysis: []
      };
    }

    // Calculate engagement-specific metrics
    let clickedCount = 0;
    const linkClicks = new Map<string, number>();
    const engagementTimes: number[] = [];
    const openTimes: number[] = [];
    const clickTimes: number[] = [];

    // Analyze each user's engagement
    let immediateEngagement = 0; // Users who engaged within 1 hour
    let delayedEngagement = 0; // Users who engaged after 1 hour
    let multiTouchEngagement = 0; // Users with 2+ engagement events (opened or clicked)
    let singleTouchEngagement = 0; // Users with only 1 engagement event (opened or clicked)

    eventsByUser.forEach((user: any) => {
      const userEvents = user.events;
      
      // Count event types for engagement analysis
      const eventTypes = new Set(userEvents.map((e: any) => e.eventType));
      userEvents.forEach((event: any) => {
        if (event.eventType === 'email.clicked') {
          clickedCount++;
          if (event.link) {
            // Normalize unsubscribe links by replacing email with placeholder
            let normalizedLink = event.link;
            if (event.link.includes('/unsubscribe?') && event.link.includes('email=')) {
              normalizedLink = event.link.replace(/email=[^&]+/, 'email=placeholder@example.com');
            }
            linkClicks.set(normalizedLink, (linkClicks.get(normalizedLink) || 0) + 1);
          }
        }
      });

      // Calculate engagement timing
      if (userEvents.length > 0) {
        const firstEvent = userEvents[0];
        const firstEventTime = new Date(firstEvent.createdAt).getTime();
        const emailSentTime = firstEventTime; // Assuming first event is delivery
        
        // Find first engagement (open or click)
        const firstEngagement = userEvents.find((e: any) => 
          e.eventType === 'email.opened' || e.eventType === 'email.clicked'
        );
        
        if (firstEngagement) {
          const engagementTime = new Date(firstEngagement.createdAt).getTime();
          const timeToEngagement = engagementTime - emailSentTime;
          engagementTimes.push(timeToEngagement);
          
          // Categorize engagement timing
          if (timeToEngagement <= 3600000) { // 1 hour in milliseconds
            immediateEngagement++;
          } else {
            delayedEngagement++;
          }
        }

        // Find open and click times
        const openEvent = userEvents.find((e: any) => e.eventType === 'email.opened');
        const clickEvent = userEvents.find((e: any) => e.eventType === 'email.clicked');
        
        if (openEvent) {
          const openTime = new Date(openEvent.createdAt).getTime();
          openTimes.push(openTime - emailSentTime);
        }
        
        if (clickEvent) {
          const clickTime = new Date(clickEvent.createdAt).getTime();
          clickTimes.push(clickTime - emailSentTime);
        }

        // Categorize engagement depth based on opened/clicked events
        const engagementEvents = userEvents.filter((event: any) => 
          event.eventType === 'email.opened' || event.eventType === 'email.clicked'
        );
        
        if (engagementEvents.length >= 2) {
          multiTouchEngagement++;
        } else if (engagementEvents.length === 1) {
          singleTouchEngagement++;
        }
      }
    });

    // Calculate timing metrics
    const averageTimeToOpen = openTimes.length > 0 
      ? Math.round(openTimes.reduce((a, b) => a + b, 0) / openTimes.length / 1000 / 60) // Convert to minutes
      : null;
    
    const averageTimeToClick = clickTimes.length > 0 
      ? Math.round(clickTimes.reduce((a, b) => a + b, 0) / clickTimes.length / 1000 / 60) // Convert to minutes
      : null;

    const fastestEngagement = engagementTimes.length > 0 
      ? Math.round(Math.min(...engagementTimes) / 1000 / 60) // Convert to minutes
      : null;
    
    const slowestEngagement = engagementTimes.length > 0 
      ? Math.round(Math.max(...engagementTimes) / 1000 / 60) // Convert to minutes
      : null;

    // Convert link clicks map to array of objects
    const linkAnalysis = Array.from(linkClicks.entries()).map(([url, clicks]) => ({
      url,
      clicks
    })).sort((a, b) => b.clicks - a.clicks); // Sort by click count descending

    return {
      taskId,
      emailSubject,
      engagementPatterns: {
        immediateEngagement,
        delayedEngagement,
        multiTouchEngagement,
        singleTouchEngagement
      },
      timingMetrics: {
        averageTimeToOpen,
        averageTimeToClick,
        fastestEngagement,
        slowestEngagement
      },
      linkAnalysis
    };
  }

  // List all HTML templates for the user (including email templates)
  private async listHtmlTemplates(userId: string): Promise<any> {
    try {
      const settingName = `email_templates_${userId}`;
      const setting = await settingsService.getSetting(settingName);
      
      let templates = [];
      if (setting) {
        try {
          templates = JSON.parse(setting.settingValue);
        } catch (error) {
          console.error('Error parsing email templates:', error);
          templates = [];
        }
      }
      
      return {
        success: true,
        email_templates: templates.map((template: any) => ({
          template_name: template.template_name,
          subject: template.subject,
          variables: template.variables || [],
          arrayVariables: template.arrayVariables || [],
          created_at: template.created_at,
          updated_at: template.updated_at
        }))
      };
    } catch (error) {
      console.error('Error listing email templates:', error);
      return {
        success: false,
        message: 'Failed to list email templates',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  // Update HTML file with direct content replacement
  private async updateHtmlFile(
    fileUrl: string,
    updateType: string,
    replacementInstructions: any,
    userId: string,
    sessionId: string
  ): Promise<any> {
    try {
      // Validate update_type
      if (!updateType || !['part', 'full'].includes(updateType)) {
        return {
          success: false,
          message: 'update_type must be either "part" or "full"'
        };
      }
      
      // Validate that replacementInstructions is an array
      if (!Array.isArray(replacementInstructions)) {
        return {
          success: false,
          message: 'replacement_json must be an array of replacement instructions'
        };
      }
      
      if (replacementInstructions.length === 0) {
        return {
          success: false,
          message: 'At least one replacement instruction is required'
        };
      }
      
      // Validate each replacement instruction based on update_type
      for (let i = 0; i < replacementInstructions.length; i++) {
        const instruction = replacementInstructions[i];
        
        if (instruction.new_content === undefined || instruction.expected_count === undefined) {
          return {
            success: false,
            message: `Missing required fields in replacement instruction ${i + 1}: new_content and expected_count are required`
          };
        }
        
        if (updateType === 'full') {
          // For full replacement, require old_file_hash
          if (!instruction.old_file_hash) {
            return {
              success: false,
              message: `Replacement instruction ${i + 1} missing old_file_hash. For update_type="full", old_file_hash is required`
            };
          }
          if (instruction.old_content !== undefined) {
            return {
              success: false,
              message: `Replacement instruction ${i + 1} should not have old_content when update_type="full". Use old_file_hash instead`
            };
          }
        } else if (updateType === 'part') {
          // For part replacement, require old_content
          if (!instruction.old_content) {
            return {
              success: false,
              message: `Replacement instruction ${i + 1} missing old_content. For update_type="part", old_content is required`
            };
          }
          if (instruction.old_file_hash !== undefined) {
            return {
              success: false,
              message: `Replacement instruction ${i + 1} should not have old_file_hash when update_type="part". Use old_content instead`
            };
          }
        }
      }
      
      // Fetch current file content
      const currentContent = await this.fetchFileContent(fileUrl);
      console.log(`AgentMode: Fetched file content, length: ${currentContent.length} characters`);
      
      // Compute hash of current content for verification
      const currentContentHash = createHash('sha256').update(currentContent).digest('hex');
      console.log(`AgentMode: Computed current content hash: ${currentContentHash}`);
      
      let updatedContent = currentContent;
      
      // Perform all replacements
      const replacementResults = [];
      
      for (let i = 0; i < replacementInstructions.length; i++) {
        const instruction = replacementInstructions[i];
        const { new_content, expected_count } = instruction;
        
        if (updateType === 'full') {
          // Entire file replacement using hash
          const { old_file_hash } = instruction;
          console.log(`AgentMode: Full replacement ${i + 1}: old_file_hash: ${old_file_hash}, new_content length: ${new_content.length}, expected_count: ${expected_count}`);
          
          // Verify that the provided hash matches the current content hash
          if (old_file_hash !== currentContentHash) {
            return {
              success: false,
              message: `Replacement ${i + 1} failed: File hash mismatch. Expected: ${currentContentHash}, provided: ${old_file_hash}. The file may have been modified since it was last read.`,
              suggestion: 'Use read_file_content to get the current content and hash, then retry the replacement'
            };
          }
          
          // For hash-based replacement, we replace the entire content
          if (expected_count === 1) {
            console.log(`AgentMode: Hash verification successful, replacing entire content`);
            updatedContent = new_content;
            replacementResults.push({
              index: i + 1,
              old_file_hash: old_file_hash,
              new_content: new_content,
              expected_count: expected_count,
              actual_count: 1,
              success: true
            });
          } else {
            return {
              success: false,
              message: `Replacement ${i + 1} failed: Full replacement only supports expected_count of 1 (entire file replacement)`,
              suggestion: 'Use expected_count: 1 for full file replacement'
            };
          }
        } else if (updateType === 'part') {
          // Partial content replacement using old_content
          const { old_content } = instruction;
          console.log(`AgentMode: Part replacement ${i + 1}: old_content length: ${old_content.length}, new_content length: ${new_content.length}, expected_count: ${expected_count}`);
          
          // Perform the replacement using the existing logic
          const replacementResult = this.performDirectReplacement(
            updatedContent,
            old_content,
            new_content,
            true // exact_match = true for partial replacements
          );
          
          if (replacementResult === null) {
            return {
              success: false,
              message: `Replacement ${i + 1} failed: The old_content was not found in the file. No changes were made to the file.`,
              suggestion: 'Check that the old_content exactly matches the content in the file'
            };
          }
          
          // Check if the actual change count matches expected count
          if (replacementResult.changeCount !== expected_count) {
            return {
              success: false,
              message: `Replacement ${i + 1} failed: Expected ${expected_count} occurrences of old_content, but found ${replacementResult.changeCount}. No changes were made to the file.`,
              suggestion: 'Check the expected_count matches the actual number of occurrences in the file'
            };
          }
          
          updatedContent = replacementResult.content;
          replacementResults.push({
            index: i + 1,
            old_content: old_content,
            new_content: new_content,
            expected_count: expected_count,
            actual_count: replacementResult.changeCount,
            success: true
          });
        }
      }
      
      // Create versioned filename and upload the updated content
      const versionedFilename = this.createVersionedFilename(fileUrl);
      console.log(`AgentMode: Original file URL: ${fileUrl}`);
      console.log(`AgentMode: Generated versioned filename: ${versionedFilename}`);
      const originalPath = this.extractPathFromS3Url(fileUrl);
      console.log(`AgentMode: Original path: ${originalPath}`);
      const uploadResult = await this.uploadUpdatedFile(updatedContent, versionedFilename, originalPath);
      
      return {
        success: true,
        s3_url: uploadResult.url,
        message: `File updated successfully with ${replacementResults.length} replacements`,
        method: 'mixed_replacement',
        replacements: replacementResults,
        versioned_filename: versionedFilename
      };
      
    } catch (error) {
      console.error('Error updating HTML file:', error);
      return {
        success: false,
        message: 'Failed to update HTML file',
        error: error instanceof Error ? error.message : 'Unknown error',
        suggestion: 'For entire file replacement, use old_file_hash from read_file_content. For partial replacement, use old_content with the exact text to replace'
      };
    }
  }

  // Fetch file content from URL
  private async fetchFileContent(fileUrl: string): Promise<string> {
    try {
      const response = await fetch(fileUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch file: ${response.status} ${response.statusText}`);
      }
      return await response.text();
    } catch (error) {
      console.error('Error fetching file content:', error);
      throw new Error(`Failed to fetch file content: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  // Perform direct replacement of old content with new content
  private performDirectReplacement(
    content: string,
    oldContent: string,
    newContent: string,
    exactMatch: boolean = true
  ): { content: string; changeCount: number } | null {
    try {
      // For entire file replacement (when oldContent is very large), use more flexible matching
      if (oldContent.length > 1000) {
        if (exactMatch) {
          // Use exact string comparison
          if (content === oldContent) {
            console.log(`AgentMode: Exact match found for entire file replacement`);
            return { content: newContent, changeCount: 1 };
          } else {
            console.warn(`Old content does not match exactly. Expected length: ${oldContent.length}, actual length: ${content.length}`);
            console.warn(`First 100 chars of expected: ${oldContent.substring(0, 100)}`);
            console.warn(`First 100 chars of actual: ${content.substring(0, 100)}`);
            return null;
          }
        } else {
          // Use normalized whitespace comparison for flexible matching
          const normalizedContent = content.replace(/\s+/g, ' ').trim();
          const normalizedOldContent = oldContent.replace(/\s+/g, ' ').trim();
          
          if (normalizedContent === normalizedOldContent) {
            console.log(`AgentMode: Normalized match found for entire file replacement`);
            return { content: newContent, changeCount: 1 };
          } else {
            // Try exact match as fallback
            if (content === oldContent) {
              console.log(`AgentMode: Exact match found for entire file replacement (fallback)`);
              return { content: newContent, changeCount: 1 };
            } else {
              console.warn(`Old content does not match even with normalization. Expected length: ${oldContent.length}, actual length: ${content.length}`);
              console.warn(`First 100 chars of expected: ${oldContent.substring(0, 100)}`);
              console.warn(`First 100 chars of actual: ${content.substring(0, 100)}`);
              return null;
            }
          }
        }
      }
      
      // For smaller content, use regex for more flexible matching
      const changeCount = (content.match(new RegExp(oldContent.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
      
      // Check if old content exists
      if (changeCount === 0) {
        console.warn(`Old content not found. Content length: ${content.length}, old content length: ${oldContent.length}`);
        return null;
      }
      
      // Perform replacement - replace all occurrences
      const updatedContent = content.replace(new RegExp(oldContent.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), newContent);
      
      return { content: updatedContent, changeCount };
      
    } catch (error) {
      console.error('Error in direct replacement:', error);
      return null;
    }
  }

  // Extract path from S3 URL
  private extractPathFromS3Url(s3Url: string): string {
    try {
      // Parse the S3 URL to extract the key
      const url = new URL(s3Url);
      const key = url.pathname.substring(1); // Remove leading slash
      
      // Extract path by removing the filename
      const lastSlashIndex = key.lastIndexOf('/');
      if (lastSlashIndex === -1) {
        return ''; // No path, just filename
      }
      
      return key.substring(0, lastSlashIndex);
    } catch (error) {
      console.error('Error extracting path from S3 URL:', error);
      return '';
    }
  }

  // Create versioned filename
  private createVersionedFilename(originalUrl: string): string {
    try {
      // Extract filename from original URL
      const urlParts = originalUrl.split('/');
      const filename = urlParts[urlParts.length - 1];
      console.log(`AgentMode: Extracted filename: ${filename}`);
      
      // Split filename into name and extension
      const lastDotIndex = filename.lastIndexOf('.');
      if (lastDotIndex === -1) {
        // No extension, just add version
        console.log(`AgentMode: No extension found, adding _v2`);
        return `${filename}_v2`;
      }
      
      const nameWithoutExt = filename.substring(0, lastDotIndex);
      const extension = filename.substring(lastDotIndex);
      console.log(`AgentMode: Name without ext: ${nameWithoutExt}, extension: ${extension}`);
      
      // Check if filename already has a version pattern (_v followed by digits)
      const versionMatch = nameWithoutExt.match(/^(.+)_v(\d+)$/);
      console.log(`AgentMode: Version match result:`, versionMatch);
      
      if (versionMatch) {
        // Extract base name and current version number
        const baseName = versionMatch[1];
        const currentVersion = parseInt(versionMatch[2], 10);
        const newVersion = currentVersion + 1;
        console.log(`AgentMode: Found existing version ${currentVersion}, incrementing to ${newVersion}`);
        return `${baseName}_v${newVersion}${extension}`;
      } else {
        // No existing version, add _v2
        console.log(`AgentMode: No existing version found, adding _v2`);
        return `${nameWithoutExt}_v2${extension}`;
      }
    } catch (error) {
      console.error('Error creating versioned filename:', error);
      // Fallback: add timestamp to avoid conflicts
      const timestamp = Date.now();
      const urlParts = originalUrl.split('/');
      const filename = urlParts[urlParts.length - 1];
      const lastDotIndex = filename.lastIndexOf('.');
      
      if (lastDotIndex === -1) {
        return `${filename}_v2_${timestamp}`;
      } else {
        const nameWithoutExt = filename.substring(0, lastDotIndex);
        const extension = filename.substring(lastDotIndex);
        return `${nameWithoutExt}_v2_${timestamp}${extension}`;
      }
    }
  }

  // Upload updated file content
  private async uploadUpdatedFile(
    content: string,
    filename: string,
    path: string
  ): Promise<{ url: string }> {
    try {
      // Upload to S3 with the same path as the original file
      const { uploadFileToS3WithPath } = await import('../utils/s3Utils');
      const uploadResult = await uploadFileToS3WithPath(content, filename, 'text/html', path);
      
      if (!uploadResult.success || !uploadResult.url) {
        throw new Error(uploadResult.error || 'Failed to upload updated file');
      }
      
      return { url: uploadResult.url };
    } catch (error) {
      console.error('Error uploading updated file:', error);
      throw new Error(`Failed to upload updated file: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  // Create HTML from template with variable substitution
    private async createHtmlFromTemplate(
      templateName: string,
      variableValues: Record<string, string> | undefined,
      arrayVariableValues: Record<string, string[]> | undefined,
      userId: string,
      sessionId: string
    ): Promise<any> {
    try {
      // Get the template
      const settingName = `email_templates_${userId}`;
      const setting = await settingsService.getSetting(settingName);
      
      if (!setting) {
        return {
          success: false,
          message: 'No email templates found for user'
        };
      }
      
      let templates = [];
      try {
        templates = JSON.parse(setting.settingValue);
      } catch (error) {
        console.error('Error parsing email templates:', error);
        return {
          success: false,
          message: 'Failed to parse email templates'
        };
      }
      
      // Find the specific template
      const template = templates.find((t: any) => t.template_name === templateName);
      if (!template) {
        return {
          success: false,
          message: `Template '${templateName}' not found`
        };
      }

      // Validate template structure first
      if (!template.html_content || !template.subject) {
        return {
          success: false,
          message: 'Invalid template structure: missing html_content or subject'
        };
      }

      // Validate that all required variables are provided
      const templateVariables = template.variables || [];
      const templateArrayVariables = template.arrayVariables || [];
      
      // Parameters are already objects
      const variableValuesObj = variableValues || {};
      const arrayVariableValuesObj = arrayVariableValues || {};
      
      // Check for missing regular variables
      const missingVariables = templateVariables.filter((variable: string) => 
        !(variable in variableValuesObj)
      );
      
      // Check for missing array variables
      const missingArrayVariables = templateArrayVariables.filter((variable: string) => 
        !(variable in arrayVariableValuesObj)
      );
      
      // Check for extra variables that aren't in the template
      const extraVariables = Object.keys(variableValuesObj).filter(variable => 
        !templateVariables.includes(variable)
      );
      
      const extraArrayVariables = Object.keys(arrayVariableValuesObj).filter(variable => 
        !templateArrayVariables.includes(variable)
      );
      
      // Build validation error message
      const validationErrors = [];
      
      if (missingVariables.length > 0) {
        validationErrors.push(`Missing required variables: ${missingVariables.join(', ')}`);
      }
      
      if (missingArrayVariables.length > 0) {
        validationErrors.push(`Missing required array variables: ${missingArrayVariables.join(', ')}`);
      }
      
      if (extraVariables.length > 0) {
        validationErrors.push(`Extra variables provided: ${extraVariables.join(', ')}`);
      }
      
      if (extraArrayVariables.length > 0) {
        validationErrors.push(`Extra array variables provided: ${extraArrayVariables.join(', ')}`);
      }
      
      // Validate array variable values are actually arrays
      const invalidArrayVariables = Object.entries(arrayVariableValuesObj).filter(([key, value]) => 
        !Array.isArray(value)
      );
      
      if (invalidArrayVariables.length > 0) {
        validationErrors.push(`Array variable items must be an array: ${invalidArrayVariables.map(([key]) => key).join(', ')}`);
      }
      
      if (validationErrors.length > 0) {
        return {
          success: false,
          message: validationErrors.join('; '),
          errors: validationErrors,
          template_variables: templateVariables,
          template_array_variables: templateArrayVariables
        };
      }
      
      // Use LLM to handle variable substitution
      const substitutionPrompt = `You are a template engine. Your task is to replace variables in HTML templates with provided values while preserving the exact same format and structure.

TEMPLATE HTML:
${template.html_content}

TEMPLATE SUBJECT:
${template.subject}

VARIABLE VALUES:
${JSON.stringify(variableValuesObj, null, 2)}

ARRAY VARIABLE VALUES:
${JSON.stringify(arrayVariableValuesObj, null, 2)}

CRITICAL INSTRUCTIONS:
1. PRESERVE THE EXACT FORMAT: Keep the same HTML structure, tags, classes, and styling as the original template
2. REPLACE VARIABLES: Replace all {{variable_name}} placeholders with corresponding values
3. ARRAY VARIABLES: For array variables, repeat the surrounding HTML structure for each array item
   - If {{array_var}} is inside a <li> tag, repeat the <li> tag for each array item
   - If {{array_var}} is inside a <div> tag, repeat the <div> tag for each array item
   - Maintain the exact same HTML structure around the array variable
4. VALID HTML: Ensure the final HTML is valid and well-formatted
5. NO STRUCTURAL CHANGES: Do not add new HTML elements, change classes, or modify the template structure (except for empty array handling as described below)
6. EMPTY ARRAY VARIABLES: If an array variable has an empty array (no data), you must add text within that section to indicate there is no data, remove the array variables from the HTML structure and keep the rest of the HTML structure intact. For example, for array variable "features_n", if there is no data, all variables "features_1", "features_2", etc. must be removed from the HTML structure as they together indicate the array variable.
7. EXACT REPLACEMENT: Only replace {{}} placeholders, keep everything else identical

RESPONSE FORMAT:
You must return a valid JSON object with exactly these two fields:
{
  "final_html": "final HTML content with variables replaced but structure preserved",
  "final_subject": "final subject with variables replaced"
}

IMPORTANT: Return ONLY the JSON object, no additional text or explanations.`;

      const substitutionResponse = await this.openai.chat.completions.create({
        model: process.env.AZURE_OPENAI_DEPLOYMENT_AGENT_MODE || 'gpt-5-chat-2',
        messages: [
          {
            role: 'user',
            content: substitutionPrompt
          }
        ],
        temperature: 0.1,
        response_format: { type: 'json_object' }
      });

      const substitutionResult = substitutionResponse.choices[0].message.content;
      if (!substitutionResult) {
        throw new Error('LLM did not return substitution result');
      }

      let substitutionData;
      try {
        substitutionData = JSON.parse(substitutionResult);
      } catch (parseError) {
        throw new Error('LLM returned invalid JSON for variable substitution');
      }

      if (!substitutionData.final_html || !substitutionData.final_subject) {
        throw new Error('LLM substitution result missing final_html or final_subject fields');
      }

      const finalHtml = substitutionData.final_html;
      const finalSubject = substitutionData.final_subject;
      
      // Verify the substitution was correct
      const remainingPlaceholders = finalHtml.match(/\{\{[^}]+\}\}/g) || [];
      const remainingSubjectPlaceholders = finalSubject.match(/\{\{[^}]+\}\}/g) || [];
      
      if (remainingPlaceholders.length > 0 || remainingSubjectPlaceholders.length > 0) {
        console.warn('Warning: Some variables were not substituted:', {
          htmlPlaceholders: remainingPlaceholders,
          subjectPlaceholders: remainingSubjectPlaceholders
        });
      }
      
      // Verify HTML structure is preserved (basic check)
      const originalTagCount = (template.html_content.match(/<[^>]+>/g) || []).length;
      const finalTagCount = (finalHtml.match(/<[^>]+>/g) || []).length;
      
      // Allow for some variation due to array repetition, but flag significant changes
      const tagDifference = Math.abs(originalTagCount - finalTagCount);
      if (tagDifference > originalTagCount * 0.5) { // More than 50% change in tag count
        console.warn('Warning: Significant HTML structure change detected:', {
          originalTagCount,
          finalTagCount,
          difference: tagDifference
        });
      }
      
      // Upload to S3
      const { uploadFileToS3 } = await import('../utils/s3Utils');
      const filename = `html_${templateName}.html`;
      const uploadResult = await uploadFileToS3(finalHtml, filename, userId, 'text/html');
      
      if (!uploadResult.success || !uploadResult.url) {
        throw new Error(uploadResult.error || 'Failed to upload to S3');
      }
      
      const s3Url = uploadResult.url;
      
      return {
        success: true,
        s3_url: s3Url,
        final_subject: finalSubject,
        template_name: templateName,
        filename: filename
      };
    } catch (error) {
      console.error('Error creating email HTML from template:', error);
      
      // Return specific error messages based on the error type
      if (error instanceof Error) {
        if (error.message.includes('Failed to process template with LLM') || error.message.includes('OpenAI API error')) {
          return {
            success: false,
            message: 'Failed to process template with LLM',
            error: error.message
          };
        } else if (error.message.includes('LLM returned invalid JSON')) {
          return {
            success: false,
            message: 'Failed to parse LLM response',
            error: error.message
          };
        } else if (error.message.includes('missing final_html or final_subject')) {
          return {
            success: false,
            message: 'LLM response missing final_html',
            error: error.message
          };
        } else if (error.message.includes('Failed to upload to S3') || error.message.includes('S3 upload failed')) {
          return {
            success: false,
            message: 'Failed to upload to S3',
            error: error.message
          };
        }
      }
      
      return {
        success: false,
        message: 'Failed to create email HTML from template',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  // Extract variables from HTML content and subject (same logic as in settings.ts)
  private extractVariables(htmlContent: string, subject?: string): { variables: string[], arrayVariables: string[] } {
    const variableRegex = /\{\{([^}]+)\}\}/g;
    const allVariables: string[] = [];
    const regularVariables: string[] = [];
    const arrayVariableNames = new Set<string>();
    let match;

    // Collect all variables from HTML content
    while ((match = variableRegex.exec(htmlContent)) !== null) {
      const variable = match[1].trim();
      if (!allVariables.includes(variable)) {
        allVariables.push(variable);
      }
    }

    // Also collect variables from subject if provided
    if (subject) {
      const subjectRegex = /\{\{([^}]+)\}\}/g;
      let subjectMatch;
      while ((subjectMatch = subjectRegex.exec(subject)) !== null) {
        const variable = subjectMatch[1].trim();
        if (!allVariables.includes(variable)) {
          allVariables.push(variable);
        }
      }
    }

    // Find all _n and _n_ patterns first
    const nPatterns = new Set<string>();
    allVariables.forEach(variable => {
      const nMatch = variable.match(/^(.+)_n(?:_(.+))?$/);
      if (nMatch) {
        const baseName = nMatch[1];
        const suffix = nMatch[2];
        if (suffix) {
          nPatterns.add(`${baseName}_n_${suffix}`);
        } else {
          nPatterns.add(`${baseName}_n`);
        }
      }
    });

    // Now process all variables
    const processedArrayNames = new Set<string>();

    allVariables.forEach(variable => {
      let isArrayVariable = false;

      // Check if this variable matches any _n pattern
      nPatterns.forEach(nPattern => {
        const baseName = nPattern.replace(/_n.*$/, '');
        const numericMatch = variable.match(new RegExp(`^${baseName}_(\\d+)(?:_|$)`));
        if (numericMatch) {
          if (!processedArrayNames.has(nPattern)) {
            arrayVariableNames.add(nPattern);
            processedArrayNames.add(nPattern);
          }
          isArrayVariable = true;
        }
      });

      // Check if this is already an _n pattern
      const nMatch = variable.match(/^(.+)_n(?:_(.+))?$/);
      if (nMatch) {
        const baseName = nMatch[1];
        const suffix = nMatch[2];
        const fullName = suffix ? `${baseName}_n_${suffix}` : `${baseName}_n`;
        if (!processedArrayNames.has(fullName)) {
          arrayVariableNames.add(fullName);
          processedArrayNames.add(fullName);
        }
        isArrayVariable = true;
      }

      if (!isArrayVariable) {
        regularVariables.push(variable);
      }
    });

    return { variables: regularVariables, arrayVariables: Array.from(arrayVariableNames) };
  }

  // Work Plan Management Methods

  private async createWorkPlan(title: string, steps: Array<{stepCount: number; title: string; description?: string; requiredFunctionCalls?: string[]}>, sessionId: string): Promise<any> {
    try {
      const session = await chatbotDb.getChatSession(sessionId);
      if (!session) {
        return {
          success: false,
          message: 'Session not found'
        };
      }

      // Create the work plan with all steps in pending status
      // Ensure stepCount is sequential starting from 1
      const workPlan = {
        title,
        steps: steps.map((step, index) => ({
          stepCount: index + 1, // Must be sequential: index+1
          title: step.title,
          description: step.description,
          status: 'pending' as const,
          completedAt: undefined,
          notes: undefined,
          requiredFunctionCalls: step.requiredFunctionCalls
        })),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      // Update the session with the work plan
      await chatbotDb.updateSessionWorkPlan(sessionId, workPlan);

      return {
        success: true,
        message: `Work plan "${title}" created with ${steps.length} steps`,
        workPlan,
        formattedContent: `Created work plan "${title}" with ${steps.length} steps:\n${workPlan.steps.map(s => `${s.stepCount}. ${s.title}`).join('\n')}`
      };
    } catch (error) {
      console.error('AgentMode: Error creating work plan:', error);
      return {
        success: false,
        message: 'Failed to create work plan',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  private async modifyWorkPlan(steps: Array<{stepCount: number; title: string; description?: string; requiredFunctionCalls?: string[]}>, removeStepCounts: number[], sessionId: string): Promise<any> {
    try {
      const session = await chatbotDb.getChatSession(sessionId);
      if (!session || !session.workPlan) {
        return {
          success: false,
          message: 'No work plan found in this session. Create one first using create_work_plan.'
        };
      }

      const workPlan = { ...session.workPlan };
      
      // Remove steps if specified
      if (removeStepCounts && removeStepCounts.length > 0) {
        workPlan.steps = workPlan.steps.filter(s => !removeStepCounts.includes(s.stepCount));
      }

      // Update or add steps
      for (const newStep of steps) {
        const existingIndex = workPlan.steps.findIndex(s => s.stepCount === newStep.stepCount);
        if (existingIndex >= 0) {
          // Update existing step (preserve status and completion info)
          workPlan.steps[existingIndex] = {
            ...workPlan.steps[existingIndex],
            title: newStep.title,
            description: newStep.description,
            requiredFunctionCalls: newStep.requiredFunctionCalls !== undefined ? newStep.requiredFunctionCalls : workPlan.steps[existingIndex].requiredFunctionCalls
          };
        } else {
          // Add new step (stepCount will be fixed by updateSessionWorkPlan)
          workPlan.steps.push({
            stepCount: newStep.stepCount,
            title: newStep.title,
            description: newStep.description,
            status: 'pending',
            completedAt: undefined,
            notes: undefined,
            requiredFunctionCalls: newStep.requiredFunctionCalls
          });
        }
      }

      // Sort steps by stepCount before saving
      workPlan.steps.sort((a, b) => a.stepCount - b.stepCount);
      workPlan.updatedAt = new Date().toISOString();

      // Update the session (will throw error if stepCount is not sequential)
      await chatbotDb.updateSessionWorkPlan(sessionId, workPlan);

      return {
        success: true,
        message: `Work plan modified successfully`,
        workPlan,
        formattedContent: `Modified work plan. Current steps:\n${workPlan.steps.map((s, i) => `${i + 1}. ${s.title} (${s.status})`).join('\n')}`
      };
    } catch (error) {
      console.error('AgentMode: Error modifying work plan:', error);
      return {
        success: false,
        message: 'Failed to modify work plan',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  private async setWorkPlanStatus(
    updates: Array<{stepCount: number; status: 'pending' | 'completed' | 'skipped'; notes?: string}>, 
    sessionId: string
  ): Promise<any> {
    try {
      const session = await chatbotDb.getChatSession(sessionId);
      if (!session || !session.workPlan) {
        return {
          success: false,
          message: 'No work plan found in this session. Create one first using create_work_plan.'
        };
      }

      const workPlan = { ...session.workPlan };
      const updatedSteps: Array<{stepCount: number; title: string; status: string}> = [];
      const notFoundSteps: number[] = [];
      const missingFunctionCalls: Array<{stepCount: number; title: string; missing: string[]}> = [];

      // Get function call counts from session (make a copy to modify)
      const calledFunctionCounts = { ...(session.calledFunctions || {}) };
      let countsModified = false;

      // Process each update
      for (const update of updates) {
        const stepIndex = workPlan.steps.findIndex(s => s.stepCount === update.stepCount);
        
        if (stepIndex < 0) {
          notFoundSteps.push(update.stepCount);
          continue;
        }

        const step = workPlan.steps[stepIndex];

        // Validate required function calls if marking as completed
        if (update.status === 'completed' && step.requiredFunctionCalls && step.requiredFunctionCalls.length > 0) {
          // Count how many times each function is required
          const requiredCounts: Record<string, number> = {};
          for (const fn of step.requiredFunctionCalls) {
            requiredCounts[fn] = (requiredCounts[fn] || 0) + 1;
          }
          
          // Check if we have enough calls for each required function
          const missing: string[] = [];
          for (const [fn, requiredCount] of Object.entries(requiredCounts)) {
            const availableCount = calledFunctionCounts[fn] || 0;
            if (availableCount < requiredCount) {
              missing.push(`${fn} (need ${requiredCount}, have ${availableCount})`);
            }
          }
          
          if (missing.length > 0) {
            missingFunctionCalls.push({
              stepCount: update.stepCount,
              title: step.title,
              missing
            });
            continue; // Skip updating this step
          }
          
          // If validation passed and marking as completed, decrement the function counts
          for (const fn of step.requiredFunctionCalls) {
            calledFunctionCounts[fn] = (calledFunctionCounts[fn] || 0) - 1;
            countsModified = true;
          }
        }

        // Update the step status
        workPlan.steps[stepIndex] = {
          ...workPlan.steps[stepIndex],
          status: update.status,
          notes: update.notes,
          completedAt: update.status === 'completed' ? new Date().toISOString() : workPlan.steps[stepIndex].completedAt
        };

        updatedSteps.push({
          stepCount: update.stepCount,
          title: workPlan.steps[stepIndex].title,
          status: update.status
        });
      }

      // Check if there are missing function calls - this is a critical error
      if (missingFunctionCalls.length > 0) {
        const errorDetails = missingFunctionCalls.map(mfc => 
          `Step ${mfc.stepCount} "${mfc.title}": missing required function calls: ${mfc.missing.join(', ')}`
        ).join('\n');
        
        return {
          success: false,
          message: 'Cannot mark steps as completed. Required function calls have not been made yet.',
          missingFunctionCalls,
          formattedContent: `❌ Cannot complete these steps yet:\n${errorDetails}\n\nPlease make the required function calls first, then mark the steps as completed.`
        };
      }

      // Check if any steps were not found
      if (notFoundSteps.length > 0 && updatedSteps.length === 0) {
        return {
          success: false,
          message: `Steps not found: ${notFoundSteps.join(', ')}`
        };
      }

      // Only update if there are changes
      if (updatedSteps.length > 0) {
        workPlan.updatedAt = new Date().toISOString();
        // Update the session (will throw error if stepCount is not sequential)
        await chatbotDb.updateSessionWorkPlan(sessionId, workPlan);
        
        // Update function counts if they were modified
        if (countsModified) {
          await chatbotDb.updateCalledFunctions(sessionId, calledFunctionCounts);
        }
      }

      const message = updatedSteps.length === 1
        ? `Step ${updatedSteps[0].stepCount} status updated to ${updatedSteps[0].status}`
        : `Updated ${updatedSteps.length} step${updatedSteps.length > 1 ? 's' : ''}`;

      const formattedContent = updatedSteps.map(s => 
        `Updated step ${s.stepCount} "${s.title}" to ${s.status}`
      ).join('\n');

      return {
        success: updatedSteps.length > 0,
        message: notFoundSteps.length > 0 
          ? `${message}. Steps not found: ${notFoundSteps.join(', ')}`
          : message,
        updatedSteps,
        notFoundSteps: notFoundSteps.length > 0 ? notFoundSteps : undefined,
        formattedContent
      };
    } catch (error) {
      console.error('AgentMode: Error setting work plan status:', error);
      return {
        success: false,
        message: 'Failed to update work plan status',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }


}

export const agentModeService = new AgentModeService();
