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
} 