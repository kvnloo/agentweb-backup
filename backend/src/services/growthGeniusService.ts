import { getAzureClient } from '../utils/llmClients';
import { searchPlatformKnowledgeBase } from './chatbotService';

export interface GrowthGeniusMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  metadata?: {
    portalType: 'genius';
    knowledgeBaseQueries?: string[];
    sources?: string[];
  };
}

export interface GrowthGeniusSession {
  sessionId: string;
  userId: string;
  title: string;
  messages: GrowthGeniusMessage[];
  createdAt: Date;
  updatedAt: Date;
  portalType: 'genius';
}

export class GrowthGeniusService {
  /**
   * Metered Azure client for Growth Genius. Preserves the original bespoke
   * deployment + api-version (GROWTH_GENIUS env vars) so usage is recorded
   * without changing which endpoint/version the calls hit.
   */
  private client(userId?: string) {
    return getAzureClient(
      { userId, feature: 'growth_genius' },
      process.env.AZURE_OPENAI_DEPLOYMENT_GROWTH_GENIUS || 'gpt-5-chat-2',
      { apiVersion: process.env.AZURE_OPENAI_API_VERSION_GROWTH_GENIUS || '2025-01-01-preview' }
    );
  }

  private getSystemPrompt(): string {
    return `You are Growth Genius, an AI-powered growth marketing assistant specializing in startup growth strategies, marketing tactics, and business scaling advice.

Your capabilities include:
- Analyzing growth marketing strategies from successful companies
- Providing actionable marketing advice based on real-world examples
- Using the search_knowledge_base function to find relevant information when needed
- Offering data-driven growth recommendations with specific examples

When responding:
1. Always provide practical, actionable advice
2. Reference specific examples when possible
3. Use the search_knowledge_base function when you need additional information to provide a comprehensive answer
4. Structure responses clearly with bullet points or numbered lists
5. Ask clarifying questions when needed to provide better advice

IMPORTANT: You have access to a search_knowledge_base function. Use it when:
- You need specific examples or case studies
- You want to provide data-driven insights
- You need to reference successful strategies
- You want to give more comprehensive, evidence-based advice
- You need to find information about specific companies, tactics, or methodologies

Do NOT use the function for:
- General questions that don't require specific examples
- Creative brainstorming sessions
- Basic concept explanations
- Casual conversation
- Questions you can answer from your existing knowledge

The function will search our knowledge base and return relevant information that you can incorporate into your response to make it more valuable and evidence-based.

Current date: ${new Date().toISOString().split('T')[0]}

Remember: You're here to help startups and businesses grow through smart marketing strategies. Use the knowledge base function intelligently to provide the most valuable insights. Focus on being informative and educational rather than promotional.`;
  }

  async searchKnowledgeBase(query: string, userId: string): Promise<any[]> {
    try {
      console.log(`GrowthGenius: Searching knowledge base for: ${query}`);
      
      // Use the existing platform knowledge base search
      const results = await searchPlatformKnowledgeBase(query, 10, userId);
      console.log(`GrowthGenius: Found ${results.length} knowledge base results`);
      
      return results;
    } catch (error) {
      console.error('GrowthGenius: Knowledge base search failed:', error);
      return [];
    }
  }

