/**
 * Prompt Builder Service
 * 
 * Manages system prompts for the AI agent (Emma).
 * Supports custom prompts from settings with fallback to defaults.
 */

import { settingsService } from '../settingsService';

/**
 * Prompt sections that can be composed together
 */
export interface PromptSection {
  name: string;
  content: string;
  priority?: number;
}

/**
 * Prompt Builder - manages and builds system prompts
 */
export class PromptBuilder {
  private static SETTING_NAMES = {
    systemPrompt: 'agent_mode_system_prompt',
    welcomeMessage: 'agent_mode_welcome_message',
    conversationStarters: 'agent_mode_conversation_starters'
  };

  /**
   * Get the marketing system prompt (from settings or default)
   */
  async getMarketingSystemPrompt(): Promise<string> {
    try {
      const setting = await settingsService.getSetting(PromptBuilder.SETTING_NAMES.systemPrompt);
      if (setting?.settingValue) {
        return setting.settingValue;
      }
    } catch (error) {
      console.error('PromptBuilder: Error getting custom system prompt:', error);
    }
    
    return this.getDefaultSystemPrompt();
  }

  /**
   * Get the welcome message
   */
  async getWelcomeMessage(): Promise<string> {
    try {
      const setting = await settingsService.getSetting(PromptBuilder.SETTING_NAMES.welcomeMessage);
      if (setting?.settingValue) {
        return setting.settingValue;
      }
    } catch (error) {
      console.error('PromptBuilder: Error getting custom welcome message:', error);
    }
    
    return this.getDefaultWelcomeMessage();
  }

  /**
   * Get conversation starters
   */
  async getConversationStarters(): Promise<string[]> {
    try {
      const setting = await settingsService.getSetting(PromptBuilder.SETTING_NAMES.conversationStarters);
      if (setting?.settingValue) {
        return JSON.parse(setting.settingValue);
      }
    } catch (error) {
      console.error('PromptBuilder: Error getting conversation starters:', error);
    }
    
    return this.getDefaultConversationStarters();
  }

  /**
   * Build a system prompt from sections
   */
  buildPrompt(sections: PromptSection[]): string {
    return sections
      .sort((a, b) => (a.priority || 0) - (b.priority || 0))
      .map(s => s.content)
      .join('\n\n');
  }

  /**
   * Get system prompt with current date injected
   */
  async getSystemPromptWithDate(): Promise<string> {
    const prompt = await this.getMarketingSystemPrompt();
    const currentDate = new Date().toISOString().split('T')[0];
    return `${prompt}\n\nCurrent date: ${currentDate}`;
  }

  /**
   * Default welcome message
   */
  private getDefaultWelcomeMessage(): string {
    return "I'm Emma, your team's new CMO 😎. I'll help you research, build, deploy, and measure Meta campaign insights in a blink of an eye.<br><br><strong>To get started, can you share your website URL?</strong>";
  }

  /**
   * Default conversation starters
   */
  private getDefaultConversationStarters(): string[] {
    return [
      "Formulate marketing strategy for my product",
      "Create social media content calendar",
      "Develop my personal brand on Linkedin or x.com",
      "Create automated newsletter for my company"
    ];
  }

  /**
   * Default system prompt for Emma
   * This is the fallback when no custom prompt is configured
   */
  private getDefaultSystemPrompt(): string {
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

## Task Creation Approach
- **IMPORTANT**: Always confirm with the user before creating any task, as tasks can take a few minutes to complete
- **Confirmation required**: Explain what the task will do and get explicit approval before proceeding
- **Web Automation Tasks Only**: The 'create_task_from_template' and 'create_task_from_prompt' tools are ONLY for web automation tasks that require browser interaction (e.g., logging into websites, scraping data, filling forms). These tools cannot run generic tasks that don't involve web browsing.
- **Primary Method**: Use the 'create_task_from_template' tool with a specific template_id and parameters_json string
- All available templates are provided in the context above - select the most appropriate one based on the user's request
- **Image Generation**: Use 'generate_image' for creating and revising images. This provides real-time (~30s) image generation.
- **Video Generation**: Use 'generate_video' for creating videos. This provides real-time video generation using Veo 3.1.
- **Blog Articles**: When creating blog articles, prefer using the 'create_blog_article' tool.
- **Meta Ads Metrics**: Use 'get_meta_ads_metrics' to fetch and analyze Meta ad performance data
- **Web Search**: Use 'search_web' proactively to gather information from the internet before asking users for clarification
- **Knowledge Base Search**: Use 'search_knowledge_base' to find information stored in the knowledge base.

## Communication Style
- Be helpful, professional, and conversational
- **Research before asking**: Use web search to gather current information before asking users for clarification
- Keep responses concise but informative
- Always confirm task creation and provide relevant details

## Response Formatting
Format your responses in HTML5 for direct rendering. Use:
- <strong> for important points
- <em> for emphasis
- <code> for technical terms and commands
- <ul> and <li> for lists
- <a href="url" target="_blank"> for links
- <table> for structured data

Use the available tools to create tasks in the agent-engine when complex work is required. Guide users through marketing flows naturally through conversation.`;
  }
}

// Singleton instance
export const promptBuilder = new PromptBuilder();
