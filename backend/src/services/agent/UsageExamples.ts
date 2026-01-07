/**
 * Example: How to use the refactored AgentServiceFactory
 * 
 * This file demonstrates how to integrate the new modular architecture
 * with the existing agentModeService.
 */

import { agentServiceFactory } from './AgentServiceFactory';
import type { ToolContext } from '../../tools';

/**
 * Example: Initialize the agent service factory
 */
async function initializeAgent() {
  // Initialize all services (tools, LLM, prompts)
  await agentServiceFactory.initialize();
  
  // Note: You must also register handlers from agentModeService
  // This should be done when agentModeService is instantiated:
  // agentServiceFactory.registerToolHandlers(agentModeServiceInstance);
}

/**
 * Example: Get tools for a user message with intent-based selection
 * This reduces token usage by 50-85%
 */
async function getToolsExample(userMessage: string, userId: string) {
  const result = await agentServiceFactory.getToolsForMessage(
    userMessage,
    userId, // actual user ID for subscription lookup
    []      // session history
  );
  
  console.log(`Selected ${result.selectedCount} of ${result.totalCount} tools`);
  console.log(`Token savings: ${result.savingsPercent}%`);
  console.log(`Categories: ${result.categories.join(', ')}`);
  
  // result.tools is in OpenAI format, ready to pass to LLM
  return result.tools;
}

/**
 * Example: Execute a tool with the new ToolExecutor
 */
async function executeToolExample() {
  const context: ToolContext = {
    userId: 'user-123',
    sessionId: 'session-456',
    llmModel: 'gpt-4',
    mockMode: false
  };
  
  const result = await agentServiceFactory.executeTool(
    'search_web',
    { query: 'AI marketing trends 2024', max_results: 5 },
    context
  );
  
  if (result.success) {
    console.log('Tool result:', result.data);
  } else {
    console.error('Tool failed');
  }
}

/**
 * Example: Make an LLM call with tools
 */
async function llmCallExample(userMessage: string) {
  // Get default model
  const model = await agentServiceFactory.getDefaultModel();
  
  // Get system prompt with date
  const systemPrompt = await agentServiceFactory.getSystemPromptWithContext(
    new Date().toISOString().split('T')[0]
  );
  
  // Get tools for this message (userId should be passed to this function)
  const { tools } = await agentServiceFactory.getToolsForMessage(userMessage, 'user-123');
  
  // Build messages
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage }
  ];
  
  // Make LLM call
  const response = await agentServiceFactory.callLLM(model, messages, {
    tools,
    tool_choice: 'auto',
    max_completion_tokens: 4096,
    temperature: 0.1
  });
  
  return response;
}

/**
 * Example: Integration pattern for agentModeService.generateMarketingResponse
 * 
 * This shows how the existing method could be refactored to use the new services.
 */
async function generateMarketingResponseExample(
  messageContent: string,
  sessionHistory: any[],
  userId: string,
  llmModel: string,
  sessionId: string
) {
  // 1. Get system prompt (uses PromptTemplateService)
  const systemPrompt = await agentServiceFactory.getSystemPromptWithContext(
    new Date().toISOString().split('T')[0]
  );
  
  // 2. Get filtered tools based on intent (uses ToolSelector + SubscriptionService)
  const { tools, savingsPercent } = await agentServiceFactory.getToolsForMessage(
    messageContent,
    userId, // actual user ID for subscription-based filtering
    sessionHistory
  );
  
  console.log(`Using ${tools.length} tools (${savingsPercent}% token savings)`);
  
  // 3. Build messages
  const messages = [
    { role: 'system', content: systemPrompt },
    ...sessionHistory,
    { role: 'user', content: messageContent }
  ];
  
  // 4. Call LLM (uses LLMClientFactory)
  const response = await agentServiceFactory.callLLM(llmModel, messages, {
    tools,
    tool_choice: 'auto',
    max_completion_tokens: 12384,
    temperature: 0.1
  });
  
  // 5. Handle tool calls (uses ToolExecutor)
  const choice = response.choices[0];
  if (choice.message.tool_calls) {
    for (const toolCall of choice.message.tool_calls) {
      const args = JSON.parse(toolCall.function.arguments);
      
      // Execute tool through factory
      const result = await agentServiceFactory.executeTool(
        toolCall.function.name,
        args,
        { userId, sessionId, llmModel }
      );
      
      console.log(`Tool ${toolCall.function.name} result:`, result.success);
    }
  }
  
  return response;
}

// Export for reference
export {
  initializeAgent,
  getToolsExample,
  executeToolExample,
  llmCallExample,
  generateMarketingResponseExample
};