  async generateSessionTitle(userMessage: string): Promise<string> {
    try {
      console.log('GrowthGenius: Generating session title for message:', userMessage);

      const response = await this.client().chat.completions.create({
        model: process.env.AZURE_OPENAI_DEPLOYMENT_GROWTH_GENIUS || 'gpt-5-chat-2',
        messages: [
          {
            role: 'system',
            content: `Generate a session title (max 60 characters) based on the user's message. Output ONLY the title text — no quotes, no punctuation at the end, no explanation.`
          },
          { role: 'user', content: userMessage.slice(0, 500) }
        ],
        max_completion_tokens: 20
      });

      const raw = response.choices[0]?.message?.content?.trim() || '';
      // Extract first line, strip markdown, hard-truncate to 60 chars
      const firstLine = raw.split('\n')[0].replace(/[*_`#[\]]/g, '').trim();
      const title = firstLine.slice(0, 60) || 'Unknown topic';
      console.log('GrowthGenius: Generated title:', title);

      return title;
    } catch (error) {
      console.error('GrowthGenius: Failed to generate session title:', error);
      return 'Unknown topic';
    }
  }



  async generateResponse(
    userMessage: string,
    sessionHistory: GrowthGeniusMessage[],
    userId: string,
    selectedStartupId?: string
  ): Promise<{ content: string; knowledgeBaseQueries: string[]; sources: string[] }> {
    try {
      console.log('GrowthGenius: Generating response for user message:', userMessage);
      
      // Prepare initial context
      const initialContext = this.buildContext(userMessage, sessionHistory, [], selectedStartupId);
      
      // First API call: Ask the model to use the functions
      const response = await this.client(userId).chat.completions.create({
        model: process.env.AZURE_OPENAI_DEPLOYMENT_GROWTH_GENIUS || 'gpt-5-chat-2',
        messages: [
          { role: 'system', content: this.getSystemPrompt() },
          { role: 'user', content: initialContext }
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'search_knowledge_base',
              description: 'Search the knowledge base for additional information when needed to provide a more comprehensive answer',
              parameters: {
                type: 'object',
                properties: {
                  query: {
                    type: 'string',
                    description: 'The search query to find relevant information'
                  },
                  reason: {
                    type: 'string',
                    description: 'Why this search is needed to improve the response'
                  }
                },
                required: ['query', 'reason']
              }
            }
          }
        ],
        tool_choice: 'auto',
        max_completion_tokens: 1500
      });

      const responseMessage = response.choices[0].message;
      console.log('GrowthGenius: Initial response received');
      
      let knowledgeBaseResults: any[] = [];
      let sources: string[] = [];
      let knowledgeBaseQueries: string[] = [];
      
      // Handle function calls if the AI decides to search
      if (responseMessage.tool_calls) {
        console.log('GrowthGenius: AI requested knowledge base searches');
        
        for (const toolCall of responseMessage.tool_calls) {
          if (toolCall.function.name === 'search_knowledge_base') {
            try {
              const functionArgs = JSON.parse(toolCall.function.arguments);
              console.log('GrowthGenius: AI decided to search for:', functionArgs.query);
              console.log('GrowthGenius: AI reasoning:', functionArgs.reason);
              
              // Execute the knowledge base search
              const searchResults = await this.searchKnowledgeBase(functionArgs.query, userId);
              console.log('GrowthGenius: Search returned', searchResults.length, 'results');
              
              knowledgeBaseResults.push(...searchResults);
              knowledgeBaseQueries.push(functionArgs.query);
              
              // Add the tool response to messages for the final call
              const toolResponse = {
                tool_call_id: toolCall.id,
                role: 'tool' as const,
                name: 'search_knowledge_base',
                content: JSON.stringify({
                  query: functionArgs.query,
                  results: searchResults,
                  count: searchResults.length
                })
              };
              
              // Update sources
              const searchSources = searchResults.map(result => result.source || 'Unknown');
              sources = [...new Set([...sources, ...searchSources])];
              
            } catch (error) {
              console.error('GrowthGenius: Error processing search function call:', error);
            }
          }
        }
        
        // Second API call: Get the final response with knowledge base results
        const finalContext = this.buildContext(userMessage, sessionHistory, knowledgeBaseResults, selectedStartupId);
        const finalResponse = await this.client(userId).chat.completions.create({
          model: process.env.AZURE_OPENAI_DEPLOYMENT_GROWTH_GENIUS || 'gpt-5-chat-2',
          messages: [
            { role: 'system', content: this.getSystemPrompt() },
            { role: 'user', content: finalContext },
            responseMessage, // Include the assistant's response with tool calls
            ...responseMessage.tool_calls?.map(toolCall => ({
              tool_call_id: toolCall.id,
              role: 'tool' as const,
              name: toolCall.function.name,
              content: JSON.stringify({
                query: JSON.parse(toolCall.function.arguments).query,
                results: knowledgeBaseResults.filter((_, index) => index < knowledgeBaseResults.length),
                count: knowledgeBaseResults.length
              })
            })) || []
          ],
          max_completion_tokens: 1500
        });
        
        const finalContent = finalResponse.choices[0]?.message?.content || 'Sorry, I could not generate a response.';
        console.log('GrowthGenius: Final response generated with knowledge base context');
        
        return {
          content: finalContent,
          knowledgeBaseQueries,
          sources
        };
      } else {
        // No function calls were made, return the initial response
        console.log('GrowthGenius: No knowledge base search needed, returning initial response');
        return {
          content: responseMessage.content || 'Sorry, I could not generate a response.',
          knowledgeBaseQueries: [],
          sources: []
        };
      }
      
    } catch (error) {
      console.error('GrowthGenius: Response generation failed:', error);
      return {
        content: "I apologize, but I'm having trouble processing your request right now. Please try again in a moment.",
        knowledgeBaseQueries: [],
        sources: []
      };
    }
  }



  private buildContext(
    userMessage: string,
    sessionHistory: GrowthGeniusMessage[],
    knowledgeBaseResults: any[],
    selectedStartupId?: string
  ): string {
    let context = `User Message: ${userMessage}\n\n`;
    
    // Add startup context if available
    if (selectedStartupId && selectedStartupId !== 'no-startup') {
      context += 'Startup Context:\n';
      context += `The user is asking about their startup with ID: ${selectedStartupId}\n`;
      context += 'Use this context to provide more personalized and relevant advice.\n\n';
    }
    
    // Add recent conversation history (last 5 messages)
    if (sessionHistory.length > 0) {
      const recentHistory = sessionHistory.slice(-5);
      context += 'Recent Conversation:\n';
      recentHistory.forEach(msg => {
        context += `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}\n`;
      });
      context += '\n';
    }
    
    // Add knowledge base insights
    if (knowledgeBaseResults.length > 0) {
      context += 'Relevant Knowledge Base Insights:\n';
      knowledgeBaseResults.slice(0, 5).forEach((result, index) => {
        context += `${index + 1}. ${result.title || 'Untitled'}\n`;
        context += `   Content: ${result.content?.substring(0, 200)}...\n`;
        if (result.source) {
          context += `   Source: ${result.source}\n`;
        }
        context += '\n';
      });
    }
    
    return context;
  }

  async createSession(userId: string, title?: string): Promise<GrowthGeniusSession> {
    const sessionId = `genius_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const now = new Date();
    
    const session: GrowthGeniusSession = {
      sessionId,
      userId,
      title: title || 'Growth Strategy Session',
      messages: [],
      createdAt: now,
      updatedAt: now,
      portalType: 'genius'
    };
    
    console.log(`GrowthGenius: Created new session ${sessionId} for user ${userId}`);
    return session;
  }

  async addMessage(
    sessionId: string,
    userId: string,
    role: 'user' | 'assistant',
    content: string,
    metadata?: any
  ): Promise<GrowthGeniusMessage> {
    const message: GrowthGeniusMessage = {
      id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      role,
      content,
      timestamp: new Date(),
      metadata: {
        portalType: 'genius',
        ...metadata
      }
    };
    
    console.log(`GrowthGenius: Added ${role} message to session ${sessionId}`);
    return message;
  }
}

export const growthGeniusService = new GrowthGeniusService();
