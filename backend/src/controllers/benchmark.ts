import { Request, Response } from 'express';
import { benchmarkTestDb } from '../services/db';
import { chatbotDb } from '../services/chatbotService';
import { agentModeService } from '../services/agentModeService';
import { generateMarketingResponseWorkerService } from '../services/generateMarketingResponseWorkerService';
import { skillService } from '../services/skillService';
import { AuthenticatedRequest, isRealAdmin } from '../middleware/auth';
import { BenchmarkTest, CreateBenchmarkTestRequest, RunBenchmarkTestRequest } from '../types/benchmark';
import { v4 as uuidv4 } from 'uuid';

// Create a new benchmark test from a session
export async function createBenchmarkTest(req: AuthenticatedRequest, res: Response) {
  try {
    const { sessionId, testName, description, expectedOutput, llmModel }: CreateBenchmarkTestRequest = req.body;
    const adminUserId = req.user.userId;

    // Check if user is admin
    if (!isRealAdmin(req)) {
      return res.status(403).json({
        message: 'Only admin users can create benchmark tests'
      });
    }

    // Get the session to extract conversation history and user info
    const session = await chatbotDb.getChatSession(sessionId);
    if (!session) {
      return res.status(404).json({ 
        message: 'Session not found' 
      });
    }

    // Use custom conversation history if provided, otherwise use session messages
    let messages = req.body.conversationHistory?.messages || session.messages || [];
    
    // Process messages to include attachments in user messages (same as generateResponse)
    messages = messages.map((message: any) => {
      if (message.role === 'user') {
        // Check for attachments in both message.attachments and message.metadata.attachments
        const attachments = message.attachments || message.metadata?.attachments || [];
        if (attachments.length > 0) {
          const attachmentUrls = attachments.map((attachment: any) => {
            return `[${attachment.filename || 'Attachment'}](${attachment.url})`;
          }).join('\n');
          return {
            ...message,
            content: `${message.content}\n\n**Attached Files:**\n${attachmentUrls}`
          };
        }
      }
      return message;
    });
    
    const conversationHistory = {
      messages
    };

    // Create the benchmark test
    const testId = uuidv4();
    const defaultModel = await agentModeService.getDefaultModel();
    const benchmarkTest: BenchmarkTest = {
      testId,
      createdBy: adminUserId,
      sessionId,
      userId: session.userId,
      testName,
      description,
      conversationHistory,
      expectedOutput,
      status: 'draft',
      llmModel: llmModel || defaultModel, // Use provided model or default
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      runCount: 0,
      successCount: 0,
      failureCount: 0
    };

    await benchmarkTestDb.createBenchmarkTest(benchmarkTest);

    res.status(201).json({
      message: 'Benchmark test created successfully',
      testId,
      benchmarkTest
    });
  } catch (error) {
    console.error('Error creating benchmark test:', error);
    res.status(500).json({ 
      message: 'Failed to create benchmark test',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}

// Get all benchmark tests (admin only)
export async function getAllBenchmarkTests(req: AuthenticatedRequest, res: Response) {
  try {
    if (!isRealAdmin(req)) {
      return res.status(403).json({
        message: 'Only admin users can view all benchmark tests'
      });
    }

    const limit = parseInt(req.query.limit as string) || 100;
    const tests = await benchmarkTestDb.getAllBenchmarkTests(limit);

    res.json({
      tests,
      count: tests.length
    });
  } catch (error) {
    console.error('Error getting benchmark tests:', error);
    res.status(500).json({ 
      message: 'Failed to get benchmark tests',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}

// Get benchmark tests created by current admin
export async function getMyBenchmarkTests(req: AuthenticatedRequest, res: Response) {
  try {
    if (!isRealAdmin(req)) {
      return res.status(403).json({
        message: 'Only admin users can view benchmark tests'
      });
    }

    const limit = parseInt(req.query.limit as string) || 50;
    const tests = await benchmarkTestDb.getBenchmarkTestsByCreator(req.user.userId, limit);

    res.json({
      tests,
      count: tests.length
    });
  } catch (error) {
    console.error('Error getting my benchmark tests:', error);
    res.status(500).json({ 
      message: 'Failed to get benchmark tests',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}

// Get a specific benchmark test
export async function getBenchmarkTest(req: AuthenticatedRequest, res: Response) {
  try {
    const { testId } = req.params;

    if (!isRealAdmin(req)) {
      return res.status(403).json({
        message: 'Only admin users can view benchmark tests'
      });
    }

    const test = await benchmarkTestDb.getBenchmarkTest(testId);
    if (!test) {
      return res.status(404).json({
        message: 'Benchmark test not found'
      });
    }

    res.json(test);
  } catch (error) {
    console.error('Error getting benchmark test:', error);
    res.status(500).json({ 
      message: 'Failed to get benchmark test',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}

// Update a benchmark test
export async function updateBenchmarkTest(req: AuthenticatedRequest, res: Response) {
  try {
    const { testId } = req.params;
    const updates = req.body;

    if (!isRealAdmin(req)) {
      return res.status(403).json({
        message: 'Only admin users can update benchmark tests'
      });
    }

    // Remove fields that shouldn't be updated
    delete updates.testId;
    delete updates.createdBy;
    delete updates.createdAt;
    delete updates.runCount;
    delete updates.successCount;
    delete updates.failureCount;

    const updatedTest = await benchmarkTestDb.updateBenchmarkTest(testId, updates);

    res.json({
      message: 'Benchmark test updated successfully',
      test: updatedTest
    });
  } catch (error) {
    console.error('Error updating benchmark test:', error);
    res.status(500).json({ 
      message: 'Failed to update benchmark test',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}

// Delete a benchmark test
export async function deleteBenchmarkTest(req: AuthenticatedRequest, res: Response) {
  try {
    const { testId } = req.params;

    if (!isRealAdmin(req)) {
      return res.status(403).json({
        message: 'Only admin users can delete benchmark tests'
      });
    }

    await benchmarkTestDb.deleteBenchmarkTest(testId);

    res.json({
      message: 'Benchmark test deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting benchmark test:', error);
    res.status(500).json({ 
      message: 'Failed to delete benchmark test',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}

// Evaluate benchmark response against expected criteria
function evaluateBenchmarkResponse(
  actualResponse: string,
  actualFunctionCalls: string[],
  expectedOutput: any
): {
  passed: boolean;
  keywordMatches: string[];
  keywordMisses: string[];
  functionCallMatches: string[];
  functionCallMisses: string[];
} {
  const expectedKeywords = expectedOutput.keywords || [];
  const expectedFunctionCalls = expectedOutput.functionCalls || [];

  // Evaluate keywords
  const keywordMatches: string[] = [];
  const keywordMisses: string[] = [];
  
  expectedKeywords.forEach((keyword: string) => {
    if (actualResponse.toLowerCase().includes(keyword.toLowerCase())) {
      keywordMatches.push(keyword);
    } else {
      keywordMisses.push(keyword);
    }
  });

  // Evaluate function calls
  const functionCallMatches: string[] = [];
  const functionCallMisses: string[] = [];
  
  expectedFunctionCalls.forEach((expectedCall: string) => {
    if (actualFunctionCalls.includes(expectedCall)) {
      functionCallMatches.push(expectedCall);
    } else {
      functionCallMisses.push(expectedCall);
    }
  });

  // Pass only if ALL expected keywords and ALL expected function calls are present
  const allKeywordsPresent = expectedKeywords.length === 0 || keywordMisses.length === 0;
  const allFunctionCallsPresent = expectedFunctionCalls.length === 0 || functionCallMisses.length === 0;
  const passed = allKeywordsPresent && allFunctionCallsPresent;

  return {
    passed,
    keywordMatches,
    keywordMisses,
    functionCallMatches,
    functionCallMisses
  };
}

// Run a benchmark test
export async function runBenchmarkTest(req: AuthenticatedRequest, res: Response) {
  try {
    const { testId } = req.params;
    const { llmName }: RunBenchmarkTestRequest = req.body;

    if (!isRealAdmin(req)) {
      return res.status(403).json({
        message: 'Only admin users can run benchmark tests'
      });
    }

    // Get the benchmark test
    const test = await benchmarkTestDb.getBenchmarkTest(testId);
    if (!test) {
      return res.status(404).json({ 
        message: 'Benchmark test not found' 
      });
    }

    if (test.status !== 'active') {
      return res.status(400).json({ 
        message: 'Benchmark test must be active to run' 
      });
    }

    const runId = uuidv4();
    const startTime = Date.now();
    const defaultModel = await agentModeService.getDefaultModel();

    try {
      // Pre-install all skills on the benchmark session so that tools referenced
      // in the stored conversation history are available to the LLM from the start.
      // Without this, skill-gated tools (like create_task_from_template) would be
      // missing from the tool list, causing models to fall back to inline answers.
      const publishedSkills = await skillService.getPublishedSkills();
      const allSkillIds = [
        ...publishedSkills.map(s => s.skillId),
        '__other_skills__'
      ];
      await agentModeService.installSkills(allSkillIds, test.userId, test.sessionId);

      // Prepare input for benchmark execution
      const messages = test.conversationHistory.messages;
      if (messages.length === 0) {
        throw new Error('No conversation history available for benchmark test');
      }

      // Use the last message as the current message content
      const lastMessage = messages[messages.length - 1];
      const messageContent = lastMessage.content;

      // Use all messages except the last one as session history
      const sessionHistory = messages.slice(0, -1);

      // Determine which model to use: override > saved model > default
      const modelToUse = llmName || test.llmModel || defaultModel;

      // Call the agent to generate response with mock mode enabled using worker process
      // This prevents blocking the main event loop during benchmark testing
      const agentResponse = await generateMarketingResponseWorkerService.runInWorker({
        messageContent,
        sessionHistory,
        userId: test.userId, // Use the original user's ID
        llmModel: modelToUse,
        sessionId: test.sessionId, // Use the original session ID
        mockMode: true // Enable mock mode for benchmark testing
      });

      const executionTime = Date.now() - startTime;

      // Extract function calls from the response
      const actualFunctionCalls = agentResponse.toolCalls?.map((call: any) => call.name).filter(Boolean) || [];

      // Evaluate the response against expected criteria
      const evaluation = evaluateBenchmarkResponse(
        agentResponse.content,
        actualFunctionCalls,
        test.expectedOutput
      );

      // Determine overall status based on pass/fail
      const status = evaluation.passed ? 'success' : 'failure';

      const result = {
        testId,
        runId,
        status,
        passed: evaluation.passed,
        actualResponse: agentResponse.content,
        responseMessages: agentResponse.responseMessages, // Store the full response messages
        actualFunctionCalls,
        keywordMatches: evaluation.keywordMatches,
        keywordMisses: evaluation.keywordMisses,
        functionCallMatches: evaluation.functionCallMatches,
        functionCallMisses: evaluation.functionCallMisses,
        executionTime,
        llmModel: modelToUse, // Save the model used in this run
        createdAt: new Date().toISOString()
      };

      // Update test statistics and save result to history
      await benchmarkTestDb.incrementRunCount(testId, status === 'success');
      await benchmarkTestDb.addTestResult(testId, result);
      
      // Update lastRunModel on the test
      await benchmarkTestDb.updateBenchmarkTest(testId, {
        lastRunModel: modelToUse,
        lastRunAt: new Date().toISOString()
      });

      res.json({
        message: 'Benchmark test executed successfully',
        result
      });

    } catch (executionError) {
      console.error('Error during benchmark execution:', executionError);
      
      const executionTime = Date.now() - startTime;
      // Determine which model was attempted (use same logic as success case)
      const modelToUse = llmName || test.llmModel || defaultModel;
      
      const errorResult = {
        testId,
        runId,
        status: 'failure' as const,
        passed: false,
        actualResponse: '',
        actualFunctionCalls: [],
        keywordMatches: [],
        keywordMisses: test.expectedOutput.keywords || [],
        functionCallMatches: [],
        functionCallMisses: test.expectedOutput.functionCalls || [],
        executionTime,
        errorMessage: executionError instanceof Error ? executionError.message : 'Unknown execution error',
        llmModel: modelToUse, // Save the model used in this run
        createdAt: new Date().toISOString()
      };

      // Update test statistics and save result to history (count as failure)
      await benchmarkTestDb.incrementRunCount(testId, false);
      await benchmarkTestDb.addTestResult(testId, errorResult);
      
      // Update lastRunModel on the test even for failures
      await benchmarkTestDb.updateBenchmarkTest(testId, {
        lastRunModel: modelToUse,
        lastRunAt: new Date().toISOString()
      });

      res.json({
        message: 'Benchmark test execution failed',
        result: errorResult
      });
    }
  } catch (error) {
    console.error('Error running benchmark test:', error);
    res.status(500).json({ 
      message: 'Failed to run benchmark test',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}
