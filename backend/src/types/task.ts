export interface Task {
  taskId: string;
  userId: string;
  name: string;
  prompt: string;
  status: string;
  createdAt: string;
  updatedAt?: string;
  error?: string;
  summary?: string;  // Summary from the agent's execution
  isInteractive?: boolean;  // Whether the task allows user interaction during execution
  isDeepResearch?: boolean;  // Whether the task should use the deep research agent
  isComplexTask?: boolean;  // Whether the task requires more steps to complete (100 vs 25)
  extractPageContent?: boolean;  // Whether to extract JSON content from pages
  validateOutput?: boolean;  // Whether to validate output from the agent
  outputAsJson?: boolean;  // Whether the agent should output the result in JSON format
  outputAsHtml?: boolean;
  llmName?: string;  // The preferred LLM to try first for this task
  useSharedBrowser?: boolean; // Whether the task should use a shared browser session
  turnOffHeadless?: boolean; // Whether to run the browser in visible mode
  useKnowledgeBase?: boolean; // Whether the task can use the knowledge base
  knowledgeBase?: string; // The GCS URL of the task's knowledge base file
  knowledgeBaseSize?: number; // Size of the knowledge base in bytes
  knowledgeBaseType?: 'public' | 'private'; // Whether the knowledge base is stored in public or private bucket
  description?: string; // Description of the task
  category?: string; // Category of the task
}

export interface TaskUpdate {
  name?: string;
  prompt?: string;
  status?: string;
  error?: string;
  summary?: string;
  emailNotification?: boolean;
  isInteractive?: boolean;
  isDeepResearch?: boolean;
  isComplexTask?: boolean;
  extractPageContent?: boolean;
  validateOutput?: boolean;
  outputAsJson?: boolean;
  outputAsHtml?: boolean;
  isAgenticDevMode?: boolean;
  llmName?: string;
  useSharedBrowser?: boolean;
  turnOffHeadless?: boolean;
  useKnowledgeBase?: boolean;
  updateKnowledgeBase?: boolean;
  knowledgeBase?: string;
  knowledgeBaseSize?: number; // Size of the knowledge base in bytes
  knowledgeBaseType?: 'public' | 'private'; // Whether the knowledge base is stored in public or private bucket
} 