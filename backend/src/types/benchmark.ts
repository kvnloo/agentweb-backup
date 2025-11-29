export interface BenchmarkTest {
  testId: string;
  createdBy: string; // Admin user ID who created the test
  sessionId: string; // Source session ID
  userId: string; // Target user ID whose session was used
  testName: string;
  description?: string;
  conversationHistory: {
    messages: Array<{
      role: 'user' | 'assistant' | 'system';
      content: string;
      metadata?: {
        timestamp: string;
        toolCalls?: any[];
        knowledgeBaseQueries?: string[];
        sources?: string[];
        attachments?: Array<{
          url: string;
          filename: string;
          size: number;
          mimetype: string;
          uploadedAt: string;
        }>;
      };
    }>;
  };
  expectedOutput: {
    keywords?: string[]; // Expected keywords in response
    functionCalls?: string[]; // Expected function calls
  };
  status: 'draft' | 'active' | 'archived';
  llmModel?: string; // Selected LLM model for this test
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  lastRunModel?: string; // Model used in the last run
  runCount: number;
  successCount: number;
  failureCount: number;
  averageScore?: number; // 0-100 score based on criteria matching
  testHistory?: BenchmarkTestResult[]; // Array of test execution results
}

export interface BenchmarkTestResult {
  testId: string;
  runId: string;
  status: 'success' | 'failure';
  passed: boolean;
  actualResponse: string;
  actualFunctionCalls: string[];
  keywordMatches: string[];
  keywordMisses: string[];
  functionCallMatches: string[];
  functionCallMisses: string[];
  executionTime: number; // milliseconds
  errorMessage?: string;
  llmModel?: string; // Model used in this test run
  createdAt: string;
}

export interface CreateBenchmarkTestRequest {
  sessionId: string;
  testName: string;
  description?: string;
  expectedOutput: {
    keywords?: string[];
    functionCalls?: string[];
  };
  llmModel?: string; // Selected LLM model for this test
}

export interface RunBenchmarkTestRequest {
  testId: string;
  llmName?: string; // Optional LLM override
}



