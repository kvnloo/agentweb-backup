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
  updateKnowledgeBase?: boolean; // Whether to update the knowledge base after each execution
  updateLeadList?: boolean; // Whether to update the lead list after each execution
  leadListIdentifier?: string; // The identifier field for the lead list
  knowledgeBase?: string; // The GCS URL of the task's knowledge base file
  knowledgeBaseSize?: number; // Size of the knowledge base in bytes
  knowledgeBaseType?: 'public' | 'private'; // Whether the knowledge base is stored in public or private bucket
  knowledgeBaseUpdatedAt?: string; // When the knowledge base was last updated
  createVideo?: boolean; // Whether to create a video recording of the task execution
  videoModel?: string; // The video model to use for video generation
  imageModel?: string; // The image model to use for image generation
  description?: string; // Description of the task
  category?: string; // Category of the task
  requireApproval?: boolean; // Whether the task requires approval before sending results
  slackChannel?: string; // The Slack channel ID for approval requests
  sendHtmlReportOnly?: boolean; // Whether to send only HTML reports to all subscribers
  emailSender?: string; // Email sender for this task (format: username@domain)
  fromName?: string; // From name for this task
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
  updateLeadList?: boolean;
  leadListIdentifier?: string | null;
  knowledgeBase?: string;
  knowledgeBaseSize?: number; // Size of the knowledge base in bytes
  knowledgeBaseType?: 'public' | 'private'; // Whether the knowledge base is stored in public or private bucket
  knowledgeBaseUpdatedAt?: string; // When the knowledge base was last updated
  createVideo?: boolean; // Whether to create a video recording of the task execution
  videoModel?: string; // The video model to use for video generation
  imageModel?: string; // The image model to use for image generation
  requireApproval?: boolean; // Whether the task requires approval before sending results
  slackChannel?: string; // The Slack channel ID for approval requests
  sendHtmlReportOnly?: boolean; // Whether to send only HTML reports to all subscribers
  emailSender?: string; // Email sender for this task (format: username@domain)
  fromName?: string; // From name for this task
} 